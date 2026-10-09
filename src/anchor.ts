import { createHash } from 'node:crypto';

export interface Anchor {
  path: string;
  baseCommit: string | null;
  documentHash: string;
  startLine: number;
  endLine: number;
  selected: string[];
  before: string[];
  after: string[];
  occurrences: number;
  // Optional so immutable anchors written by older clients remain valid.
  sentenceContext?: { before: string; after: string };
  afterBoundary?: 'document-end' | 'file-end';
}

export interface Estimate {
  estimatedLine: number;
  estimatedRange?: { startLine: number; endLine: number };
  /** A gap before this line; document.length means after the final physical line. */
  insertionLine?: number;
  confidence: number;
  reason: string;
}
export interface EstimateCandidate extends Estimate { reference: 'saved' | 'local' }
export type Location = ({ kind: 'attached'; startLine: number; endLine: number; similarity?: number } |
  ({ kind: 'uncertain'; candidates?: EstimateCandidate[] } & Estimate) |
  { kind: 'outdated'; reason: string }) & { source?: 'local' };

export function locationEstimates(location: Location): EstimateCandidate[] {
  return location.kind === 'uncertain' ? location.candidates ?? [{ ...location, reference: location.source === 'local' ? 'local' : 'saved' }] : [];
}

export const MAX_CONTEXT_LENGTH = 4096;

function lines(text: string): string[] { return text.replace(/\r\n/g, '\n').split('\n'); }
export function documentHash(text: string): string { return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex'); }

function matches(document: string[], selected: string[]): number[] {
  const result: number[] = [];
  for (let i = 0; i + selected.length <= document.length; i++) {
    if (selected.every((line, offset) => document[i + offset] === line)) { result.push(i); }
  }
  return result;
}

export function createAnchor(path: string, text: string, startLine: number, endLine: number, baseCommit: string | null): Anchor {
  const document = lines(text);
  if (startLine < 0 || endLine < startLine || endLine >= document.length) { throw new Error('Invalid comment line range.'); }
  const selected = document.slice(startLine, endLine + 1);
  if (!selected.some(line => line.trim())) { throw new Error('Select at least one non-empty line.'); }
  const boundary = endBoundary(document);
  const afterBoundary = endLine <= boundary.line && document.slice(endLine + 1, boundary.line).every(emptyTail) &&
    (endLine === boundary.line || boundary.kind === 'document-end' || emptyTail(document[boundary.line])) ? boundary.kind : undefined;
  return { path, baseCommit, documentHash: documentHash(text), startLine, endLine, selected,
    before: document.slice(Math.max(0, startLine - 3), startLine),
    after: document.slice(endLine + 1, endLine + 4), occurrences: matches(document, selected).length,
    sentenceContext: surroundingSentences(document, startLine, endLine), ...(afterBoundary ? { afterBoundary } : {}) };
}

export function locateAnchor(anchor: Anchor, text: string): Location {
  const location = locateText(anchor, text);
  return location.kind === 'attached' ? location : contextOnly(anchor, lines(text)) ?? location;
}

function locateText(anchor: Anchor, text: string): Location {
  if (documentHash(text) === anchor.documentHash) { return { kind: 'attached', startLine: anchor.startLine, endLine: anchor.endLine }; }
  const full = lines(text);
  const boundary = endBoundary(full);
  const document = (anchor.afterBoundary === 'document-end' || endBoundary(anchor.after).kind === 'document-end') && boundary.kind === 'document-end'
    ? full.slice(0, boundary.line + 1) : full;
  const candidates = matches(document, anchor.selected).map(start => {
    let score = 0;
    for (let i = 1; i <= anchor.before.length; i++) {
      if (document[start - i] !== anchor.before[anchor.before.length - i]) { break; }
      score++;
    }
    for (let i = 0; i < anchor.after.length; i++) {
      if (document[start + anchor.selected.length + i] !== anchor.after[i]) { break; }
      score++;
    }
    score += sentenceEvidence(anchor, document, start, start + anchor.selected.length - 1) * 3;
    return { start, score };
  }).sort((a, b) => b.score - a.score);
  if (!candidates.length) { return approximate(anchor, document); }
  const best = candidates[0];
  // An old sentence copied elsewhere must not outrank its slightly edited passage with intact context.
  const contextWeight = anchor.before.length + anchor.after.length +
    [anchor.sentenceContext?.before, anchor.sentenceContext?.after].filter(Boolean).length * 3;
  if (anchor.selected.join(' ').length >= 16 && best.score < contextWeight / 2) {
    return approximate(anchor, document);
  }
  // Never select one of several identical passages based only on its line number.
  if ((candidates.length > 1 && (best.score === 0 || best.score === candidates[1].score)) ||
      (anchor.occurrences > 1 && best.score === 0)) {
    return { kind: 'outdated', reason: 'Several passages could match this comment. Review the original excerpt.' };
  }
  return { kind: 'attached', startLine: best.start, endLine: best.start + anchor.selected.length - 1 };
}

function normalize(text: string): string { return text.replace(/\s+/gu, ' ').trim(); }
function pairs(text: string): Map<string, number> {
  const result = new Map<string, number>();
  for (let i = 1; i < text.length; i++) {
    const pair = text.slice(i - 1, i + 1);
    result.set(pair, (result.get(pair) ?? 0) + 1);
  }
  return result;
}
function dice(a: string, b: string): number {
  if (a === b) { return a ? 1 : 0; }
  const left = pairs(a), right = pairs(b);
  let common = 0;
  for (const [pair, count] of left) { common += Math.min(count, right.get(pair) ?? 0); }
  return 2 * common / Math.max(1, a.length + b.length - 2);
}

// Bounded edit distance is used only for the best inexpensive candidate matches.
function similarity(a: string, b: string, budget: { remaining: number }): number {
  if (a === b) { return 1; }
  const limit = Math.floor(Math.max(a.length, b.length) * 0.28);
  if (Math.abs(a.length - b.length) > limit) { return 0; }
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = new Array<number>(b.length + 1).fill(limit + 1);
    next[0] = i;
    let minimum = next[0];
    for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j++) {
      if (--budget.remaining < 0) { return 0; }
      next[j] = Math.min(previous[j] + 1, next[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      minimum = Math.min(minimum, next[j]);
    }
    if (minimum > limit) { return 0; }
    previous = next;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function approximate(anchor: Anchor, document: string[]): Location {
  const selected = normalize(anchor.selected.join('\n'));
  const normalized = document.map(normalize);
  const missing: Location = { kind: 'outdated', reason: 'No sufficiently similar passage was found. Review the saved excerpt.' };
  if (!selected || selected.length > 12_000) { return missing; }
  const context = (start: number, end: number): number => {
    let total = 0, weight = 0;
    for (const [saved, current] of [
      [anchor.before.slice().reverse(), normalized.slice(Math.max(0, start - anchor.before.length), start).reverse()],
      [anchor.after, normalized.slice(end + 1, end + 1 + anchor.after.length)]
    ]) {
      saved.forEach((line, index) => {
        const text = normalize(line);
        if (!text) { return; }
        const importance = 1 / (index + 1);
        // Exact context is stronger evidence than a nearly identical section heading elsewhere.
        total += (text === current[index] ? 1 : dice(text, current[index] ?? '') * 0.5) * importance;
        weight += importance;
      });
    }
    const sentenceCount = [anchor.sentenceContext?.before, anchor.sentenceContext?.after].filter(Boolean).length;
    total += sentenceEvidence(anchor, document, start, end) * 2;
    weight += sentenceCount * 2;
    return weight ? total / weight : 0;
  };
  type Candidate = { start: number; end: number; text: string; context: number; rank: number; similarity: number };
  let candidates: Candidate[] = [];
  const maximumLines = Math.max(12, anchor.selected.length * 2 + 6);
  for (let start = 0; start < normalized.length; start++) {
    if (!normalized[start]) { continue; }
    let text = '';
    for (let end = start; end < Math.min(normalized.length, start + maximumLines); end++) {
      if (normalized[end]) { text += (text ? ' ' : '') + normalized[end]; }
      if (text.length > selected.length / 0.72) { break; }
      if (!normalized[end] || text.length < selected.length * 0.72) { continue; }
      const rough = dice(selected, text);
      if (rough < 0.5) { continue; }
      const surroundings = context(start, end);
      candidates.push({ start, end, text, context: surroundings, rank: rough * 0.8 + surroundings * 0.2, similarity: 0 });
      if (candidates.length > 128) { candidates.sort((a, b) => b.rank - a.rank); candidates.length = 64; }
    }
  }
  candidates.sort((a, b) => b.rank - a.rank);
  const budget = { remaining: 8_000_000 };
  candidates = candidates.slice(0, 64).filter(candidate => {
    candidate.similarity = similarity(selected, candidate.text, budget);
    candidate.rank = candidate.similarity * 0.8 + candidate.context * 0.2;
    const threshold = selected.length < 16 ? (candidate.context >= 0.5 ? 0.85 : 0.95) :
      candidate.context >= 0.35 ? 0.74 : 0.86;
    return candidate.similarity >= threshold;
  }).sort((a, b) => b.rank - a.rank);
  if (budget.remaining < 0 || !candidates.length) { return missing; }
  const best = candidates[0];
  const alternative = candidates.find(candidate => {
    const overlap = Math.max(0, Math.min(best.end, candidate.end) - Math.max(best.start, candidate.start) + 1);
    return overlap / Math.max(best.end - best.start + 1, candidate.end - candidate.start + 1) < 0.5;
  });
  if ((alternative && best.rank - alternative.rank < 0.06) || (anchor.occurrences > 1 && best.context < 0.35)) {
    return { kind: 'outdated', reason: 'Several similar passages could match this comment. Review the saved excerpt.' };
  }
  if (best.end - best.start + 1 === anchor.selected.length && anchor.selected.every((line, offset) => document[best.start + offset] === line)) {
    return { kind: 'attached', startLine: best.start, endLine: best.end };
  }
  return { kind: 'attached', startLine: best.start, endLine: best.end, similarity: best.similarity };
}

// Keep structural LaTeX and comments out of sentence identity. Inline macros remain
// part of the saved text; a wrapped sentence is stored independently of line breaks.
function structural(line: string): boolean {
  return /^\s*(?:\\(?:begin|end|(?:sub)*section|(?:sub)?paragraph|chapter|part|label|documentclass|usepackage|include|input)\b|\\[\[\]]|\$\$|%)/u.test(line);
}
function proseLine(line: string): string {
  // A control symbol consumes its next character: \% is text, but \\ followed
  // by % starts a comment. A negative lookbehind cannot distinguish those cases.
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; }
    else if (line[i] === '%') { return normalize(line.slice(0, i)); }
  }
  return normalize(line);
}

function endBoundary(document: string[]): { kind: 'document-end' | 'file-end'; line: number } {
  const line = document.findIndex(line => /^\\end\s*\{\s*document\s*\}\s*$/u.test(proseLine(line)));
  return line < 0 ? { kind: 'file-end', line: document.length - 1 } : { kind: 'document-end', line };
}
function emptyTail(line: string): boolean {
  const text = proseLine(line);
  return !text || /^\\(?:end|label)\s*\{[^{}]*\}\s*$/u.test(text);
}

/** A named heading is useful context; the command name alone is not evidence. */
function headingTitle(text: string): string | undefined {
  const command = /^\\(?:(?:sub){0,2}section|(?:sub)?paragraph|chapter|part)\*?\s*/u.exec(text);
  if (!command) { return undefined; }
  let at = command[0].length;
  const group = (open: string, close: string): string | undefined => {
    if (text[at] !== open) { return undefined; }
    const start = ++at;
    let depth = 1;
    for (; at < text.length; at++) {
      if (text[at] === '\\') { at++; }
      else if (text[at] === open) { depth++; }
      else if (text[at] === close && --depth === 0) { return text.slice(start, at++); }
    }
    return undefined;
  };
  if (text[at] === '[' && group('[', ']') === undefined) { return undefined; }
  while (/\s/u.test(text[at] ?? '') && at < text.length) { at++; }
  const title = group('{', '}');
  if (title === undefined || !/^(?:\s*\\label\{[^{}]*\})*\s*$/u.test(text.slice(at))) { return undefined; }
  return normalize(title.replace(/\\[a-zA-Z]+\*?/gu, '').replace(/[{}]/gu, '').replace(/~|\\ /gu, ' '));
}

type Sentence = { text: string; start: number; end: number; startLine: number; endLine: number; heading?: string };
function sentenceIndex(document: string[]) {
  const normalized = document.map(proseLine);
  const offsets: number[] = [];
  let length = 0;
  for (const line of normalized) { offsets.push(length); length += line.length + 1; }
  const text = normalized.join(' ');
  const lineAt = (offset: number): number => {
    let low = 0, high = offsets.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (offsets[middle] <= offset) { low = middle; } else { high = middle - 1; }
    }
    return low;
  };
  const sentences: Sentence[] = [];
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  let first = 0;
  const flush = (end: number) => {
    const block = normalized.slice(first, end).join(' ');
    // Do not spend unbounded time segmenting a generated/minified LaTeX block.
    if (!block || block.length > 32_768) { return; }
    for (const part of segmenter.segment(block)) {
      const value = part.segment.trim();
      if (!value || value.length > MAX_CONTEXT_LENGTH) { continue; }
      const start = offsets[first] + part.index + part.segment.indexOf(value);
      const end = start + value.length;
      sentences.push({ text: value, start, end, startLine: lineAt(start), endLine: lineAt(end - 1) });
    }
  };
  for (let i = 0; i <= document.length; i++) {
    if (i === document.length || !normalized[i] || structural(document[i])) {
      flush(i); first = i + 1;
      const heading = i < document.length ? headingTitle(normalized[i]) : undefined;
      if (heading && normalized[i].length <= MAX_CONTEXT_LENGTH) {
        sentences.push({ text: normalized[i], start: offsets[i], end: offsets[i] + normalized[i].length, startLine: i, endLine: i, heading });
      }
    }
  }
  return { text, sentences, lineAt, offsets };
}

function surroundingSentences(document: string[], start: number, end: number): { before: string; after: string } {
  // Segment each side independently so an unfinished/edited selected sentence cannot
  // consume its following context. Never store selected text as its own context.
  const first = Math.max(0, start - 64);
  const previous = document.slice(first, start);
  const boundary = first === 0 || !proseLine(document[first - 1]) || structural(document[first - 1]) ||
    /[.!?。！？]["'”’)}\]]*$/u.test(proseLine(document[first - 1]));
  const before = sentenceIndex(previous).sentences.filter(sentence =>
    boundary || sentence.startLine > 0 || sentence.heading !== undefined).at(-1);
  const tail = endBoundary(document);
  const last = Math.min(end + 65, tail.kind === 'document-end' ? tail.line : document.length);
  const next = document.slice(end + 1, last);
  const afterBoundary = last === document.length || !proseLine(document[last]) || structural(document[last]);
  // A paragraph/file boundary also ends useful context, even without punctuation.
  // Only discard a trailing fragment when the bounded window cuts through prose.
  const after = sentenceIndex(next).sentences.find(sentence => afterBoundary || sentence.endLine < next.length - 1 ||
    sentence.heading !== undefined || /[.!?。！？]["'”’)}\]]*$/u.test(sentence.text));
  return { before: before?.text ?? '', after: after?.text ?? '' };
}

function sentenceEvidence(anchor: Anchor, document: string[], start: number, end: number): number {
  const saved = anchor.sentenceContext;
  if (!saved) { return 0; }
  // Full sentences can extend past the old three-line window after rewrapping.
  return Number(!!saved.before && normalize(document.slice(Math.max(0, start - 64), start).map(proseLine).join(' ')).endsWith(saved.before)) +
    Number(!!saved.after && normalize(document.slice(end + 1, end + 65).map(proseLine).join(' ')).startsWith(saved.after));
}

function distinctive(text: string): boolean {
  const title = headingTitle(text);
  if (title !== undefined) {
    return (title.match(/\p{L}/gu)?.length ?? 0) >= (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(title) ? 2 : 4);
  }
  const prose = text.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/gu, '').replace(/[{}$\d]/gu, '');
  const words = prose.match(/\p{L}{2,}/gu) ?? [];
  return (new Set(words.map(word => word.toLowerCase())).size >= 4 && words.join('').length >= 18) ||
    (prose.match(/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0) >= 12;
}

function usableContext(text: string): boolean {
  if (headingTitle(text) !== undefined) { return distinctive(text); }
  if (structural(text)) { return false; }
  const prose = text.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/gu, '');
  return (prose.match(/\p{L}/gu)?.length ?? 0) >= 4 ||
    (prose.match(/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0) >= 2;
}

/** Recover spacing only from lines actually saved next to the selected passage. */
function contextSpacing(anchor: Anchor, side: 'before' | 'after', context: string): number | undefined {
  const saved = anchor[side].map(proseLine);
  const offset = (side === 'before' ? [...saved].reverse() : saved).findIndex(Boolean);
  if (offset < 0) { return undefined; }
  const line = side === 'before' ? saved.length - offset - 1 : offset;
  if (side === 'before' ? context.endsWith(saved[line]) : context.startsWith(saved[line])) {
    return side === 'before' ? saved.length - line : line + 1;
  }
  return undefined;
}

function contextOnly(anchor: Anchor, document: string[]): Location | undefined {
  // Older anchors use their actual saved lines, never context invented from today's document.
  const legacy = surroundingSentences([...anchor.before, '', ...anchor.after], anchor.before.length, anchor.before.length);
  const savedBoundary = anchor.afterBoundary ?? (endBoundary(anchor.after).kind === 'document-end' ? 'document-end' : undefined);
  const saved = {
    before: anchor.sentenceContext?.before || legacy.before || normalize(anchor.before.filter(line => !structural(line)).map(proseLine).join(' ')),
    after: anchor.sentenceContext?.after || (savedBoundary ? '' : legacy.after || normalize(anchor.after.filter(line => !structural(line)).map(proseLine).join(' ')))
  };
  const useEnd = !!savedBoundary && !saved.after;
  if (saved.before === saved.after ||
      (headingTitle(saved.before) !== undefined && headingTitle(saved.after) !== undefined) ||
      saved.before.length > MAX_CONTEXT_LENGTH || saved.after.length > MAX_CONTEXT_LENGTH) { return undefined; }
  const boundary = endBoundary(document);
  if (boundary.kind === 'document-end') { document = document.slice(0, boundary.line + 1); }
  const index = sentenceIndex(document);
  type Match = { start: number; end: number; score: number };
  const budget = { remaining: 4_000_000 };
  let ambiguousContext = false;
  const find = (text: string): Match[] => {
    const found: Match[] = [];
    const title = headingTitle(text);
    const strong = distinctive(text);
    const needle = strong ? text : text.replace(/[.!?。！？]+["'”’)}\]]*$/u, '').trim();
    const atBoundary = (at: number) => at < 0 || at >= index.text.length ||
      (strong ? /\s/u : /[\s.!?。！？"'“”‘’()[\]{}]/u).test(index.text[at]);
    for (let at = index.text.indexOf(needle); at !== -1; at = index.text.indexOf(needle, at + 1)) {
      if (atBoundary(at - 1) && atBoundary(at + needle.length) &&
          (title !== undefined || !structural(document[index.lineAt(at)]))) {
        found.push({ start: at, end: at + needle.length, score: 1 });
        if (found.length > 32) { ambiguousContext = true; return []; }
      }
    }
    // Short context is useful in a unique pair, but fuzzy short matches are too weak.
    if (!strong) { return found; }
    // Compare titles, not shared \section syntax; unrelated short titles must not
    // look similar merely because their command names match.
    const rough = index.sentences.filter(sentence => (title !== undefined) === (sentence.heading !== undefined))
      .map(sentence => ({ ...sentence, score: dice(title ?? text, sentence.heading ?? sentence.text) }))
      .filter(sentence => sentence.score >= 0.65 && !found.some(match => match.start < sentence.end && match.end > sentence.start))
      .sort((a, b) => b.score - a.score);
    if (rough.length > 64) { ambiguousContext = true; return []; }
    for (const sentence of rough) {
      const score = similarity(title ?? text, sentence.heading ?? sentence.text, budget);
      if (score >= 0.86) { found.push({ start: sentence.start, end: sentence.end, score }); }
    }
    return found;
  };
  if (useEnd && savedBoundary === 'document-end' && boundary.kind !== 'document-end') { return undefined; }
  const endOffset = boundary.kind === 'document-end' ? index.offsets[boundary.line] : index.text.length;
  const before = usableContext(saved.before) ? find(saved.before) : [];
  const after = useEnd ? [{ start: endOffset, end: endOffset, score: 1 }] : usableContext(saved.after) ? find(saved.after) : [];
  if (budget.remaining < 0 || ambiguousContext) { return undefined; }
  // An end sentinel alone adds no identity evidence to short preceding text.
  if (useEnd && !distinctive(saved.before)) { return undefined; }
  const beforeSpacing = contextSpacing(anchor, 'before', saved.before);
  const afterSpacing = contextSpacing(anchor, 'after', saved.after);
  const maxGap = Math.min(2000, Math.max(160, normalize(anchor.selected.join(' ')).length * 3 + 80));
  const maxLines = Math.max(8, Math.min(40, anchor.selected.length * 3 + 4));
  const candidates: (Omit<Estimate, 'reason'> & { start: number; end: number })[] = [];
  for (const left of before) {
    for (const right of after) {
      const gap = right.start - left.end;
      const leftLine = index.lineAt(left.end - 1), rightLine = index.lineAt(right.start);
      const between = document.slice(leftLine + 1, rightLine);
      if (gap < 0 || gap > maxGap || between.filter(line => proseLine(line)).length > maxLines ||
          between.some(line => structural(line) && !(useEnd && emptyTail(line)))) { continue; }
      const startLine = Math.min(leftLine + 1, rightLine);
      const estimate = beforeSpacing !== undefined ? leftLine + beforeSpacing : afterSpacing !== undefined ?
        rightLine - afterSpacing - (anchor.selected.length - 1) : startLine;
      const estimatedLine = Math.max(startLine, Math.min(estimate, rightLine));
      const insertionLine = estimatedLine === rightLine && proseLine(document[rightLine]) ?
        useEnd && boundary.kind === 'file-end' ? leftLine === rightLine ? document.length : undefined : rightLine : undefined;
      candidates.push({ estimatedLine, estimatedRange: { startLine, endLine: rightLine },
        ...(insertionLine !== undefined ? { insertionLine } : {}),
        confidence: (left.score + right.score) / 2 - 0.1 * gap / maxGap, start: left.start, end: right.end });
    }
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];
  if (!best || best.confidence < 0.85) {
    // One unique, identifying context can retain a lower-confidence estimate when
    // the other side is gone. Never override two conflicting or distant matches.
    const side = before.length === 1 && !after.length ? 'before' : after.length === 1 && !before.length && !useEnd ? 'after' : undefined;
    if (!side || !distinctive(saved[side])) { return undefined; }
    const spacing = side === 'before' ? beforeSpacing : afterSpacing;
    if (spacing === undefined) { return undefined; }
    const match = (side === 'before' ? before : after)[0];
    const line = index.lineAt(side === 'before' ? match.end - 1 : match.start);
    const estimate = side === 'before' ? line + spacing : line - spacing - (anchor.selected.length - 1);
    const estimatedLine = Math.max(0, Math.min(estimate, document.length - 1));
    const between = side === 'before' ? document.slice(line + 1, estimatedLine + 1) : document.slice(estimatedLine, line);
    if (between.some(structural)) { return undefined; }
    const insertionLine = side === 'after' && estimatedLine === line ? line :
      side === 'before' && estimate >= document.length ? document.length : undefined;
    return { kind: 'uncertain', estimatedLine, ...(insertionLine !== undefined ? { insertionLine } : {}), confidence: match.score * 0.75,
      reason: `The original passage could not be matched. Only the ${side === 'before' ? 'preceding' : 'following'} context remains; the location is estimated using saved spacing. Review the saved reference before reconnecting.` };
  }
  const alternative = candidates.find(candidate => candidate.start !== best.start || candidate.end !== best.end);
  if (alternative && best.confidence - alternative.confidence < 0.08) { return undefined; }
  const shortPenalty = (distinctive(saved.before) ? 0 : 0.08) + (useEnd || distinctive(saved.after) ? 0 : 0.08);
  return { kind: 'uncertain', estimatedLine: best.estimatedLine, estimatedRange: best.estimatedRange, confidence: best.confidence - shortPenalty,
    ...(best.insertionLine !== undefined ? { insertionLine: best.insertionLine } : {}),
    reason: useEnd ? 'The original passage could not be matched. Its location is estimated from preceding context and the document end; review the saved reference before reconnecting.' :
      'The original passage could not be matched. Its location is estimated from the surrounding context; review the saved reference before reconnecting.' };
}
