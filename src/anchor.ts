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
}

export type Location = { kind: 'attached'; startLine: number; endLine: number; similarity?: number } |
  { kind: 'outdated'; reason: string };

function lines(text: string): string[] { return text.replace(/\r\n/g, '\n').split('\n'); }
function hash(text: string): string { return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex'); }

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
  return { path, baseCommit, documentHash: hash(text), startLine, endLine, selected,
    before: document.slice(Math.max(0, startLine - 3), startLine),
    after: document.slice(endLine + 1, endLine + 4), occurrences: matches(document, selected).length };
}

export function locateAnchor(anchor: Anchor, text: string): Location {
  if (hash(text) === anchor.documentHash) { return { kind: 'attached', startLine: anchor.startLine, endLine: anchor.endLine }; }
  const document = lines(text);
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
    return { start, score };
  }).sort((a, b) => b.score - a.score);
  if (!candidates.length) { return approximate(anchor, document); }
  const best = candidates[0];
  // An old sentence copied elsewhere must not outrank its slightly edited passage with intact context.
  if (anchor.selected.join(' ').length >= 16 && best.score < (anchor.before.length + anchor.after.length) / 2) {
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
