import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionAnchor, createAnchor, documentHash } from '../src/anchor';
import { EditTracking, enableEditTracking, diffEdits, positionAt } from '../src/editTracking';
import { validAnchor } from '../src/model';

function fixture(text: string, selected: string) {
  const start = text.indexOf(selected), end = start + selected.length;
  const anchor = enableEditTracking(createSelectionAnchor('main.tex', text, { start: positionAt(text, start), end: positionAt(text, end) }, null), text);
  const tracker = new EditTracking();
  assert.equal(tracker.seed('thread', 'revision', 'main.tex', anchor, text), true);
  return { anchor, tracker, text };
}
function edit(f: ReturnType<typeof fixture>, start: number, deleteCount: number, inserted: string, undoRedo = false) {
  const range = { start: positionAt(f.text, start), end: positionAt(f.text, start + deleteCount) };
  f.text = f.text.slice(0, start) + inserted + f.text.slice(start + deleteCount);
  f.tracker.change('main.tex', f.text, [{ range, text: inserted }], undoRedo);
  return f.tracker.locate('thread', 'revision', f.text);
}
function reference(f: ReturnType<typeof fixture>) { return f.tracker.reference('thread', 'revision', f.anchor, f.text, null)!; }

test('dragged text is exact, reversed selections normalize, and only a cursor selects the whole line', () => {
  const text = 'Earlier. Target sentence. Later.\r\nNext line.';
  for (const range of [{ start: { line: 0, character: 9 }, end: { line: 0, character: 25 } },
    { start: { line: 0, character: 25 }, end: { line: 0, character: 9 } }]) {
    const anchor = createSelectionAnchor('main.tex', text, range, null);
    assert.deepEqual(anchor.selected, ['Target sentence.']); assert.ok(validAnchor(anchor));
  }
  const cursor = createSelectionAnchor('main.tex', text, { start: { line: 0, character: 10 }, end: { line: 0, character: 10 } }, null);
  assert.deepEqual(cursor.selected, ['Earlier. Target sentence. Later.']);
  const partial = createSelectionAnchor('main.tex', text, { start: { line: 0, character: 9 }, end: { line: 1, character: 0 } }, null);
  assert.equal(partial.endLine, 0); assert.deepEqual(partial.selected, ['Target sentence. Later.']);
  assert.throws(() => createSelectionAnchor('main.tex', text, { start: { line: 0, character: 8 }, end: { line: 0, character: 9 } }, null), /non-empty/);
  assert.ok(validAnchor(createSelectionAnchor('main.tex', 'catalog', { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, null)));
});

test('prefix edits shift ranges, boundary inserts are excluded, Unicode offsets are UTF-16', () => {
  const f = fixture('Before. 실험 🧪 문장입니다. After.', '실험 🧪 문장입니다.');
  edit(f, 0, 0, 'New text. ');
  edit(f, f.text.indexOf('실험'), 0, 'Prefix ');
  edit(f, f.text.indexOf(' After.'), 0, ' Appended sentence.');
  assert.deepEqual(reference(f).selected, ['실험 🧪 문장입니다.']);
  assert.equal(reference(f).logicalRange!.startCharacter, f.text.indexOf('실험'));
  assert.deepEqual(f.anchor.selected, ['실험 🧪 문장입니다.']);
});

test('whole-range cut and paste moves to the pasted range and does not follow copies', () => {
  const f = fixture('Before. Target text. After.\nDestination: ', 'Target text.');
  const cut = 'Target text.';
  assert.equal(edit(f, f.text.indexOf(cut), cut.length, '').kind, 'uncertain');
  assert.equal(edit(f, f.text.length, 0, cut).kind, 'attached');
  assert.equal(reference(f).startLine, 1);
  const at = reference(f).logicalRange!.startCharacter;
  edit(f, 0, 0, cut + ' ');
  assert.equal(reference(f).startLine, 1, 'copying identical text does not retarget the thread');
  assert.equal(reference(f).logicalRange!.startCharacter, at);
});

test('cutting a container moves an inner selection by its relative offset', () => {
  const f = fixture('Intro\n\u005ctextbf{Target text.} tail\nDestination\n', 'Target text.');
  const start = f.text.indexOf('\u005ctextbf'), chunk = f.text.slice(start, f.text.indexOf('\nDestination'));
  edit(f, start, chunk.length, '');
  edit(f, f.text.length, 0, chunk);
  assert.deepEqual(reference(f).selected, ['Target text.']);
  assert.equal(reference(f).startLine, 3);
});

test('text inserted inside a range splits it; whitespace reflow retains one range', () => {
  const f = fixture('Prefix. Alpha beta gamma. Suffix.', 'Alpha beta gamma.');
  edit(f, f.text.indexOf('beta'), 0, 'INSERTED ');
  assert.deepEqual(reference(f).selected, ['Alpha ']);
  assert.equal(reference(f).tracking!.fragments.length, 2);
  assert.deepEqual(f.anchor.selected, ['Alpha beta gamma.'], 'the creation identity is preserved');
  const wrap = fixture('Prefix. Alpha beta gamma. Suffix.', 'Alpha beta gamma.');
  edit(wrap, wrap.text.indexOf('beta'), 0, '\n');
  assert.deepEqual(reference(wrap).selected, ['Alpha ', 'beta gamma.']);
  assert.equal(reference(wrap).tracking!.fragments.length, 1);
});

test('a split-off tail can move while the original leading fragment retains the comment', () => {
  const f = fixture('Alpha beta gamma.\nEnd', 'Alpha beta gamma.');
  const start = f.text.indexOf('beta'), chunk = 'beta gamma.';
  edit(f, start, chunk.length, '');
  edit(f, f.text.length, 0, '\n');
  edit(f, f.text.length, 0, chunk);
  const next = reference(f);
  assert.deepEqual(next.selected, ['Alpha ']);
  assert.equal(next.tracking!.fragments.length, 2);
  const restored = new EditTracking();
  assert.equal(restored.seed('thread', 'next', 'main.tex', next, f.text), true);
  assert.equal(restored.locate('thread', 'next', f.text).kind, 'attached');
});

test('undo and redo restore splits, removals and moves exactly', () => {
  const f = fixture('Alpha beta gamma.\nEnd', 'Alpha beta gamma.');
  const original = f.text;
  edit(f, 6, 0, 'INSERTED ');
  const split = f.text;
  edit(f, 6, 9, '', true);
  assert.equal(f.text, original); assert.deepEqual(reference(f).selected, ['Alpha beta gamma.']);
  edit(f, 6, 0, 'INSERTED ', true);
  assert.equal(f.text, split); assert.deepEqual(reference(f).selected, ['Alpha ']);
});

test('same-event cut and paste works in both directions', () => {
  for (const reverse of [false, true]) {
    const f = fixture('Start\nTarget text.\nEnd\n', 'Target text.');
    const start = f.text.indexOf('Target text.'), to = reverse ? 0 : f.text.length;
    const changes = [ { range: { start: positionAt(f.text, start), end: positionAt(f.text, start + 12) }, text: '' },
      { range: { start: positionAt(f.text, to), end: positionAt(f.text, to) }, text: 'Target text.' } ];
    f.text = reverse ? 'Target text.' + f.text.replace('Target text.', '') : f.text.replace('Target text.', '') + 'Target text.';
    f.tracker.change('main.tex', f.text, changes);
    assert.equal(reference(f).startLine, reverse ? 0 : 3);
  }
});

test('saved tracking survives restart and exact external diffs; unknown revisions stay pending', () => {
  const f = fixture('Before.\nTarget text.\nAfter.', 'Target text.');
  edit(f, 0, 0, 'Preface.\n'); f.tracker.locate('thread', 'revision', f.text, true);
  const restored = new EditTracking(JSON.parse(JSON.stringify(f.tracker.snapshot())));
  const location = restored.locate('thread', 'revision', 'More.\n' + f.text);
  assert.equal(location.kind, 'attached'); if (location.kind === 'attached') { assert.equal(location.startLine, 3); }
  assert.equal(restored.locate('thread', 'remote-new-revision', f.text).kind, 'pending');
});

test('staged references follow edits while input and Git writes are pending', () => {
  const f = fixture('Before. Target text. After.', 'Target text.');
  f.tracker.stage('main.tex', f.anchor, f.text);
  edit(f, 0, 0, 'New preface. ');
  assert.equal(f.tracker.adopt('created-thread', 'new', 'main.tex', f.anchor), true);
  const location = f.tracker.locate('created-thread', 'new', f.text);
  assert.equal(location.kind, 'attached');
  if (location.kind === 'attached') { assert.equal(location.logicalRange!.startCharacter, f.text.indexOf('Target')); }
});

test('diff scripts reconstruct varied edits without fuzzy passage searches', () => {
  let seed = 12345;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 250; i++) {
    const text = Array.from({ length: 40 }, () => 'abc \n'[Math.floor(random() * 5)]).join('');
    let target = text;
    for (let j = 0; j < 4; j++) {
      const start = Math.floor(random() * target.length), length = Math.floor(random() * 5);
      target = target.slice(0, start) + (random() > 0.5 ? 'XYZ' : '') + target.slice(start + length);
    }
    let applied = text;
    for (const edit of diffEdits(text, target).reverse()) { applied = applied.slice(0, edit.start) + edit.text + applied.slice(edit.start + edit.deleteCount); }
    assert.equal(applied, target);
  }
  assert.equal(documentHash('abc\r\n'), documentHash('abc\n'));
  assert.equal(new EditTracking().seed('key', 'rev', 'main.tex', createAnchor('main.tex', 'abc', 0, 0, null), 'different'), false);
});


test('whole-document editor reloads replay exact changes around a partial selection', () => {
  const f = fixture('Before. Target text. After.', 'Target text.');
  edit(f, 0, f.text.length, 'New intro. Before. Target text. After. New ending.');
  assert.deepEqual(reference(f).selected, ['Target text.']);
  assert.equal(reference(f).logicalRange!.startCharacter, f.text.indexOf('Target'));
});

test('an oversized unproven diff retains a gap instead of absorbing unrelated content', () => {
  const f = fixture('a'.repeat(2000), 'a'.repeat(2000));
  const updated = 'b'.repeat(2000);
  assert.equal(diffEdits(f.text, updated)[0].opaque, true);
  assert.equal(f.tracker.locate('thread', 'revision', updated).kind, 'uncertain');
});

test('CRLF editor changes use line columns and snapshots use normalized offsets', () => {
  const f = fixture('First.\nTarget text.\nLast.', 'Target text.');
  const text = 'Preface.\r\nFirst.\r\nTarget text.\r\nLast.';
  f.tracker.change('main.tex', text, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'Preface.\r\n' }]);
  const location = f.tracker.locate('thread', 'revision', text);
  assert.equal(location.kind, 'attached');
  if (location.kind === 'attached') { assert.equal(location.startLine, 2); }
  assert.deepEqual(f.tracker.reference('thread', 'revision', f.anchor, text, null)!.selected, ['Target text.']);
});

test('split highlights distinguish original fragments from inserted text and survive sharing', () => {
  const f = fixture('Before. Alpha beta gamma. After.', 'Alpha beta gamma.');
  edit(f, f.text.indexOf('beta'), 0, 'INSERTED ');
  const highlights = () => f.tracker.highlights('thread', 'revision', f.text);
  assert.deepEqual(highlights().owned.map(range => f.text.slice(range.start, range.end)), ['Alpha ', 'beta gamma.']);
  assert.deepEqual(highlights().inserted.map(range => f.text.slice(range.start, range.end)), ['INSERTED ']);
  edit(f, 0, 0, 'Preface.\n');
  edit(f, f.text.indexOf('INSERTED') + 3, 0, ' changed ');
  assert.deepEqual(highlights().inserted.map(range => f.text.slice(range.start, range.end)), ['INS changed ERTED ']);
  const next = reference(f);
  assert.ok(validAnchor(next));
  assert.equal(next.tracking!.insertions!.length, 1);
  const peer = new EditTracking();
  assert.equal(peer.seed('peer', 'next', 'main.tex', JSON.parse(JSON.stringify(next)), f.text), true);
  assert.deepEqual(peer.highlights('peer', 'next', f.text), highlights());
  f.tracker.locate('thread', 'revision', f.text, true);
  const restored = new EditTracking(JSON.parse(JSON.stringify(f.tracker.snapshot())));
  assert.deepEqual(restored.highlights('thread', 'revision', f.text), highlights());
  assert.deepEqual(restored.highlights('thread', 'different-revision', f.text), { owned: [], inserted: [] });
});

test('moving a split container moves both original and inserted shading without coloring unrelated gaps', () => {
  const f = fixture('Prefix. Alpha beta. Suffix.\nDestination: ', 'Alpha beta.');
  edit(f, f.text.indexOf('beta'), 0, 'INSERTED ');
  const start = f.text.indexOf('Alpha'), cut = 'Alpha INSERTED beta.';
  edit(f, start, cut.length, '');
  edit(f, f.text.length, 0, cut);
  const colors = f.tracker.highlights('thread', 'revision', f.text);
  assert.deepEqual(colors.owned.map(range => f.text.slice(range.start, range.end)), ['Alpha ', 'beta.']);
  assert.deepEqual(colors.inserted.map(range => f.text.slice(range.start, range.end)), ['INSERTED ']);
  const ordinary = fixture('Alpha beta.\nUnrelated paragraph.\n', 'Alpha beta.');
  edit(ordinary, 6, 5, ''); edit(ordinary, ordinary.text.length, 0, 'beta.');
  assert.deepEqual(ordinary.tracker.highlights('thread', 'revision', ordinary.text).inserted, [], 'a cut does not turn all intervening text into inserted prose');
});

test('saving a cut keeps it live, but closing or restoring its saved state makes it outdated', () => {
  const f = fixture('Before. Target text. After.\n', 'Target text.');
  const selected = 'Target text.';
  edit(f, f.text.indexOf(selected), selected.length, '');
  assert.equal(f.tracker.locate('thread', 'revision', f.text, true).kind, 'uncertain');
  const saved = f.tracker.snapshot();
  assert.ok(!JSON.stringify(saved).includes('"cut"'), 'clipboard records are not persisted');
  const restored = new EditTracking(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.locate('thread', 'revision', f.text).kind, 'outdated');
  assert.deepEqual(restored.highlights('thread', 'revision', f.text), { owned: [], inserted: [] });
  const reopened = f.text + selected;
  restored.change('main.tex', reopened, [{ range: { start: positionAt(f.text, f.text.length), end: positionAt(f.text, f.text.length) }, text: selected }]);
  assert.equal(restored.locate('thread', 'revision', reopened).kind, 'outdated', 'a new session cannot revive an expired cut');
  // More than the old 100-change limit must not expire a live editor session.
  for (let i = 0; i < 105; i++) { edit(f, 0, 0, 'x'); }
  edit(f, f.text.length, 0, selected);
  assert.equal(f.tracker.locate('thread', 'revision', f.text).kind, 'attached');
  assert.equal(reference(f).startLine, 1);
  edit(f, f.text.indexOf(selected), selected.length, '');
  f.tracker.locate('thread', 'revision', f.text, true);
  f.tracker.endSession('main.tex');
  assert.equal(f.tracker.locate('thread', 'revision', f.text).kind, 'outdated');
  edit(f, f.text.length, 0, selected);
  assert.equal(f.tracker.locate('thread', 'revision', f.text).kind, 'outdated');
});

test('a partial cut remains pasteable after saving a reply at the surviving fragment', () => {
  const f = fixture('Alpha beta.\nDestination: ', 'Alpha beta.');
  edit(f, 6, 5, '');
  const next = reference(f);
  f.tracker.stage('main.tex', next, f.text, 'thread');
  assert.equal(f.tracker.adopt('thread', 'next', 'main.tex', next), true);
  const at = f.text.length;
  f.tracker.change('main.tex', f.text + 'beta.', [{ range: { start: positionAt(f.text, at), end: positionAt(f.text, at) }, text: 'beta.' }]);
  f.text += 'beta.';
  const highlights = f.tracker.highlights('thread', 'next', f.text);
  assert.deepEqual(highlights.owned.map(range => f.text.slice(range.start, range.end)), ['Alpha ', 'beta.']);
});

test('insertion highlights follow undo, deletion and line reflow', () => {
  const f = fixture('Alpha beta.', 'Alpha beta.');
  edit(f, 6, 0, 'New ');
  edit(f, 6, 4, '', true);
  assert.deepEqual(f.tracker.highlights('thread', 'revision', f.text).inserted, []);
  edit(f, 6, 0, 'New ', true);
  assert.equal(f.tracker.highlights('thread', 'revision', f.text).inserted.length, 1);
  edit(f, 8, 0, '\n');
  assert.deepEqual(f.tracker.highlights('thread', 'revision', f.text).inserted.map(range => f.text.slice(range.start, range.end)), ['Ne\nw ']);
  edit(f, 6, 5, '');
  assert.deepEqual(f.tracker.highlights('thread', 'revision', f.text).inserted, []);
});

test('pasting original text into inserted text keeps the two highlight ranges disjoint and shareable', () => {
  const f = fixture('Alpha beta. tail', 'Alpha beta.');
  edit(f, 6, 0, 'New ');
  edit(f, 10, 5, '');
  edit(f, 8, 0, 'beta.');
  const colors = f.tracker.highlights('thread', 'revision', f.text);
  assert.deepEqual(colors.owned.map(range => f.text.slice(range.start, range.end)), ['Alpha ', 'beta.']);
  assert.deepEqual(colors.inserted.map(range => f.text.slice(range.start, range.end)), ['Ne', 'w ']);
  const next = reference(f), peer = new EditTracking();
  assert.equal(peer.seed('peer', 'next', 'main.tex', next, f.text), true);
  assert.deepEqual(peer.highlights('peer', 'next', f.text), colors);
});

test('moving inserted text inside an original fragment does not duplicate insertion shading', () => {
  const f = fixture('Alpha beta.', 'Alpha beta.');
  edit(f, 6, 0, 'New ');
  edit(f, 6, 4, '');
  edit(f, 2, 0, 'New ');
  const colors = f.tracker.highlights('thread', 'revision', f.text);
  assert.deepEqual(colors.owned.map(range => f.text.slice(range.start, range.end)), ['Al', 'pha ', 'beta.']);
  assert.deepEqual(colors.inserted, [{ start: 2, end: 6 }]);
});

test('pending paper versions freeze tracking and cannot publish or shade an older document', () => {
  const f = fixture('Before. Target text. After.', 'Target text.');
  const head = 'a'.repeat(40);
  f.tracker.resume('thread', 'revision', head);
  f.tracker.locate('thread', 'revision', f.text, true);
  const saved = new EditTracking(f.tracker.snapshot());
  assert.equal(saved.paperHead('thread'), head);
  f.tracker.suspend('thread');
  edit(f, 0, f.text.length, 'An earlier unrelated paper.');
  assert.equal(f.tracker.locate('thread', 'revision', f.text, true).kind, 'pending');
  assert.deepEqual(f.tracker.highlights('thread', 'revision', f.text), { owned: [], inserted: [] });
  assert.equal(reference(f), undefined);
  assert.equal(f.tracker.text('thread'), 'Before. Target text. After.');
  f.text = 'Introduction. Before. Target text. After.';
  f.tracker.resume('thread', 'revision', head);
  assert.deepEqual(reference(f).selected, ['Target text.']);
});

test('a shared reference with unchanged geometry preserves live cut tickets and final outdated state', () => {
  const f = fixture('Before. Target text. After.\n', 'Target text.');
  edit(f, 8, 12, '');
  assert.equal(f.tracker.rebind('thread', 'revision', 'reply'), true);
  const at = f.text.length;
  f.tracker.change('main.tex', f.text + 'Target text.', [{ range: { start: positionAt(f.text, at), end: positionAt(f.text, at) }, text: 'Target text.' }]);
  f.text += 'Target text.';
  const location = f.tracker.locate('thread', 'reply', f.text);
  assert.equal(location.kind, 'attached');
  if (location.kind === 'attached') { assert.equal(location.startLine, 1); }
  f.tracker.change('main.tex', f.text.slice(0, at), [{ range: { start: positionAt(f.text, at), end: positionAt(f.text, f.text.length) }, text: '' }]);
  f.text = f.text.slice(0, at);
  f.tracker.locate('thread', 'reply', f.text, true); f.tracker.endSession('main.tex');
  assert.equal(f.tracker.rebind('thread', 'reply', 'second-reply'), true);
  assert.equal(f.tracker.locate('thread', 'second-reply', f.text).kind, 'outdated');
  assert.equal(new EditTracking(f.tracker.snapshot()).locate('thread', 'second-reply', f.text).kind, 'outdated');
});
