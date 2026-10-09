import { Anchor, createAnchor, documentHash, Location, TextPosition } from './anchor';

export interface Edit { start: number; deleteCount: number; text: string; opaque?: boolean }
interface Span { start: number; end: number }
interface Fragment { range?: Span; gap: number; cut?: { text: string; offset: number; length: number; step: number } }
interface State { key: string; revision: string; uri: string; text: string; fragments: Fragment[]; step: number }
interface Entry extends State { history: State[] }
export interface EditTrackingState { version: 1; entries: State[] }
export const normalizedText = (text: string): string => text.replace(/\r\n/g, '\n');
export function offsetAt(text: string, position: TextPosition): number {
  let at = 0;
  for (let line = 0; line < position.line; line++) {
    const next = text.indexOf('\n', at);
    if (next < 0) { return text.length; }
    at = next + 1;
  }
  return Math.min(text.length, at + position.character);
}
export function positionAt(text: string, offset: number): TextPosition {
  const prefix = text.slice(0, offset);
  return { line: prefix.split('\n').length - 1, character: offset - prefix.lastIndexOf('\n') - 1 };
}
function anchorSpan(anchor: Anchor, text: string): Span {
  return { start: offsetAt(text, { line: anchor.startLine, character: anchor.logicalRange?.startCharacter ?? 0 }),
    end: offsetAt(text, { line: anchor.endLine, character: anchor.logicalRange?.endCharacter ?? text.split('\n')[anchor.endLine]?.length ?? 0 }) };
}
export function enableEditTracking(anchor: Anchor, text: string, fragments?: Span[]): Anchor {
  text = normalizedText(text);
  return { ...anchor, tracking: { version: 1, fragments: fragments ?? [anchorSpan(anchor, text)] } };
}

/** Exact character diff for changes received while the editor was closed. No similarity scoring. */
export function diffEdits(before: string, after: string): Edit[] {
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) { prefix++; }
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) { suffix++; }
  const left = before.slice(prefix, before.length - suffix), right = after.slice(prefix, after.length - suffix);
  if (!left && !right) { return []; }
  if (!left || !right) { return [{ start: prefix, deleteCount: left.length, text: right }]; }
  const trace: Map<number, number>[] = [];
  let frontier = new Map<number, number>([[1, 0]]), budget = 2_000_000;
  for (let distance = 0; distance <= Math.min(left.length + right.length, 1024); distance++) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (--budget < 0) { break; }
      const down = diagonal === -distance || diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1);
      let x = down ? frontier.get(diagonal + 1) ?? 0 : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < left.length && y < right.length && left[x] === right[y] && --budget >= 0) { x++; y++; }
      frontier.set(diagonal, x);
      if (x < left.length || y < right.length) { continue; }
      const operations: { kind: 'equal' | 'insert' | 'delete'; text: string }[] = [];
      for (let d = distance; d >= 0; d--) {
        const previous = trace[d], k = x - y;
        const next = k === -d || k !== d && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1) ? k + 1 : k - 1;
        const oldX = previous.get(next) ?? 0, oldY = oldX - next;
        while (x > oldX && y > oldY) { operations.push({ kind: 'equal', text: left[--x] }); y--; }
        if (!d) { break; }
        if (x === oldX) { operations.push({ kind: 'insert', text: right[--y] }); }
        else { operations.push({ kind: 'delete', text: left[--x] }); }
      }
      let cursor = prefix;
      const edits: Edit[] = [];
      let edit: Edit | undefined;
      for (const operation of operations.reverse()) {
        if (operation.kind === 'equal') { edit = undefined; cursor++; continue; }
        if (!edit) { edit = { start: cursor, deleteCount: 0, text: '' }; edits.push(edit); }
        if (operation.kind === 'insert') { edit.text += operation.text; }
        else { edit.deleteCount++; cursor++; }
      }
      return edits;
    }
    if (budget < 0) { break; }
  }
  // A bounded diff cannot prove correspondence inside a large replacement.
  return [{ start: prefix, deleteCount: left.length, text: right, opaque: true }];
}

const copyState = (entry: State): State => ({ key: entry.key, revision: entry.revision, uri: entry.uri, text: entry.text,
  fragments: structuredClone(entry.fragments), step: entry.step });

/** Ranges advance only through edit operations from a known document snapshot. */
export class EditTracking {
  private readonly live = new Map<string, Entry>();
  private readonly saved = new Map<string, State>();
  private readonly staged = new Set<string>();
  generation = 0;

  constructor(snapshot?: unknown) {
    const data = snapshot as EditTrackingState | undefined;
    if (data?.version !== 1 || !Array.isArray(data.entries)) { return; }
    for (const state of data.entries) {
      if (!state || typeof state.key !== 'string' || typeof state.revision !== 'string' || typeof state.uri !== 'string' ||
          typeof state.text !== 'string' || !Number.isSafeInteger(state.step) || !Array.isArray(state.fragments) ||
          state.fragments.length > 1024 || state.fragments.some(fragment => !fragment || !Number.isSafeInteger(fragment.gap) ||
            fragment.gap < 0 || fragment.gap > state.text.length || fragment.range &&
            (!Number.isSafeInteger(fragment.range.start) || !Number.isSafeInteger(fragment.range.end) || fragment.range.start < 0 ||
              fragment.range.end <= fragment.range.start || fragment.range.end > state.text.length))) { continue; }
      // Clipboard matching and undo checkpoints are deliberately session-local.
      const restored = { ...state, fragments: state.fragments.map(({ range, gap }) => ({ range, gap })) };
      this.saved.set(state.key, restored); this.live.set(state.key, { ...restored, history: [] });
    }
  }

  snapshot(): EditTrackingState { return { version: 1, entries: [...this.saved.values()] }; }
  has(key: string, revision: string): boolean { return this.live.get(key)?.revision === revision; }
  text(key: string): string | undefined { return this.live.get(key)?.text; }

  private stagingKey(uri: string, anchor: Anchor): string {
    return `draft:${uri}:${anchor.documentHash}:${JSON.stringify(anchor.tracking?.fragments)}`;
  }

  /** Start observing before an input box or asynchronous Git write can change the source. */
  stage(uri: string, anchor: Anchor, text: string): void {
    const key = this.stagingKey(uri, anchor);
    this.seed(key, '', uri, anchor, text); this.staged.add(key);
    if (this.staged.size > 64) {
      const oldest = this.staged.values().next().value!;
      this.staged.delete(oldest); this.live.delete(oldest);
    }
  }

  adopt(key: string, revision: string, uri: string, anchor: Anchor): boolean {
    const stagedKey = this.stagingKey(uri, anchor), entry = this.live.get(stagedKey);
    if (!entry) { return false; }
    this.live.set(key, { ...copyState(entry), key, revision, history: entry.history.map(state => ({ ...copyState(state), key, revision })) });
    this.live.delete(stagedKey); this.staged.delete(stagedKey);
    return true;
  }

  seed(key: string, revision: string, uri: string, anchor: Anchor, source: string): boolean {
    source = normalizedText(source);
    if (documentHash(source) !== anchor.documentHash) { return false; }
    const fragments = anchor.tracking?.fragments ?? [anchorSpan(anchor, source)];
    const owned = anchorSpan(anchor, source);
    if (source.slice(owned.start, owned.end) !== anchor.selected.join('\n') || !fragments.length || fragments.some(range =>
      !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start ||
      range.end > source.length || !source.slice(range.start, range.end).trim())) { return false; }
    this.live.set(key, { key, revision, uri, text: source, fragments: fragments.map(range => ({ range: { ...range }, gap: range.start })), step: 0, history: [] });
    return true;
  }

  change(uri: string, text: string, changes: { range: { start: TextPosition; end: TextPosition }; text: string }[], undoRedo = false): void {
    text = normalizedText(text);
    for (const entry of this.live.values()) {
      if (entry.uri !== uri || entry.text === text) { continue; }
      let edits = changes.map(change => ({ start: offsetAt(entry.text, change.range.start),
        deleteCount: offsetAt(entry.text, change.range.end) - offsetAt(entry.text, change.range.start), text: normalizedText(change.text) }));
      // Formatters and file reloads often report a whole-document replacement. Recover
      // exact operations inside that replacement instead of discarding every range.
      edits = edits.flatMap(edit => edit.deleteCount && edit.text && entry.fragments.some(fragment => fragment.range &&
        edit.start <= fragment.range.start && edit.start + edit.deleteCount >= fragment.range.end &&
        (edit.start < fragment.range.start || edit.start + edit.deleteCount > fragment.range.end)) ?
        diffEdits(entry.text.slice(edit.start, edit.start + edit.deleteCount), edit.text).map(part => ({ ...part, start: part.start + edit.start })) : [edit]);
      this.advance(entry, text, edits, undoRedo);
    }
  }

  locate(key: string, revision: string, text: string, persist = false): Location {
    const entry = this.live.get(key);
    if (!entry || entry.revision !== revision) { return { kind: 'pending', reason: 'Pending document · Pull the paper source to receive this comment’s document version, or reconnect the comment manually.' }; }
    text = normalizedText(text);
    if (entry.text !== text) { this.advance(entry, text, diffEdits(entry.text, text)); }
    if (persist && JSON.stringify(this.saved.get(key)) !== JSON.stringify(copyState(entry))) { this.saved.set(key, copyState(entry)); this.generation++; }
    const first = entry.fragments.find(fragment => fragment.range && text.slice(fragment.range.start, fragment.range.end).trim());
    if (!first?.range) {
      const gap = Math.min(entry.fragments[0]?.gap ?? 0, text.length);
      const position = positionAt(text, gap);
      return { kind: 'uncertain', estimatedLine: position.line, confidence: 1,
        reason: 'The selected text was removed. Its position is retained from editor edits; a matching cut and paste can reconnect it.',
        ...(position.character === 0 ? { insertionLine: position.line } : {}) };
    }
    const start = positionAt(text, first.range.start), end = positionAt(text, first.range.end);
    // A trailing selected newline belongs to the previous physical line.
    const endLine = end.line > start.line && end.character === 0 ? end.line - 1 : end.line;
    const endCharacter = endLine === end.line ? end.character : text.split('\n')[endLine].length;
    return { kind: 'attached', startLine: start.line, endLine,
      logicalRange: { startCharacter: start.character, endCharacter } };
  }

  reference(key: string, revision: string, anchor: Anchor, text: string, baseCommit: string | null): Anchor | undefined {
    const location = this.locate(key, revision, text);
    if (location.kind !== 'attached') { return undefined; }
    const next = createAnchor(anchor.path, text, location.startLine, location.endLine, baseCommit, location.logicalRange);
    const ranges = this.live.get(key)!.fragments.flatMap(fragment => fragment.range && normalizedText(text).slice(fragment.range.start, fragment.range.end).trim() ? [fragment.range] : []);
    return enableEditTracking(next, text, ranges);
  }

  private advance(entry: Entry, text: string, edits: Edit[], undoRedo = false): void {
    const old = copyState(entry);
    const restored = undoRedo ? [...entry.history].reverse().find(state => state.text === text) : undefined;
    if (restored) {
      Object.assign(entry, copyState(restored));
    } else {
      let applied = entry.text;
      for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        applied = applied.slice(0, edit.start) + edit.text + applied.slice(edit.start + edit.deleteCount);
      }
      if (applied !== text) { edits = diffEdits(entry.text, text); }
      // Deletions first in descending source order; insertions in that batch can match a cut.
      const insertions: Edit[] = [];
      for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        this.transform(entry, edit);
        entry.text = entry.text.slice(0, edit.start) + edit.text + entry.text.slice(edit.start + edit.deleteCount);
        insertions.push(edit);
      }
      // A move may be one multi-edit event with insertion before deletion. Revisit the
      // final inserted ranges only when their coordinates can be determined exactly.
      for (const edit of insertions.filter(edit => edit.text && !edit.deleteCount)) {
        const shift = edits.filter(other => other !== edit && other.start < edit.start).reduce((sum, other) => sum + other.text.length - other.deleteCount, 0);
        this.paste(entry, edit.text, edit.start + shift);
      }
      entry.text = text; entry.step++;
    }
    entry.history.push(old);
    if (entry.history.length > 32) { entry.history.shift(); }
  }

  private paste(entry: Entry, text: string, at: number): void {
    const matches = entry.fragments.filter(fragment => !fragment.range && fragment.cut?.text === text && entry.step - fragment.cut.step <= 100);
    // Only the most recent deletion with this content can supply a move.
    const step = Math.max(-1, ...matches.map(fragment => fragment.cut!.step));
    for (const fragment of matches.filter(fragment => fragment.cut!.step === step)) {
      const cut = fragment.cut!;
      fragment.range = { start: at + cut.offset, end: at + cut.offset + cut.length }; fragment.gap = fragment.range.start;
      delete fragment.cut;
    }
  }

  private transform(entry: Entry, edit: Edit): void {
    const a = edit.start, b = a + edit.deleteCount, length = edit.text.length, delta = length - edit.deleteCount;
    const removed = entry.text.slice(a, b);
    const next: Fragment[] = [];
    const gapAt = (gap: number) => gap <= a ? gap : gap >= b ? gap + delta : a;
    for (const fragment of entry.fragments) {
      const range = fragment.range;
      if (!range) { next.push({ ...fragment, gap: gapAt(fragment.gap) }); continue; }
      const { start, end } = range;
      if (b <= start) { next.push({ ...fragment, range: { start: start + delta, end: end + delta }, gap: start + delta }); continue; }
      if (a >= end) { next.push(fragment); continue; }
      if (!edit.deleteCount && !edit.text.trim()) {
        next.push({ range: { start, end: end + length }, gap: start }); continue;
      }
      // A replacement wholly inside the target proves continuity by its edit range.
      if (edit.deleteCount && length && !edit.opaque && a >= start && b <= end) {
        next.push({ range: { start, end: end + delta }, gap: start }); continue;
      }
      if (start < a) { next.push({ range: { start, end: a }, gap: start }); }
      if (edit.deleteCount) {
        const cutStart = Math.max(start, a), cutEnd = Math.min(end, b);
        next.push({ gap: a, ...(!length ? { cut: { text: removed, offset: cutStart - a, length: cutEnd - cutStart, step: entry.step } } : {}) });
      }
      if (end > b) { next.push({ range: { start: a + length, end: end + delta }, gap: a + length }); }
    }
    entry.fragments = next;
    if (length && !edit.deleteCount) { this.paste(entry, edit.text, a); }
  }
}
