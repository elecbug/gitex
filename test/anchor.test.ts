import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnchor, locateAnchor } from '../src/anchor';

test('inserting paragraphs preserves a multi-line comment, including CRLF documents', () => {
  const original = '\\section{Results}\nFirst sentence.\nSecond sentence.\n\\label{results}\n';
  const anchor = createAnchor('chapters/main.tex', original, 1, 2, null);
  assert.deepEqual(locateAnchor(anchor, `New paragraph.\n\n${original}`.replace(/\n/g, '\r\n')),
    { kind: 'attached', startLine: 3, endLine: 4 });
});

test('an edited or deleted passage retains an outdated comment', () => {
  const original = 'Introduction\nA result.\nConclusion\n';
  const anchor = createAnchor('main.tex', original, 1, 1, null);
  assert.equal(locateAnchor(anchor, 'Introduction\nAnother result.\nConclusion\n').kind, 'outdated');
  assert.equal(locateAnchor(anchor, 'Introduction\nConclusion\n').kind, 'outdated');
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
