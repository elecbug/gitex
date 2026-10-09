import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnchor, locateAnchor } from '../src/anchor';

test('inserting paragraphs preserves a multi-line comment, including CRLF documents', () => {
  const original = '\\section{Results}\nFirst sentence.\nSecond sentence.\n\\label{results}\n';
  const anchor = createAnchor('chapters/main.tex', original, 1, 2, null);
  assert.deepEqual(locateAnchor(anchor, `New paragraph.\n\n${original}`.replace(/\n/g, '\r\n')),
    { kind: 'attached', startLine: 3, endLine: 4 });
});

test('an unrelated replacement or deleted passage retains an outdated comment', () => {
  const original = 'Introduction\nA result.\nConclusion\n';
  const anchor = createAnchor('main.tex', original, 1, 1, null);
  assert.equal(locateAnchor(anchor, 'Introduction\nAnother result.\nConclusion\n').kind, 'outdated');
  assert.equal(locateAnchor(anchor, 'Introduction\nConclusion\n').kind, 'outdated');
});

test('small edits keep a shifted passage attached using text and surrounding context', () => {
  const original = '\\section{Results}\nOur method improves accuracy on the evaluation dataset.\nThe experiment uses five seeds.\n';
  const anchor = createAnchor('main.tex', original, 1, 1, null);
  const updated = 'New introduction\n' + original.replace('improves accuracy', 'improves prediction accuracy');
  const location = locateAnchor(anchor, updated);
  assert.equal(location.kind, 'attached');
  if (location.kind === 'attached') {
    assert.equal(location.startLine, 2); assert.equal(location.endLine, 2);
    assert.ok(location.similarity! >= 0.74 && location.similarity! < 1);
  }
});

test('whitespace and rewrapping can change the number of matched lines', () => {
  const original = 'Introduction\nOur method improves accuracy on the evaluation dataset.\nConclusion';
  const anchor = createAnchor('main.tex', original, 1, 1, null);
  const location = locateAnchor(anchor, 'Introduction\n  Our method improves\n accuracy on the evaluation\n dataset.\nConclusion');
  assert.deepEqual(location, { kind: 'attached', startLine: 1, endLine: 3, similarity: 1 });
  const wrapped = createAnchor('main.tex', 'Introduction\nOur method improves\naccuracy on the evaluation dataset.\nConclusion', 1, 2, null);
  assert.deepEqual(locateAnchor(wrapped, original), { kind: 'attached', startLine: 1, endLine: 1, similarity: 1 });
});

test('small LaTeX and Korean edits preserve order-sensitive matches', () => {
  for (const [before, after] of [
    ['We use $x_i$ to compute the final result.', 'We use $x_j$ to compute the final result.'],
    ['실험 결과는 제안한 방법의 높은 정확도를 보여줍니다.', '실험 결과는 제안한 방법의 더 높은 정확도를 보여줍니다.']
  ]) {
    const anchor = createAnchor('main.tex', `Before\n${before}\nAfter`, 1, 1, null);
    assert.equal(locateAnchor(anchor, `Before\n${after}\nAfter`).kind, 'attached');
  }
});

test('ambiguous approximate matches are not chosen by proximity to the old line', () => {
  const original = 'Before\nWe report the average accuracy over all runs.\nAfter';
  const anchor = createAnchor('main.tex', original, 1, 1, null);
  const edited = original.replace('average accuracy', 'mean accuracy');
  assert.equal(locateAnchor(anchor, `${edited}\n\n${edited}`).kind, 'outdated');
});

test('surrounding context disambiguates similar passages in different sections', () => {
  const original = 'A section\nOur method improves accuracy on the evaluation dataset.\nEnd A';
  const anchor = createAnchor('main.tex', original, 1, 1, null);
  const edited = 'Our method improves prediction accuracy on the evaluation dataset.';
  const location = locateAnchor(anchor, `B section\n${edited}\nEnd B\n\nA section\n${edited}\nEnd A`);
  assert.equal(location.kind, 'attached');
  if (location.kind === 'attached') { assert.equal(location.startLine, 5); }
});

test('text order and a minimum text similarity prevent attachment to unrelated passages', () => {
  const anchor = createAnchor('main.tex', 'Before\nThe method increases precision while reducing latency.\nAfter', 1, 1, null);
  for (const body of ['We discuss a completely separate observation.', 'latency. reducing while precision increases method The', '']) {
    assert.equal(locateAnchor(anchor, `Before\n${body}\nAfter`).kind, 'outdated');
  }
});

test('a copied old sentence does not steal the anchor from an edited passage with matching context', () => {
  const sentence = 'Our method improves accuracy on the evaluation dataset.';
  const original = `Results\n${sentence}\nDiscussion`;
  const anchor = createAnchor('main.tex', original, 1, 1, null);
  const updated = `Results\n${sentence.replace('accuracy', 'precision')}\nDiscussion\n\nAppendix\n${sentence}\nEnd`;
  const location = locateAnchor(anchor, updated);
  assert.equal(location.kind, 'attached');
  if (location.kind === 'attached') { assert.equal(location.startLine, 1); }
});

test('unchanged repeated lines attach exactly; ambiguous changed documents do not guess', () => {
  const original = 'a\nRepeated\nz\na\nRepeated\nz';
  const anchor = createAnchor('main.tex', original, 1, 1, null);
  assert.deepEqual(locateAnchor(anchor, original), { kind: 'attached', startLine: 1, endLine: 1 });
  const ambiguous = 'a\nRepeated\nz\nx\nx\nx\na\nRepeated\nz';
  const minimal = { ...anchor, before: ['a'], after: ['z'] };
  assert.equal(locateAnchor(minimal, ambiguous).kind, 'outdated');
});

test('context disambiguates repeated lines after an insertion', () => {
  const original = 'Section one\nRepeated\nEnd one\nSection two\nRepeated\nEnd two';
  const anchor = createAnchor('main.tex', original, 4, 4, null);
  assert.deepEqual(locateAnchor(anchor, `Title\n${original}`), { kind: 'attached', startLine: 5, endLine: 5 });
});

test('blank-only and invalid ranges cannot create misleading anchors', () => {
  assert.throws(() => createAnchor('main.tex', '\n\n', 0, 1, null), /non-empty/);
  assert.throws(() => createAnchor('main.tex', 'text', 0, 3, null), /range/);
});
