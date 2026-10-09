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

export type Location = { kind: 'attached'; startLine: number; endLine: number } |
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
  if (!candidates.length) { return { kind: 'outdated', reason: 'The commented text was changed or removed.' }; }
  const best = candidates[0];
  // Never select one of several identical passages based only on its line number.
  if ((candidates.length > 1 && (best.score === 0 || best.score === candidates[1].score)) ||
      (anchor.occurrences > 1 && best.score === 0)) {
    return { kind: 'outdated', reason: 'Several passages could match this comment. Review the original excerpt.' };
  }
  return { kind: 'attached', startLine: best.start, endLine: best.start + anchor.selected.length - 1 };
}
