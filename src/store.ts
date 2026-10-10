import { isDeepStrictEqual } from 'node:util';
import { archiveFiles, archiveEvents } from './archive';
import { createHash, randomUUID } from 'node:crypto';
import { Anchor, documentHash } from './anchor';
import { Git, GitError } from './git';
import { Author, sameAuthor, materialize, reviewAtCommit, PaperReviewState, parseEvent, ReviewEvent, ReviewThread } from './model';
import { snapshotChangesPresent } from './documentSync';
import { EditTracking } from './editTracking';
import { inspectPublication, PublicationGuard } from './snapshotPrivacy';
import { ReviewTransport, ReviewEndpoint } from './reviewTransport';
export { REMOTE_REF } from './reviewTransport';

export const LOCAL_REF = 'refs/gitex/comments';
const legacyMarker = JSON.stringify({ format: 'gitex-comments', version: 1 });
const marker = JSON.stringify({ format: 'gitex-comments', version: 2 });
const commentMarker = JSON.stringify({ format: 'gitex-comments', version: 4 });
const checkpointMarker = JSON.stringify({ format: 'gitex-comments', version: 3 });
export type CommitHints = Map<string, { basedOn: string; anchor: Anchor }>;
export interface SyncResult {
  threads: ReviewThread[];
  publishedTip: string | null;
  localTip: string | null;
}
export interface EarlierReviewNotice {
  commits: string[];
  count: number;
  previous?: { paperCommit: string; review: ReviewThread };
}
type Entry = { event: ReviewEvent };
interface PaperPublication { version: 1; id: string; paperCommit: string; threads: string[] }
class Entries extends Map<string, Entry> {
  documents = new Map<string, string>();
  publications = new Map<string, PaperPublication>();
}
function validatePublications(entries: Entries): void {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const checkpoints = new Set([...entries.values()].flatMap(({ event }) => event.type === 'checkpoint' ? [`${event.paperCommit}:${event.threadId}`] : []));
  for (const [id, publication] of entries.publications) {
    if (!publication || publication.version !== 1 || publication.id !== id || !uuid.test(id) || entries.has(id) ||
        typeof publication.paperCommit !== 'string' || !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(publication.paperCommit) ||
        !Array.isArray(publication.threads) || new Set(publication.threads).size !== publication.threads.length ||
        publication.threads.some(thread => typeof thread !== 'string' || !uuid.test(thread) || !checkpoints.has(`${publication.paperCommit}:${thread}`))) {
      throw new Error('Invalid GiTex paper publication.');
    }
  }
}
type Payload = { type: 'create'; anchor: Anchor; body: string } | { type: 'reply'; body: string; anchor?: Anchor; anchorBasedOn?: string } |
  { type: 'edit'; commentId: string; basedOn: string; body: string; merges?: string[]; anchor?: Anchor; anchorBasedOn?: string } |
  { type: 'move'; anchor: Anchor; basedOn: string } | { type: 'state'; resolved: boolean };

export class ReviewStore {
  readonly git: Git;
  private pending: Promise<unknown> = Promise.resolve();
  private networkPending: Promise<unknown> = Promise.resolve();
  private readonly transport: ReviewTransport;
  private readonly blobOids = new Map<string, string>();
  private cachedArchive?: { tip: string; entries: Entries };
  private cachedThreads?: { tip: string | null; threads: ReviewThread[] };

  constructor(readonly root: string) { this.git = new Git(root); this.transport = new ReviewTransport(this.git); }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action, action);
    this.pending = next.catch(() => undefined);
    return next;
  }

  /** A slow remote or approval dialog never owns the local writer queue. */
  private network<T>(action: () => Promise<T>): Promise<T> {
    const next = this.networkPending.then(action, action);
    this.networkPending = next.catch(() => undefined);
    return next;
  }

  async author(): Promise<Author> {
    const identity = await this.git.text(['var', 'GIT_AUTHOR_IDENT']);
    const match = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(identity);
    if (!match) { throw new Error('Configure Git user.name and user.email before writing comments.'); }
    return { name: match[1], email: match[2] };
  }

  async threads(): Promise<ReviewThread[]> {
    const tip = await this.git.ref(LOCAL_REF);
    if (this.cachedThreads?.tip === tip) { return structuredClone(this.cachedThreads.threads); }
    const threads = materialize([...await this.read(tip)].map(([, entry]) => entry.event));
    this.cachedThreads = { tip, threads };
    return structuredClone(threads);
  }

  async head(): Promise<string | null> { return this.git.ref('HEAD'); }

  /** Snapshots are shared once per document hash, separately from immutable events. */
  async documentText(anchor: Anchor): Promise<string | undefined> {
    const tip = await this.git.ref(LOCAL_REF);
    const spec = anchor.tracking && tip ? `${tip}:documents/${anchor.documentHash}.txt` :
      anchor.baseCommit ? `${anchor.baseCommit}:${anchor.path}` : undefined;
    if (!spec) { return undefined; }
    const result = await this.git.run(['show', spec]);
    if (result.code !== 0) { return undefined; }
    const text = result.stdout.toString('utf8').replace(/\r\n/g, '\n');
    return documentHash(text) === anchor.documentHash ? text : undefined;
  }

  /** A comment snapshot must have reached this paper's branch before replaying later edits. */
  async isAncestor(before: string | null, after: string | null): Promise<boolean> {
    if (before === after) { return true; }
    if (!before || !after) { return before === after; }
    return (await this.git.run(['merge-base', '--is-ancestor', before, after])).code === 0;
  }

  async documentAvailable(anchor: Anchor, text: string, head?: string | null): Promise<boolean> {
    head = head === undefined ? await this.head() : head;
    if (!head || documentHash(text) !== anchor.documentHash) { return false; }
    for (const content of new Set([text, text.replace(/\n/g, '\r\n')])) {
      const oid = await this.git.text(['hash-object', '--stdin'], content);
      const history = await this.git.run(['log', '--format=%H', '--max-count=1', `--find-object=${oid}`, head, '--', anchor.path]);
      if (history.code === 0 && history.stdout.toString('utf8').trim()) { return true; }
    }
    // A review may be saved before the author finishes the paper commit. Require
    // every draft edit at its original base coordinate; a matching sentence alone
    // does not prove that the receiver has this version of the document.
    if (anchor.baseCommit && await this.isAncestor(anchor.baseCommit, head)) {
      const base = await this.git.run(['show', `${anchor.baseCommit}:${anchor.path}`]);
      const current = await this.git.run(['show', `${head}:${anchor.path}`]);
      if (base.code === 0 && current.code === 0 && snapshotChangesPresent(base.stdout.toString('utf8'), text, current.stdout.toString('utf8'))) { return true; }
    }
    return false;
  }

  create(anchor: Anchor, body: string, document?: string, paperCommit?: string | null): Promise<string> {
    return this.append(undefined, { type: 'create', anchor, body: body.trim() }, document, paperCommit);
  }
  reply(threadId: string, body: string, anchor?: Anchor, anchorBasedOn?: string, document?: string, paperCommit?: string | null): Promise<string> {
    return this.append(threadId, { type: 'reply', body: body.trim(), anchor, anchorBasedOn }, document, paperCommit);
  }
  edit(threadId: string, commentId: string, body: string, basedOn: string, anchor?: Anchor, anchorBasedOn?: string, document?: string, paperCommit?: string | null, acknowledgedRevisions?: string[]): Promise<string> {
    return this.append(threadId, { type: 'edit', commentId, basedOn, body: body.trim(), anchor, anchorBasedOn, merges: acknowledgedRevisions }, document, paperCommit);
  }
  move(threadId: string, anchor: Anchor, basedOn: string, document?: string, paperCommit?: string | null, sourcePaperCommit?: string): Promise<string> {
    return this.append(threadId, { type: 'move', anchor, basedOn }, document, paperCommit, sourcePaperCommit);
  }
  setResolved(threadId: string, resolved: boolean, paperCommit?: string | null): Promise<string> {
    return this.append(threadId, { type: 'state', resolved }, undefined, paperCommit);
  }

  /** Follow every parent, stopping at the nearest recorded view on each path. */
  private async inheritedReview(review: ReviewThread, commit: string, graph?: Map<string, string[]>, parentsOnly = false, closedVersions = new Set<string>()): Promise<ReviewThread | undefined> {
    const current = !parentsOnly && reviewAtCommit(review, commit);
    if (current) { return current; }
    graph ??= await this.paperGraph(commit);
    const pending = [...(graph.get(commit) ?? [])], visited = new Set<string>(), views: ReviewThread[] = [];
    while (pending.length) {
      const hash = pending.pop()!;
      if (visited.has(hash)) { continue; } visited.add(hash);
      const inherited = reviewAtCommit(review, hash);
      if (inherited) { views.push(inherited); }
      else if (!closedVersions.has(hash)) { pending.push(...(graph.get(hash) ?? [])); }
    }
    if (views.length) { return this.unionReviews(review, views); }
    if (review.paperHistory.length) { return undefined; }
    if (!review.anchor.baseCommit || graph.has(review.anchor.baseCommit)) { return review; }
    return undefined;
  }

  private unionReviews(global: ReviewThread, views: ReviewThread[]): ReviewThread {
    const ids = new Set(views.flatMap(view => view.events.map(event => event.id)));
    const combined = materialize(global.events.filter(event => ids.has(event.id)))[0];
    const records = views.flatMap(view => view.paperRecord ? [view.paperRecord] : []).sort((a, b) => b.clock - a.clock || b.id.localeCompare(a.id, 'en'));
    const record = records.find(record => record.basedOn === combined.anchorRevision);
    return { ...combined, paperHistory: global.paperHistory, paperRecord: record, archivedComments: global.comments };
  }

  private async paperGraph(commit: string): Promise<Map<string, string[]>> {
    return new Map((await this.git.text(['rev-list', '--parents', commit])).split('\n').filter(Boolean).map(line => {
      const [hash, ...parents] = line.split(' '); return [hash, parents];
    }));
  }

  /** Read-only disclosure of ancestor updates excluded from this commit's published view. */
  async earlierReviewUpdates(commit: string, reviews?: ReviewThread[]): Promise<Map<string, EarlierReviewNotice>> {
    const ancestors = await this.paperGraph(commit);
    const notices = new Map<string, EarlierReviewNotice>();
    for (const global of reviews ?? await this.threads()) {
      const current = reviewAtCommit(global, commit);
      const included = new Set(current?.events.map(event => event.id));
      const missing = global.events.filter(event => event.type !== 'checkpoint' && event.paperCommit && event.paperCommit !== commit &&
        ancestors.has(event.paperCommit) && !included.has(event.id));
      if (!missing.length) { continue; }
      const notice: EarlierReviewNotice = { commits: [...new Set(missing.map(event => event.paperCommit!))], count: missing.length };
      if (!current) {
        // Stop at the nearest recorded version on each ancestry path, including
        // resolved versions. Do not revive an older open state or borrow a future view.
        const queue = [...(ancestors.get(commit) ?? [])], visited = new Set<string>();
        for (let offset = 0; offset < queue.length; offset++) {
          const hash = queue[offset];
          if (visited.has(hash)) { continue; } visited.add(hash);
          const previous = reviewAtCommit(global, hash);
          if (previous) {
            notice.previous ??= { paperCommit: hash, review: previous };
            if (!previous.resolved) { notice.previous = { paperCommit: hash, review: previous }; break; }
          } else { queue.push(...(ancestors.get(hash) ?? [])); }
        }
      }
      notices.set(global.id, notice);
    }
    return notices;
  }

  private state(review: ReviewThread, commit: string, source: PaperReviewState['source']): PaperReviewState {
    return { paperCommit: commit, source, eventIds: review.events.map(event => event.id),
      reviewVersion: review.reviewVersion, basedOn: review.anchorRevision,
      status: 'pending', reason: 'This paper commit does not contain the required document version.',
      comments: review.comments.map(comment => ({ id: comment.id, revision: comment.revisions.at(-1)!.id })), resolved: review.resolved };
  }

  private async addCheckpoint(entries: Entries, threadId: string, state: PaperReviewState, author: Author): Promise<void> {
    const id = randomUUID(), clock = Math.max(0, ...[...entries.values()].map(entry => entry.event.clock)) + 1;
    const event = parseEvent(JSON.stringify({ version: 1, type: 'checkpoint', id, threadId, clock, at: new Date().toISOString(), author, ...state }));
    entries.set(id, { event });
  }

  async paperCommitsSince(previous: string | null | undefined, head: string): Promise<string[]> {
    if (previous && previous !== head && await this.isAncestor(previous, head)) {
      return (await this.git.text(['rev-list', '--first-parent', '--reverse', `${previous}..${head}`])).split('\n').filter(Boolean);
    }
    return [head];
  }

  /** One metadata transaction records every thread against an immutable paper commit. */
  recordPaperCommit(commit: string, hints: CommitHints = new Map()): Promise<ReviewThread[]> {
    return this.exclusive(() => this.checkpoint(commit, hints));
  }

  private async checkpoint(commit: string, hints: CommitHints = new Map(), finalize = false, published = new Set<string>()): Promise<ReviewThread[]> {
    if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(commit) || await this.git.ref(`${commit}^{commit}`) !== commit) {
      throw new Error('Cannot record reviews without a valid paper commit.');
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const old = await this.git.ref(LOCAL_REF), entries = await this.read(old);
      const reviews = materialize([...entries.values()].map(entry => entry.event));
      const publications = [...entries.publications.values()].filter(record => record.paperCommit === commit && (!finalize || published.has(record.id)));
      const inheritedThreads = publications.length ? new Set(publications.flatMap(record => record.threads)) : undefined;
      const missing = reviews.filter(review => {
        const records = review.paperHistory.filter(record => record.paperCommit === commit);
        return !records.length ? !inheritedThreads || inheritedThreads.has(review.id) : finalize && !records.some(record => !record.provisional && published.has(record.id));
      });
      if (!missing.length && (!finalize || publications.length)) { return reviews; }
      const author = await this.author();
      let added = false;
      const ancestry = await this.paperGraph(commit);
      const closedVersions = new Set([...entries.publications.values()].map(record => record.paperCommit));
      const documents = new Map<string, Promise<string | undefined>>();
      const sources = new Map<string, Promise<string | undefined>>();
      const proofs = new Map<string, Promise<boolean>>();
      for (const global of missing) {
        let review = await this.inheritedReview(global, commit, ancestry, false, closedVersions);
        if (!review) { continue; }
        const current = reviewAtCommit(global, commit);
        if (finalize && current) {
          const inherited = await this.inheritedReview(global, commit, ancestry, true, closedVersions);
          if (inherited) { review = this.unionReviews(global, [inherited, current]); }
          // Preserve this commit's editor-derived geometry when only discussion changed.
          if (current.paperRecord?.basedOn === review.anchorRevision) { review.paperRecord = current.paperRecord; }
        }
        const path = review.anchor.path;
        if (!documents.has(path)) { documents.set(path, this.git.run(['show', `${commit}:${path}`]).then(result => result.code === 0 ? result.stdout.toString('utf8').replace(/\r\n/g, '\n') : undefined)); }
        const text = await documents.get(path)!;
        const state = this.state(review, commit, 'commit');
        state.provisional = !finalize;
        if (text === undefined) { state.status = 'outdated'; state.reason = 'The referenced file is absent from this paper commit.'; }
        else {
          const tracker = new EditTracking();
          const hint = hints.get(review.id);
          let seeded = !!hint && hint.basedOn === review.anchorRevision && hint.anchor.baseCommit === commit &&
            hint.anchor.path === path && tracker.seed(review.id, review.anchorRevision, path, hint.anchor, text);
          if (!seeded && (review.paperRecord?.status === 'outdated' || review.paperRecord?.status === 'uncertain')) {
            state.status = review.paperRecord.status; state.reason = review.paperRecord.reason;
          } else if (!seeded) {
            const savedAnchor = review.paperRecord?.anchor && review.paperRecord.basedOn === review.anchorRevision ? review.paperRecord.anchor : review.anchor;
            const sourceKey = `${path}:${savedAnchor.documentHash}`;
            if (!sources.has(sourceKey)) { sources.set(sourceKey, this.documentText(savedAnchor)); }
            const source = documentHash(text) === savedAnchor.documentHash ? text : await sources.get(sourceKey)!;
            if (source !== undefined) {
              const proofKey = `${sourceKey}:${savedAnchor.baseCommit}`;
              if (!proofs.has(proofKey)) { proofs.set(proofKey, documentHash(text) === savedAnchor.documentHash ? Promise.resolve(true) : this.documentAvailable(savedAnchor, source, commit)); }
              if (await proofs.get(proofKey)) { seeded = tracker.seed(review.id, review.anchorRevision, path, savedAnchor, source); }
            }
          }
          if (seeded) {
            const anchor = tracker.reference(review.id, review.anchorRevision, review.anchor, text, commit);
            if (anchor) {
              state.status = 'attached'; state.anchor = anchor; delete state.reason;
              if (!entries.documents.has(anchor.documentHash)) {
                entries.documents.set(anchor.documentHash, await this.git.text(['hash-object', '-w', '--stdin'], text));
              }
            } else {
              const location = tracker.locate(review.id, review.anchorRevision, text);
              state.status = location.kind === 'uncertain' && location.evidence === 'reconstructed' ? 'uncertain' : 'outdated';
              state.reason = state.status === 'uncertain' && location.kind === 'uncertain' ? location.reason : 'The reviewed target has no surviving fragment in this committed document.';
              if (location.kind === 'uncertain') { state.estimatedLine = location.estimatedLine; }
            }
          }
        }
        await this.addCheckpoint(entries, review.id, state, author);
        added = true;
      }
      if (finalize && !publications.length) {
        const id = randomUUID();
        const threads = new Set([...entries.values()].flatMap(({ event }) => event.type === 'checkpoint' && event.paperCommit === commit ? [event.threadId] : []));
        entries.publications.set(id, { version: 1, id, paperCommit: commit, threads: [...threads].sort() });
        added = true;
      }
      if (!added) { return reviews; }
      const result = materialize([...entries.values()].map(entry => entry.event));
      const next = await this.commit(entries, old ? [old] : []);
      if (await this.advance(next, old)) { return result; }
    }
    throw new Error('Reviews changed while recording the paper commit. The commit record will be retried.');
  }

  private append(threadId: string | undefined, payload: Payload, document?: string, paperCommit?: string | null, sourcePaperCommit?: string): Promise<string> {
    return this.exclusive(async () => {
      const id = randomUUID();
      paperCommit = paperCommit === undefined ? await this.head() : paperCommit;
      const author = await this.author();
      for (let attempt = 0; attempt < 8; attempt++) {
        const old = await this.git.ref(LOCAL_REF);
        const entries = await this.read(old);
        if ('anchor' in payload && payload.anchor?.tracking) {
          if (document !== undefined) {
            document = document.replace(/\r\n/g, '\n');
            if (documentHash(document) !== payload.anchor.documentHash) { throw new Error('The comment document snapshot does not match its reference.'); }
            const oid = await this.git.text(['hash-object', '-w', '--stdin'], document);
            entries.documents.set(payload.anchor.documentHash, oid);
          }
          if (!entries.documents.has(payload.anchor.documentHash)) { throw new Error('The comment document snapshot is missing.'); }
        }
        if (threadId && !entries.has(threadId)) { throw new Error('The comment thread no longer exists locally. Refresh or sync comments.'); }
        const global = threadId ? materialize([...entries.values()].map(entry => entry.event)).find(thread => thread.id === threadId) : undefined;
        let thread = global && paperCommit ? await this.inheritedReview(global, paperCommit, undefined, false, new Set([...entries.publications.values()].map(record => record.paperCommit))) : global;
        // An explicit move can reconnect a review after amend/rebase. Mere text equality cannot.
        if (!thread && global && payload.type === 'move') {
          thread = reviewAtCommit(global, sourcePaperCommit ?? global.paperHistory.at(-1)?.paperCommit ?? null);
          if (!thread && sourcePaperCommit) { throw new Error('The earlier review version is no longer available. Refresh comments before reconnecting it.'); }
          thread ??= global;
        }
        const publishedViews = [...entries.publications.values()].filter(record => record.paperCommit === paperCommit);
        if (global && payload.type !== 'move' && paperCommit && !reviewAtCommit(global, paperCommit) && publishedViews.length &&
            !publishedViews.some(record => record.threads.includes(global.id))) { thread = undefined; }
        if (global && !thread) { throw new Error('This review belongs to another paper commit. Pull or switch the paper before editing it.'); }
        if (payload.type === 'move' && payload.basedOn !== thread!.anchorRevision) {
          throw new Error('This comment location changed while you were choosing a destination. Refresh and move it again.');
        }
        let anchorBasedOn: string | undefined;
        if ((payload.type === 'reply' || payload.type === 'edit') && payload.anchor) {
          if (payload.anchor.path !== thread!.anchor.path) { throw new Error('A GiTex tracking update cannot change the file path. The comment location changed; refresh before saving.'); }
          anchorBasedOn = payload.anchorBasedOn ?? thread!.anchorRevision;
          if (anchorBasedOn !== thread!.anchorRevision) { throw new Error('The comment location changed while you were editing. Your draft is preserved. Refresh before saving.'); }
        }
        let merges: string[] | undefined;
        if (payload.type === 'edit') {
          const comment = thread?.comments.find(comment => comment.id === payload.commentId);
          if (!comment) { throw new Error('The comment to edit does not exist in this thread.'); }
          if (!sameAuthor(author, comment.author)) { throw new Error('Only the original author can edit this comment. Reply with your own comment instead.'); }
          merges = comment.conflictingRevisions.length ? comment.conflictingRevisions : undefined;
          if (merges && (merges.length !== payload.merges?.length || merges.some(id => !payload.merges!.includes(id)))) {
            throw new Error('Concurrent edits changed. Review History, then cancel and edit again to resolve the current versions. Your draft is preserved.');
          }
          if (comment.revisions.at(-1)!.id !== payload.basedOn) {
            throw new Error('This comment changed while you were editing. Your draft is preserved. Review the history, then cancel and edit the latest version.');
          }
          if (!merges && comment.body === payload.body && (!payload.anchor || JSON.stringify(payload.anchor) === JSON.stringify(thread!.anchor))) { return threadId!; }
        }
        const clock = Math.max(0, ...[...entries.values()].map(entry => entry.event.clock)) + 1;
        const event = parseEvent(JSON.stringify({ version: 1, id, threadId: threadId ?? id, clock, at: new Date().toISOString(), author, ...payload,
          ...(payload.type === 'edit' ? { authorOnly: true, ...(merges ? { merges } : {}) } : {}),
          ...(anchorBasedOn ? { anchorBasedOn } : {}), ...(paperCommit ? { paperCommit } : {}) }));
        entries.set(id, { event });
        if (paperCommit) {
          const updated = materialize([...(thread?.events ?? []), event])[0];
          const state = this.state(updated, paperCommit, 'working-copy');
          state.provisional = !!global && !global.paperHistory.some(record => record.paperCommit === paperCommit && !record.provisional);
          const changedAnchor = 'anchor' in payload && payload.anchor;
          if (changedAnchor || !thread?.paperRecord || thread.paperRecord.status === 'attached') {
            state.status = 'attached'; state.anchor = changedAnchor || thread?.paperRecord?.anchor || updated.anchor; delete state.reason;
          } else {
            state.status = thread.paperRecord.status; state.reason = thread.paperRecord.reason;
            state.estimatedLine = thread.paperRecord.estimatedLine;
          }
          await this.addCheckpoint(entries, updated.id, state, author);
        }
        materialize([...entries.values()].map(entry => entry.event));
        const commit = await this.commit(entries, old ? [old] : []);
        if (await this.advance(commit, old)) { return threadId ?? id; }
      }
      throw new Error('Comments are being updated in another window. Try again.');
    });
  }

  pull(remote = 'origin'): Promise<ReviewThread[]> {
    return this.network(async () => {
      const endpoint = await this.transport.endpoint(remote, 'fetch');
      await this.receive(endpoint);
      return this.threads();
    });
  }

  sync(remote = 'origin', paperCommit?: string, beforePush?: PublicationGuard): Promise<SyncResult> {
    return this.network(async () => {
      if (!beforePush) { throw new Error('A publication policy is required before GiTex can push comments.'); }
      // Resolve once: fetch, inspection, approval and every push retry use this destination.
      const endpoint = await this.transport.endpoint(remote, 'push');
      const head = paperCommit ?? await this.head();
      for (let attempt = 0; attempt < 4; attempt++) {
        const remoteTip = await this.receive(endpoint);
        const publishTip = await this.exclusive(async () => {
          const remoteEntries = await this.read(remoteTip);
          const published = new Set([...remoteEntries.keys(), ...remoteEntries.publications.keys()]);
          if (head) {
            const reviews = await this.threads();
            const provisional = new Set(reviews.flatMap(review => review.paperHistory.filter(record => !published.has(record.id)).map(record => record.paperCommit)));
            const order = (await this.git.text(['rev-list', '--topo-order', '--reverse', head])).split('\n');
            for (const commit of order.filter(commit => commit === head || provisional.has(commit))) { await this.checkpoint(commit, new Map(), true, published); }
          }
          const tip = await this.git.ref(LOCAL_REF);
          await this.read(tip);
          return tip;
        });
        if (!publishTip) { return this.syncResult(null); }
        if (publishTip !== remoteTip) { await beforePush(await inspectPublication(this.git, publishTip, remoteTip, endpoint.url)); }
        // Local saves can continue; never substitute a newer tip after approval.
        const pushed = await this.transport.push(endpoint, publishTip);
        if (pushed.code === 0) { return this.syncResult(publishTip); }
        const status = pushed.stdout.toString('utf8') + pushed.stderr;
        if (!/\[(?:remote )?rejected\].*\((fetch first|non-fast-forward|failed to update ref)\)/.test(status)) { throw new GitError(pushed, 'push'); }
      }
      throw new Error('Remote comments keep changing. Your work is saved locally; try Sync Comments again.');
    });
  }

  private async syncResult(publishedTip: string | null): Promise<SyncResult> {
    const localTip = await this.git.ref(LOCAL_REF);
    const threads = materialize([...await this.read(localTip)].map(([, entry]) => entry.event));
    return { threads, localTip, publishedTip };
  }

  private receive(endpoint: ReviewEndpoint): Promise<string | null> {
    return this.transport.snapshot(endpoint, remoteTip => this.exclusive(() => this.mergeRemote(remoteTip)));
  }

  /** A bounded local compare-and-swap transaction; it performs no network I/O. */
  private async mergeRemote(remoteTip: string | null): Promise<string | null> {
    const remoteEntries = await this.read(remoteTip);
    for (let attempt = 0; attempt < 8; attempt++) {
      const localTip = await this.git.ref(LOCAL_REF);
      const localEntries = await this.read(localTip);
      const union = new Entries(localEntries);
      union.documents = new Map(localEntries.documents);
      union.publications = new Map(localEntries.publications);
      for (const [id, publication] of remoteEntries.publications) {
        if (union.publications.has(id) && !isDeepStrictEqual(union.publications.get(id), publication)) { throw new Error('Conflicting immutable paper publication IDs.'); }
        union.publications.set(id, publication);
      }
      for (const [hash, oid] of remoteEntries.documents) {
        if (union.documents.has(hash) && union.documents.get(hash) !== oid) { throw new Error('Conflicting GiTex document snapshots.'); }
        union.documents.set(hash, oid);
      }
      for (const [id, entry] of remoteEntries) {
        if (union.has(id) && !isDeepStrictEqual(union.get(id)!.event, entry.event)) { throw new Error('Conflicting immutable comment IDs. Sync stopped without overwriting data.'); }
        union.set(id, entry);
      }
      materialize([...union.values()].map(entry => entry.event));
      validatePublications(union);
      if (!remoteTip || localTip === remoteTip) { return remoteTip; }
      if (!localTip) {
        if (await this.advance(remoteTip, null)) { return remoteTip; }
      } else {
        const forward = await this.git.run(['merge-base', '--is-ancestor', localTip, remoteTip]);
        if (forward.code === 0 && union.size === remoteEntries.size && union.publications.size === remoteEntries.publications.size) {
          if (await this.advance(remoteTip, localTip)) { return remoteTip; }
          continue;
        }
        if (forward.code !== 0 && forward.code !== 1) { throw new GitError(forward, 'merge-base'); }
        const ancestor = await this.git.run(['merge-base', '--is-ancestor', remoteTip, localTip]);
        if (ancestor.code === 0 && union.size === localEntries.size && union.publications.size === localEntries.publications.size) { return remoteTip; }
        if (ancestor.code !== 0 && ancestor.code !== 1) { throw new GitError(ancestor, 'merge-base'); }
        const commit = await this.commit(union, [localTip, remoteTip]);
        if (await this.advance(commit, localTip)) { return remoteTip; }
      }
    }
    throw new Error('Comments are busy in another window. Try fetching again.');
  }

  private async read(tip: string | null): Promise<Entries> {
    if (!tip) { return new Entries(); }
    if (this.cachedArchive?.tip === tip) {
      const copy = new Entries(this.cachedArchive.entries); copy.documents = new Map(this.cachedArchive.entries.documents);
      copy.publications = new Map(this.cachedArchive.entries.publications); return copy;
    }
    const listing = await this.git.text(['ls-tree', '-r', '-l', '-z', tip]);
    const records = listing.split('\0').filter(Boolean).map(record => {
      const match = /^100644 blob ([a-f0-9]+) +([0-9]+)\t(.+)$/.exec(record);
      if (!match) { throw new Error('The GiTex metadata branch contains unsupported entries.'); }
      return { oid: match[1], size: Number(match[2]), path: match[3] };
    });
    if (!records.some(record => record.path === '_gitex.json') || records.some(record =>
      record.path !== '_gitex.json' && !/^(events|comments|papers)\/[a-f0-9-]{36}\.json$/.test(record.path) && !/^documents\/[a-f0-9]{64}\.txt$/.test(record.path))) {
      throw new Error('The gitex-comments branch is not a GiTex metadata branch. It has not been overwritten.');
    }
    const entries = new Entries(), files = new Map<string, string>();
    for (const record of records.filter(record => record.path.startsWith('documents/'))) { entries.documents.set(record.path.slice(10, -4), record.oid); }
    const metadata = records.filter(record => !record.path.startsWith('documents/'));
    let archiveVersion = 0;
    // Bound each Git response instead of reading the entire archive through one 32 MiB pipe.
    for (let offset = 0; offset < metadata.length;) {
      const chunk: typeof metadata = []; let size = 0;
      do { const record = metadata[offset++]; chunk.push(record); size += record.size + 100; }
      while (offset < metadata.length && size + metadata[offset].size < 8 * 1024 * 1024);
      const batch = await this.git.run(['cat-file', '--batch'], chunk.map(record => record.oid).join('\n') + '\n');
      if (batch.code !== 0) { throw new GitError(batch, 'cat-file'); }
      let cursor = 0;
      for (const record of chunk) {
        const end = batch.stdout.indexOf(10, cursor);
        const match = /^([a-f0-9]+) blob (\d+)$/.exec(batch.stdout.subarray(cursor, end).toString('utf8'));
        if (end < 0 || !match || match[1] !== record.oid || Number(match[2]) !== record.size) { throw new Error('Cannot read GiTex metadata objects.'); }
        const content = batch.stdout.subarray(end + 1, end + 1 + record.size).toString('utf8');
        this.cacheBlob(content, record.oid);
        cursor = end + 2 + record.size;
        if (record.path === '_gitex.json') {
          archiveVersion = JSON.parse(content).version;
          if (![commentMarker, checkpointMarker, marker, legacyMarker].includes(content)) { throw new Error('Unsupported GiTex metadata format. Update GiTex before syncing.'); }
        } else if (record.path.startsWith('papers/')) {
          const id = record.path.slice(7, -5); entries.publications.set(id, JSON.parse(content));
        } else { files.set(record.path, content); }
      }
    }
    for (const event of archiveEvents(files, archiveVersion)) {
      if ('anchor' in event && event.anchor?.tracking && !entries.documents.has(event.anchor.documentHash)) { throw new Error('A GiTex document snapshot is missing.'); }
      entries.set(event.id, { event });
    }
    if (archiveVersion < 3 && [...entries.values()].some(entry => entry.event.type === 'checkpoint' || entry.event.paperCommit)) {
      throw new Error('Commit-scoped reviews require GiTex metadata format 3.');
    }
    if (entries.publications.size && archiveVersion < 4) { throw new Error('Paper publications require GiTex metadata format 4.'); }
    materialize([...entries.values()].map(entry => entry.event));
    validatePublications(entries);
    const cached = new Entries(entries); cached.documents = new Map(entries.documents); cached.publications = new Map(entries.publications);
    this.cachedArchive = { tip, entries: cached };
    return entries;
  }

  private cacheBlob(text: string, oid: string): void {
    if (this.blobOids.size >= 4096) { this.blobOids.delete(this.blobOids.keys().next().value!); }
    this.blobOids.set(createHash('sha256').update(text).digest('hex'), oid);
  }

  private async writeBlob(text: string): Promise<string> {
    const known = this.blobOids.get(createHash('sha256').update(text).digest('hex'));
    if (known) { return known; }
    const oid = await this.git.text(['hash-object', '-w', '--stdin'], text);
    this.cacheBlob(text, oid); return oid;
  }

  private async commit(entries: Entries, parents: string[]): Promise<string> {
    validatePublications(entries);
    const files = archiveFiles([...entries.values()].map(entry => entry.event));
    for (const publication of entries.publications.values()) { files.set(`papers/${publication.id}.json`, JSON.stringify(publication)); }
    const directories = new Map<string, string[]>();
    for (const [file, text] of files) {
      const [directory, name] = file.split('/');
      const oid = await this.writeBlob(text);
      const lines = directories.get(directory) ?? []; lines.push(`100644 blob ${oid}\t${name}\n`); directories.set(directory, lines);
    }
    if (entries.documents.size) { directories.set('documents', [...entries.documents].map(([hash, oid]) => `100644 blob ${oid}\t${hash}.txt\n`)); }
    const markerOid = await this.writeBlob(commentMarker);
    const roots = [`100644 blob ${markerOid}\t_gitex.json\n`];
    for (const [name, lines] of directories) {
      const oid = await this.git.text(['mktree'], lines.sort().join(''));
      roots.push(`040000 tree ${oid}\t${name}\n`);
    }
    const tree = await this.git.text(['mktree'], roots.join(''));
    return this.git.text(['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent])], 'GiTex review update\n');
  }

  private async advance(next: string, expected: string | null): Promise<boolean> {
    const result = await this.git.run(['update-ref', LOCAL_REF, next, expected ?? '0'.repeat(next.length)]);
    if (result.code === 0) { return true; }
    // Retry only an actual competing update; permissions and disk errors must be surfaced.
    if (await this.git.ref(LOCAL_REF) !== expected) { return false; }
    throw new GitError(result, 'update-ref');
  }
}
