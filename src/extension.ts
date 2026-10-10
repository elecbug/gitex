import { SnapshotPublication } from './snapshotPrivacy';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { Anchor, createSelectionAnchor, documentHash, EstimateCandidate, Location, locationEstimates } from './anchor';
import { EditTracking, enableEditTracking, normalizedText, positionAt } from './editTracking';
import { redact } from './git';
import { Author, sameAuthor, ReviewComment, ReviewThread, reviewAtCommit, validPath } from './model';
import { CommitHints, ReviewStore, SyncResult } from './store';
import { ReviewAction, ReviewPanel } from './reviewPanel';
import { checkImportTarget, importRepository } from './importRepository';
import { discoverRepositories, findRepository, repositoryContaining, within } from './repositories';

interface Repository { store: ReviewStore; folder: vscode.WorkspaceFolder }
class SnapshotSharingPending extends Error {}
interface ThreadItem { reviewNotice?: string; notInherited?: boolean; key: string; repository: Repository; review: ReviewThread; uri: vscode.Uri; location: Location; paperCommit?: string | null }
interface NativeReviewComment extends vscode.Comment {
  commentId: string;
  threadKey: string;
  revisionId: string;
  editingRevision?: string;
  editingConflicts?: string[];
  editingPaperCommit?: string | null;
}
const supported = /\.(tex|bib|sty|cls|ltx)$/i;

class GiTex implements vscode.Disposable, vscode.TreeDataProvider<ThreadItem> {
  private readonly controller = vscode.comments.createCommentController('gitex', 'GiTex');
  private readonly changed = new vscode.EventEmitter<ThreadItem | undefined>();
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly output = vscode.window.createOutputChannel('GiTex');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  private readonly uncertainDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, borderStyle: 'dashed', borderWidth: '0 0 1px 0',
    borderColor: new vscode.ThemeColor('descriptionForeground')
  });
  private readonly commentDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('gitex.commentBackground'),
    border: '1px solid', borderColor: new vscode.ThemeColor('gitex.commentBorder'),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  private readonly insertionDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('gitex.insertedBackground'),
    border: '1px dashed', borderColor: new vscode.ThemeColor('gitex.insertedBorder'),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  private readonly repositories = new Map<string, Repository>();
  private readonly dirtyRepositories = new Set<string>();
  private readonly nativeThreads = new Map<string, vscode.CommentThread>();
  private readonly threadItems = new WeakMap<vscode.CommentThread, ThreadItem>();
  private readonly authors = new Map<string, Author>();
  private readonly nativeComments = new Map<string, NativeReviewComment>();
  private readonly panels = new Map<string, ReviewPanel>();
  private readonly syncs = new Map<string, Promise<void>>();
  private readonly syncErrors = new Map<string, string>();
  private readonly excerpts = new Map<string, string>();
  private readonly excerptSources = new Map<string, vscode.Uri>();
  private readonly tree: vscode.TreeView<ThreadItem>;
  private readonly editTracking: EditTracking;
  private readonly documentProofs = new Map<string, Promise<boolean>>();
  private readonly bufferHeads = new WeakMap<vscode.TextDocument, string | null>();
  private readonly watchedRoots = new Set<string>();
  private readonly documentChanges = new Map<string, Promise<void>>();
  private readonly paperHeads: Map<string, string | null>;
  private readonly commitErrors = new Map<string, string>();
  private localSavedGeneration = 0;
  private localSaving: Promise<void> = Promise.resolve();
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
    this.editTracking = new EditTracking(context.workspaceState.get('gitex.editTracking.v1'));
    this.paperHeads = new Map(Object.entries(context.workspaceState.get<Record<string, string | null>>('gitex.paperHeads.v1') ?? {}));
    this.status.command = 'gitex.sync';
    this.controller.options = { prompt: 'Review this passage', placeHolder: 'Comment or explain your change…' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: document => {
        if (!this.repositoryFor(document.uri) || !supported.test(document.uri.fsPath)) { return []; }
        const ranges: vscode.Range[] = [];
        let start: number | undefined;
        for (let line = 0; line <= document.lineCount; line++) {
          if (line < document.lineCount && document.lineAt(line).text.trim()) {
            start ??= line;
          } else if (start !== undefined) {
            ranges.push(new vscode.Range(start, 0, line - 1, document.lineAt(line - 1).text.length));
            start = undefined;
          }
        }
        return ranges;
      }
    };
    const tree = this.tree = vscode.window.createTreeView('gitex.comments', { treeDataProvider: this, manageCheckboxStateManually: true });
    context.subscriptions.push(this, tree, tree.onDidChangeCheckboxState(event => {
      void this.checkResolved(event.items).catch(error => { this.report(error); this.changed.fire(undefined); });
    }),
      vscode.workspace.registerTextDocumentContentProvider('gitex-original', { provideTextDocumentContent: uri => this.excerpts.get(uri.toString()) ?? '' }),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
        onDidChangeCodeLenses: this.lensesChanged.event, provideCodeLenses: document => this.provideEstimateLenses(document)
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidateRepositories()),
      vscode.workspace.onDidOpenTextDocument(document => { if (document.uri.scheme === 'file') { this.schedule(); } }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.contentChanges.length && supported.test(event.document.uri.fsPath)) {
          this.queueDocumentChange(event);
        }
      }),
      vscode.workspace.onDidSaveTextDocument(async document => {
        await this.documentChanges.get(document.uri.toString());
        this.trackDocument(document, true); void this.persistLocalTracking(); this.schedule();
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => this.selectEditor(editor)),
      vscode.window.onDidChangeVisibleTextEditors(() => { this.renderUncertainLocations(); this.renderHighlights(); }),
      vscode.window.onDidChangeTextEditorSelection(event => { void this.openHighlightedComment(event).catch(error => this.report(error)); }),
      vscode.window.tabGroups.onDidChangeTabs(async event => {
        for (const tab of event.closed) {
          if (!(tab.input instanceof vscode.TabInputText)) { continue; }
          const uri = tab.input.uri.toString();
          await this.documentChanges.get(uri);
          if (vscode.window.tabGroups.all.some(group => group.tabs.some(current => current.input instanceof vscode.TabInputText && current.input.uri.toString() === uri))) { continue; }
          this.editTracking.endSession(uri);
          for (const item of this.items.filter(item => item.uri.toString() === uri)) { this.dirtyRepositories.add(item.repository.store.root); }
        }
        void this.persistLocalTracking(); this.schedule();
      }),
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
    this.command('gitex.reviewThread', (target: ThreadItem | vscode.CommentThread | string) => this.reviewThread(target));
    this.command('gitex.editComment', (comment: NativeReviewComment) => this.editComment(comment));
    this.command('gitex.saveComment', (comment: NativeReviewComment) => this.saveComment(comment));
    this.command('gitex.cancelEdit', (comment: NativeReviewComment) => this.cancelEdit(comment));
    this.command('gitex.commentHistory', (comment: NativeReviewComment) => this.commentHistory(comment));
    this.command('gitex.moveComment', (target?: ThreadItem | vscode.CommentThread) => this.moveComment(target));
    this.command('gitex.refresh', () => { this.invalidateRepositories(); return this.refresh(); });
    this.command('gitex.pull', () => this.pull());
    this.command('gitex.sync', () => this.sync());
    this.command('gitex.syncThread', (reply: vscode.CommentReply) => this.syncThread(reply));
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
    const register = async (root: string) => {
      const folder = folderFor(root);
      if (!folder) { return; }
      const repository = this.repositories.get(root) ?? { store: new ReviewStore(root), folder };
      repository.folder = folder; this.repositories.set(root, repository);
      if (!this.watchedRoots.has(root)) {
        const dirs = await repository.store.git.text(['rev-parse', '--absolute-git-dir', '--git-common-dir']);
        for (const dir of new Set(dirs.split('\n').map(dir => path.resolve(root, dir)))) {
          const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '{HEAD,packed-refs,shallow,refs/heads/**}'));
          const changed = () => { this.documentProofs.clear(); this.dirtyRepositories.add(root); this.schedule(); };
          this.context.subscriptions.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed));
        }
        this.watchedRoots.add(root);
      }
    };
    if (this.scannedVersion !== this.discoveryVersion) {
      const version = this.discoveryVersion;
      const roots = new Set(await discoverRepositories(folders.map(folder => folder.uri.fsPath)));
      for (const root of roots) { await register(root); }
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
        await register(root);
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

  private trackDocument(document: vscode.TextDocument, force = false): void {
    if (document.uri.scheme !== 'file' || !supported.test(document.uri.fsPath)) { return; }
    const repository = this.repositoryFor(document.uri);
    if (!repository) { return; }
    for (const item of this.items) {
      if (item.repository.store.root === repository.store.root && item.uri.toString() === document.uri.toString()) {
        this.locateReview(repository, item.review, document, force);
        this.dirtyRepositories.add(repository.store.root);
      }
    }
  }

  private queueDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const { document } = event, uri = document.uri.toString();
    const text = document.getText(), version = document.version;
    const changes = [...event.contentChanges], undoRedo = event.reason !== undefined;
    const maybeReload = document.uri.scheme === 'file' && !document.isDirty && !undoRedo;
    const previous = this.documentChanges.get(uri) ?? Promise.resolve();
    const next = previous.then(async () => {
      // VS Code may emit an edit before updating isDirty. Compare with disk before
      // treating it as a reload; otherwise an ordinary first keystroke gets lost.
      if (maybeReload) {
        const disk = await readFile(document.uri.fsPath, 'utf8').catch(() => undefined);
        if (disk !== undefined && normalizedText(disk) === normalizedText(text)) { this.editTracking.suspendDocument(uri); }
      }
      this.editTracking.change(uri, text, changes, undoRedo);
      if (document.version === version) { this.trackDocument(document); this.renderHighlights(); }
      this.schedule();
    }).catch(error => this.report(error));
    this.documentChanges.set(uri, next);
    void next.then(() => { if (this.documentChanges.get(uri) === next) { this.documentChanges.delete(uri); } });
  }

  private cachedDocumentProof(key: string, check: () => Promise<boolean>): Promise<boolean> {
    let proof = this.documentProofs.get(key);
    if (!proof) {
      proof = check().catch(error => { this.documentProofs.delete(key); throw error; });
      this.documentProofs.set(key, proof);
      if (this.documentProofs.size > 256) { this.documentProofs.delete(this.documentProofs.keys().next().value!); }
    }
    return proof;
  }

  private async rememberBufferHead(document: vscode.TextDocument, head: string | null): Promise<void> {
    if (document.isDirty || this.bufferHeads.get(document) === head) { return; }
    const version = document.version, text = normalizedText(document.getText());
    const disk = await readFile(document.uri.fsPath, 'utf8').catch(() => undefined);
    // HEAD can advance before VS Code reloads a clean buffer from disk.
    if (disk !== undefined && document.version === version && !document.isDirty && normalizedText(disk) === text) { this.bufferHeads.set(document, head); }
  }

  private async prepareReview(repository: Repository, review: ReviewThread, document: vscode.TextDocument, attempt = 0, paper?: { head: string | null }): Promise<void> {
    await this.documentChanges.get(document.uri.toString());
    const key = `${repository.store.root}:${review.id}`;
    const head = paper ? paper.head : await repository.store.head();
    await this.rememberBufferHead(document, head);
    const version = document.version;
    const text = document.getText();
    // A pull can update HEAD and the disk while a dirty editor still holds the
    // previous paper. That buffer retains its last clean paper lineage.
    const bufferHead = this.bufferHeads.get(document);
    const geometry = (anchor: Anchor) => JSON.stringify([anchor.path, anchor.documentHash, anchor.startLine, anchor.endLine, anchor.logicalRange, anchor.tracking]);
    const sharedAnchor = review.paperRecord?.anchor ?? review.anchor;
    const sharedReference = `${review.anchorRevision}:${geometry(sharedAnchor)}`;
    if (this.editTracking.adopt(key, review.anchorRevision, document.uri.toString(), review.anchor)) {
      this.editTracking.resume(key, review.anchorRevision, bufferHead ?? head);
      this.editTracking.rememberReference(key, sharedReference); this.locations.delete(document); return;
    }
    const previous = this.items.find(item => item.key === key)?.review;
    if (previous && previous.anchorRevision !== review.anchorRevision) {
      const identity = (thread: ReviewThread) => thread.anchorHistory.filter(entry => entry.kind === 'move').at(-1)?.id ?? thread.id;
      if (geometry(previous.anchor) === geometry(review.anchor) && identity(previous) === identity(review)) {
        this.editTracking.rebind(key, previous.anchorRevision, review.anchorRevision);
      }
    }
    const known = this.editTracking.has(key, review.anchorRevision);
    const receiptHead = this.editTracking.paperHead(key);
    const paperHead = bufferHead === undefined && document.isDirty && known ? receiptHead : bufferHead;
    const changedCommit = this.items.find(item => item.key === key)?.paperCommit !== review.paperRecord?.paperCommit;
    const changedReference = this.editTracking.sharedReference(key) !== sharedReference;
    const liveAnchor = known && changedReference && review.paperRecord?.anchor ?
      this.editTracking.reference(key, review.anchorRevision, review.anchor, text, sharedAnchor.baseCommit) : undefined;
    const changedGeometry = changedReference && !!review.paperRecord?.anchor &&
      (!liveAnchor || geometry(liveAnchor) !== geometry(sharedAnchor));
    const sameLineage = known && !changedGeometry && !(changedCommit && this.editTracking.text(key) !== normalizedText(text)) && (receiptHead === undefined ? this.editTracking.text(key) === normalizedText(text) :
      paperHead !== undefined && (receiptHead === paperHead || await this.cachedDocumentProof(`${repository.store.root}:lineage:${receiptHead}:${paperHead}`,
        () => repository.store.isAncestor(receiptHead, paperHead))));
    let source: string | undefined;
    let seedAnchor = review.anchor;
    let received = sameLineage;
    if (!received) {
      for (const record of review.paperRecord ? [review.paperRecord] : []) {
        if (!record.anchor || record.basedOn !== review.anchorRevision) { continue; }
        const exact = documentHash(text) === record.anchor.documentHash;
        if (!exact && (record.source !== 'commit' || paperHead === undefined || !await this.cachedDocumentProof(`${repository.store.root}:lineage:${record.paperCommit}:${paperHead}`,
          () => repository.store.isAncestor(record.paperCommit, paperHead)))) { continue; }
        const saved = exact ? text : await repository.store.documentText(record.anchor);
        if (saved === undefined) { continue; }
        source = saved; seedAnchor = record.anchor; received = true; break;
      }
    }
    if (!received && documentHash(text) === review.anchor.documentHash) { source = text; received = true; }
    if (!received) {
      source = await repository.store.documentText(review.anchor);
      if (source !== undefined && paperHead !== undefined) {
        const proofKey = `${repository.store.root}:${paperHead}:${review.anchor.baseCommit}:${review.anchor.path}:${review.anchor.documentHash}`;
        received = await this.cachedDocumentProof(proofKey, () => repository.store.documentAvailable(review.anchor, source!, paperHead));
      }
    }
    if (document.version !== version || !paper && await repository.store.head() !== head) {
      this.editTracking.suspend(key);
      if (attempt < 2) { await this.prepareReview(repository, review, document, attempt + 1); }
      else { this.schedule(); }
      return;
    }
    if (received && (sameLineage || source !== undefined && this.editTracking.seed(key, review.anchorRevision, document.uri.toString(), seedAnchor, source))) {
      this.editTracking.resume(key, review.anchorRevision, paperHead ?? head);
      this.editTracking.rememberReference(key, sharedReference); this.locations.delete(document);
    } else { this.editTracking.suspend(key); }
  }

  private locateReview(repository: Repository, review: ReviewThread, document: vscode.TextDocument, force = false): Location {
    let cached = this.locations.get(document);
    if (!cached || cached.version !== document.version) {
      cached = { version: document.version, entries: new Map() }; this.locations.set(document, cached);
    }
    const key = `${repository.store.root}:${review.id}`;
    const reference = review.anchorRevision;
    const previous = cached.entries.get(key);
    if (!force && previous?.reference === reference) { return previous.location; }
    const location = this.editTracking.locate(key, reference, document.getText(), !document.isDirty);
    cached.entries.set(key, { reference, location });
    return location;
  }

  private persistLocalTracking(): Promise<void> {
    if (this.localSavedGeneration === this.editTracking.generation) { return this.localSaving; }
    const snapshot = this.editTracking.snapshot();
    this.localSavedGeneration = this.editTracking.generation;
    this.localSaving = this.localSaving.then(() => this.context.workspaceState.update('gitex.editTracking.v1', snapshot)).catch(error => {
      this.localSavedGeneration = -1;
      this.output.appendLine(`Unable to save local tracking hints: ${redact(String(error))}`);
    });
    return this.localSaving;
  }

  private async recordCommitStates(repository: Repository, head: string | null, items: ThreadItem[]): Promise<void> {
    const root = repository.store.root, known = this.paperHeads.has(root), previous = this.paperHeads.get(root);
    try {
      if (head) {
        const commits = previous === head ? [head] : await repository.store.paperCommitsSince(previous, head);
        for (const commit of commits) {
          const hints: CommitHints = new Map();
          if (commit === head) {
            for (const item of items) {
              const text = this.editTracking.text(item.key);
              if (text === undefined) { continue; }
              const anchor = this.editTracking.reference(item.key, item.review.anchorRevision, item.review.anchor, text, commit);
              if (anchor) { hints.set(item.review.id, { basedOn: item.review.anchorRevision, anchor }); }
            }
          }
          await repository.store.recordPaperCommit(commit, hints);
        }
      }
      this.commitErrors.delete(root);
      if (!known || previous !== head) {
        this.paperHeads.set(root, head);
        await this.context.workspaceState.update('gitex.paperHeads.v1', Object.fromEntries(this.paperHeads));
        if (known && head && items.length && vscode.workspace.getConfiguration('gitex', repository.folder.uri).get<boolean>('autoSyncOnCommit', true)) {
          this.queueSync(repository, head);
        }
      }
    } catch (error) {
      const message = `Paper commit record pending: ${redact(error instanceof Error ? error.message : String(error))}`;
      if (this.commitErrors.get(root) !== message) { this.output.appendLine(message); }
      this.commitErrors.set(root, message);
    }
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
      let head: string | null;
      try { head = await repository.store.head(); reviews = await repository.store.threads(); }
      catch (error) {
        if (repository.store.root === this.activeRoot) { throw error; }
        this.output.appendLine(`Unable to refresh ${repository.store.root}: ${redact(String(error))}`);
        next.push(...previous); continue;
      }
      const author = await repository.store.author().catch(() => undefined);
      if (author) { this.authors.set(repository.store.root, author); } else { this.authors.delete(repository.store.root); }
      // Remember clean buffers even before their first comment arrives, so later
      // metadata can be checked against the base of an ongoing local edit.
      for (const document of vscode.workspace.textDocuments) {
        if (this.repositoryFor(document.uri) === repository && supported.test(document.uri.fsPath)) { await this.rememberBufferHead(document, head); }
      }
      await this.recordCommitStates(repository, head, previous);
      reviews = await repository.store.threads();
      const earlier = new Map<string, Awaited<ReturnType<ReviewStore['earlierReviewUpdates']>>>();
      for (const global of reviews) {
        let review = reviewAtCommit(global, head) ?? global;
        let paperCommit = head;
        const uri = vscode.Uri.file(path.join(repository.store.root, review.anchor.path));
        let location: Location;
        let reviewNotice: string | undefined, notInherited = false;
        try {
          const documentKey = `${repository.store.root}:${uri.toString()}`;
          if (!documents.has(documentKey)) { documents.set(documentKey, this.document(uri, repository)); }
          const document = await documents.get(documentKey)!;
          await this.rememberBufferHead(document, head);
          paperCommit = this.bufferHeads.get(document) ?? head;
          const scoped = reviewAtCommit(global, paperCommit);
          review = scoped ?? global;
          if (!scoped && paperCommit) {
            this.editTracking.suspend(`${repository.store.root}:${review.id}`);
            location = { kind: 'pending', reason: 'Pending paper version · No review version belongs to this document commit. Pull the paper source or switch to its reviewed commit.' };
          } else if (review.paperRecord?.status === 'uncertain') {
            this.editTracking.suspend(`${repository.store.root}:${review.id}`);
            location = { kind: 'uncertain', confidence: 0, estimatedLine: Math.min(review.paperRecord.estimatedLine ?? review.anchor.startLine, document.lineCount - 1), reason: review.paperRecord.reason ?? 'The reconstructed target is ambiguous. Select text and move the comment to confirm its location.' };
          } else if (review.paperRecord?.status === 'outdated' && !this.editTracking.isActive(`${repository.store.root}:${review.id}`, review.anchorRevision)) {
            location = { kind: 'outdated', reason: review.paperRecord.reason ?? 'The target is absent from this paper commit.' };
          } else {
            await this.prepareReview(repository, review, document, 0, { head });
            location = this.locateReview(repository, review, document, true);
          }
        } catch { location = review.paperRecord?.status === 'outdated' ? { kind: 'outdated', reason: review.paperRecord.reason ?? 'The file is absent from this paper commit.' } : { kind: 'pending', reason: 'Pending document · Pull the paper source. The referenced file is missing or unavailable in this working copy.' }; }
        if (paperCommit) {
          if (!earlier.has(paperCommit)) { earlier.set(paperCommit, await repository.store.earlierReviewUpdates(paperCommit, reviews)); }
          const notice = earlier.get(paperCommit)!.get(global.id);
          if (notice) {
            notInherited = !reviewAtCommit(global, paperCommit);
            reviewNotice = `${notice.count} review update(s) remain on earlier paper commit(s) ${notice.commits.map(hash => hash.slice(0, 8)).join(', ')}. Published inheritance is fixed; these updates were not copied into this version. View Paper history or switch to the earlier commit to review them.`;
          }
        }
        if (notInherited && location.kind === 'pending') {
          location.reason = 'Not inherited · This review belongs to an earlier paper commit. Switch to that commit or explicitly move the comment to a selection in this version.';
        }
        next.push({ key: `${repository.store.root}:${review.id}`, repository, review, uri, location, paperCommit, reviewNotice, notInherited });
      }
      // Check one immutable paper tip per repository, not two Git reads per thread.
      // A concurrent checkout invalidates this whole display pass before rendering.
      if (await repository.store.head() !== head) {
        for (const item of next.filter(item => item.repository === repository)) {
          this.editTracking.suspend(item.key);
          item.location = { kind: 'pending', reason: 'Pending document · The paper version is changing. GiTex will check again after the update finishes.' };
        }
        this.schedule();
      }
    }
    if (this.disposed) { return; }
    const visible = new Set<string>();
    for (const item of next) {
      const { review, location } = item;
      if (item.repository.store.root !== this.activeRoot) { continue; }
      if (location.kind === 'outdated' || location.kind === 'pending') { continue; }
      if (review.resolved) { continue; }
      visible.add(item.key);
      const markerLine = location.kind === 'uncertain' ? (location.insertionLine === undefined ? location.estimatedLine : Math.max(0, location.insertionLine - 1)) : 0;
      const range = location.kind === 'uncertain' ? new vscode.Range(markerLine, 0, markerLine, 0) :
        new vscode.Range(location.startLine, location.logicalRange?.startCharacter ?? 0, location.endLine, location.logicalRange?.endCharacter ?? 0);
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
      thread.label = location.kind === 'uncertain' ? location.candidates ? 'GiTex · Uncertain · 2 candidate locations' : 'GiTex · Uncertain · Estimated location' :
        location.similarity === undefined ? 'GiTex' : `GiTex · Similar text (${Math.round(location.similarity * 100)}%)`;
      if (location.source === 'local') { thread.label += ' · Local context'; }
      thread.contextValue = review.resolved ? 'gitex-resolved' : 'gitex-open';
      thread.state = review.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      this.threadItems.set(thread, item);
    }
    for (const [key, thread] of this.nativeThreads) {
      if (!visible.has(key)) {
        const item = next.find(item => item.key === key);
        if (item && item.location.kind !== 'pending' && item.location.kind !== 'outdated' && item.repository.store.root === this.activeRoot && !item.review.resolved && thread.comments.some(comment => comment.mode === vscode.CommentMode.Editing)) { thread.label = 'GiTex · Draft preserved'; }
        else { thread.dispose(); this.nativeThreads.delete(key); }
      }
    }
    this.items = next;
    this.renderUncertainLocations();
    this.renderHighlights();
    this.lensesChanged.fire();
    this.renderPanels();
    this.changed.fire(undefined);
    const repository = this.activeRoot ? this.repositories.get(this.activeRoot) : undefined;
    this.tree.description = repository ? this.repositoryLabel(repository) : undefined;
    const pendingDocuments = this.getChildren().filter(item => item.location.kind === 'pending' && !item.notInherited).length;
    const earlierUpdates = this.getChildren().filter(item => item.reviewNotice).length;
    this.tree.message = repository ? [pendingDocuments ? `${pendingDocuments} comment(s) pending document. Pull the paper source in Source Control.` : '', earlierUpdates ? `${earlierUpdates} thread(s) have updates left on earlier commits. Open Review for details.` : ''].filter(Boolean).join(' ') || undefined : 'Open a paper file to select its Git repository. Repositories in subfolders are discovered automatically.';
    const open = this.getChildren().filter(item => !item.review.resolved).length;
    const failed = !!this.activeRoot && this.syncErrors.has(this.activeRoot);
    this.status.text = failed ? '$(warning) GiTex · Sync pending' : `$(comment-discussion) GiTex ${open}`;
    this.status.tooltip = `${repository?.store.root ?? ''}\n${failed ? `${this.syncErrors.get(this.activeRoot!) ?? 'Comments are saved locally.'} Click to retry.` :
      'Sync comments with this repository’s Git remote. Paper commits use Source Control.'}`;
    if (repository) { this.status.show(); } else { this.status.hide(); }
    await this.persistLocalTracking();
  }

  getChildren(): ThreadItem[] { return this.items.filter(item => item.repository.store.root === this.activeRoot); }
  private estimateMarkers(document: vscode.TextDocument): { item: ThreadItem; estimate: EstimateCandidate }[] {
    if (document.uri.scheme !== 'file' || !supported.test(document.uri.fsPath)) { return []; }
    return this.getChildren().filter(item => !item.review.resolved && item.uri.toString() === document.uri.toString())
      .flatMap(item => locationEstimates(item.location).map(estimate => ({ item, estimate })));
  }

  private estimateExcerpt(item: ThreadItem, estimate: EstimateCandidate): string {
    return item.review.anchor.selected.join('\n');
  }

  private provideEstimateLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return this.estimateMarkers(document).filter(({ item, estimate }) => estimate.insertionLine !== undefined ||
      item.location.kind === 'uncertain' && item.location.candidates).map(({ item, estimate }) => {
      const line = Math.max(0, Math.min(estimate.insertionLine ?? estimate.estimatedLine, document.lineCount - 1));
      const reference = estimate.reference === 'local' ? 'Local context' : 'Saved reference';
      const multiple = item.location.kind === 'uncertain' && !!item.location.candidates;
      const preview = this.estimateExcerpt(item, estimate).replace(/\s+/gu, ' ').slice(0, 80);
      const afterEnd = estimate.insertionLine === document.lineCount;
      return new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: `Uncertain · ${multiple ? reference + ' candidate · ' : ''}${afterEnd ? 'After final line' : 'Estimated passage'}: ${preview}`,
        command: 'gitex.reviewThread', arguments: [item.key],
        tooltip: `${reference}\n${estimate.reason}\n${this.estimateExcerpt(item, estimate)}\nOpen the review to compare references and reconnect manually.`
      });
    });
  }

  private renderUncertainLocations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const decorations: vscode.DecorationOptions[] = [];
      for (const { item, estimate } of this.estimateMarkers(editor.document)) {
        // A gap has a CodeLens row of its own; do not underline the following sentence.
        if (estimate.insertionLine !== undefined) { continue; }
        const reference = estimate.reference === 'local' ? 'Local context' : 'Saved reference';
        const multiple = item.location.kind === 'uncertain' && !!item.location.candidates;
        const hover = new vscode.MarkdownString();
        hover.appendText(`Uncertain · ${reference}\n\n${estimate.reason}\n\n${this.estimateExcerpt(item, estimate)}`);
        hover.appendMarkdown(`\n\n[Open saved reference and reconnect](command:gitex.reviewThread?${encodeURIComponent(JSON.stringify([item.key]))})`);
        hover.isTrusted = { enabledCommands: ['gitex.reviewThread'] };
        decorations.push({ range: new vscode.Range(estimate.estimatedLine, 0, estimate.estimatedLine, 0), hoverMessage: hover,
          renderOptions: multiple ? undefined : { after: { contentText: '  Uncertain · Estimated location',
            color: new vscode.ThemeColor('descriptionForeground'), fontStyle: 'italic' } } });
      }
      editor.setDecorations(this.uncertainDecoration, decorations);
    }
  }

  private highlightedRanges(document: vscode.TextDocument): { item: ThreadItem; range: vscode.Range; inserted: boolean }[] {
    if (document.uri.scheme !== 'file' || !supported.test(document.uri.fsPath)) { return []; }
    const text = normalizedText(document.getText());
    return this.getChildren().filter(item => !item.review.resolved && item.location.kind !== 'pending' && item.uri.toString() === document.uri.toString()).flatMap(item => {
      const highlights = this.editTracking.highlights(item.key, item.review.anchorRevision, text);
      return [...highlights.owned.map(range => ({ ...range, inserted: false })), ...highlights.inserted.map(range => ({ ...range, inserted: true }))]
        .map(span => {
          const start = positionAt(text, span.start), end = positionAt(text, span.end);
          return { item, range: new vscode.Range(start.line, start.character, end.line, end.character), inserted: span.inserted };
        });
    });
  }

  private renderHighlights(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const owned: vscode.DecorationOptions[] = [], inserted: vscode.DecorationOptions[] = [];
      for (const highlight of this.highlightedRanges(editor.document)) {
        const hover = new vscode.MarkdownString();
        hover.appendText(highlight.inserted ? 'GiTex · Inserted text between comment fragments\n\n' : 'GiTex · Commented text\n\n');
        hover.appendText(highlight.item.review.comments[0].body);
        hover.appendMarkdown(`\n\n[Open comment](command:gitex.reviewThread?${encodeURIComponent(JSON.stringify([highlight.item.key]))})`);
        hover.isTrusted = { enabledCommands: ['gitex.reviewThread'] };
        (highlight.inserted ? inserted : owned).push({ range: highlight.range, hoverMessage: hover });
      }
      editor.setDecorations(this.commentDecoration, owned);
      editor.setDecorations(this.insertionDecoration, inserted);
    }
  }

  private async openHighlightedComment(event: vscode.TextEditorSelectionChangeEvent): Promise<void> {
    // A click opens the review without hijacking text selection, keyboard movement, or editing focus.
    if (event.kind !== vscode.TextEditorSelectionChangeKind.Mouse || event.selections.length !== 1 || !event.selections[0].isEmpty) { return; }
    const point = event.selections[0].active;
    const candidates = [...new Map(this.highlightedRanges(event.textEditor.document)
      .filter(({ range }) => range.start.isBeforeOrEqual(point) && point.isBefore(range.end)).map(({ item }) => [item.key, item])).values()];
    if (!candidates.length) { return; }
    const selected = candidates.length === 1 ? candidates[0] : (await vscode.window.showQuickPick(candidates.map(item => ({
      label: item.review.comments[0].body.split('\n')[0].slice(0, 100), description: item.review.comments[0].author.name, item
    })), { placeHolder: 'Open a comment on this text' }))?.item;
    if (!selected) { return; }
    await this.refresh();
    const item = this.items.find(item => item.key === selected.key);
    if (!item || item.review.resolved || item.location.kind === 'pending' || item.location.kind === 'outdated') { return; }
    const thread = this.nativeThreads.get(item.key);
    if (thread) { thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded; }
    await this.reviewThread(item, true);
  }

  getTreeItem(item: ThreadItem): vscode.TreeItem {
    const first = item.review.comments[0];
    const node = new vscode.TreeItem(first.body.split('\n')[0].slice(0, 100));
    node.id = item.key;
    const location = item.location;
    const line = location.kind === 'attached' ? location.startLine + 1 : location.kind === 'uncertain' ?
      locationEstimates(location).map(estimate => `~${estimate.estimatedLine + 1}`).join(' / ') : '?';
    const state = location.kind === 'uncertain' ? ' · Uncertain' : location.kind === 'outdated' ? ' · Outdated' : location.kind === 'pending' ? item.notInherited ? ' · Not inherited' : ' · Pending document' : location.similarity !== undefined ? ' · Similar text' : '';
    node.description = `${item.review.anchor.path}:${line}${item.review.resolved ? ' · Resolved' : ''}${state}${location.source === 'local' ? ' · Local context' : ''}`;
    const record = item.review.paperHistory.filter(record => record.paperCommit === item.paperCommit).at(-1);
    if (item.reviewNotice && !item.notInherited) { node.description += ' · Earlier updates'; }
    node.description += item.paperCommit ? ` · ${item.paperCommit.slice(0, 8)}` : '';
    node.tooltip = `${first.author.name}: ${first.body}\n${location.kind !== 'attached' ? location.reason : item.review.resolved ? 'Resolved' : 'Open'}\nPaper commit: ${item.paperCommit ?? 'Not committed yet'}\n${record ? `Recorded review: ${record.at} · ${record.status}${record.reviewVersion === item.review.reviewVersion ? ' · Latest' : ' · Newer review available'}` : 'Review not yet recorded for this commit'}`;
    node.iconPath = new vscode.ThemeIcon(location.kind === 'pending' ? 'clock' : location.kind === 'outdated' ? 'warning' : item.review.resolved ? 'pass' : location.kind === 'uncertain' ? 'question' : 'comment-discussion',
      location.kind === 'uncertain' ? new vscode.ThemeColor('descriptionForeground') : undefined);
    node.contextValue = item.review.resolved ? 'gitex-resolved' : 'gitex-open';
    node.checkboxState = { state: item.review.resolved ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: item.review.resolved ? 'Reopen: show in the paper editor' : 'Resolve: hide from the paper editor',
      accessibilityInformation: { label: 'Resolved', role: 'checkbox' } };
    node.command = { command: 'gitex.reviewThread', title: 'Open review', arguments: [item] };
    return node;
  }

  private async anchor(repository: Repository, document: vscode.TextDocument, range: vscode.Range) {
    const text = document.getText();
    const bufferHead = this.bufferHeads.get(document);
    const relative = path.relative(repository.store.root, document.uri.fsPath).split(path.sep).join('/');
    if (!validPath(relative)) { throw new Error('This file cannot be annotated.'); }
    const anchor = enableEditTracking(createSelectionAnchor(relative, text, range, null), text);
    this.editTracking.stage(document.uri.toString(), anchor, text);
    await this.document(document.uri, repository);
    anchor.baseCommit = bufferHead === undefined ? await repository.store.head() : bufferHead;
    return { anchor, text };
  }

  private async addComment(body?: string): Promise<void> {
    await this.discover(true);
    const editor = vscode.window.activeTextEditor;
    if (!editor || !supported.test(editor.document.uri.fsPath)) { throw new Error('Select a passage in a .tex, .bib, .sty, .cls, or .ltx file.'); }
    const repository = this.repositoryFor(editor.document.uri);
    if (!repository) { throw new Error('Open this file inside a Git repository workspace.'); }
    // Capture before showing the input box so a changing editor selection cannot retarget the comment.
    const { anchor, text } = await this.anchor(repository, editor.document, editor.selection);
    body ??= await vscode.window.showInputBox({ prompt: 'Comment on the selected text', placeHolder: 'Explain this change or leave a review…',
      validateInput: value => !value.trim() ? 'Enter a comment.' : value.length > 100_000 ? 'Comment is too long.' : undefined });
    if (body === undefined) { return; }
    const id = await repository.store.create(anchor, body, text, anchor.baseCommit);
    await this.afterSave(repository);
    const native = this.nativeThreads.get(`${repository.store.root}:${id}`);
    if (native) { native.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded; }
  }

  private async currentAnchor(item: ThreadItem): Promise<{ anchor: Anchor; basedOn: string; text: string } | undefined> {
    const global = (await item.repository.store.threads()).find(review => review.id === item.review.id);
    const review = global && reviewAtCommit(global, item.paperCommit ?? null);
    if (!review || review.paperRecord?.status === 'uncertain') { return undefined; }
    let document: vscode.TextDocument;
    try { document = await this.document(vscode.Uri.file(path.join(item.repository.store.root, review.anchor.path)), item.repository); } catch { return undefined; }
    await this.prepareReview(item.repository, review, document);
    await this.documentChanges.get(document.uri.toString());
    const receiptHead = this.editTracking.paperHead(item.key);
    const head = receiptHead === undefined ? await item.repository.store.head() : receiptHead;
    const text = document.getText();
    const anchor = this.editTracking.reference(item.key, review.anchorRevision, review.anchor, text, head);
    if (anchor) { this.editTracking.stage(document.uri.toString(), anchor, text, item.key); }
    return anchor ? { anchor, basedOn: review.anchorRevision, text } : undefined;
  }

  private async reply(reply: vscode.CommentReply): Promise<void> {
    if (!reply?.thread || !reply.text.trim()) { return; }
    const item = this.threadItems.get(reply.thread);
    let repository = item?.repository;
    if (item) {
      const reference = await this.currentAnchor(item);
      await item.repository.store.reply(item.review.id, reply.text, reference?.anchor, reference?.basedOn, reference?.text, item.paperCommit);
    }
    else {
      await this.discover(true);
      repository = this.repositoryFor(reply.thread.uri);
      if (!repository || !reply.thread.range) { throw new Error('Open this comment in its paper repository.'); }
      const document = await this.document(reply.thread.uri, repository);
      // VS Code retains the original drag range even after focus moves into the reply input.
      const { anchor, text } = await this.anchor(repository, document, reply.thread.range);
      const id = await repository.store.create(anchor, reply.text, text, anchor.baseCommit);
      this.nativeThreads.set(`${repository.store.root}:${id}`, reply.thread);
    }
    await this.afterSave(repository!);
  }

  private async setResolved(target: ThreadItem | vscode.CommentThread, resolved: boolean): Promise<void> {
    const item = target && ('review' in target ? target : this.threadItems.get(target));
    if (!item) { return; }
    await item.repository.store.setResolved(item.review.id, resolved, item.paperCommit);
    await this.refresh(item.repository);
  }

  private async checkResolved(items: readonly [ThreadItem, vscode.TreeItemCheckboxState][]): Promise<void> {
    for (const [item, state] of items) { await this.setResolved(item, state === vscode.TreeItemCheckboxState.Checked); }
  }

  private async moveComment(target?: ThreadItem | vscode.CommentThread): Promise<void> {
    const editor = vscode.window.activeTextEditor ?? this.lastEditor;
    if (!editor || !vscode.window.visibleTextEditors.includes(editor) || editor.document.uri.scheme !== 'file' || !supported.test(editor.document.uri.fsPath)) {
      throw new Error('Select the destination text in a visible LaTeX source editor, then move the comment to that selection.');
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
    const anchor = enableEditTracking(createSelectionAnchor(relative, text, selection, await repository.store.head()), text);
    const paperCommit = this.bufferHeads.get(document) ?? await repository.store.head();
    const reviews = (await repository.store.threads()).flatMap(global => { const review = reviewAtCommit(global, paperCommit) ?? reviewAtCommit(global, global.paperHistory.at(-1)?.paperCommit ?? null) ?? global; return [review]; });
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
    this.editTracking.stage(document.uri.toString(), anchor, text);
    await repository.store.move(review.id, anchor, review.anchorRevision, text, paperCommit);
    await this.afterSave(repository);
  }

  private async open(item: ThreadItem, reference?: 'saved' | 'local'): Promise<void> {
    // Recompute locations before navigation; the user may have edited since this tree item was created.
    await this.refresh();
    item = this.items.find(current => current.key === item.key) ?? item;
    if (item.location.kind !== 'outdated' && item.location.kind !== 'pending') {
      const candidate = reference ? locationEstimates(item.location).find(estimate => estimate.reference === reference) : undefined;
      const line = candidate?.estimatedLine ?? (item.location.kind === 'uncertain' ? item.location.estimatedLine : 0);
      const selection = item.location.kind === 'uncertain' ? new vscode.Range(line, 0, line, 0) :
        new vscode.Range(item.location.startLine, item.location.logicalRange?.startCharacter ?? 0, item.location.endLine, item.location.logicalRange?.endCharacter ?? 0);
      const sourceEditor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === item.uri.toString());
      await vscode.window.showTextDocument(await this.document(item.uri, item.repository), { selection, viewColumn: sourceEditor?.viewColumn });
      const native = this.nativeThreads.get(item.key);
      if (native && (!candidate || item.location.kind === 'uncertain' && candidate.estimatedLine === item.location.estimatedLine)) {
        native.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      }
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
    const key = `${item.key}@${item.paperCommit ?? 'uncommitted'}:${comment.id}`;
    const latest = comment.revisions.at(-1)!;
    let native = this.nativeComments.get(key);
    if (!native) {
      native = { commentId: comment.id, threadKey: item.key, revisionId: latest.id, body: '',
        mode: vscode.CommentMode.Preview, author: { name: comment.author.name } };
      this.nativeComments.set(key, native);
    }
    native.revisionId = latest.id;
    native.contextValue = sameAuthor(this.authors.get(item.repository.store.root), comment.author) ? 'gitex-owned-comment' : 'gitex-comment';
    native.timestamp = new Date(comment.at);
    native.label = [comment.conflictingRevisions.length ? 'Concurrent edits · Review history' : '', item.location.kind === 'uncertain' ? item.location.candidates ? 'Uncertain · 2 candidate locations' : 'Uncertain · Estimated location' : '',
      native.editingRevision && native.editingRevision !== latest.id ? 'Changed remotely · draft preserved' :
        comment.revisions.length > 1 ? `Edited by ${latest.author.name}` : ''].filter(Boolean).join(' · ') || undefined;
    if (native.mode !== vscode.CommentMode.Editing) { native.body = new vscode.MarkdownString().appendText(comment.body); }
    return native;
  }

  private async commentTarget(native: NativeReviewComment): Promise<{ item: ThreadItem; comment: ReviewComment }> {
    const item = this.items.find(item => item.key === native.threadKey);
    if (!item) { throw new Error('Open the comment from GiTex Comments again.'); }
    const global = (await item.repository.store.threads()).find(thread => thread.id === item.review.id);
    const review = global && reviewAtCommit(global, item.paperCommit ?? null);
    const comment = review?.comments.find(comment => comment.id === native.commentId);
    if (!comment) { throw new Error('The comment is unavailable. Refresh comments and try again.'); }
    return { item, comment };
  }

  private async editComment(native: NativeReviewComment): Promise<void> {
    if (!native || native.mode === vscode.CommentMode.Editing) { return; }
    const { item, comment } = await this.commentTarget(native);
    if (!sameAuthor(await item.repository.store.author(), comment.author)) { throw new Error('Only the original author can edit this comment. Reply with your own comment instead.'); }
    native.editingPaperCommit = item.paperCommit;
    native.editingRevision = comment.revisions.at(-1)!.id;
    native.editingConflicts = comment.conflictingRevisions;
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
      if (native.editingPaperCommit !== item.paperCommit) { throw new Error('The paper commit changed while you were editing. Your draft is preserved; switch back to its paper version before saving.'); }
      const reference = await this.currentAnchor(item);
      await item.repository.store.edit(item.review.id, native.commentId, body, basedOn, reference?.anchor, reference?.basedOn, reference?.text, item.paperCommit, native.editingConflicts);
    }
    catch (error) {
      // VS Code closes the inline input as soon as Save is clicked, before async validation finishes.
      // Restore the saved preview and retain the rejected draft in the review panel's editor.
      native.mode = vscode.CommentMode.Preview;
      native.editingRevision = undefined;
      await this.refresh();
      await this.reviewThread(item);
      this.panels.get(item.key)?.preserveDraft(native.commentId, body, basedOn, `${item.key}@${native.editingPaperCommit ?? 'uncommitted'}`);
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
    this.queueSync(repository);
  }

  private queueSync(repository: Repository, paperCommit?: string): void {
    const remote = vscode.workspace.getConfiguration('gitex', repository.folder.uri).get('remote', 'origin');
    const key = `${repository.store.root}:${remote}`;
    const previous = this.syncs.get(key) ?? Promise.resolve();
    const operation = previous.then(async () => {
      try {
        const result = await repository.store.sync(remote, paperCommit ?? await repository.store.head() ?? undefined, publication => this.confirmPublication(repository, publication, true));
        this.recordSyncResult(repository, result);
        await this.refresh(repository);
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        this.output.appendLine(`${new Date().toISOString()} Auto sync: ${message}`);
        this.syncErrors.set(repository.store.root, `${error instanceof SnapshotSharingPending ? 'Sync paused' : 'Auto sync failed'}. Your comment is saved locally. ${message}`);
        // A fetch may have succeeded before a push failed. Display any received changes too.
        try { await this.refresh(repository); } catch { this.renderPanels(); }
        if (this.activeRoot === repository.store.root) {
          this.status.text = '$(warning) GiTex · Sync pending';
          this.status.tooltip = `${this.syncErrors.get(repository.store.root)} Click to retry.`;
        }
      }
    }).finally(() => { if (this.syncs.get(key) === operation) { this.syncs.delete(key); } });
    this.syncs.set(key, operation);
  }

  private async reviewThread(target: ThreadItem | vscode.CommentThread | string, preserveFocus = false): Promise<void> {
    const item = typeof target === 'string' ? this.items.find(item => item.key === target) : target && ('review' in target ? target : this.threadItems.get(target));
    if (!item) { return; }
    let panel = this.panels.values().next().value as ReviewPanel | undefined;
    if (!panel) {
      panel = new ReviewPanel(this.context.extensionUri, this.panelKey(item), async (key, action) => {
        const current = this.items.find(candidate => this.panelKey(candidate) === key);
        if (!current) { throw new Error('This paper version is no longer displayed. Your draft is preserved; switch back to its paper commit before saving.'); }
        await this.panelAction(current, action);
      }, () => this.panels.clear(), preserveFocus);
    } else { panel.key = this.panelKey(item); panel.panel.reveal(undefined, preserveFocus); }
    this.panels.clear();
    this.panels.set(item.key, panel);
    this.renderPanels();
    // Resolved inline widgets are removed, but their drafts remain recoverable in the shared review tab.
    if (!this.nativeThreads.has(item.key)) {
      for (const native of this.nativeComments.values()) {
        if (native.threadKey !== item.key || native.mode !== vscode.CommentMode.Editing || !native.editingRevision) { continue; }
        panel.preserveDraft(native.commentId, typeof native.body === 'string' ? native.body : native.body.value, native.editingRevision, `${item.key}@${native.editingPaperCommit ?? 'uncommitted'}`);
        native.mode = vscode.CommentMode.Preview; native.editingRevision = undefined;
      }
    }
  }

  private async panelAction(item: ThreadItem, action: ReviewAction): Promise<void> {
    if (action.type === 'ready') { this.renderPanels(); return; }
    if (action.type === 'edit' || action.type === 'reply') {
      if (item.paperCommit && !item.review.paperHistory.some(record => record.paperCommit === item.paperCommit)) {
        throw new Error('This review belongs to another paper commit. Pull or switch the paper before editing it.');
      }
      const reference = await this.currentAnchor(item);
      if (action.type === 'edit') { await item.repository.store.edit(item.review.id, action.commentId, action.body, action.basedOn, reference?.anchor, reference?.basedOn, reference?.text, item.paperCommit, action.merges); }
      else { await item.repository.store.reply(item.review.id, action.body, reference?.anchor, reference?.basedOn, reference?.text, item.paperCommit); }
    }
    else if (action.type === 'move') { await this.moveComment(item); return; }
    else if (action.type === 'resolve') { await this.setResolved(item, action.resolved); return; }
    else if (action.type === 'source') { await this.open(item, action.reference); return; }
    await this.afterSave(item.repository);
  }

  private panelKey(item: ThreadItem): string { return `${item.key}@${item.paperCommit ?? 'uncommitted'}`; }

  private renderPanels(): void {
    if (this.disposed) { return; }
    for (const [key, panel] of this.panels) {
      const item = this.items.find(item => item.key === key);
      if (!item) { continue; }
      const automatic = this.autoSyncEnabled(item.repository);
      const status = this.syncErrors.get(item.repository.store.root) ||
        (automatic ? 'Auto sync after saving is enabled. Comments for this paper version are pulled, merged and published after saving.' :
          'Auto sync after saving is disabled. Edits are saved locally; use Sync Comments to publish them.');
      panel.key = this.panelKey(item);
      panel.update(item.review, { repository: this.repositoryLabel(item.repository), location: item.location,
        localReference: undefined,
        editableComments: item.review.comments.filter(comment => sameAuthor(this.authors.get(item.repository.store.root), comment.author)).map(comment => comment.id),
        paperCommit: item.paperCommit, reviewNotice: item.reviewNotice, notInherited: item.notInherited, commitError: this.commitErrors.get(item.repository.store.root),
        sync: this.syncErrors.has(item.repository.store.root) ? 'failed' : automatic ? 'automatic' : 'manual', status });
    }
  }

  private async pull(repository?: Repository): Promise<void> {
    repository ??= await this.chooseRepository();
    if (!repository) { return; }
    const remote = vscode.workspace.getConfiguration('gitex', repository.folder.uri).get('remote', 'origin');
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `GiTex: Fetching comments from ${remote}…` },
      () => repository!.store.pull(remote));
    // Receiving reviews does not acknowledge publication of newer local work.
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

  private syncThread(reply: vscode.CommentReply): void {
    // VS Code clears the reply form after any commentThread/context action completes.
    // Only allow an empty form, then return before network I/O so typing during sync is safe.
    if (reply?.text) { return; }
    const item = reply?.thread && this.threadItems.get(reply.thread);
    if (!item) { throw new Error('Open the comment from GiTex Comments again before syncing.'); }
    void this.sync(item.repository).catch(error => this.report(error));
  }

  private readonly snapshotNotices = new Set<string>();

  private async confirmPublication(repository: Repository, publication: SnapshotPublication, automatic: boolean): Promise<void> {
    const key = `snapshot-sharing-v1:${createHash('sha256').update(repository.store.root).digest('hex')}:${publication.destinationKey}`;
    const acknowledged = this.context.globalState.get<boolean>(key, false);
    const drafts = publication.snapshots.filter(snapshot => !snapshot.committed);
    const allowDrafts = vscode.workspace.getConfiguration('gitex', repository.folder.uri).get('autoShareUncommittedSnapshots', false);
    if (acknowledged && (!drafts.length || allowDrafts)) { return; }
    if (automatic) {
      if (!this.snapshotNotices.has(key)) {
        this.snapshotNotices.add(key);
        void vscode.window.showWarningMessage('GiTex comments are saved locally. Run Sync Comments to review sharing full document snapshots, which may include uncommitted text and remain in Git history.');
      }
      throw new SnapshotSharingPending(!acknowledged ? 'Before the first push, run Sync Comments to review document snapshot sharing.' :
        'Uncommitted document snapshots are saved locally. Run Sync Comments to approve sharing, or enable GiTex: Auto Share Uncommitted Snapshots.');
    }
    const size = (publication.bytes / 1024).toFixed(1);
    const detail = `GiTex shares complete document snapshots, including unsaved or uncommitted text when a comment references it. These snapshots remain in Git history even after later edits.\n\n` +
      `This push contains ${publication.snapshots.length} new snapshot(s), ${size} KiB before Git compression. ${drafts.length} snapshot(s) are not found in your current paper commit history. Older snapshots in outgoing Git history are included.\n\n` +
      'Only comment metadata is pushed; this does not commit or push your paper branch. Cancel keeps your comments locally. Automatic sharing of uncommitted snapshots is controlled separately in GiTex settings.';
    if (!await this.showSnapshotConfirmation(detail)) { throw new Error('Snapshot sharing cancelled. Comments remain saved locally.'); }
    await this.context.globalState.update(key, true);
  }

  private async showSnapshotConfirmation(detail: string): Promise<boolean> {
    return await vscode.window.showWarningMessage('Share GiTex comments and document snapshots?', { modal: true, detail }, 'Share This Push') === 'Share This Push';
  }

  private recordSyncResult(repository: Repository, result: SyncResult): boolean {
    const pending = result.localTip !== result.publishedTip;
    if (pending) {
      this.syncErrors.set(repository.store.root, 'Approved comments were shared. Newer comments remain saved locally for the next sync.');
    } else { this.syncErrors.delete(repository.store.root); }
    return pending;
  }

  private async sync(repository?: Repository): Promise<void> {
    repository ??= await this.chooseRepository();
    if (!repository) { return; }
    const remote = vscode.workspace.getConfiguration('gitex', repository.folder.uri).get('remote', 'origin');
    const selected = repository;
    let pending = false;
    try {
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `GiTex: Syncing comments with ${remote}…` },
        async () => selected.store.sync(remote, await selected.store.head() ?? undefined, publication => this.confirmPublication(selected, publication, false)));
      pending = this.recordSyncResult(selected, result);
    } catch (error) {
      this.syncErrors.set(repository.store.root, redact(error instanceof Error ? error.message : String(error)));
      await this.refresh(repository);
      throw error;
    }
    await this.refresh(repository);
    void vscode.window.showInformationMessage(pending ? 'GiTex shared the approved comments. Newer local comments await the next sync.' : 'GiTex comments synced for your paper version.');
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const panel of this.panels.values()) { panel.dispose(); }
    this.controller.dispose(); this.changed.dispose(); this.lensesChanged.dispose(); this.output.dispose(); this.status.dispose(); this.uncertainDecoration.dispose();
    this.commentDecoration.dispose(); this.insertionDecoration.dispose();
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const app = new GiTex(context);
  try { await app.refresh(); }
  catch (error) { void vscode.window.showErrorMessage(`GiTex: ${redact(error instanceof Error ? error.message : String(error))}`); }
  return app;
}
