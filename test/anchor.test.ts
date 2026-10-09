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

const preceding = 'We evaluated the protocol on the independent validation dataset.';
const target = 'The results show a 15% improvement.';
const following = 'Further analysis is needed to explain the observed performance.';
const contextPaper = `${preceding}\n${target}\n${following}`;

test('anchors save one complete sentence on each side, across line wraps and CRLF', () => {
  const paper = 'An older sentence.\nWe evaluated the protocol\non the independent\nvalidation dataset.\n' + target +
    '\nFurther analysis is needed\nto explain the observed\nperformance.\nAnother later sentence.';
  const anchor = createAnchor('main.tex', paper.replace(/\n/g, '\r\n'), 4, 4, null);
  assert.deepEqual(anchor.sentenceContext, { before: preceding, after: following });
  assert.equal(anchor.before.length, 3); assert.equal(anchor.after.length, 3, 'legacy fields keep their original limits');
  assert.deepEqual(createAnchor('main.tex', target, 0, 0, null).sentenceContext, { before: '', after: '' });
});

test('LaTeX structure, comments, inline macros and non-Latin sentences are handled conservatively', () => {
  const before = '우리는 독립적인 데이터로 프로토콜을 평가했습니다.';
  const after = '결과를 설명하려면 추가적인 분석이 필요합니다.';
  const text = `\\section{Results}\n${before}\n${target}\n${after}\n% This sentence is commented out.`;
  const anchor = createAnchor('main.tex', text, 2, 2, null);
  assert.deepEqual(anchor.sentenceContext, { before, after });
  assert.equal(locateAnchor(anchor, text.replace(target + '\n', '')).kind, 'uncertain');
  const latex = createAnchor('main.tex', `We evaluated the \\emph{protocol} using independent validation data.\n${target}\n${following}`, 1, 1, null);
  assert.match(latex.sentenceContext!.before, /\\emph\{protocol\}/);
});

test('deletion and complete replacement estimate locality without claiming text identity', () => {
  const anchor = createAnchor('main.tex', contextPaper, 1, 1, null);
  const original = structuredClone(anchor);
  for (const replacement of ['', 'An unrelated observation about compiler design.\n']) {
    const location = locateAnchor(anchor, `A new introductory paragraph.\n${preceding}\n${replacement}${following}`);
    assert.equal(location.kind, 'uncertain');
    if (location.kind === 'uncertain') {
      assert.equal(location.estimatedLine, 2);
      assert.ok(location.confidence >= 0.85 && location.confidence <= 1);
      assert.equal('startLine' in location, false, 'an estimate is not an attached range');
    }
  }
  assert.deepEqual(anchor, original, 'location calculations must never mutate saved anchors');
  assert.equal(locateAnchor(anchor, `Title\n${contextPaper}`).kind, 'attached');
});

test('context-only matches tolerate sentence rewrapping and small edits on both sides', () => {
  const anchor = createAnchor('main.tex', contextPaper, 1, 1, null);
  const changed = `${preceding.replace('independent', 'independent test').replace('protocol on', 'protocol\non')}\n` + following.replace('needed', 'required');
  const location = locateAnchor(anchor, changed);
  assert.equal(location.kind, 'uncertain');
  if (location.kind === 'uncertain') { assert.equal(location.estimatedLine, 2); }
});

test('complete sentence evidence follows passages when context is rewrapped beyond three lines', () => {
  const longBefore = 'Before the final measurement we independently evaluated each protocol over the entire validation dataset.';
  const longAfter = 'After every experimental run the team recorded the complete measurements for further statistical analysis.';
  const anchor = createAnchor('main.tex', `${longBefore}\n${target}\n${longAfter}`, 1, 1, null);
  const before = longBefore.split(' ').join('\n'), after = longAfter.split(' ').join('\n');
  const location = locateAnchor(anchor, `${before}\n${target}\n${after}`);
  assert.equal(location.kind, 'attached');
  const removed = locateAnchor(anchor, `${before}\n${after}`);
  assert.equal(removed.kind, 'uncertain');
});

test('missing, reversed, distant, repetitive or structural context cannot produce estimates', () => {
  const anchor = createAnchor('main.tex', contextPaper, 1, 1, null);
  for (const changed of [
    preceding, following, `${following}\n${preceding}`,
    `${preceding}\n${'Unrelated discussion.\n'.repeat(20)}${following}`,
    `${preceding}\n${following}\n\n${preceding}\n${following}`,
    `${preceding}\n\\section{Different section}\n${following}`,
    `${preceding}\n${following}\n`.repeat(40)
  ]) { assert.equal(locateAnchor(anchor, changed).kind, 'outdated', changed); }
  const structure = '\\end{figure}\n' + target + '\n\\begin{figure}';
  assert.equal(locateAnchor(createAnchor('main.tex', structure, 1, 1, null), '\\end{figure}\n\\begin{figure}').kind, 'outdated');
});

test('one unique context pair can disambiguate individually repeated sentences', () => {
  const anchor = createAnchor('main.tex', contextPaper, 1, 1, null);
  const location = locateAnchor(anchor, `${preceding}\nA different ending.\n\\section{Next}\n${preceding}\n${following}`);
  assert.equal(location.kind, 'uncertain');
  if (location.kind === 'uncertain') { assert.equal(location.estimatedLine, 4); }
});

test('legacy anchors use only their saved line context and do not invent missing sentences', () => {
  const { sentenceContext, ...legacy } = createAnchor('main.tex', contextPaper, 1, 1, null);
  assert.equal(locateAnchor(legacy, `${preceding}\n${following}`).kind, 'uncertain');
  assert.equal(locateAnchor({ ...legacy, before: ['Before'], after: ['After'] }, `${preceding}\n${following}`).kind, 'outdated');
  assert.equal(locateAnchor(legacy, contextPaper).kind, 'attached');
});

test('bounded sentence capture does not save a clipped tail as a complete sentence', () => {
  const long = Array.from({ length: 70 }, (_, i) => i === 69 ? 'the final measurements.' : 'More words across wrapped lines');
  const anchor = createAnchor('main.tex', [...long, target, following].join('\n'), 70, 70, null);
  assert.deepEqual(anchor.sentenceContext, { before: '', after: following });
});
