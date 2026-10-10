import { Anchor, MAX_CONTEXT_LENGTH } from './anchor';
import { createHash } from 'node:crypto';

export interface Author { name: string; email: string }
/** Git identity is a collaboration convention, not authentication. */
export function sameAuthor(left: Author | undefined, right: Author): boolean {
  return !!left?.email.trim() && left.email.trim().toLowerCase() === right.email.trim().toLowerCase();
}
interface BaseEvent { version: 1; id: string; threadId: string; clock: number; at: string; author: Author; paperCommit?: string }
export type ReviewEvent = BaseEvent & (
  { type: 'create'; anchor: Anchor; body: string } |
  { type: 'reply'; body: string; anchor?: Anchor; anchorBasedOn?: string } |
  { type: 'edit'; commentId: string; basedOn: string; body: string; authorOnly?: true; merges?: string[]; anchor?: Anchor; anchorBasedOn?: string } |
  { type: 'move'; anchor: Anchor; basedOn: string } |
  { type: 'state'; resolved: boolean } |
  ({ type: 'checkpoint' } & PaperReviewState)
);
export interface PaperReviewState {
  paperCommit: string;
  eventIds: string[];
  /** First publication freezes inheritance; old clients' records are already frozen. */
  provisional?: boolean;
  source: 'commit' | 'working-copy';
  reviewVersion: string;
  basedOn: string;
  status: 'attached' | 'uncertain' | 'outdated' | 'pending';
  anchor?: Anchor;
  reason?: string;
  estimatedLine?: number;
  comments: { id: string; revision: string }[];
  resolved: boolean;
}
export type PaperReviewRecord = BaseEvent & PaperReviewState;
export interface CommentRevision { id: string; body: string; author: Author; at: string; basedOn?: string; merges?: string[] }
export interface ReviewComment {
  id: string;
  body: string;
  author: Author;
  at: string;
  revisions: CommentRevision[];
  conflictingRevisions: string[];
}
export interface ReviewThread {
  id: string;
  anchor: Anchor;
  /** Creation or last explicit move; automatic reference updates cannot replace it. */
  identityAnchor: Anchor;
  anchorRevision: string;
  anchorHistory: { id: string; anchor: Anchor; author: Author; at: string; kind: 'original' | 'update' | 'move'; basedOn?: string; from?: Anchor }[];
  comments: ReviewComment[];
  resolved: boolean;
  /** Fingerprint of substantive review events, excluding commit checkpoints. */
  reviewVersion: string;
  paperHistory: PaperReviewRecord[];
  events: ReviewEvent[];
  paperRecord?: PaperReviewRecord;
  archivedComments?: ReviewComment[];
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const objectId = /^[a-f0-9]{40}([a-f0-9]{24})?$/;
export function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') &&
    !value.includes(':') && !/[\x00-\x1f]/.test(value) && value.split('/').every(part => part !== '..' && part !== '.' && part !== '' && part.toLowerCase() !== '.git');
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(line => typeof line === 'string' && !line.includes('\n')); }

export function validAnchor(value: unknown): value is Anchor {
  if (!value || typeof value !== 'object') { return false; }
  const a = value as Anchor;
  if (!validPath(a.path) ||
      !(a.baseCommit === null || (typeof a.baseCommit === 'string' && objectId.test(a.baseCommit))) ||
      typeof a.documentHash !== 'string' || !/^[a-f0-9]{64}$/.test(a.documentHash) ||
      !Number.isSafeInteger(a.startLine) || a.startLine < 0 || !Number.isSafeInteger(a.endLine) || a.endLine < a.startLine ||
      !strings(a.selected) || a.selected.length !== a.endLine - a.startLine + 1 || !a.selected.some(line => line.trim()) ||
      !strings(a.before) || a.before.length > 3 || !strings(a.after) || a.after.length > 3 ||
      !Number.isSafeInteger(a.occurrences) || a.occurrences < 1 ||
      (a.afterBoundary !== undefined && a.afterBoundary !== 'document-end' && a.afterBoundary !== 'file-end')) { return false; }
  if (a.logicalRange !== undefined) {
    const range = a.logicalRange;
    if (!range || typeof range !== 'object' || Array.isArray(range) ||
        !Number.isSafeInteger(range.startCharacter) || range.startCharacter < 0 ||
        !Number.isSafeInteger(range.endCharacter) || range.endCharacter < 0 ||
        range.endCharacter !== a.selected.at(-1)!.length + (a.selected.length === 1 ? range.startCharacter : 0)) { return false; }
  }
  if (a.tracking !== undefined && (!a.tracking || a.tracking.version !== 1 || !Array.isArray(a.tracking.fragments) ||
      !a.tracking.fragments.length || a.tracking.fragments.length > 1024 || a.tracking.fragments.some(fragment =>
        !fragment || !Number.isSafeInteger(fragment.start) || !Number.isSafeInteger(fragment.end) || fragment.start < 0 || fragment.end <= fragment.start))) { return false; }
  if (a.tracking?.evidence !== undefined && !['observed', 'reconstructed'].includes(a.tracking.evidence)) { return false; }
  if (a.tracking?.insertions !== undefined && (!Array.isArray(a.tracking.insertions) || a.tracking.insertions.length > 1024 ||
      a.tracking.insertions.some(range => !range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
        range.start < 0 || range.end <= range.start))) { return false; }
  return a.sentenceContext === undefined || (!!a.sentenceContext && !Array.isArray(a.sentenceContext) &&
    typeof a.sentenceContext === 'object' && (['before', 'after'] as const).every(side =>
      typeof a.sentenceContext![side] === 'string' && a.sentenceContext![side].length <= MAX_CONTEXT_LENGTH &&
      !/[\r\n\0]/u.test(a.sentenceContext![side])));
}

export function parseEvent(text: string): ReviewEvent {
  const e = JSON.parse(text);
  const bad = () => { throw new Error('Invalid GiTex review data. No remote data has been overwritten.'); };
  if (!e || e.version !== 1 || !uuid.test(e.id) || !uuid.test(e.threadId) || !Number.isSafeInteger(e.clock) || e.clock < 1 ||
      typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at)) || !e.author ||
      typeof e.author.name !== 'string' || typeof e.author.email !== 'string') { return bad(); }
  if (e.paperCommit !== undefined && (typeof e.paperCommit !== 'string' || !objectId.test(e.paperCommit))) { return bad(); }
  if (e.type === 'create' || e.type === 'reply' || e.type === 'edit') {
    if (typeof e.body !== 'string' || !e.body.trim() || e.body.length > 100_000) { return bad(); }
  }
  if (e.type === 'create' && e.threadId !== e.id) { return bad(); }
  if (e.type === 'create' || e.type === 'move' || ((e.type === 'edit' || e.type === 'reply') && e.anchor !== undefined)) {
    if (!validAnchor(e.anchor)) { return bad(); }
  }
  if ((e.type === 'edit' || e.type === 'reply') && e.anchorBasedOn !== undefined && (!e.anchor || !uuid.test(e.anchorBasedOn))) { return bad(); }
  if (e.type === 'state') {
    if (typeof e.resolved !== 'boolean') { return bad(); }
  } else if (e.type === 'checkpoint') {
    if (typeof e.paperCommit !== 'string' || !objectId.test(e.paperCommit) || !uuid.test(e.basedOn) ||
        e.provisional !== undefined && typeof e.provisional !== 'boolean' ||
        !['commit', 'working-copy'].includes(e.source) || !Array.isArray(e.eventIds) || !e.eventIds.length ||
        e.eventIds.some((id: unknown) => typeof id !== 'string' || !uuid.test(id)) || new Set(e.eventIds).size !== e.eventIds.length ||
        typeof e.reviewVersion !== 'string' || !/^[a-f0-9]{64}$/.test(e.reviewVersion) ||
        !['attached', 'uncertain', 'outdated', 'pending'].includes(e.status) || typeof e.resolved !== 'boolean' ||
        !Array.isArray(e.comments) || !e.comments.length || e.comments.some((comment: any) => !comment || !uuid.test(comment.id) || !uuid.test(comment.revision)) ||
        new Set(e.comments.map((comment: any) => comment.id)).size !== e.comments.length ||
        e.reason !== undefined && (typeof e.reason !== 'string' || e.reason.length > MAX_CONTEXT_LENGTH) ||
        e.estimatedLine !== undefined && (!Number.isSafeInteger(e.estimatedLine) || e.estimatedLine < 0) ||
        (e.status === 'attached' ? !validAnchor(e.anchor) || e.source === 'commit' && (e.anchor.baseCommit !== e.paperCommit || !e.anchor.tracking) : e.anchor !== undefined)) { return bad(); }
  } else if (e.type === 'move') {
    if (!uuid.test(e.basedOn)) { return bad(); }
  } else if (e.type === 'edit') {
    if (!uuid.test(e.commentId) || !uuid.test(e.basedOn) || e.authorOnly !== undefined && e.authorOnly !== true ||
        e.merges !== undefined && (!Array.isArray(e.merges) || e.merges.some((id: unknown) => typeof id !== 'string' || !uuid.test(id)) || new Set(e.merges).size !== e.merges.length)) { return bad(); }
  } else if (e.type !== 'reply' && e.type !== 'create') { return bad(); }
  return e as ReviewEvent;
}

export function materialize(events: ReviewEvent[]): ReviewThread[] {
  const ordered = [...events].sort((a, b) => a.clock - b.clock || a.id.localeCompare(b.id, 'en'));
  const threads = new Map<string, ReviewThread>();
  const comments = new Map<string, { threadId: string; comment: ReviewComment }>();
  const applied = new Map<string, ReviewEvent>();
  const savedReviews = new Map<string, ReviewThread>();
  const references = new Map<string, { threadId: string; anchor: Anchor; clock: number; moveId: string }>();
  const activeMove = new Map<string, string>();
  const versions = new Map<string, string[]>();
  for (const e of ordered) {
    if (e.type === 'create') { threads.set(e.id, { id: e.id, anchor: e.anchor, identityAnchor: e.anchor, anchorRevision: e.id, anchorHistory: [], comments: [], resolved: false,
      reviewVersion: '', paperHistory: [], events: [] }); versions.set(e.id, []); }
  }
  for (const e of ordered) {
    const thread = threads.get(e.threadId);
    if (!thread) { throw new Error('A GiTex comment references a missing thread.'); }
    if (e.type === 'checkpoint') {
      const base = references.get(e.basedOn);
      if (!base || base.threadId !== e.threadId || base.clock >= e.clock || e.anchor && e.anchor.path !== base.anchor.path ||
          e.comments.some(saved => { const target = comments.get(saved.id); return !target || target.threadId !== e.threadId ||
            !target.comment.revisions.some(revision => revision.id === saved.revision); })) {
        throw new Error('A GiTex paper checkpoint references an invalid review revision.');
      }
      if (e.eventIds.some(id => !applied.has(id) || applied.get(id)!.threadId !== e.threadId) || !e.eventIds.includes(e.threadId)) {
        throw new Error('A GiTex paper checkpoint contains invalid event ancestry.');
      }
      const cacheKey = e.threadId + ':' + e.eventIds.join(',');
      const saved = savedReviews.get(cacheKey) ?? materialize(e.eventIds.map(id => applied.get(id)!))[0];
      savedReviews.set(cacheKey, saved);
      if (saved.reviewVersion !== e.reviewVersion || saved.anchorRevision !== e.basedOn || saved.resolved !== e.resolved ||
          JSON.stringify(saved.comments.map(c => ({ id: c.id, revision: c.revisions.at(-1)!.id }))) !== JSON.stringify(e.comments)) {
        throw new Error('A GiTex paper checkpoint does not match its recorded review state.');
      }
      thread.paperHistory.push(e);
      continue;
    }
    versions.get(e.threadId)!.push(e.id);
    thread.events.push(e);
    if ((e.type === 'create' || e.type === 'reply' || e.type === 'edit' || e.type === 'move') && e.anchor) {
      const basedOn = e.type === 'move' ? e.basedOn : e.type === 'create' ? undefined : e.anchorBasedOn ?? e.threadId;
      const base = basedOn ? references.get(basedOn) : undefined;
      if (basedOn && (!base || base.threadId !== e.threadId || base.clock >= e.clock)) {
        throw new Error('A GiTex location change references an invalid tracking revision.');
      }
      if (e.type !== 'create' && e.type !== 'move' && e.anchor.path !== base!.anchor.path) {
        throw new Error('A GiTex tracking update cannot change the file path.');
      }
      const moveId = e.type === 'move' || e.type === 'create' ? e.id : base!.moveId;
      references.set(e.id, { threadId: e.threadId, anchor: e.anchor, clock: e.clock, moveId });
      if (e.type === 'create' || e.type === 'move') { activeMove.set(e.threadId, moveId); thread.identityAnchor = e.anchor; }
      const changed = JSON.stringify(e.anchor) !== JSON.stringify(thread.anchor);
      const recorded = !thread.anchorHistory.length || changed || e.type === 'move';
      if (recorded) {
        thread.anchorHistory.push({ id: e.id, anchor: e.anchor, author: e.author, at: e.at,
          kind: e.type === 'create' ? 'original' : e.type === 'move' ? 'move' : 'update', basedOn, from: e.type === 'move' ? base!.anchor : undefined });
      }
      // Automatic snapshots from an older location must not undo a concurrent manual move.
      if (activeMove.get(e.threadId) === moveId && recorded) { thread.anchor = e.anchor; thread.anchorRevision = e.id; }
    }
    if (e.type === 'state') { thread.resolved = e.resolved; }
    else if (e.type === 'edit') {
      const target = comments.get(e.commentId);
      const base = applied.get(e.basedOn);
      if (!target || target.threadId !== e.threadId || !base || base.clock >= e.clock ||
          !target.comment.revisions.some(revision => revision.id === e.basedOn)) {
        throw new Error('A GiTex edit references an invalid comment or revision.');
      }
      if (e.authorOnly && !sameAuthor(e.author, target.comment.author)) { throw new Error('Only the original author can edit this comment.'); }
      if (e.merges?.some(id => !target.comment.revisions.some(revision => revision.id === id))) {
        throw new Error('A GiTex edit resolves an unknown revision.');
      }
      target.comment.body = e.body;
      target.comment.revisions.push({ id: e.id, body: e.body, author: e.author, at: e.at, basedOn: e.basedOn, ...(e.merges ? { merges: e.merges } : {}) });
    } else if (e.type !== 'move') {
      const revision = { id: e.id, body: e.body, author: e.author, at: e.at };
      const comment = { ...revision, revisions: [revision], conflictingRevisions: [] };
      thread.comments.push(comment);
      comments.set(e.id, { threadId: e.threadId, comment });
    }
    applied.set(e.id, e);
  }
  for (const thread of threads.values()) {
    thread.reviewVersion = createHash('sha256').update(versions.get(thread.id)!.join('\n')).digest('hex');
    for (const comment of thread.comments) {
      const superseded = new Set(comment.revisions.flatMap(revision => [...(revision.basedOn ? [revision.basedOn] : []), ...(revision.merges ?? [])]));
      const heads = comment.revisions.filter(revision => !superseded.has(revision.id)).map(revision => revision.id);
      comment.conflictingRevisions = heads.length > 1 ? heads : [];
    }
  }
  return [...threads.values()];
}

/** A paper version inherits an explicit event set, never the global latest discussion.
 * Concurrent saves on the same commit are unioned; immutable edits retain both histories. */
export function reviewAtCommit(thread: ReviewThread, commit: string | null): ReviewThread | undefined {
  if (!commit) { return thread.paperHistory.length ? undefined : thread; }
  const records = thread.paperHistory.filter(record => record.paperCommit === commit);
  if (!records.length) { return undefined; }
  const ids = new Set(records.flatMap(record => record.eventIds));
  const review = materialize(thread.events.filter(event => ids.has(event.id)))[0];
  // A later concurrent reply at an obsolete location cannot replace a manual move's geometry.
  const latest = [...records].reverse().find(record => record.basedOn === review.anchorRevision) ?? records.at(-1)!;
  return { ...review, paperHistory: thread.paperHistory, paperRecord: latest, archivedComments: thread.comments };
}
