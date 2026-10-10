import { Anchor, createAnchor, documentHash, Location, TextPosition } from './anchor';

export interface Edit { start: number; deleteCount: number; text: string; opaque?: boolean; reconstructed?: boolean; pairable?: boolean }
export interface Span { start: number; end: number }
interface Fragment { range?: Span; gap: number; cut?: { text: string; offset: number; length: number; step: number; origin: number; batch: boolean } }
interface State { key: string; revision: string; uri: string; text: string; fragments: Fragment[]; insertions?: Fragment[]; step: number; ended?: boolean; uncertainReason?: string; evidence?: 'observed' | 'reconstructed'; sharedReference?: string; paperHead?: string | null }
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
export function enableEditTracking(anchor: Anchor, text: string, fragments?: Span[], insertions?: Span[]): Anchor {
  text = normalizedText(text);
  return { ...anchor, tracking: { version: 1, fragments: fragments ?? [anchorSpan(anchor, text)],
    ...(insertions?.length ? { insertions } : {}) } };
}

/** A possible character edit script, not proof of the actual operations. */
export function reverseDiffEdits(before: string, after: string): Edit[] {
  const reverse = (text: string) => text.split('').reverse().join(''); // UTF-16 offsets, including surrogate pairs.
  return diffEdits(reverse(before), reverse(after)).map(edit => ({ ...edit,
    start: before.length - edit.start - edit.deleteCount, text: reverse(edit.text) })).reverse();
}
function occurrences(text: string, needle: string): number {
  if (!needle) { return 0; }
  const first = text.indexOf(needle);
  return first < 0 ? 0 : text.indexOf(needle, first + 1) < 0 ? 1 : 2;
}
function identifyingCut(text: string): boolean {
  const letters = text.match(/[\p{L}\p{N}]/gu) ?? [];
  return text.trim().length >= 10 && letters.length >= 6 && new Set(letters).size >= 4 &&
    !/^\\(?:begin|end)\{[^}]+\}\s*$/u.test(text.trim());
}

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
  fragments: structuredClone(entry.fragments), insertions: structuredClone(entry.insertions ?? []), step: entry.step,
  ...(entry.uncertainReason ? { uncertainReason: entry.uncertainReason } : {}), ...(entry.evidence ? { evidence: entry.evidence } : {}),
  ...(entry.sharedReference !== undefined ? { sharedReference: entry.sharedReference } : {}),
  ...(entry.paperHead !== undefined ? { paperHead: entry.paperHead } : {}), ...(entry.ended ? { ended: true } : {}) });
const surviving = (state: State): boolean => state.fragments.some(fragment => fragment.range && state.text.slice(fragment.range.start, fragment.range.end).trim());
const endedState = (state: State): State => ({ ...copyState(state),
  fragments: state.fragments.map(({ range, gap }) => ({ range: range ? { ...range } : undefined, gap })),
  insertions: (state.insertions ?? []).map(({ range, gap }) => ({ range: range ? { ...range } : undefined, gap })),
  ended: !surviving(state) });

/** Ranges advance from a known snapshot; reconstructed alignments retain their uncertainty. */
export class EditTracking {
  private readonly live = new Map<string, Entry>();
  private readonly saved = new Map<string, State>();
  private readonly staged = new Set<string>();
  private readonly suspended = new Set<string>();
  generation = 0;

  constructor(snapshot?: unknown) {
    const data = snapshot as EditTrackingState | undefined;
    if (data?.version !== 1 || !Array.isArray(data.entries)) { return; }
    for (const state of data.entries) {
      if (!state || typeof state.key !== 'string' || typeof state.revision !== 'string' || typeof state.uri !== 'string' ||
          typeof state.text !== 'string' || !Number.isSafeInteger(state.step) || !Array.isArray(state.fragments) ||
          state.uncertainReason !== undefined && typeof state.uncertainReason !== 'string' ||
          state.evidence !== undefined && !['observed', 'reconstructed'].includes(state.evidence) ||
          state.sharedReference !== undefined && typeof state.sharedReference !== 'string' ||
          state.paperHead !== undefined && state.paperHead !== null && !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(state.paperHead) ||
          state.fragments.length > 1024 || state.insertions !== undefined && (!Array.isArray(state.insertions) || state.insertions.length > 1024) ||
          [...state.fragments, ...state.insertions ?? []].some(fragment => !fragment || !Number.isSafeInteger(fragment.gap) ||
            fragment.gap < 0 || fragment.gap > state.text.length || fragment.range &&
            (!Number.isSafeInteger(fragment.range.start) || !Number.isSafeInteger(fragment.range.end) || fragment.range.start < 0 ||
              fragment.range.end <= fragment.range.start || fragment.range.end > state.text.length))) { continue; }
      // Clipboard matching and undo checkpoints are deliberately session-local.
      const restored = endedState(state);
      this.saved.set(state.key, restored); this.live.set(state.key, { ...restored, history: [] });
    }
  }

  // A saved deletion is final after this session ends; live cut tickets stay intact.
  snapshot(): EditTrackingState { return { version: 1, entries: [...this.saved.values()].map(endedState) }; }
  has(key: string, revision: string): boolean { return this.live.get(key)?.revision === revision; }
  isActive(key: string, revision: string): boolean { return this.has(key, revision) && !this.suspended.has(key); }
  text(key: string): string | undefined { return this.live.get(key)?.text; }
  paperHead(key: string): string | null | undefined { return this.live.get(key)?.paperHead; }
  sharedReference(key: string): string | undefined { return this.live.get(key)?.sharedReference; }
  rememberReference(key: string, reference: string): void {
    const entry = this.live.get(key);
    if (entry) { entry.sharedReference = reference; }
    const saved = this.saved.get(key);
    if (saved && saved.sharedReference !== reference) { saved.sharedReference = reference; this.generation++; }
  }
  rebind(key: string, before: string, after: string): boolean {
    const entry = this.live.get(key);
    if (entry?.revision !== before) { return false; }
    entry.revision = after;
    for (const state of entry.history) { state.revision = after; }
    const saved = this.saved.get(key);
    if (saved?.revision === before) { saved.revision = after; this.generation++; }
    return true;
  }
  suspend(key: string): void { this.suspended.add(key); }
  suspendDocument(uri: string): void { for (const entry of this.live.values()) { if (entry.uri === uri && !this.staged.has(entry.key)) { this.suspend(entry.key); } } }
  resume(key: string, revision: string, head: string | null): void {
    const entry = this.live.get(key);
    if (entry?.revision !== revision) { return; }
    entry.paperHead = head; this.suspended.delete(key);
  }

  private stagingKey(uri: string, anchor: Anchor, sourceKey = ''): string {
    return `draft:${sourceKey}:${uri}:${anchor.documentHash}:${JSON.stringify(anchor.tracking)}`;
  }

  /** Start observing before an input box or asynchronous Git write can change the source. */
  stage(uri: string, anchor: Anchor, text: string, sourceKey?: string): void {
    const key = this.stagingKey(uri, anchor, sourceKey);
    const previous = sourceKey ? this.live.get(sourceKey) : undefined;
    if (previous && previous.uri === uri && previous.text === normalizedText(text)) {
      this.live.set(key, { ...copyState(previous), key, revision: '', history: previous.history.map(copyState) });
    } else { this.seed(key, '', uri, anchor, text); }
    this.staged.add(key);
    if (this.staged.size > 64) {
      const oldest = this.staged.values().next().value!;
      this.staged.delete(oldest); this.live.delete(oldest);
    }
  }

  adopt(key: string, revision: string, uri: string, anchor: Anchor): boolean {
    const specific = this.stagingKey(uri, anchor, key);
    const stagedKey = this.live.has(specific) ? specific : this.stagingKey(uri, anchor), entry = this.live.get(stagedKey);
    if (!entry) { return false; }
    this.live.set(key, { ...copyState(entry), key, revision, history: entry.history.map(state => ({ ...copyState(state), key, revision })) });
    this.live.delete(stagedKey); this.staged.delete(stagedKey);
    return true;
  }

  seed(key: string, revision: string, uri: string, anchor: Anchor, source: string): boolean {
    source = normalizedText(source);
    if (documentHash(source) !== anchor.documentHash) { return false; }
    const fragments = anchor.tracking?.fragments ?? [anchorSpan(anchor, source)];
    const insertions = anchor.tracking?.insertions ?? [];
    const owned = anchorSpan(anchor, source);
    if (source.slice(owned.start, owned.end) !== anchor.selected.join('\n') || !fragments.length || fragments.some(range =>
      !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start ||
      range.end > source.length || !source.slice(range.start, range.end).trim())) { return false; }
    if (insertions.some(range => !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start ||
      range.end > source.length || fragments.some(fragment => range.start < fragment.end && range.end > fragment.start))) { return false; }
    this.live.set(key, { key, revision, uri, text: source, fragments: fragments.map(range => ({ range: { ...range }, gap: range.start })),
      insertions: insertions.map(range => ({ range: { ...range }, gap: range.start })), evidence: anchor.tracking?.evidence ?? 'observed', step: 0, history: [] });
    return true;
  }

  /** Finish only the saved state; saving on its own never discards a live cut. */
  endSession(uri: string): void {
    for (const entry of this.live.values()) {
      if (entry.uri !== uri || this.staged.has(entry.key)) { continue; }
      const saved = this.saved.get(entry.key);
      if (!saved || saved.revision !== entry.revision || saved.text !== entry.text) { continue; }
      Object.assign(entry, endedState(entry), { history: [] });
      this.saved.set(entry.key, copyState(entry)); this.generation++;
    }
  }

  highlights(key: string, revision: string, text: string): { owned: Span[]; inserted: Span[] } {
    const entry = this.live.get(key);
    if (this.suspended.has(key) || !entry || entry.revision !== revision || entry.text !== normalizedText(text) || entry.uncertainReason || !surviving(entry)) { return { owned: [], inserted: [] }; }
    const ranges = (fragments: Fragment[]) => fragments.flatMap(fragment => fragment.range ? [{ ...fragment.range }] : []);
    return { owned: ranges(entry.fragments), inserted: ranges(entry.insertions ?? []) };
  }

  change(uri: string, text: string, changes: { range: { start: TextPosition; end: TextPosition }; text: string }[], undoRedo = false): void {
    text = normalizedText(text);
    for (const entry of this.live.values()) {
      if (this.suspended.has(entry.key) || entry.uri !== uri || entry.text === text) { continue; }
      let edits = changes.map(change => ({ start: offsetAt(entry.text, change.range.start),
        deleteCount: offsetAt(entry.text, change.range.end) - offsetAt(entry.text, change.range.start), text: normalizedText(change.text) }));
      // Broad replacements describe snapshots; their internal correspondence is reconstructed.
      const reconstructed = edits.some(edit => edit.deleteCount && edit.text &&
        (edit.start === 0 && edit.deleteCount === entry.text.length || entry.fragments.some(fragment => fragment.range &&
          edit.start <= fragment.range.start && edit.start + edit.deleteCount >= fragment.range.end &&
          (edit.start < fragment.range.start || edit.start + edit.deleteCount > fragment.range.end))));
      if (reconstructed) { edits = diffEdits(entry.text, text); }
      this.advance(entry, text, edits, undoRedo, reconstructed);
    }
  }

  locate(key: string, revision: string, text: string, persist = false): Location {
    const entry = this.live.get(key);
    if (this.suspended.has(key) || !entry || entry.revision !== revision) { return { kind: 'pending', reason: 'Pending document · Pull the paper source to receive this comment’s document version. If the editor has unsaved changes, save or reconcile them with the pulled file before reconnecting this comment.' }; }
    text = normalizedText(text);
    if (entry.text !== text) { this.advance(entry, text, diffEdits(entry.text, text), false, true); }
    if (persist && JSON.stringify(this.saved.get(key)) !== JSON.stringify(copyState(entry))) { this.saved.set(key, copyState(entry)); this.generation++; }
    if (entry.uncertainReason) {
      const position = positionAt(text, Math.min(entry.fragments[0]?.range?.start ?? entry.fragments[0]?.gap ?? 0, text.length));
      return { kind: 'uncertain', estimatedLine: position.line, confidence: 0, reason: entry.uncertainReason, evidence: 'reconstructed' };
    }
    const first = entry.fragments.find(fragment => fragment.range && text.slice(fragment.range.start, fragment.range.end).trim());
    if (!first?.range) {
      if (entry.ended) { return { kind: 'outdated', reason: 'The target was removed and the document was saved before its editing session ended. Select text and move this comment to reconnect it.' }; }
      const gap = Math.min(entry.fragments[0]?.gap ?? 0, text.length);
      const position = positionAt(text, gap);
      return { kind: 'uncertain', estimatedLine: position.line, confidence: 1,
        reason: 'The selected text was removed. Its last position is retained. Only an unambiguous, identifying cut/paste can reconnect it; otherwise use Move to editor selection.',
        ...(position.character === 0 ? { insertionLine: position.line } : {}) };
    }
    const start = positionAt(text, first.range.start), end = positionAt(text, first.range.end);
    // A trailing selected newline belongs to the previous physical line.
    const endLine = end.line > start.line && end.character === 0 ? end.line - 1 : end.line;
    const endCharacter = endLine === end.line ? end.character : text.split('\n')[endLine].length;
    return { kind: 'attached', startLine: start.line, endLine, evidence: entry.evidence,
      logicalRange: { startCharacter: start.character, endCharacter } };
  }

  reference(key: string, revision: string, anchor: Anchor, text: string, baseCommit: string | null): Anchor | undefined {
    const location = this.locate(key, revision, text);
    if (location.kind !== 'attached') { return undefined; }
    const next = createAnchor(anchor.path, text, location.startLine, location.endLine, baseCommit, location.logicalRange);
    const ranges = this.live.get(key)!.fragments.flatMap(fragment => fragment.range && normalizedText(text).slice(fragment.range.start, fragment.range.end).trim() ? [fragment.range] : []);
    const inserted = (this.live.get(key)!.insertions ?? []).flatMap(fragment => fragment.range ? [fragment.range] : []);
    const tracked = enableEditTracking(next, text, ranges, inserted);
    tracked.tracking!.evidence = this.live.get(key)!.evidence;
    return tracked;
  }

  private advance(entry: Entry, text: string, edits: Edit[], undoRedo = false, reconstructed = false): void {
    const old = copyState(entry);
    const restored = undoRedo ? [...entry.history].reverse().find(state => state.text === text) : undefined;
    if (restored) {
      Object.assign(entry, copyState(restored), { ended: restored.ended, uncertainReason: restored.uncertainReason, evidence: restored.evidence });
    } else {
      let applied = entry.text;
      for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        applied = applied.slice(0, edit.start) + edit.text + applied.slice(edit.start + edit.deleteCount);
      }
      if (applied !== text) { edits = diffEdits(entry.text, text); reconstructed = true; }
      if (reconstructed) {
        const alternate: Entry = { ...copyState(entry), history: [] };
        const forward: Entry = { ...copyState(entry), history: [] };
        const replay = (state: Entry, script: Edit[]) => {
          for (const fragment of [...state.fragments, ...state.insertions ?? []]) { delete fragment.cut; }
          for (const edit of [...script].sort((a, b) => b.start - a.start)) {
            this.transform(state, { ...edit, reconstructed: true });
            state.text = state.text.slice(0, edit.start) + edit.text + state.text.slice(edit.start + edit.deleteCount);
          }
        };
        const reverse = reverseDiffEdits(entry.text, text);
        replay(forward, edits); replay(alternate, reverse);
        const ranges = (state: Entry) => state.fragments.filter(fragment => fragment.range).map(fragment => fragment.range);
        const ambiguous = JSON.stringify(ranges(forward)) !== JSON.stringify(ranges(alternate));
        const lost = !surviving(forward) && entry.fragments.some(fragment => fragment.range &&
          (occurrences(text, entry.text.slice(fragment.range.start, fragment.range.end)) > 0 ||
            [...edits, ...reverse].some(edit => edit.opaque && edit.start < fragment.range!.end && edit.start + edit.deleteCount > fragment.range!.start)));
        if (ambiguous || lost) {
          entry.uncertainReason = 'Reconstructed changes have ambiguous correspondence to the saved target. Actual edit operations were not observed. Select text and move this comment to confirm its location.';
        }
        entry.evidence = 'reconstructed';
        for (const fragment of [...entry.fragments, ...entry.insertions ?? []]) { delete fragment.cut; }
        edits = edits.map(edit => ({ ...edit, reconstructed: true }));
      } else {
        const before = entry.text;
        edits = edits.map(edit => {
          const removed = before.slice(edit.start, edit.start + edit.deleteCount);
          const paired = !edit.text && !!removed && edits.filter(other => !other.deleteCount && other.text === removed).length === 1 &&
            edits.filter(other => !other.text && before.slice(other.start, other.start + other.deleteCount) === removed).length === 1;
          return { ...edit, pairable: paired || !edit.text && identifyingCut(removed) && occurrences(before, removed) === 1 };
        });
      }
      // Deletions first in descending source order; insertions in that batch can match a cut.
      const insertions: Edit[] = [];
      for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        this.transform(entry, edit);
        entry.text = entry.text.slice(0, edit.start) + edit.text + entry.text.slice(edit.start + edit.deleteCount);
        insertions.push(edit);
      }
      // A move may be one multi-edit event with insertion before deletion. Revisit the
      // final inserted ranges only when their coordinates can be determined exactly.
      for (const edit of insertions.filter(edit => edit.text && !edit.deleteCount && !edit.reconstructed)) {
        const shift = edits.filter(other => other !== edit && other.start < edit.start).reduce((sum, other) => sum + other.text.length - other.deleteCount, 0);
        this.paste(entry, edit.text, edit.start + shift, text);
      }
      entry.text = text; entry.step++;
    }
    this.normalizeInsertions(entry);
    entry.history.push(old);
    if (entry.history.length > 32) { entry.history.shift(); }
  }

  private normalizeInsertions(entry: Entry): void {
    // Pasting an original fragment into an inserted region restores its ownership.
    // The destination region must not also shade that original text as inserted.
    const owned = entry.fragments.flatMap(fragment => fragment.range ? [fragment.range] : []);
    const ranges = (entry.insertions ?? []).flatMap(fragment => {
      let spans = fragment.range ? [{ ...fragment.range }] : [];
      for (const range of owned) {
        spans = spans.flatMap(span => range.end <= span.start || range.start >= span.end ? [span] : [
          ...(span.start < range.start ? [{ start: span.start, end: range.start }] : []),
          ...(span.end > range.end ? [{ start: range.end, end: span.end }] : [])
        ]);
      }
      return spans;
    }).sort((a, b) => a.start - b.start);
    const merged: Span[] = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end) { last.end = Math.max(last.end, range.end); }
      else { merged.push(range); }
    }
    // Keep detached insertion tickets so a later paste can still restore their color.
    entry.insertions = [...(entry.insertions ?? []).filter(fragment => !fragment.range),
      ...merged.map(range => ({ range, gap: range.start }))];
  }

  private paste(entry: Entry, text: string, at: number, result: string): void {
    const matches = [...entry.fragments, ...entry.insertions ?? []].filter(fragment => !fragment.range && fragment.cut?.text === text);
    const groups = new Set(matches.map(fragment => `${fragment.cut!.step}:${fragment.cut!.origin}`));
    if (groups.size !== 1) { return; }
    const ticket = matches[0].cut!;
    const batch = ticket.step === entry.step && ticket.batch;
    if (!batch && (!identifyingCut(text) || occurrences(result, text) !== 1)) { return; }
    for (const fragment of matches) {
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
    // Inserted regions retain their distinct provenance through subsequent edits and cuts.
    entry.insertions = (entry.insertions ?? []).flatMap(fragment => {
      if (!fragment.range) { return [{ ...fragment, gap: gapAt(fragment.gap) }]; }
      const { start, end } = fragment.range;
      if (b < start || b === start && edit.deleteCount > 0) { return [{ ...fragment, range: { start: start + delta, end: end + delta }, gap: start + delta }]; }
      if (a > end || a === end && edit.deleteCount > 0) { return [fragment]; }
      if (a <= start && b >= end && edit.deleteCount) {
        if (!length) { return [{ gap: a, ...(!edit.reconstructed && edit.pairable ? { cut: { text: removed, offset: start - a, length: end - start, step: entry.step, origin: a, batch: true } } : {}) }]; }
        // Broad replacements cannot turn surrounding original text into inserted text.
        return a === start && b === end ? [{ range: { start: a, end: a + length }, gap: a }] : [];
      }
      const updated = { start: Math.min(start, a), end: end >= b ? end + delta : a + length };
      return updated.end > updated.start ? [{ range: updated, gap: updated.start }] : [];
    });
    for (const fragment of entry.fragments) {
      const range = fragment.range;
      if (!range) { next.push({ ...fragment, gap: gapAt(fragment.gap) }); continue; }
      const { start, end } = range;
      if (b <= start) { next.push({ ...fragment, range: { start: start + delta, end: end + delta }, gap: start + delta }); continue; }
      if (a >= end) { next.push(fragment); continue; }
      if (!edit.deleteCount && !edit.text.trim()) {
        next.push({ range: { start, end: end + length }, gap: start }); continue;
      }
      if (!edit.deleteCount && edit.text.trim()) { entry.insertions.push({ range: { start: a, end: a + length }, gap: a }); }
      // Replacements inside a fragment retain its extent; advance checks inferred scripts for ambiguity.
      if (edit.deleteCount && length && !edit.opaque && a >= start && b <= end) {
        next.push({ range: { start, end: end + delta }, gap: start }); continue;
      }
      if (start < a) { next.push({ range: { start, end: a }, gap: start }); }
      if (edit.deleteCount) {
        const cutStart = Math.max(start, a), cutEnd = Math.min(end, b);
        next.push({ gap: a, ...(!length && !edit.reconstructed && edit.pairable ? { cut: { text: removed, offset: cutStart - a, length: cutEnd - cutStart, step: entry.step, origin: a, batch: true } } : {}) });
      }
      if (end > b) { next.push({ range: { start: a + length, end: end + delta }, gap: a + length }); }
    }
    entry.fragments = next;

  }
}
