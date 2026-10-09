import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnchor, locateAnchor } from '../src/anchor';

test('inserting paragraphs preserves a multi-line comment, including CRLF documents', () => {
  const original = '\\section{Results}\nFirst sentence.\nSecond sentence.\n\\label{results}\n';
  const anchor = createAnchor('chapters/main.tex', original, 1, 2, null);
  assert.deepEqual(locateAnchor(anchor, `New paragraph.\n\n${original}`.replace(/\n/g, '\r\n')),
    { kind: 'attached', startLine: 3, endLine: 4 });
});

test('unique short context estimates an unrelated replacement without claiming attachment', () => {
  const original = 'Introduction\nA result.\nConclusion\n';
  const anchor = createAnchor('main.tex', original, 1, 1, null);
  assert.equal(locateAnchor(anchor, 'Introduction\nAnother result.\nConclusion\n').kind, 'uncertain');
  assert.equal(locateAnchor(anchor, 'Introduction\nConclusion\n').kind, 'uncertain');
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
    assert.equal(locateAnchor(anchor, `Before\n${body}\nAfter`).kind, 'uncertain');
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

test('reversed, distant, repetitive or structural context cannot produce estimates', () => {
  const anchor = createAnchor('main.tex', contextPaper, 1, 1, null);
  for (const changed of [
    `${following}\n${preceding}`,
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

const koreanHeading = String.raw`\section*{작은 생각}`;
const koreanParagraph = '오늘은 바람이 살랑이고, 창밖의 구름은 천천히 흘러간다. 따뜻한 차 한 잔과 함께 잠시 쉬어 가도 좋겠다.';
const nextParagraph = '다음 날에는 새로운 실험 결과를 자세하게 살펴봅니다.';

test('short prose without punctuation is saved on both sides of the selected lines', () => {
  for (const ending of ['', '\n', '\n\\end{document}', '\n\nA later sentence.']) {
    const original = `${koreanHeading}\n헬로\n랄랄루${ending}`;
    const anchor = createAnchor('main.tex', original, 1, 1, null);
    assert.deepEqual(anchor.sentenceContext, { before: koreanHeading, after: '랄랄루' });
    assert.equal(anchor.afterBoundary, undefined, 'existing following text must not be replaced with an end boundary');
    assert.equal(createAnchor('main.tex', original, 2, 2, null).sentenceContext!.before, '헬로');
  }
  assert.deepEqual(createAnchor('main.tex', 'Hello\nSelected\nWorld', 1, 1, null).sentenceContext,
    { before: 'Hello', after: 'World' });
});

test('nearby unterminated prose takes priority over distant complete sentences and retains line wrapping', () => {
  const original = ['An older sentence.', '', '바로 앞 문맥', '', target, '', '% Ignore this.',
    '바로 뒤', '문맥', '', 'A later sentence.'].join('\r\n');
  assert.deepEqual(createAnchor('main.tex', original, 4, 4, null).sentenceContext,
    { before: '바로 앞 문맥', after: '바로 뒤 문맥' });
  const comment = createAnchor('main.tex', `${target}\n랄랄루 % A comment.\n\\end{document}\nInactive prose.`, 0, 0, null);
  assert.equal(comment.sentenceContext!.after, '랄랄루');
});

test('unterminated context is accepted at real boundaries but not when clipped by the search window', () => {
  const wrapped = Array(64).fill('Wrapped prose');
  for (const end of ['', '\n', '\n\\end{document}']) {
    const anchor = createAnchor('main.tex', [target, ...wrapped].join('\n') + end, 0, 0, null);
    assert.equal(anchor.sentenceContext!.after, wrapped.join(' '));
  }
  assert.equal(createAnchor('main.tex', [target, ...wrapped, 'Still the same paragraph'].join('\n'), 0, 0, null).sentenceContext!.after, '');
  const short = createAnchor('main.tex', `${koreanHeading}\n헬로\n랄랄루`, 1, 1, null);
  assert.equal(locateAnchor(short, `${koreanHeading}\n랄랄루`).kind, 'uncertain', 'a unique short context pair is enough for an estimate, not attachment');
});

test('deleted Korean text retains its estimated position between a heading and short wrapped prose', () => {
  const original = ['\\documentclass{article}', '\\usepackage{kotex}', '', '\\begin{document}', '',
    koreanHeading, '', '', '헬로', '', '', '랄랄루', '랄랄라.', '', '\\end{document}'].join('\n');
  const anchor = createAnchor('main.tex', original, 8, 8, null);
  assert.deepEqual(anchor.sentenceContext, { before: koreanHeading, after: '랄랄루 랄랄라.' });
  const snapshot = structuredClone(anchor);
  for (const updated of [original.replace('헬로', ''), original.replace('헬로', '').replace('랄랄루\n랄랄라.', '랄랄루 랄랄라.')]) {
    const location = locateAnchor(anchor, updated);
    assert.equal(location.kind, 'uncertain');
    if (location.kind === 'uncertain') { assert.equal(location.estimatedLine, 8); assert.deepEqual(location.estimatedRange, { startLine: 6, endLine: 11 }); }
  }
  assert.deepEqual(anchor, snapshot);
});

test('short saved context still matches when its following sentence is extended or punctuated', () => {
  const original = `${koreanHeading}\n헬로\n랄랄루`;
  const anchor = createAnchor('main.tex', original, 1, 1, null);
  for (const tail of ['랄랄루\n랄랄라.', '랄랄루.', '랄랄루 랄랄라.']) {
    assert.equal(locateAnchor(anchor, `${koreanHeading}\n\n${tail}`).kind, 'uncertain');
  }
  const punctuated = createAnchor('main.tex', `${original}.`, 1, 1, null);
  assert.equal(locateAnchor(punctuated, `${koreanHeading}\n랄랄루`).kind, 'uncertain');
});

test('one unique identifying side yields a lower-confidence estimate using saved spacing', () => {
  const anchor = createAnchor('main.tex', contextPaper, 1, 1, null);
  for (const [remaining, side] of [[preceding, 'preceding'], [following, 'following']]) {
    const location = locateAnchor(anchor, remaining);
    assert.equal(location.kind, 'uncertain');
    if (location.kind === 'uncertain') { assert.ok(location.confidence < 0.85); assert.equal(location.estimatedLine, 0); assert.ok(location.reason.includes(side)); }
    assert.equal(locateAnchor(anchor, `${remaining}\n\n${remaining}`).kind, 'outdated', 'one repeated side does not identify a location');
  }
  const short = createAnchor('main.tex', `${koreanHeading}\n헬로\n랄랄루`, 1, 1, null);
  assert.equal(locateAnchor(short, '랄랄루').kind, 'outdated', 'a short fragment alone is insufficient');
  assert.equal(locateAnchor(anchor, `${preceding}\n\\section{New scope}`).kind, 'outdated', 'a one-sided estimate must not cross into another section');
});

test('short contexts require an unambiguous ordered pair and ignore inactive or structural text', () => {
  const original = `${koreanHeading}\n헬로\n랄랄루`;
  const anchor = createAnchor('main.tex', original, 1, 1, null);
  for (const document of [
    `${koreanHeading}\n랄랄루\n\n${koreanHeading}\n랄랄루`,
    `${koreanHeading}\n${'랄랄루\n'.repeat(40)}`,
    `랄랄루\n${koreanHeading}`,
    `${koreanHeading}\n${'Unrelated discussion.\n'.repeat(20)}랄랄루`
  ]) { assert.equal(locateAnchor(anchor, document).kind, 'outdated'); }
  const missingHeading = `\\section{다른 제목}\n\\label{랄랄루}\n\\end{document}\n${koreanHeading}\n랄랄루`;
  assert.equal(locateAnchor(anchor, missingHeading).kind, 'outdated');
  const structure = createAnchor('main.tex', '\\end{figure}\n헬로\n\\begin{figure}', 1, 1, null);
  assert.equal(locateAnchor(structure, '\\end{figure}\n\\begin{figure}').kind, 'outdated');
});

test('named LaTeX headings and the next nonblank paragraph provide context for the reported Korean example', () => {
  for (const blanks of [1, 15, 40]) {
    const original = [koreanHeading, koreanParagraph, ...Array(blanks).fill(''), nextParagraph].join('\n');
    const anchor = createAnchor('main.tex', original, 1, 1, null);
    assert.deepEqual(anchor.sentenceContext, { before: koreanHeading, after: nextParagraph });
    const location = locateAnchor(anchor, original.replace(koreanParagraph + '\n', ''));
    assert.equal(location.kind, 'uncertain');
    if (location.kind === 'uncertain') { assert.equal(location.estimatedLine, 1); }
    assert.equal(locateAnchor(anchor, original.replace('따뜻한 차', '따뜻한 녹차')).kind, 'attached');
  }
});

test('headings support stars, optional short titles, nested formatting and labels', () => {
  for (const heading of [
    String.raw`\section*{작은 생각}`,
    String.raw`\subsection[Short]{A distinctive research question}`,
    String.raw`\chapter{A \textbf{distinctive} research question}\label{chap:question}`,
    String.raw`\paragraph*{A distinctive research question}`
  ]) {
    const original = `${heading}\n${target}\n\n${following}`;
    const anchor = createAnchor('main.tex', original, 1, 1, null);
    assert.equal(anchor.sentenceContext!.before, heading);
    assert.equal(locateAnchor(anchor, original.replace(target + '\n', '')).kind, 'uncertain');
  }
});

test('heading matching uses title identity instead of shared command syntax', () => {
  const anchor = createAnchor('main.tex', `${koreanHeading}\n${koreanParagraph}\n\n${nextParagraph}`, 1, 1, null);
  assert.equal(locateAnchor(anchor, `\\section{작은 생각}\\label{sec:new}\n\n${nextParagraph}`).kind, 'uncertain');
  assert.equal(locateAnchor(anchor, `\\section*{다른 이야기}\n\n${nextParagraph}`).kind, 'outdated');
  const duplicate = `${koreanHeading}\n\n${nextParagraph}\n`;
  assert.equal(locateAnchor(anchor, duplicate.repeat(2)).kind, 'outdated');
  assert.equal(locateAnchor(anchor, koreanHeading).kind, 'uncertain', 'a unique saved heading can provide a lower-confidence estimate');
});

test('empty sentence fields from 0.8.0 recover available heading context without rewriting history', () => {
  const created = createAnchor('main.tex', `${koreanHeading}\n${koreanParagraph}\n\n${nextParagraph}`, 1, 1, null);
  const old = { ...created, sentenceContext: { before: '', after: nextParagraph } };
  const snapshot = structuredClone(old);
  assert.equal(locateAnchor(old, `${koreanHeading}\n\n${nextParagraph}`).kind, 'uncertain');
  assert.deepEqual(old, snapshot);
  const { sentenceContext, ...legacy } = old;
  assert.equal(locateAnchor(legacy, `${koreanHeading}\n\n${nextParagraph}`).kind, 'uncertain');
  assert.equal(locateAnchor({ ...old, before: [], after: [], sentenceContext: { before: '', after: '' } },
    `${koreanHeading}\n\n${nextParagraph}`).kind, 'outdated', 'missing historical context is not invented from the current file');
});

test('blank lines on either side are skipped within the bounded context search', () => {
  const original = [preceding, ...Array(15).fill(''), target, ...Array(15).fill(''), following].join('\n');
  const anchor = createAnchor('main.tex', original, 16, 16, null);
  assert.deepEqual(anchor.sentenceContext, { before: preceding, after: following });
  assert.equal(locateAnchor(anchor, original.replace(target + '\n', '')).kind, 'uncertain');
  const beyondLimit = `${koreanHeading}\n${target}\n${'\n'.repeat(65)}${following}`;
  assert.equal(createAnchor('main.tex', beyondLimit, 1, 1, null).sentenceContext!.after, '');
});

test('bare LaTeX structure and two headings do not replace identifying prose context', () => {
  for (const heading of [String.raw`\begin{figure}`, String.raw`\end{figure}`, String.raw`\label{sec:example}`, String.raw`\section*{}`]) {
    const original = `${heading}\n${target}\n\n${following}`;
    assert.equal(locateAnchor(createAnchor('main.tex', original, 1, 1, null), original.replace(target + '\n', '')).kind, 'outdated');
  }
  const original = `${koreanHeading}\n${target}\n\\section{또 다른 생각}`;
  assert.equal(locateAnchor(createAnchor('main.tex', original, 1, 1, null), original.replace(target + '\n', '')).kind, 'outdated');
});

test('escaped percent signs survive while comments after LaTeX line breaks are excluded', () => {
  const before = String.raw`The measured improvement is 15\% across the complete validation dataset.`;
  const after = String.raw`Further measurements confirm the observed result. \\% This commented sentence must not be saved.`;
  const anchor = createAnchor('main.tex', `${before}\n${target}\n${after}`, 1, 1, null);
  assert.equal(anchor.sentenceContext!.before, before);
  assert.equal(anchor.sentenceContext!.after, 'Further measurements confirm the observed result.');
});

test('document-end context is recorded before end document, excluding inactive trailing text', () => {
  const original = `${preceding}\n${target}\n\n\\end{document}\nIgnored text after the document.`;
  const anchor = createAnchor('main.tex', original, 1, 1, null);
  assert.equal(anchor.afterBoundary, 'document-end');
  assert.equal(anchor.sentenceContext!.after, '');
  const location = locateAnchor(anchor, original.replace(target + '\n', ''));
  assert.equal(location.kind, 'uncertain');
  if (location.kind === 'uncertain') { assert.equal(location.estimatedLine, 1); assert.match(location.reason, /document end/); }
  assert.equal(locateAnchor(anchor, `${preceding}\n\n\\end{document}\n${target}`).kind, 'uncertain', 'an inactive copy beyond the saved end boundary cannot steal the comment');
});

test('file-end context supports files with and without a final newline', () => {
  for (const ending of ['', '\n', '\n\n% A trailing comment']) {
    const original = `${preceding}\n${target}${ending}`;
    const anchor = createAnchor('main.tex', original, 1, 1, null);
    assert.equal(anchor.afterBoundary, 'file-end');
    assert.equal(locateAnchor(anchor, `${preceding}${ending}`).kind, 'uncertain');
  }
});

test('end boundaries need identifying preceding context and a bounded gap', () => {
  const original = `${koreanHeading}\n${koreanParagraph}\n\\end{document}`;
  const anchor = createAnchor('main.tex', original, 1, 1, null);
  assert.equal(locateAnchor(anchor, `${koreanHeading}\n\\end{document}`).kind, 'uncertain');
  assert.equal(locateAnchor(anchor, `${koreanHeading}\n`).kind, 'outdated', 'a missing saved end-document marker is not silently replaced');
  assert.equal(locateAnchor(anchor, `${koreanHeading}\n${'Unrelated prose remains here.\n'.repeat(40)}\\end{document}`).kind, 'outdated');
  assert.equal(locateAnchor(createAnchor('main.tex', `${target}\n\\end{document}`, 0, 0, null), '\\end{document}').kind, 'outdated');
});

test('legacy end-document context works without rewriting the original anchor', () => {
  const original = `${preceding}\n${target}\n\\end{document}`;
  const { afterBoundary, ...legacy } = createAnchor('main.tex', original, 1, 1, null);
  const before = structuredClone(legacy);
  assert.equal(locateAnchor(legacy, `${preceding}\n\\end{document}`).kind, 'uncertain');
  assert.deepEqual(legacy, before);
});
