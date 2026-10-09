import * as vscode from 'vscode';
import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import { Anchor, createAnchor, locateAnchor, Location } from './anchor';
import { redact } from './git';
import { ReviewComment, ReviewThread, validPath } from './model';
import { ReviewStore } from './store';
import { ReviewAction, ReviewPanel } from './reviewPanel';
import { checkImportTarget, importRepository } from './importRepository';
import { discoverRepositories, findRepository, repositoryContaining, within } from './repositories';

interface Repository { store: ReviewStore; folder: vscode.WorkspaceFolder }
interface ThreadItem { key: string; repository: Repository; review: ReviewThread; uri: vscode.Uri; location: Location }
interface NativeReviewComment extends vscode.Comment {
  commentId: string;
  threadKey: string;
  revisionId: string;
  editingRevision?: string;
}
const supported = /\.(tex|bib|sty|cls|ltx)$/i;

class GiTex implements vscode.Disposable, vscode.TreeDataProvider<ThreadItem> {
  private readonly controller = vscode.comments.createCommentController('gitex', 'GiTex');
  private readonly changed = new vscode.EventEmitter<ThreadItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly output = vscode.window.createOutputChannel('GiTex');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  private readonly repositories = new Map<string, Repository>();
  private readonly dirtyRepositories = new Set<string>();
  private readonly nativeThreads = new Map<string, vscode.CommentThread>();
  private readonly threadItems = new WeakMap<vscode.CommentThread, ThreadItem>();
  private readonly nativeComments = new Map<string, NativeReviewComment>();
  private readonly panels = new Map<string, ReviewPanel>();
  private readonly syncs = new Map<string, Promise<void>>();
  private readonly syncErrors = new Map<string, string>();
  private readonly excerpts = new Map<string, string>();
  private readonly excerptSources = new Map<string, vscode.Uri>();
  private readonly tree: vscode.TreeView<ThreadItem>;
  private readonly locations = new WeakMap<vscode.TextDocument, { version: number; entries: Map<string, { reference: string; location: Location }> }>();
  private items: ThreadItem[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing: Promise<void> = Promise.resolve();
  private disposed = false;
  private lastEditor = vscode.window.activeTextEditor;
  private contextUri = vscode.window.activeTextEditor?.document.uri.scheme === 'file' ? vscode.window.activeTextEditor.document.uri : undefined;
  private activeRoot?: string;
  private discoveryVersion = 0;
  private scannedVersion = -1;
  private ownerDirty = true;
  private discovery?: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status.command = 'gitex.sync';
    this.controller.options = { prompt: 'Review this passage', placeHolder: 'Comment or explain your change…' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: document => this.repositoryFor(document.uri) && supported.test(document.uri.fsPath)
        ? [new vscode.Range(0, 0, document.lineCount - 1, 0)] : []
    };
    const tree = this.tree = vscode.window.createTreeView('gitex.comments', { treeDataProvider: this, manageCheckboxStateManually: true });
    context.subscriptions.push(this, tree, tree.onDidChangeCheckboxState(event => {
      void this.checkResolved(event.items).catch(error => { this.report(error); this.changed.fire(undefined); });
    }),
      vscode.workspace.registerTextDocumentContentProvider('gitex-original', { provideTextDocumentContent: uri => this.excerpts.get(uri.toString()) ?? '' }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidateRepositories()),
      vscode.workspace.onDidOpenTextDocument(document => { if (document.uri.scheme === 'file') { this.schedule(); } }),
      vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length && supported.test(event.document.uri.fsPath)) { this.schedule(); } }),
      vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
      vscode.window.onDidChangeActiveTextEditor(editor => this.selectEditor(editor)),
      vscode.window.onDidChangeWindowState(event => { if (event.focused) { this.schedule(); } }),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('gitex')) { this.schedule(); } })
    );
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{tex,bib,sty,cls,ltx}');
    context.subscriptions.push(watcher, watcher.onDidChange(() => this.schedule()), watcher.onDidCreate(() => this.schedule()), watcher.onDidDelete(() => this.schedule()));
    const repositories = vscode.workspace.createFileSystemWatcher('**/.git');
    context.subscriptions.push(repositories, repositories.onDidCreate(() => this.invalidateRepositories()),
      repositories.onDidDelete(() => this.invalidateRepositories()), repositories.onDidChange(() => this.invalidateRepositories()));
    this.command('gitex.clone', () => vscode.commands.executeCommand('git.clone'));
    this.command('gitex.applyRepository', () => this.applyRepository());
    this.command('gitex.connect', () => this.connect());
    this.command('gitex.addComment', (body?: string) => this.addComment(typeof body === 'string' ? body : undefined));
    this.command('gitex.reply', (reply: vscode.CommentReply) => this.reply(reply));
    this.command('gitex.resolve', (target: ThreadItem | vscode.CommentThread) => this.setResolved(target, true));
    this.command('gitex.reopen', (target: ThreadItem | vscode.CommentThread) => this.setResolved(target, false));
    this.command('gitex.openThread', (item: ThreadItem) => this.open(item));
    this.command('gitex.reviewThread', (target: ThreadItem | vscode.CommentThread) => this.reviewThread(target));
    this.command('gitex.editComment', (comment: NativeReviewComment) => this.editComment(comment));
    this.command('gitex.saveComment', (comment: NativeReviewComment) => this.saveComment(comment));
    this.command('gitex.cancelEdit', (comment: NativeReviewComment) => this.cancelEdit(comment));
    this.command('gitex.commentHistory', (comment: NativeReviewComment) => this.commentHistory(comment));
    this.command('gitex.moveComment', (target?: ThreadItem | vscode.CommentThread) => this.moveComment(target));
    this.command('gitex.refresh', () => { this.invalidateRepositories(); return this.refresh(); });
    this.command('gitex.pull', () => this.pull());
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

  private schedule(delay = 350): void {
    if (this.disposed) { return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.refresh().catch(error => this.report(error)); }, delay);
  }

  private invalidateRepositories(): void {
    this.discoveryVersion++; this.ownerDirty = true; this.schedule();
  }

  private selectEditor(editor: vscode.TextEditor | undefined): void {
    if (!editor) { return; } // Explorer/webview focus retains the selected source repository.
    const uri = editor.document.uri;
    if (uri.scheme === 'file') { this.lastEditor = editor; }
    const source = uri.scheme === 'file' ? uri : this.excerptSources.get(uri.toString());
    if (!source) { return; } // VS Code also uses text editors for its virtual comment inputs.
    this.contextUri = source; this.ownerDirty = true;
    // Native comment focus can fire this event again for the same file. Keep its widgets
    // alive while verifying ownership so an in-flight save still updates the same objects.
    if (this.repositoryFor(source)?.store.root !== this.activeRoot) {
      this.activeRoot = undefined; this.changed.fire(undefined); this.status.hide();
    }
    this.schedule(0);
  }

  refresh(repository?: Repository): Promise<void> {
    if (repository) { this.dirtyRepositories.add(repository.store.root); }
    this.refreshing = this.refreshing.catch(() => undefined).then(() => this.refreshNow());
    return this.refreshing;
  }

  private async discover(checkActive = false): Promise<void> {
    if (checkActive) {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.uri.scheme === 'file' && editor.document.uri.toString() !== this.contextUri?.toString()) { this.selectEditor(editor); }
      this.ownerDirty = true;
    }
    if (!this.discovery) {
      this.discovery = this.discoverNow().finally(() => { this.discovery = undefined; });
    }
    await this.discovery;
    if (this.scannedVersion !== this.discoveryVersion || this.ownerDirty) { await this.discover(); }
  }

  private async discoverNow(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
    const folderFor = (root: string) => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root)) ??
      folders.find(folder => within(root, folder.uri.fsPath));
    const register = (root: string) => {
      const folder = folderFor(root);
      if (!folder) { return; }
      const repository = this.repositories.get(root) ?? { store: new ReviewStore(root), folder };
      repository.folder = folder; this.repositories.set(root, repository);
    };
    if (this.scannedVersion !== this.discoveryVersion) {
      const version = this.discoveryVersion;
      const roots = new Set(await discoverRepositories(folders.map(folder => folder.uri.fsPath)));
      for (const root of roots) { register(root); }
      for (const root of this.repositories.keys()) { if (!roots.has(root)) { this.repositories.delete(root); } }
      this.scannedVersion = version; this.ownerDirty = true;
    }
    if (!this.ownerDirty) { return; }
    this.ownerDirty = false;
    const uri = this.contextUri;
    if (uri) {
      // A cheap Git probe on file switches catches newly cloned/nested repositories even if a watcher missed them.
      const root = uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri) ? await findRepository(path.dirname(uri.fsPath)) : undefined;
      if (root) {
        register(root);
        // A removed nested .git must not keep claiming this file through the cached root list.
        for (const previous of this.repositories.keys()) {
          if (previous !== root && within(root, previous) && within(previous, uri.fsPath)) { this.repositories.delete(previous); }
        }
      }
      if (this.contextUri === uri) { this.activeRoot = root && this.repositories.has(root) ? root : undefined; }
    } else if (!this.activeRoot || !this.repositories.has(this.activeRoot)) {
      this.activeRoot = this.repositories.size === 1 ? this.repositories.keys().next().value : undefined;
    }
  }

  private repositoryFor(uri: vscode.Uri): Repository | undefined {
    if (uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri)) { return undefined; }
    const root = repositoryContaining(this.repositories.keys(), uri.fsPath);
    return root ? this.repositories.get(root) : undefined;
  }

  private async chooseRepository(): Promise<Repository | undefined> {
    await this.discover(true);
    const current = this.activeRoot && this.repositories.get(this.activeRoot);
    if (current) { return current; }
    if (this.contextUri) { throw new Error('The selected file is not in a Git working repository in this workspace. Select a paper file first.'); }
    const repositories = [...this.repositories.values()];
    if (!repositories.length) { throw new Error('Open a local Git repository, or run GiTex: Clone Repository / Apply Repository to Current Folder first.'); }
    if (repositories.length === 1) { return repositories[0]; }
    const selected = (await vscode.window.showQuickPick(repositories.map(repository => ({ label: this.repositoryLabel(repository), description: repository.store.root, repository })),
      { placeHolder: 'Select a paper repository' }))?.repository;
    if (selected) { this.activeRoot = selected.store.root; }
    return selected;
  }

  private repositoryLabel(repository: Repository): string {
    const relative = path.relative(repository.folder.uri.fsPath, repository.store.root);
    return relative && within(repository.folder.uri.fsPath, repository.store.root) ? `${repository.folder.name}/${relative.split(path.sep).join('/')}` : path.basename(repository.store.root);
  }

  private async document(uri: vscode.Uri, repository: Repository): Promise<vscode.TextDocument> {
    const canonical = await realpath(uri.fsPath);
    if (!within(await realpath(repository.store.root), canonical)) { throw new Error('The file resolves outside this repository.'); }
    if (await findRepository(path.dirname(canonical)) !== repository.store.root) { throw new Error('The file belongs to another Git repository.'); }
    return vscode.workspace.openTextDocument(uri);
  }

  private async refreshNow(): Promise<void> {
    if (this.disposed) { return; }
    await this.discover();
    const next: ThreadItem[] = [];
    // Retain inactive snapshots for drafts/pending actions without reading every repository
    // again on each keystroke. Refresh the selected/open review and stores changed by actions.
    const loaded = new Set(this.dirtyRepositories);
    if (this.activeRoot) { loaded.add(this.activeRoot); }
    for (const key of this.panels.keys()) {
      const item = this.items.find(item => item.key === key);
      if (item) { loaded.add(item.repository.store.root); }
    }
    const documents = new Map<string, Promise<vscode.TextDocument>>();
    for (const repository of this.repositories.values()) {
      const previous = this.items.filter(item => item.repository.store.root === repository.store.root);
      if (!loaded.has(repository.store.root)) { next.push(...previous); continue; }
      this.dirtyRepositories.delete(repository.store.root);
      let reviews: ReviewThread[];
      try { reviews = await repository.store.threads(); }
      catch (error) {
        if (repository.store.root === this.activeRoot) { throw error; }
        this.output.appendLine(`Unable to refresh ${repository.store.root}: ${redact(String(error))}`);
        next.push(...previous); continue;
      }
      for (const review of reviews) {
        const uri = vscode.Uri.file(path.join(repository.store.root, review.anchor.path));
        let location: Location;
        try {
          const documentKey = `${repository.store.root}:${uri.toString()}`;
          if (!documents.has(documentKey)) { documents.set(documentKey, this.document(uri, repository)); }
          const document = await documents.get(documentKey)!;
          let cached = this.locations.get(document);
          if (!cached || cached.version !== document.version) {
            cached = { version: document.version, entries: new Map() }; this.locations.set(document, cached);
          }
          const reference = review.anchorRevision;
          const previous = cached.entries.get(review.id);
          location = previous?.reference === reference ? previous.location : locateAnchor(review.anchor, document.getText());
          cached.entries.set(review.id, { reference, location });
        } catch { location = { kind: 'outdated', reason: 'The original file is missing, moved, or unavailable.' }; }
        next.push({ key: `${repository.store.root}:${review.id}`, repository, review, uri, location });
      }
    }
    if (this.disposed) { return; }
    const visible = new Set<string>();
    for (const item of next) {
      const { review, location } = item;
      if (item.repository.store.root !== this.activeRoot) { continue; }
      if (location.kind !== 'attached') { continue; }
      if (review.resolved) { continue; }
      visible.add(item.key);
      const range = new vscode.Range(location.startLine, 0, location.endLine, 0);
      let thread = this.nativeThreads.get(item.key);
      if (thread && thread.uri.toString() !== item.uri.toString()) {
        if (thread.comments.some(comment => comment.mode === vscode.CommentMode.Editing)) {
          thread.label = 'GiTex · Location changed · draft preserved';
          this.threadItems.set(thread, item);
          continue;
        }
        thread.dispose(); this.nativeThreads.delete(item.key); thread = undefined;
      }
      if (!thread) {
        thread = this.controller.createCommentThread(item.uri, range, []);
        this.nativeThreads.set(item.key, thread);
      }
      thread.range = range;
      // Plain text avoids loading images or executing links supplied in shared comments.
      thread.comments = review.comments.map(comment => this.nativeComment(item, comment));
      thread.label = location.similarity === undefined ? 'GiTex' : `GiTex · Similar text (${Math.round(location.similarity * 100)}%)`;
      thread.contextValue = review.resolved ? 'gitex-resolved' : 'gitex-open';
      thread.state = review.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      this.threadItems.set(thread, item);
    }
    for (const [key, thread] of this.nativeThreads) {
      if (!visible.has(key)) {
        const item = next.find(item => item.key === key);
        if (item && item.repository.store.root === this.activeRoot && !item.review.resolved && thread.comments.some(comment => comment.mode === vscode.CommentMode.Editing)) { thread.label = 'GiTex · Draft preserved'; }
        else { thread.dispose(); this.nativeThreads.delete(key); }
      }
    }
    this.items = next;
    this.renderPanels();
    this.changed.fire(undefined);
    const repository = this.activeRoot ? this.repositories.get(this.activeRoot) : undefined;
    this.tree.description = repository ? this.repositoryLabel(repository) : undefined;
    this.tree.message = repository ? undefined : 'Open a paper file to select its Git repository. Repositories in subfolders are discovered automatically.';
    const open = this.getChildren().filter(item => !item.review.resolved).length;
    const failed = !!this.activeRoot && this.syncErrors.has(this.activeRoot);
    this.status.text = failed ? '$(warning) GiTex · Sync pending' : `$(comment-discussion) GiTex ${open}`;
    this.status.tooltip = `${repository?.store.root ?? ''}\n${failed ? 'Comment saved locally; auto sync failed. Click to retry.' :
      'Sync comments with this repository’s Git remote. Paper commits use Source Control.'}`;
    if (repository) { this.status.show(); } else { this.status.hide(); }
  }

  getChildren(): ThreadItem[] { return this.items.filter(item => item.repository.store.root === this.activeRoot); }
  getTreeItem(item: ThreadItem): vscode.TreeItem {
    const first = item.review.comments[0];
    const node = new vscode.TreeItem(first.body.split('\n')[0].slice(0, 100));
    node.id = item.key;
    node.description = `${item.review.anchor.path}:${item.location.kind === 'attached' ? item.location.startLine + 1 : '?'}${item.review.resolved ? ' · Resolved' : ''}${item.location.kind === 'outdated' ? ' · Outdated' : item.location.similarity !== undefined ? ' · Similar text' : ''}`;
    node.tooltip = `${first.author.name}: ${first.body}\n${item.location.kind === 'outdated' ? item.location.reason : item.review.resolved ? 'Resolved' : 'Open'}`;
    node.iconPath = new vscode.ThemeIcon(item.location.kind === 'outdated' ? 'warning' : item.review.resolved ? 'pass' : 'comment-discussion');
    node.contextValue = item.review.resolved ? 'gitex-resolved' : 'gitex-open';
    node.checkboxState = { state: item.review.resolved ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: item.review.resolved ? 'Reopen: show in the paper editor' : 'Resolve: hide from the paper editor',
      accessibilityInformation: { label: 'Resolved', role: 'checkbox' } };
    node.command = { command: 'gitex.reviewThread', title: 'Open review', arguments: [item] };
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
    await this.discover(true);
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
    await this.afterSave(repository);
    const native = this.nativeThreads.get(`${repository.store.root}:${id}`);
    if (native) { native.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded; }
  }

  private async currentAnchor(item: ThreadItem): Promise<{ anchor: Anchor; basedOn: string } | undefined> {
    const review = (await item.repository.store.threads()).find(review => review.id === item.review.id);
    if (!review) { return undefined; }
    const head = await item.repository.store.head();
    let document: vscode.TextDocument;
    try { document = await this.document(vscode.Uri.file(path.join(item.repository.store.root, review.anchor.path)), item.repository); } catch { return undefined; }
    const text = document.getText();
    const location = locateAnchor(review.anchor, text);
    if (location.kind !== 'attached') { return undefined; }
    return { anchor: createAnchor(review.anchor.path, text, location.startLine, location.endLine, head), basedOn: review.anchorRevision };
  }

  private async reply(reply: vscode.CommentReply): Promise<void> {
    if (!reply?.thread || !reply.text.trim()) { return; }
    const item = this.threadItems.get(reply.thread);
    let repository = item?.repository;
    if (item) {
      const reference = await this.currentAnchor(item);
      await item.repository.store.reply(item.review.id, reply.text, reference?.anchor, reference?.basedOn);
    }
    else {
      await this.discover(true);
      repository = this.repositoryFor(reply.thread.uri);
      if (!repository || !reply.thread.range) { throw new Error('Open this comment in its paper repository.'); }
      const document = await this.document(reply.thread.uri, repository);
      // Comment API ranges include their last line; unlike selections, column zero does not exclude it.
      const id = await repository.store.create(await this.anchor(repository, document, reply.thread.range, true), reply.text);
      this.nativeThreads.set(`${repository.store.root}:${id}`, reply.thread);
    }
    await this.afterSave(repository!);
  }

  private async setResolved(target: ThreadItem | vscode.CommentThread, resolved: boolean): Promise<void> {
    const item = target && ('review' in target ? target : this.threadItems.get(target));
    if (!item) { return; }
    await item.repository.store.setResolved(item.review.id, resolved);
    await this.refresh(item.repository);
  }

  private async checkResolved(items: readonly [ThreadItem, vscode.TreeItemCheckboxState][]): Promise<void> {
    for (const [item, state] of items) { await this.setResolved(item, state === vscode.TreeItemCheckboxState.Checked); }
  }

  private async moveComment(target?: ThreadItem | vscode.CommentThread): Promise<void> {
    const editor = vscode.window.activeTextEditor ?? this.lastEditor;
    if (!editor || !vscode.window.visibleTextEditors.includes(editor) || editor.document.uri.scheme !== 'file' || !supported.test(editor.document.uri.fsPath)) {
      throw new Error('Select the destination lines in a visible LaTeX source editor, then move the comment to that selection.');
    }
    const document = editor.document;
    const version = document.version;
    const text = document.getText();
    const selection = editor.selection;
    await this.discover(true);
    const repository = this.repositoryFor(document.uri);
    if (!repository) { throw new Error('The destination must be in the same open Git repository as the comment.'); }
    const targetItem = target && ('review' in target ? target : this.threadItems.get(target));
    if (targetItem && targetItem.repository.store.root !== repository.store.root) { throw new Error('Comments can only move within the same Git repository.'); }
    await this.document(document.uri, repository);
    const relative = path.relative(repository.store.root, document.uri.fsPath).split(path.sep).join('/');
    if (!validPath(relative)) { throw new Error('This destination cannot be annotated.'); }
    const end = selection.end.line > selection.start.line && selection.end.character === 0 ? selection.end.line - 1 : selection.end.line;
    const anchor = createAnchor(relative, text, selection.start.line, end, await repository.store.head());
    const reviews = await repository.store.threads();
    const review = targetItem ? reviews.find(review => review.id === targetItem.review.id) :
      (await vscode.window.showQuickPick(reviews.map(review => ({ label: review.comments[0].body.split('\n')[0].slice(0, 100),
        description: `${review.anchor.path}:${review.anchor.startLine + 1}–${review.anchor.endLine + 1}${review.resolved ? ' · Resolved' : ''}`, review })),
        { placeHolder: `Move a comment to ${relative}:${anchor.startLine + 1}–${anchor.endLine + 1}` }))?.review;
    if (!review) { if (targetItem) { throw new Error('This comment is no longer available. Refresh comments.'); } return; }
    if (document.isClosed || document.version !== version) { throw new Error('The destination text changed while choosing a comment. Select the destination again.'); }
    const key = `${repository.store.root}:${review.id}`;
    if ([...this.nativeComments.values()].some(comment => comment.threadKey === key && comment.mode === vscode.CommentMode.Editing)) {
      throw new Error('Save or cancel the inline comment edit before moving this thread. Its draft has been preserved.');
    }
    await repository.store.move(review.id, anchor, review.anchorRevision);
    await this.afterSave(repository);
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
      const uri = vscode.Uri.from({ scheme: 'gitex-original', path: `/${item.review.id}/original.txt`,
        query: `${item.repository.store.root}:${item.review.comments.map(comment => comment.revisions.at(-1)!.id).join(',')}` });
      this.excerpts.set(uri.toString(), [
        `GiTex — saved tracking excerpt from ${item.review.anchor.path}`,
        `Lines ${item.review.anchor.startLine + 1}–${item.review.anchor.endLine + 1} in the author's local document`,
        `Base commit: ${item.review.anchor.baseCommit ?? '(not committed yet)'}`,
        item.location.reason, '', ...item.review.anchor.selected, '', 'Comments:',
        ...item.review.comments.map(comment => `${comment.author.name} (${comment.at})\n${comment.body}\n`)
      ].join('\n'));
      this.excerptSources.set(uri.toString(), item.uri);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    }
  }

  private nativeComment(item: ThreadItem, comment: ReviewComment): NativeReviewComment {
    const key = `${item.key}:${comment.id}`;
    const latest = comment.revisions.at(-1)!;
    let native = this.nativeComments.get(key);
    if (!native) {
      native = { commentId: comment.id, threadKey: item.key, revisionId: latest.id, body: '',
        mode: vscode.CommentMode.Preview, author: { name: comment.author.name } };
      this.nativeComments.set(key, native);
    }
    native.revisionId = latest.id;
    native.contextValue = 'gitex-comment';
    native.timestamp = new Date(comment.at);
    native.label = native.editingRevision && native.editingRevision !== latest.id ? 'Changed remotely · draft preserved' :
      comment.revisions.length > 1 ? `Edited by ${latest.author.name}` : undefined;
    if (native.mode !== vscode.CommentMode.Editing) { native.body = new vscode.MarkdownString().appendText(comment.body); }
    return native;
  }

  private async commentTarget(native: NativeReviewComment): Promise<{ item: ThreadItem; comment: ReviewComment }> {
    const item = this.items.find(item => item.key === native.threadKey);
    if (!item) { throw new Error('Open the comment from GiTex Comments again.'); }
    const review = (await item.repository.store.threads()).find(thread => thread.id === item.review.id);
    const comment = review?.comments.find(comment => comment.id === native.commentId);
    if (!comment) { throw new Error('The comment is unavailable. Refresh comments and try again.'); }
    return { item, comment };
  }

  private async editComment(native: NativeReviewComment): Promise<void> {
    if (!native || native.mode === vscode.CommentMode.Editing) { return; }
    const { comment } = await this.commentTarget(native);
    native.editingRevision = comment.revisions.at(-1)!.id;
    native.body = comment.body;
    native.mode = vscode.CommentMode.Editing;
    await this.refresh();
  }

  private async saveComment(native: NativeReviewComment): Promise<void> {
    if (!native?.editingRevision) { return; }
    const body = typeof native.body === 'string' ? native.body : native.body.value;
    const basedOn = native.editingRevision;
    const { item } = await this.commentTarget(native);
    try {
      const reference = await this.currentAnchor(item);
      await item.repository.store.edit(item.review.id, native.commentId, body, basedOn, reference?.anchor, reference?.basedOn);
    }
    catch (error) {
      // VS Code closes the inline input as soon as Save is clicked, before async validation finishes.
      // Restore the saved preview and retain the rejected draft in the review panel's editor.
      native.mode = vscode.CommentMode.Preview;
      native.editingRevision = undefined;
      await this.refresh();
      await this.reviewThread(item);
      this.panels.get(item.key)?.preserveDraft(native.commentId, body, basedOn);
      throw error;
    }
    native.mode = vscode.CommentMode.Preview;
    native.editingRevision = undefined;
    await this.afterSave(item.repository);
  }

  private async cancelEdit(native: NativeReviewComment): Promise<void> {
    if (!native) { return; }
    await this.commentTarget(native);
    native.mode = vscode.CommentMode.Preview;
    native.editingRevision = undefined;
    await this.refresh();
  }

  private async commentHistory(native: NativeReviewComment): Promise<void> {
    const { item, comment } = await this.commentTarget(native);
    const uri = vscode.Uri.from({ scheme: 'gitex-original', path: `/${comment.id}/history.txt`,
      query: `${item.repository.store.root}:${comment.revisions.map(revision => revision.id).join(',')}` });
    this.excerpts.set(uri.toString(), [`GiTex — comment history (${item.review.anchor.path})`,
      'Versions are ordered by logical clock and event ID. Concurrent edits are retained.', '',
      ...comment.revisions.flatMap((revision, index) => [
        `${index === 0 ? 'Original' : `Edit ${index}`}${index === comment.revisions.length - 1 ? ' — currently displayed' : ''}`,
        `${revision.author.name} <${revision.author.email}> · ${revision.at}`,
        `Revision: ${revision.id}${revision.basedOn ? `\nBased on: ${revision.basedOn}` : ''}`, '', revision.body, '', '---', ''
      ])].join('\n'));
    this.excerptSources.set(uri.toString(), item.uri);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
  }

  private autoSyncEnabled(repository: Repository): boolean {
    const config = vscode.workspace.getConfiguration('gitex', repository.folder.uri);
    const setting = config.inspect<boolean>('autoSyncOnSave');
    const explicit = setting?.workspaceFolderValue ?? setting?.workspaceValue ?? setting?.globalValue;
    return explicit ?? config.get<boolean>('autoPullOnInteraction', true);
  }

  private async afterSave(repository: Repository): Promise<void> {
    await this.refresh(repository);
    // A saved comment is immediately usable; network latency must not keep the editor open.
    if (this.disposed || !this.autoSyncEnabled(repository)) { return; }
    const remote = vscode.workspace.getConfiguration('gitex', repository.folder.uri).get('remote', 'origin');
    const key = `${repository.store.root}:${remote}`;
    const previous = this.syncs.get(key) ?? Promise.resolve();
    const operation = previous.then(async () => {
      try {
        await repository.store.sync(remote);
        this.syncErrors.delete(repository.store.root);
        await this.refresh(repository);
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        this.output.appendLine(`${new Date().toISOString()} Auto sync: ${message}`);
        this.syncErrors.set(repository.store.root, 'Auto sync failed. Your comment is saved locally. Use Sync Comments to retry. See GiTex Output for details.');
        // A fetch may have succeeded before a push failed. Display any received changes too.
        try { await this.refresh(repository); } catch { this.renderPanels(); }
        if (this.activeRoot === repository.store.root) {
          this.status.text = '$(warning) GiTex · Sync pending';
          this.status.tooltip = 'Comment saved locally; auto sync failed. Click to retry.';
        }
      }
    }).finally(() => { if (this.syncs.get(key) === operation) { this.syncs.delete(key); } });
    this.syncs.set(key, operation);
  }

  private async reviewThread(target: ThreadItem | vscode.CommentThread): Promise<void> {
    const item = target && ('review' in target ? target : this.threadItems.get(target));
    if (!item) { return; }
    let panel = this.panels.values().next().value as ReviewPanel | undefined;
    if (!panel) {
      panel = new ReviewPanel(this.context.extensionUri, item.key, async (key, action) => {
        const current = this.items.find(candidate => candidate.key === key);
        if (!current) { throw new Error('This comment is no longer available in the open workspace. Your draft is preserved.'); }
        await this.panelAction(current, action);
      }, () => this.panels.clear());
    } else { panel.key = item.key; panel.panel.reveal(); }
    this.panels.clear();
    this.panels.set(item.key, panel);
    this.renderPanels();
    // Resolved inline widgets are removed, but their drafts remain recoverable in the shared review tab.
    if (!this.nativeThreads.has(item.key)) {
      for (const native of this.nativeComments.values()) {
        if (native.threadKey !== item.key || native.mode !== vscode.CommentMode.Editing || !native.editingRevision) { continue; }
        panel.preserveDraft(native.commentId, typeof native.body === 'string' ? native.body : native.body.value, native.editingRevision);
        native.mode = vscode.CommentMode.Preview; native.editingRevision = undefined;
      }
    }
  }

  private async panelAction(item: ThreadItem, action: ReviewAction): Promise<void> {
    if (action.type === 'ready') { this.renderPanels(); return; }
    if (action.type === 'edit' || action.type === 'reply') {
      const reference = await this.currentAnchor(item);
      if (action.type === 'edit') { await item.repository.store.edit(item.review.id, action.commentId, action.body, action.basedOn, reference?.anchor, reference?.basedOn); }
      else { await item.repository.store.reply(item.review.id, action.body, reference?.anchor, reference?.basedOn); }
    }
    else if (action.type === 'move') { await this.moveComment(item); return; }
    else if (action.type === 'resolve') { await this.setResolved(item, action.resolved); return; }
    else if (action.type === 'source') { await this.open(item); return; }
    await this.afterSave(item.repository);
  }

  private renderPanels(): void {
    if (this.disposed) { return; }
    for (const [key, panel] of this.panels) {
      const item = this.items.find(item => item.key === key);
      if (!item) { continue; }
      const automatic = this.autoSyncEnabled(item.repository);
      const status = this.syncErrors.get(item.repository.store.root) ||
        (automatic ? 'Auto sync after saving is enabled. Saved comments are fetched and pushed in the background.' :
          'Auto sync after saving is disabled. Edits are saved locally; use Sync Comments to publish them.');
      panel.update(item.review, { repository: this.repositoryLabel(item.repository), location: item.location,
        sync: this.syncErrors.has(item.repository.store.root) ? 'failed' : automatic ? 'automatic' : 'manual', status });
    }
  }

  private async pull(): Promise<void> {
    const repository = await this.chooseRepository();
    if (!repository) { return; }
    const remote = vscode.workspace.getConfiguration('gitex', repository.folder.uri).get('remote', 'origin');
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `GiTex: Fetching comments from ${remote}…` },
      () => repository.store.pull(remote));
    await this.refresh(repository);
  }

  private async applyRepository(address?: string, folder?: vscode.WorkspaceFolder): Promise<void> {
    const folders = vscode.workspace.workspaceFolders?.filter(candidate => candidate.uri.scheme === 'file') ?? [];
    if (!folders.length) { throw new Error('Open a local folder before applying a repository.'); }
    const active = vscode.window.activeTextEditor?.document.uri;
    folder ??= active?.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    folder ??= folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder to receive the repository' });
    if (!folder) { return; }
    if (folder.uri.scheme !== 'file') { throw new Error('Select a local folder.'); }
    const root = folder.uri.fsPath;
    const checkEditors = () => {
      if (vscode.workspace.textDocuments.some(document => document.isDirty && within(root, document.uri.fsPath))) {
        throw new Error('Save or revert unsaved files in this folder before applying a repository.');
      }
    };
    checkEditors();
    await checkImportTarget(root);
    address ??= await vscode.window.showInputBox({ prompt: `Repository SSH/HTTPS URL or local bare repository path to apply to ${folder.name}`,
      ignoreFocusOut: true, validateInput: value => !value.trim() || value.trim().startsWith('-') || /[\r\n\0]/.test(value) ? 'Enter a valid Git repository address.' : undefined });
    if (!address) { return; }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'GiTex: Checking and applying repository…' },
      () => importRepository(root, address!, checkEditors));
    this.invalidateRepositories();
    await this.refresh();
    void vscode.window.showInformationMessage(`Repository applied to ${folder.name}. The default branch and origin are ready. Use Fetch Comments to receive existing reviews.`);
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
    this.syncErrors.delete(repository.store.root);
    await this.refresh(repository);
    void vscode.window.showInformationMessage('GiTex comments synced. Use Source Control to commit and sync the paper.');
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const panel of this.panels.values()) { panel.dispose(); }
    this.controller.dispose(); this.changed.dispose(); this.output.dispose(); this.status.dispose();
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const app = new GiTex(context);
  try { await app.refresh(); }
  catch (error) { void vscode.window.showErrorMessage(`GiTex: ${redact(error instanceof Error ? error.message : String(error))}`); }
  return app;
}
