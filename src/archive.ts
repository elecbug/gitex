import { parseEvent, ReviewEvent } from './model';

/** Logical events remain immutable; each comment/reply owns one physical file. */
export function archiveFiles(events: ReviewEvent[]): Map<string, string> {
  const files = new Map<string, string>();
  const comments = new Map<string, ReviewEvent[]>();
  const checkpoints = new Map<string, Extract<ReviewEvent, { type: 'checkpoint' }>>();
  for (const event of [...events].sort((a, b) => a.clock - b.clock || a.id.localeCompare(b.id, 'en'))) {
    if (event.type === 'create' || event.type === 'reply' || event.type === 'edit') {
      const id = event.type === 'edit' ? event.commentId : event.id;
      const revisions = comments.get(id) ?? []; revisions.push(event); comments.set(id, revisions);
    } else if (event.type === 'checkpoint') {
      const base = checkpoints.get(event.threadId);
      const ids = new Set(event.eventIds);
      if (base && base.clock < event.clock && base.eventIds.every(id => ids.has(id))) {
        const inherited = new Set(base.eventIds);
        const { eventIds, ...rest } = event;
        files.set(`events/${event.id}.json`, JSON.stringify({ ...rest, eventBase: base.id, eventDelta: eventIds.filter(id => !inherited.has(id)) }));
      } else { files.set(`events/${event.id}.json`, JSON.stringify(event)); }
      checkpoints.set(event.threadId, event);
    } else { files.set(`events/${event.id}.json`, JSON.stringify(event)); }
  }
  for (const [id, revisions] of comments) {
    files.set(`comments/${id}.json`, JSON.stringify({ version: 1, commentId: id, threadId: revisions[0].threadId, events: revisions }));
  }
  return files;
}

/** Expand checkpoint deltas before the ordinary event and ancestry validation. */
export function archiveEvents(files: Map<string, string>, version: number): ReviewEvent[] {
  const raw = new Map<string, any>();
  for (const [path, text] of files) {
    const value = JSON.parse(text);
    const grouped = path.startsWith('comments/');
    if (grouped && (version < 4 || value.version !== 1 || !Array.isArray(value.events) || !value.events.length || path !== `comments/${value.commentId}.json`)) {
      throw new Error('Invalid GiTex comment file.');
    }
    for (const event of grouped ? value.events : [value]) {
      if (!event || raw.has(event.id) || (grouped ?
        !['create', 'reply', 'edit'].includes(event.type) || event.threadId !== value.threadId ||
          (event.type === 'edit' ? event.commentId : event.id) !== value.commentId : path !== `events/${event.id}.json`)) {
        throw new Error('Invalid or duplicate GiTex event filename.');
      }
      raw.set(event.id, event);
    }
  }
  const expanded = new Map<string, ReviewEvent>();
  // Lamport order ensures a compact base has already been decoded, without recursion.
  for (const value of [...raw.values()].sort((a, b) => a.clock - b.clock || String(a.id).localeCompare(String(b.id), 'en'))) {
    let event = value;
    if ('eventBase' in value || 'eventDelta' in value) {
      const base = expanded.get(value.eventBase);
      if (version < 4 || value.type !== 'checkpoint' || value.eventIds !== undefined || base?.type !== 'checkpoint' ||
          base.threadId !== value.threadId || base.clock >= value.clock || !Array.isArray(value.eventDelta)) {
        throw new Error('Invalid compact GiTex checkpoint ancestry.');
      }
      const { eventBase, eventDelta, ...rest } = value;
      event = { ...rest, eventIds: [...base.eventIds, ...eventDelta].sort((a, b) => (raw.get(a)?.clock ?? 0) - (raw.get(b)?.clock ?? 0) || String(a).localeCompare(String(b), 'en')) };
    }
    expanded.set(event.id, parseEvent(JSON.stringify(event)));
  }
  return [...expanded.values()];
}
