import { createHash, randomUUID } from 'node:crypto';
import { Anchor, documentHash } from './anchor';
import { Git, GitError } from './git';
import { Author, materialize, parseEvent, ReviewEvent, ReviewThread } from './model';
import { snapshotChangesPresent } from './documentSync';

export const LOCAL_REF = 'refs/gitex/comments';
export const REMOTE_REF = 'refs/heads/gitex-comments';
const legacyMarker = JSON.stringify({ format: 'gitex-comments', version: 1 });
const marker = JSON.stringify({ format: 'gitex-comments', version: 2 });
type Entry = { event: ReviewEvent; oid: string };
class Entries extends Map<string, Entry> { documents = new Map<string, string>(); }
type Payload = { type: 'create'; anchor: Anchor; body: string } | { type: 'reply'; body: string; anchor?: Anchor; anchorBasedOn?: string } |
  { type: 'edit'; commentId: string; basedOn: string; body: string; anchor?: Anchor; anchorBasedOn?: string } |
  { type: 'move'; anchor: Anchor; basedOn: string } | { type: 'state'; resolved: boolean };

export class ReviewStore {
  readonly git: Git;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(readonly root: string) { this.git = new Git(root); }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action, action);
    this.pending = next.catch(() => undefined);
    return next;
  }

  async author(): Promise<Author> {
    const identity = await this.git.text(['var', 'GIT_AUTHOR_IDENT']);
    const match = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(identity);
    if (!match) { throw new Error('Configure Git user.name and user.email before writing comments.'); }
    return { name: match[1], email: match[2] };
  }

  async threads(): Promise<ReviewThread[]> {
    return materialize([...await this.read(await this.git.ref(LOCAL_REF))].map(([, entry]) => entry.event));
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

  create(anchor: Anchor, body: string, document?: string): Promise<string> {
    return this.append(undefined, { type: 'create', anchor, body: body.trim() }, document);
  }
  reply(threadId: string, body: string, anchor?: Anchor, anchorBasedOn?: string, document?: string): Promise<string> { return this.append(threadId, { type: 'reply', body: body.trim(), anchor, anchorBasedOn }, document); }
  edit(threadId: string, commentId: string, body: string, basedOn: string, anchor?: Anchor, anchorBasedOn?: string, document?: string): Promise<string> {
    return this.append(threadId, { type: 'edit', commentId, basedOn, body: body.trim(), anchor, anchorBasedOn }, document);
  }
  move(threadId: string, anchor: Anchor, basedOn: string, document?: string): Promise<string> { return this.append(threadId, { type: 'move', anchor, basedOn }, document); }
  setResolved(threadId: string, resolved: boolean): Promise<string> { return this.append(threadId, { type: 'state', resolved }); }

  private append(threadId: string | undefined, payload: Payload, document?: string): Promise<string> {
    return this.exclusive(async () => {
      const id = randomUUID();
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
        const thread = threadId ? materialize([...entries.values()].map(entry => entry.event)).find(thread => thread.id === threadId) : undefined;
        if (payload.type === 'move' && payload.basedOn !== thread!.anchorRevision) {
          throw new Error('This comment location changed while you were choosing a destination. Refresh and move it again.');
        }
        let anchorBasedOn: string | undefined;
        if ((payload.type === 'reply' || payload.type === 'edit') && payload.anchor) {
          if (payload.anchor.path !== thread!.anchor.path) { throw new Error('A GiTex tracking update cannot change the file path. The comment location changed; refresh before saving.'); }
          anchorBasedOn = payload.anchorBasedOn ?? thread!.anchorRevision;
          if (anchorBasedOn !== thread!.anchorRevision) { throw new Error('The comment location changed while you were editing. Your draft is preserved. Refresh before saving.'); }
        }
        if (payload.type === 'edit') {
          const comment = thread?.comments.find(comment => comment.id === payload.commentId);
          if (!comment) { throw new Error('The comment to edit does not exist in this thread.'); }
          if (comment.revisions.at(-1)!.id !== payload.basedOn) {
            throw new Error('This comment changed while you were editing. Your draft is preserved. Review the history, then cancel and edit the latest version.');
          }
          if (comment.body === payload.body && (!payload.anchor || JSON.stringify(payload.anchor) === JSON.stringify(thread!.anchor))) { return threadId!; }
        }
        const clock = Math.max(0, ...[...entries.values()].map(entry => entry.event.clock)) + 1;
        const event = parseEvent(JSON.stringify({ version: 1, id, threadId: threadId ?? id, clock, at: new Date().toISOString(), author, ...payload,
          ...(anchorBasedOn ? { anchorBasedOn } : {}) }));
        const oid = await this.git.text(['hash-object', '-w', '--stdin'], JSON.stringify(event));
        entries.set(id, { event, oid });
        materialize([...entries.values()].map(entry => entry.event));
        const commit = await this.commit(entries, old ? [old] : []);
        if (await this.advance(commit, old)) { return threadId ?? id; }
      }
      throw new Error('Comments are being updated in another window. Try again.');
    });
  }

  pull(remote = 'origin'): Promise<ReviewThread[]> {
    return this.exclusive(async () => {
      await this.receive(remote);
      return this.threads();
    });
  }

  sync(remote = 'origin'): Promise<ReviewThread[]> {
    return this.exclusive(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const remoteTip = await this.receive(remote);
        const publishTip = await this.git.ref(LOCAL_REF);
        if (!publishTip || publishTip === remoteTip) { return this.threads(); }
        // Publish the exact snapshot we validated. A later local edit stays queued for the next sync.
        const pushed = await this.git.run(['push', '--porcelain', remote, `${publishTip}:${REMOTE_REF}`]);
        if (pushed.code === 0) { return this.threads(); }
        const status = pushed.stdout.toString('utf8') + pushed.stderr;
        const concurrentRejection = /\[(?:remote )?rejected\].*\((fetch first|non-fast-forward|failed to update ref)\)/.test(status);
        if (!concurrentRejection) { throw new GitError(pushed, 'push'); }
        // Another user published first: fetch, union immutable events, and retry a normal push.
      }
      throw new Error('Other users are updating comments. Your local comments are saved; sync again.');
    });
  }

  private async receive(remote: string): Promise<string | null> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote)) { throw new Error('Choose a valid Git remote name with GiTex: Connect Repository.'); }
    await this.git.text(['remote', 'get-url', remote]);
    const tracking = `refs/gitex/remotes/${createHash('sha256').update(remote).digest('hex')}`;
    const advertised = await this.git.run(['ls-remote', '--exit-code', '--heads', remote, REMOTE_REF]);
    let remoteTip: string | null = null;
    if (advertised.code === 0) {
      await this.git.text(['fetch', '--no-tags', '--no-write-fetch-head', remote, `+${REMOTE_REF}:${tracking}`]);
      remoteTip = await this.git.ref(tracking);
    } else if (advertised.code !== 2) { throw new GitError(advertised, 'ls-remote'); }
    const remoteEntries = await this.read(remoteTip);
    for (let attempt = 0; attempt < 8; attempt++) {
      const localTip = await this.git.ref(LOCAL_REF);
      const localEntries = await this.read(localTip);
      const union = new Entries(localEntries);
      union.documents = new Map(localEntries.documents);
      for (const [hash, oid] of remoteEntries.documents) {
        if (union.documents.has(hash) && union.documents.get(hash) !== oid) { throw new Error('Conflicting GiTex document snapshots.'); }
        union.documents.set(hash, oid);
      }
      for (const [id, entry] of remoteEntries) {
        if (union.has(id) && union.get(id)!.oid !== entry.oid) { throw new Error('Conflicting immutable comment IDs. Sync stopped without overwriting data.'); }
        union.set(id, entry);
      }
      materialize([...union.values()].map(entry => entry.event));
      if (!remoteTip || localTip === remoteTip) { return remoteTip; }
      if (!localTip) {
        if (await this.advance(remoteTip, null)) { return remoteTip; }
      } else {
        const forward = await this.git.run(['merge-base', '--is-ancestor', localTip, remoteTip]);
        if (forward.code === 0 && union.size === remoteEntries.size) {
          if (await this.advance(remoteTip, localTip)) { return remoteTip; }
          continue;
        }
        if (forward.code !== 0 && forward.code !== 1) { throw new GitError(forward, 'merge-base'); }
        const ancestor = await this.git.run(['merge-base', '--is-ancestor', remoteTip, localTip]);
        if (ancestor.code === 0 && union.size === localEntries.size) { return remoteTip; }
        if (ancestor.code !== 0 && ancestor.code !== 1) { throw new GitError(ancestor, 'merge-base'); }
        const commit = await this.commit(union, [localTip, remoteTip]);
        if (await this.advance(commit, localTip)) { return remoteTip; }
      }
    }
    throw new Error('Comments are busy in another window. Try fetching again.');
  }

  private async read(tip: string | null): Promise<Entries> {
    if (!tip) { return new Entries(); }
    const listing = await this.git.text(['ls-tree', '-r', '-z', tip]);
    const records = listing.split('\0').filter(Boolean).map(record => {
      const match = /^100644 blob ([a-f0-9]+)\t(.+)$/.exec(record);
      if (!match) { throw new Error('The GiTex metadata branch contains unsupported entries.'); }
      return { oid: match[1], path: match[2] };
    });
    if (!records.some(record => record.path === '_gitex.json') || records.some(record =>
      record.path !== '_gitex.json' && !/^events\/[a-f0-9-]{36}\.json$/.test(record.path) && !/^documents\/[a-f0-9]{64}\.txt$/.test(record.path))) {
      throw new Error('The gitex-comments branch is not a GiTex metadata branch. It has not been overwritten.');
    }
    const metadata = records.filter(record => !record.path.startsWith('documents/'));
    const batch = await this.git.run(['cat-file', '--batch'], metadata.map(record => record.oid).join('\n') + '\n');
    if (batch.code !== 0) { throw new GitError(batch, 'cat-file'); }
    const entries = new Entries();
    for (const record of records.filter(record => record.path.startsWith('documents/'))) { entries.documents.set(record.path.slice(10, -4), record.oid); }
    let cursor = 0;
    for (const record of metadata) {
      const end = batch.stdout.indexOf(10, cursor);
      const header = batch.stdout.subarray(cursor, end).toString('utf8');
      const match = /^([a-f0-9]+) blob (\d+)$/.exec(header);
      if (end < 0 || !match || match[1] !== record.oid) { throw new Error('Cannot read GiTex metadata objects.'); }
      const length = Number(match[2]);
      const content = batch.stdout.subarray(end + 1, end + 1 + length).toString('utf8');
      cursor = end + 2 + length;
      if (record.path === '_gitex.json') {
        if (content !== marker && content !== legacyMarker) { throw new Error('Unsupported GiTex metadata format. Update GiTex before syncing.'); }
      } else {
        const event = parseEvent(content);
        if (record.path !== `events/${event.id}.json`) { throw new Error('Invalid GiTex event filename.'); }
        if ('anchor' in event && event.anchor?.tracking && !entries.documents.has(event.anchor.documentHash)) { throw new Error('A GiTex document snapshot is missing.'); }
        entries.set(event.id, { event, oid: record.oid });
      }
    }
    materialize([...entries.values()].map(entry => entry.event));
    return entries;
  }

  private async commit(entries: Entries, parents: string[]): Promise<string> {
    const markerOid = await this.git.text(['hash-object', '-w', '--stdin'], entries.documents.size ? marker : legacyMarker);
    const eventTree = await this.git.text(['mktree'], [...entries].sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([id, entry]) => `100644 blob ${entry.oid}\t${id}.json\n`).join(''));
    const documents = entries.documents.size ? await this.git.text(['mktree'], [...entries.documents].sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([hash, oid]) => `100644 blob ${oid}\t${hash}.txt\n`).join('')) : undefined;
    const tree = await this.git.text(['mktree'], `100644 blob ${markerOid}\t_gitex.json\n040000 tree ${eventTree}\tevents\n` +
      (documents ? `040000 tree ${documents}\tdocuments\n` : ''));
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
