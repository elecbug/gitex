import { createHash, randomUUID } from 'node:crypto';
import { Anchor } from './anchor';
import { Git, GitError } from './git';
import { Author, materialize, parseEvent, ReviewEvent, ReviewThread } from './model';

export const LOCAL_REF = 'refs/gitex/comments';
export const REMOTE_REF = 'refs/heads/gitex-comments';
const marker = JSON.stringify({ format: 'gitex-comments', version: 1 });
type Entry = { event: ReviewEvent; oid: string };
type Entries = Map<string, Entry>;
type Payload = { type: 'create'; anchor: Anchor; body: string } | { type: 'reply'; body: string } | { type: 'state'; resolved: boolean };

export class ReviewStore {
  readonly git: Git;
  private pending: Promise<unknown> = Promise.resolve();
  private markerOid?: string;

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

  create(anchor: Anchor, body: string): Promise<string> {
    return this.append(undefined, { type: 'create', anchor, body: body.trim() });
  }
  reply(threadId: string, body: string): Promise<string> { return this.append(threadId, { type: 'reply', body: body.trim() }); }
  setResolved(threadId: string, resolved: boolean): Promise<string> { return this.append(threadId, { type: 'state', resolved }); }

  private append(threadId: string | undefined, payload: Payload): Promise<string> {
    return this.exclusive(async () => {
      const id = randomUUID();
      const author = await this.author();
      for (let attempt = 0; attempt < 8; attempt++) {
        const old = await this.git.ref(LOCAL_REF);
        const entries = await this.read(old);
        if (threadId && !entries.has(threadId)) { throw new Error('The comment thread no longer exists locally. Refresh or sync comments.'); }
        const clock = Math.max(0, ...[...entries.values()].map(entry => entry.event.clock)) + 1;
        const event = parseEvent(JSON.stringify({ version: 1, id, threadId: threadId ?? id, clock, at: new Date().toISOString(), author, ...payload }));
        const oid = await this.git.text(['hash-object', '-w', '--stdin'], JSON.stringify(event));
        entries.set(id, { event, oid });
        const commit = await this.commit(entries, old ? [old] : []);
        if (await this.advance(commit, old)) { return threadId ?? id; }
      }
      throw new Error('Comments are being updated in another window. Try again.');
    });
  }

  sync(remote = 'origin'): Promise<ReviewThread[]> {
    return this.exclusive(async () => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote)) { throw new Error('Choose a valid Git remote name with GiTex: Connect Repository.'); }
      await this.git.text(['remote', 'get-url', remote]);
      const tracking = `refs/gitex/remotes/${createHash('sha256').update(remote).digest('hex')}`;
      for (let attempt = 0; attempt < 5; attempt++) {
        const advertised = await this.git.run(['ls-remote', '--exit-code', '--heads', remote, REMOTE_REF]);
        let remoteTip: string | null = null;
        if (advertised.code === 0) {
          await this.git.text(['fetch', '--no-tags', '--no-write-fetch-head', remote, `+${REMOTE_REF}:${tracking}`]);
          remoteTip = await this.git.ref(tracking);
        } else if (advertised.code !== 2) { throw new GitError(advertised, 'ls-remote'); }
        const remoteEntries = await this.read(remoteTip);
        let ready = false;
        for (let localAttempt = 0; localAttempt < 8; localAttempt++) {
          const localTip = await this.git.ref(LOCAL_REF);
          const localEntries = await this.read(localTip);
          const union = new Map(localEntries);
          for (const [id, entry] of remoteEntries) {
            if (union.has(id) && union.get(id)!.oid !== entry.oid) { throw new Error('Conflicting immutable comment IDs. Sync stopped without overwriting data.'); }
            union.set(id, entry);
          }
          materialize([...union.values()].map(entry => entry.event));
          if (!remoteTip || localTip === remoteTip) { ready = true; break; }
          if (!localTip) {
            if (await this.advance(remoteTip, null)) { ready = true; break; }
          } else {
            const canFastForward = await this.git.run(['merge-base', '--is-ancestor', localTip, remoteTip]);
            if (canFastForward.code === 0 && union.size === remoteEntries.size) {
              if (await this.advance(remoteTip, localTip)) { ready = true; break; }
              continue;
            }
            if (canFastForward.code !== 0 && canFastForward.code !== 1) { throw new GitError(canFastForward, 'merge-base'); }
            const ancestor = await this.git.run(['merge-base', '--is-ancestor', remoteTip, localTip]);
            if (ancestor.code === 0 && union.size === localEntries.size) { ready = true; break; }
            if (ancestor.code !== 0 && ancestor.code !== 1) { throw new GitError(ancestor, 'merge-base'); }
            const commit = await this.commit(union, [localTip, remoteTip]);
            if (await this.advance(commit, localTip)) { ready = true; break; }
          }
        }
        if (!ready) { throw new Error('Comments are busy in another window. Try syncing again.'); }
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

  private async read(tip: string | null): Promise<Entries> {
    if (!tip) { return new Map(); }
    const listing = await this.git.text(['ls-tree', '-r', '-z', tip]);
    const records = listing.split('\0').filter(Boolean).map(record => {
      const match = /^100644 blob ([a-f0-9]+)\t(.+)$/.exec(record);
      if (!match) { throw new Error('The GiTex metadata branch contains unsupported entries.'); }
      return { oid: match[1], path: match[2] };
    });
    if (!records.some(record => record.path === '_gitex.json') || records.some(record =>
      record.path !== '_gitex.json' && !/^events\/[a-f0-9-]{36}\.json$/.test(record.path))) {
      throw new Error('The gitex-comments branch is not a GiTex metadata branch. It has not been overwritten.');
    }
    const batch = await this.git.run(['cat-file', '--batch'], records.map(record => record.oid).join('\n') + '\n');
    if (batch.code !== 0) { throw new GitError(batch, 'cat-file'); }
    const entries: Entries = new Map();
    let cursor = 0;
    for (const record of records) {
      const end = batch.stdout.indexOf(10, cursor);
      const header = batch.stdout.subarray(cursor, end).toString('utf8');
      const match = /^([a-f0-9]+) blob (\d+)$/.exec(header);
      if (end < 0 || !match || match[1] !== record.oid) { throw new Error('Cannot read GiTex metadata objects.'); }
      const length = Number(match[2]);
      const content = batch.stdout.subarray(end + 1, end + 1 + length).toString('utf8');
      cursor = end + 2 + length;
      if (record.path === '_gitex.json') {
        if (content !== marker) { throw new Error('Unsupported GiTex metadata format. Update GiTex before syncing.'); }
      } else {
        const event = parseEvent(content);
        if (record.path !== `events/${event.id}.json`) { throw new Error('Invalid GiTex event filename.'); }
        entries.set(event.id, { event, oid: record.oid });
      }
    }
    materialize([...entries.values()].map(entry => entry.event));
    return entries;
  }

  private async commit(entries: Entries, parents: string[]): Promise<string> {
    this.markerOid ??= await this.git.text(['hash-object', '-w', '--stdin'], marker);
    const eventTree = await this.git.text(['mktree'], [...entries].sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([id, entry]) => `100644 blob ${entry.oid}\t${id}.json\n`).join(''));
    const tree = await this.git.text(['mktree'], `100644 blob ${this.markerOid}\t_gitex.json\n040000 tree ${eventTree}\tevents\n`);
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
