import * as vscode from 'vscode';
import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import { createAnchor, locateAnchor, Location } from './anchor';
import { Git, redact } from './git';
import { ReviewThread, validPath } from './model';
import { ReviewStore } from './store';

interface Repository { store: ReviewStore; folder: vscode.WorkspaceFolder }
interface ThreadItem { key: string; repository: Repository; review: ReviewThread; uri: vscode.Uri; location: Location }
const supported = /\.(tex|bib|sty|cls|ltx)$/i;
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

class GiTex implements vscode.Disposable, vscode.TreeDataProvider<ThreadItem> {
  private readonly controller = vscode.comments.createCommentController('gitex', 'GiTex');
  private readonly changed = new vscode.EventEmitter<ThreadItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly output = vscode.window.createOutputChannel('GiTex');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  private readonly repositories = new Map<string, Repository>();
  private readonly nativeThreads = new Map<string, vscode.CommentThread>();
  private readonly threadItems = new WeakMap<vscode.CommentThread, ThreadItem>();
  private readonly excerpts = new Map<string, string>();
  private items: ThreadItem[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status.command = 'gitex.sync';
    this.controller.options = { prompt: 'Review this passage', placeHolder: 'Comment or explain your change…' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: document => this.repositoryFor(document.uri) && supported.test(document.uri.fsPath)
        ? [new vscode.Range(0, 0, document.lineCount - 1, 0)] : []
    };
    context.subscriptions.push(this, vscode.window.registerTreeDataProvider('gitex.comments', this),
      vscode.workspace.registerTextDocumentContentProvider('gitex-original', { provideTextDocumentContent: uri => this.excerpts.get(uri.toString()) ?? '' }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule()),
      vscode.workspace.onDidOpenTextDocument(document => { if (document.uri.scheme === 'file') { this.schedule(); } }),
      vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length && supported.test(event.document.uri.fsPath)) { this.schedule(); } }),
      vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
      vscode.window.onDidChangeWindowState(event => { if (event.focused) { this.schedule(); } }),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('gitex')) { this.schedule(); } })
    );
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{tex,bib,sty,cls,ltx}');
    context.subscriptions.push(watcher, watcher.onDidChange(() => this.schedule()), watcher.onDidCreate(() => this.schedule()), watcher.onDidDelete(() => this.schedule()));
    this.command('gitex.clone', () => vscode.commands.executeCommand('git.clone'));
    this.command('gitex.connect', () => this.connect());
    this.command('gitex.addComment', (body?: string) => this.addComment(typeof body === 'string' ? body : undefined));
    this.command('gitex.reply', (reply: vscode.CommentReply) => this.reply(reply));
    this.command('gitex.resolve', (target: ThreadItem | vscode.CommentThread) => this.setResolved(target, true));
    this.command('gitex.reopen', (target: ThreadItem | vscode.CommentThread) => this.setResolved(target, false));
    this.command('gitex.openThread', (item: ThreadItem) => this.open(item));
    this.command('gitex.refresh', () => this.refresh());
    this.command('gitex.sync', () => this.sync());
  }

  private command(name: string, handler: (...args: any[]) => unknown): void {
    this.context.subscriptions.push(vscode.commands.registerCommand(name, async (...args: unknown[]) => {
      try { return await handler(...args); }
      catch (error) { this.report(error); }
    }));
  }

  private report(error: unknown): void {
    const message = redact(error instanceof Error ? error.message : String(error));
    this.output.appendLine(`${new Date().toISOString()} ${message}`);
    void vscode.window.showErrorMessage(`GiTex: ${message}`);
  }

  private schedule(): void {
    if (this.disposed) { return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.refresh().catch(error => this.report(error)); }, 350);
  }

  refresh(): Promise<void> {
    this.refreshing = this.refreshing.catch(() => undefined).then(() => this.refreshNow());
    return this.refreshing;
  }

  private async discover(): Promise<void> {
    const roots = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') { continue; }
      const git = new Git(folder.uri.fsPath);
      const result = await git.run(['rev-parse', '--show-toplevel']);
      if (result.code !== 0) { continue; }
      const root = result.stdout.toString('utf8').trimEnd();
      roots.add(root);
      if (!this.repositories.has(root)) { this.repositories.set(root, { store: new ReviewStore(root), folder }); }
    }
    for (const root of this.repositories.keys()) { if (!roots.has(root)) { this.repositories.delete(root); } }
  }

  private repositoryFor(uri: vscode.Uri): Repository | undefined {
    if (uri.scheme !== 'file') { return undefined; }
    return [...this.repositories.values()].filter(repo => within(repo.store.root, uri.fsPath))
      .sort((a, b) => b.store.root.length - a.store.root.length)[0];
  }

  private async chooseRepository(): Promise<Repository | undefined> {
    await this.discover();
    const active = vscode.window.activeTextEditor;
    const current = active && this.repositoryFor(active.document.uri);
    if (current) { return current; }
    const repositories = [...this.repositories.values()];
    if (!repositories.length) { throw new Error('Open a local Git repository, or run GiTex: Clone Repository first.'); }
    if (repositories.length === 1) { return repositories[0]; }
    return (await vscode.window.showQuickPick(repositories.map(repository => ({ label: repository.folder.name, description: repository.store.root, repository })),
      { placeHolder: 'Select a paper repository' }))?.repository;
  }

  private async document(uri: vscode.Uri, repository: Repository): Promise<vscode.TextDocument> {
    const canonical = await realpath(uri.fsPath);
    if (!within(await realpath(repository.store.root), canonical)) { throw new Error('The file resolves outside this repository.'); }
    return vscode.workspace.openTextDocument(uri);
  }

  private async refreshNow(): Promise<void> {
    if (this.disposed) { return; }
    await this.discover();
    const next: ThreadItem[] = [];
    const documents = new Map<string, Promise<vscode.TextDocument>>();
    for (const repository of this.repositories.values()) {
      const showResolved = vscode.workspace.getConfiguration('gitex', repository.folder.uri).get('showResolved', true);
      for (const review of await repository.store.threads()) {
        if (review.resolved && !showResolved) { continue; }
        const uri = vscode.Uri.file(path.join(repository.store.root, review.anchor.path));
        let location: Location;
        try {
          if (!documents.has(uri.toString())) { documents.set(uri.toString(), this.document(uri, repository)); }
          location = locateAnchor(review.anchor, (await documents.get(uri.toString())!).getText());
        } catch { location = { kind: 'outdated', reason: 'The original file is missing, moved, or unavailable.' }; }
        next.push({ key: `${repository.store.root}:${review.id}`, repository, review, uri, location });
      }
    }
    if (this.disposed) { return; }
    const visible = new Set<string>();
    for (const item of next) {
      const { review, location } = item;
      if (location.kind !== 'attached') { continue; }
      visible.add(item.key);
      const range = new vscode.Range(location.startLine, 0, location.endLine, 0);
      let thread = this.nativeThreads.get(item.key);
      if (!thread) {
        thread = this.controller.createCommentThread(item.uri, range, []);
        this.nativeThreads.set(item.key, thread);
      }
      thread.range = range;
      // Plain text avoids loading images or executing links supplied in shared comments.
      thread.comments = review.comments.map(comment => ({ body: new vscode.MarkdownString().appendText(comment.body),
        mode: vscode.CommentMode.Preview, author: { name: comment.author.name }, timestamp: new Date(comment.at) }));
      thread.label = review.resolved ? 'GiTex · Resolved' : 'GiTex';
      thread.contextValue = review.resolved ? 'gitex-resolved' : 'gitex-open';
      thread.state = review.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      this.threadItems.set(thread, item);
    }
    for (const [key, thread] of this.nativeThreads) {
      if (!visible.has(key)) { thread.dispose(); this.nativeThreads.delete(key); }
    }
    this.items = next;
    this.changed.fire(undefined);
    const open = next.filter(item => !item.review.resolved).length;
    this.status.text = `$(comment-discussion) GiTex ${open}`;
    this.status.tooltip = 'Sync comments with the selected Git remote. Paper commits use Source Control.';
    if (this.repositories.size) { this.status.show(); } else { this.status.hide(); }
  }

  getChildren(): ThreadItem[] { return this.items; }
  getTreeItem(item: ThreadItem): vscode.TreeItem {
    const first = item.review.comments[0];
    const node = new vscode.TreeItem(first.body.split('\n')[0].slice(0, 100));
    node.id = item.key;
    node.description = `${item.review.anchor.path}:${item.location.kind === 'attached' ? item.location.startLine + 1 : '?'}${item.location.kind === 'outdated' ? ' · Outdated' : ''}`;
    node.tooltip = `${first.author.name}: ${first.body}\n${item.location.kind === 'outdated' ? item.location.reason : item.review.resolved ? 'Resolved' : 'Open'}`;
    node.iconPath = new vscode.ThemeIcon(item.location.kind === 'outdated' ? 'warning' : item.review.resolved ? 'pass' : 'comment-discussion');
    node.contextValue = item.review.resolved ? 'gitex-resolved' : 'gitex-open';
    node.command = { command: 'gitex.openThread', title: 'Open comment', arguments: [item] };
    return node;
  }

  private async anchor(repository: Repository, document: vscode.TextDocument, range: vscode.Range, inclusive = false) {
    await this.document(document.uri, repository);
    const relative = path.relative(repository.store.root, document.uri.fsPath).split(path.sep).join('/');
    if (!validPath(relative)) { throw new Error('This file cannot be annotated.'); }
    const end = !inclusive && range.end.line > range.start.line && range.end.character === 0 ? range.end.line - 1 : range.end.line;
    return createAnchor(relative, document.getText(), range.start.line, end, await repository.store.head());
  }

  private async addComment(body?: string): Promise<void> {
    await this.discover();
    const editor = vscode.window.activeTextEditor;
    if (!editor || !supported.test(editor.document.uri.fsPath)) { throw new Error('Select a passage in a .tex, .bib, .sty, .cls, or .ltx file.'); }
    const repository = this.repositoryFor(editor.document.uri);
    if (!repository) { throw new Error('Open this file inside a Git repository workspace.'); }
    // Capture before showing the input box so a changing editor selection cannot retarget the comment.
    const anchor = await this.anchor(repository, editor.document, editor.selection);
    body ??= await vscode.window.showInputBox({ prompt: 'Comment on the selected lines', placeHolder: 'Explain this change or leave a review…',
      validateInput: value => !value.trim() ? 'Enter a comment.' : value.length > 100_000 ? 'Comment is too long.' : undefined });
    if (body === undefined) { return; }
    const id = await repository.store.create(anchor, body);
    await this.refresh();
    const native = this.nativeThreads.get(`${repository.store.root}:${id}`);
    if (native) { native.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded; }
  }

  private async reply(reply: vscode.CommentReply): Promise<void> {
    if (!reply?.thread || !reply.text.trim()) { return; }
    const item = this.threadItems.get(reply.thread);
    if (item) { await item.repository.store.reply(item.review.id, reply.text); }
    else {
      const repository = this.repositoryFor(reply.thread.uri);
      if (!repository || !reply.thread.range) { throw new Error('Open this comment in its paper repository.'); }
      const document = await this.document(reply.thread.uri, repository);
      // Comment API ranges include their last line; unlike selections, column zero does not exclude it.
      const id = await repository.store.create(await this.anchor(repository, document, reply.thread.range, true), reply.text);
      this.nativeThreads.set(`${repository.store.root}:${id}`, reply.thread);
    }
    await this.refresh();
  }

  private async setResolved(target: ThreadItem | vscode.CommentThread, resolved: boolean): Promise<void> {
    const item = target && ('review' in target ? target : this.threadItems.get(target));
    if (!item) { return; }
    await item.repository.store.setResolved(item.review.id, resolved);
    await this.refresh();
  }

  private async open(item: ThreadItem): Promise<void> {
    // Recompute locations before navigation; the user may have edited since this tree item was created.
    await this.refresh();
    item = this.items.find(current => current.key === item.key) ?? item;
    if (item.location.kind === 'attached') {
      const selection = new vscode.Range(item.location.startLine, 0, item.location.endLine, 0);
      await vscode.window.showTextDocument(await this.document(item.uri, item.repository), { selection });
      const native = this.nativeThreads.get(item.key);
      if (native) { native.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded; }
    } else {
      const uri = vscode.Uri.from({ scheme: 'gitex-original', path: `/${item.review.id}/original.txt`, query: item.repository.store.root });
      this.excerpts.set(uri.toString(), [
        `GiTex — original excerpt from ${item.review.anchor.path}`,
        `Lines ${item.review.anchor.startLine + 1}–${item.review.anchor.endLine + 1} in the author's local document`,
        `Base commit: ${item.review.anchor.baseCommit ?? '(not committed yet)'}`,
        item.location.reason, '', ...item.review.anchor.selected, '', 'Comments:',
        ...item.review.comments.map(comment => `${comment.author.name} (${comment.at})\n${comment.body}\n`)
      ].join('\n'));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    }
  }

  private async connect(): Promise<void> {
    const repository = await this.chooseRepository();
    if (!repository) { return; }
    const remotes = (await repository.store.git.text(['remote'])).split('\n').filter(Boolean);
    const selected = await vscode.window.showQuickPick([...remotes.map(remote => ({ label: remote, remote })), { label: 'Add a remote…', remote: '' }],
      { placeHolder: 'Git remote for sharing paper comments' });
    if (!selected) { return; }
    let remote = selected.remote;
    if (!remote) {
      const name = await vscode.window.showInputBox({ prompt: 'Remote name', value: remotes.includes('origin') ? 'papers' : 'origin',
        validateInput: value => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || remotes.includes(value) ? 'Enter a new Git remote name.' : undefined });
      if (!name) { return; }
      const url = await vscode.window.showInputBox({ prompt: 'Repository SSH/HTTPS URL or local bare repository path', ignoreFocusOut: true,
        validateInput: value => !value.trim() || value.startsWith('-') || /[\r\n\0]/.test(value) ? 'Enter a valid Git repository address.' : undefined });
      if (!url) { return; }
      await repository.store.git.text(['remote', 'add', name, url.trim()]);
      remote = name;
    }
    await vscode.workspace.getConfiguration('gitex', repository.folder.uri).update('remote', remote, vscode.ConfigurationTarget.WorkspaceFolder);
    void vscode.window.showInformationMessage(`GiTex connected to ${remote}. Use Sync Comments to share reviews.`);
  }

  private async sync(): Promise<void> {
    const repository = await this.chooseRepository();
    if (!repository) { return; }
    const remote = vscode.workspace.getConfiguration('gitex', repository.folder.uri).get('remote', 'origin');
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `GiTex: Syncing comments with ${remote}…` },
      () => repository.store.sync(remote));
    await this.refresh();
    void vscode.window.showInformationMessage('GiTex comments synced. Use Source Control to commit and sync the paper.');
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.controller.dispose(); this.changed.dispose(); this.output.dispose(); this.status.dispose();
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const app = new GiTex(context);
  try { await app.refresh(); }
  catch (error) { void vscode.window.showErrorMessage(`GiTex: ${redact(error instanceof Error ? error.message : String(error))}`); }
  return app;
}
