import { diffEdits, reverseDiffEdits, normalizedText } from './editTracking';

/** Check that a draft's changes occur at stable base coordinates in a later paper version.
 * Coordinates are relative to the same committed base, never a fuzzy passage match.
 */
export function snapshotChangesPresent(base: string, snapshot: string, paper: string): boolean {
  base = normalizedText(base); snapshot = normalizedText(snapshot); paper = normalizedText(paper);
  const containsEdits = (before: string, draft: string, current: string, wholeLines = false): boolean => {
    const expected = [diffEdits(before, draft), reverseDiffEdits(before, draft)];
    const received = [diffEdits(before, current), reverseDiffEdits(before, current)];
    if (expected.some(script => !script.length) || [...expected, ...received].some(script => script.some(edit => edit.opaque))) { return false; }
    // Both possible alignments must agree on receipt. A one-sided diff cannot
    // establish which repeated occurrence was changed.
    return expected.every(script => received.every(actual => script.every(edit => actual.some(candidate => candidate.start === edit.start &&
      candidate.deleteCount === edit.deleteCount && (edit.text ?
        wholeLines ? candidate.text.includes(edit.text) : candidate.text.startsWith(edit.text) : !candidate.text)))));
  };
  if (containsEdits(base, snapshot, paper)) { return true; }
  // Character diffs can place an identical inserted space on either side of a
  // word. Also compare exact whole-line edits against the same base coordinates.
  // Tokens represent full source lines, not normalized prose or fuzzy matches.
  const tokens = new Map<string, string>();
  const encode = (text: string) => text.split('\n').map(line => {
    if (!tokens.has(line)) { tokens.set(line, String.fromCharCode(tokens.size + 1)); }
    return tokens.get(line)!;
  }).join('');
  const encoded = [base, snapshot, paper].map(encode);
  if (tokens.size > 65_534) { return false; }
  return containsEdits(encoded[0], encoded[1], encoded[2], true);
}
