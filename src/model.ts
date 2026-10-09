import { Anchor } from './anchor';

export interface Author { name: string; email: string }
interface BaseEvent { version: 1; id: string; threadId: string; clock: number; at: string; author: Author }
export type ReviewEvent = BaseEvent & (
  { type: 'create'; anchor: Anchor; body: string } |
  { type: 'reply'; body: string; anchor?: Anchor } |
  { type: 'edit'; commentId: string; basedOn: string; body: string; anchor?: Anchor } |
  { type: 'state'; resolved: boolean }
);
export interface CommentRevision { id: string; body: string; author: Author; at: string; basedOn?: string }
export interface ReviewComment {
  id: string;
  body: string;
  author: Author;
  at: string;
  revisions: CommentRevision[];
}
export interface ReviewThread {
  id: string;
  anchor: Anchor;
  anchorHistory: { id: string; anchor: Anchor; author: Author; at: string }[];
  comments: ReviewComment[];
  resolved: boolean;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const objectId = /^[a-f0-9]{40}([a-f0-9]{24})?$/;
export function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') &&
    !value.includes(':') && !/[\x00-\x1f]/.test(value) && value.split('/').every(part => part !== '..' && part !== '.' && part !== '' && part.toLowerCase() !== '.git');
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(line => typeof line === 'string' && !line.includes('\n')); }

export function parseEvent(text: string): ReviewEvent {
  const e = JSON.parse(text);
  const bad = () => { throw new Error('Invalid GiTex review data. No remote data has been overwritten.'); };
  if (!e || e.version !== 1 || !uuid.test(e.id) || !uuid.test(e.threadId) || !Number.isSafeInteger(e.clock) || e.clock < 1 ||
      typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at)) || !e.author ||
      typeof e.author.name !== 'string' || typeof e.author.email !== 'string') { return bad(); }
  if (e.type === 'create' || e.type === 'reply' || e.type === 'edit') {
    if (typeof e.body !== 'string' || !e.body.trim() || e.body.length > 100_000) { return bad(); }
  }
  if (e.type === 'create' && e.threadId !== e.id) { return bad(); }
  if (e.type === 'create' || ((e.type === 'edit' || e.type === 'reply') && e.anchor !== undefined)) {
    const a = e.anchor;
    if (!a || !validPath(a.path) ||
        !(a.baseCommit === null || (typeof a.baseCommit === 'string' && objectId.test(a.baseCommit))) ||
        typeof a.documentHash !== 'string' || !/^[a-f0-9]{64}$/.test(a.documentHash) ||
        !Number.isSafeInteger(a.startLine) || a.startLine < 0 || !Number.isSafeInteger(a.endLine) || a.endLine < a.startLine ||
        !strings(a.selected) || a.selected.length !== a.endLine - a.startLine + 1 || !a.selected.some((line: string) => line.trim()) ||
        !strings(a.before) || a.before.length > 3 || !strings(a.after) || a.after.length > 3 ||
        !Number.isSafeInteger(a.occurrences) || a.occurrences < 1) { return bad(); }
  }
  if (e.type === 'state') {
    if (typeof e.resolved !== 'boolean') { return bad(); }
  } else if (e.type === 'edit') {
    if (!uuid.test(e.commentId) || !uuid.test(e.basedOn)) { return bad(); }
  } else if (e.type !== 'reply' && e.type !== 'create') { return bad(); }
  return e as ReviewEvent;
}

export function materialize(events: ReviewEvent[]): ReviewThread[] {
  const ordered = [...events].sort((a, b) => a.clock - b.clock || a.id.localeCompare(b.id, 'en'));
  const threads = new Map<string, ReviewThread>();
  const comments = new Map<string, { threadId: string; comment: ReviewComment }>();
  const applied = new Map<string, ReviewEvent>();
  for (const e of ordered) {
    if (e.type === 'create') { threads.set(e.id, { id: e.id, anchor: e.anchor, anchorHistory: [], comments: [], resolved: false }); }
  }
  for (const e of ordered) {
    const thread = threads.get(e.threadId);
    if (!thread) { throw new Error('A GiTex comment references a missing thread.'); }
    if ((e.type === 'create' || e.type === 'reply' || e.type === 'edit') && e.anchor) {
      if (e.anchor.path !== thread.anchor.path) { throw new Error('A GiTex tracking update cannot change the file path.'); }
      if (!thread.anchorHistory.length || JSON.stringify(e.anchor) !== JSON.stringify(thread.anchor)) {
        thread.anchorHistory.push({ id: e.id, anchor: e.anchor, author: e.author, at: e.at });
        thread.anchor = e.anchor;
      }
    }
    if (e.type === 'state') { thread.resolved = e.resolved; }
    else if (e.type === 'edit') {
      const target = comments.get(e.commentId);
      const base = applied.get(e.basedOn);
      if (!target || target.threadId !== e.threadId || !base || base.clock >= e.clock ||
          !target.comment.revisions.some(revision => revision.id === e.basedOn)) {
        throw new Error('A GiTex edit references an invalid comment or revision.');
      }
      target.comment.body = e.body;
      target.comment.revisions.push({ id: e.id, body: e.body, author: e.author, at: e.at, basedOn: e.basedOn });
    } else {
      const revision = { id: e.id, body: e.body, author: e.author, at: e.at };
      const comment = { ...revision, revisions: [revision] };
      thread.comments.push(comment);
      comments.set(e.id, { threadId: e.threadId, comment });
    }
    applied.set(e.id, e);
  }
  return [...threads.values()];
}
