import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnchor, locateAnchor, renewAnchor } from '../src/anchor';
import { validAnchor } from '../src/model';
import { LocalTracking } from '../src/localTracking';

const before = 'We evaluated the protocol using an independent validation dataset.';
const original = 'The results show a significant improvement.';
const after = 'Further analysis describes the independent measurements in detail.';
const suffix = ' However, the overhead is considerable.';
const paper = `${before}\n${original}\n${after}`;
const identity = createAnchor('main.tex', paper, 1, 1, null);

test('unchanged and slightly edited prefixes renew only their logical passage', () => {
  for (const passage of [original, original.replace('show', 'showed')]) {
    const text = `${before}\n${passage}${suffix}\n${after}`;
    const location = locateAnchor(identity, text);
    const renewed = renewAnchor(identity, identity, text, location)!;
    assert.ok(renewed);
    assert.deepEqual(renewed.selected, [passage]);
    assert.deepEqual(renewed.logicalRange, { startCharacter: 0, endCharacter: passage.length });
    assert.equal(renewed.sentenceContext!.after, suffix.trim());
    assert.equal(renewed.afterBoundary, undefined);
    assert.ok(validAnchor(renewed));
    const restored = JSON.parse(JSON.stringify(renewed));
    for (const updated of [text, text + '\n', text.replace(suffix, ' Additional evidence is available.')]) {
      const nextLocation = locateAnchor(restored, updated);
      assert.equal(nextLocation.kind, 'attached');
      assert.deepEqual(renewAnchor(restored, identity, updated, nextLocation)!.selected, [passage]);
    }
    assert.notEqual(locateAnchor(restored, `${before}\n${suffix.trim()}\n${after}`).kind, 'attached');
    assert.deepEqual(identity.selected, [original]);
  }
});

test('a display attachment with weak context does not authorize replacing the reference', () => {
  const initial = `Before\n${original}\nAfter`;
  const anchor = createAnchor('main.tex', initial, 1, 1, null);
  const changed = initial.replace('show', 'showed');
  const location = locateAnchor(anchor, changed);
  assert.equal(location.kind, 'attached');
  assert.equal(renewAnchor(anchor, anchor, changed, location), undefined);
  const tooDifferent = paper.replace('significant improvement', 'considerable improvement');
  assert.equal(locateAnchor(identity, tooDifferent).kind, 'attached');
  assert.equal(renewAnchor(identity, identity, tooDifferent, locateAnchor(identity, tooDifferent)), undefined);
});

test('automatic shared revisions remain tethered to the creation identity', () => {
  const original = 'The system measures accuracy across the validation dataset.';
  let text = `${before}\n${original}\n${after}`;
  const root = createAnchor('main.tex', text, 1, 1, null);
  let shared = root;
  let precedingStep = root;
  let accepted = 0;
  const body = [...original];
  const positions = [...original.matchAll(/[a-z]/g)].slice(0, 12).map(match => match.index!);
  for (const position of positions) {
    body[position] = body[position].toUpperCase();
    text = `${before}\n${body.join('')}\n${after}`;
    const step = locateAnchor(precedingStep, text);
    assert.equal(step.kind, 'attached');
    if (step.kind === 'attached') { assert.ok(step.similarity! > 0.95, 'each individual step is a very strong match'); }
    const next = renewAnchor(shared, root, text, locateAnchor(shared, text));
    if (next) { shared = next; accepted++; }
    precedingStep = createAnchor('main.tex', text, 1, 1, null);
  }
  assert.ok(accepted > 1 && accepted < positions.length, 'several renewals succeed, but shared saves cannot reset the cumulative limit');
  assert.notDeepEqual(shared.selected, precedingStep.selected);
  const moved = createAnchor('main.tex', text, 1, 1, null);
  assert.ok(renewAnchor(moved, moved, text, locateAnchor(moved, text)), 'an explicit move establishes a new identity');
});

test('logical endpoints map normalized text to raw columns across tabs, CRLF, Unicode and wrapping', () => {
  const original = '실험 🧪 결과는 제안한 방법의 높은 정확도를 보여줍니다.';
  const initial = `${before}\n${original}\n${after}`;
  const anchor = createAnchor('main.tex', initial, 1, 1, null);
  const owned = ['  실험\t🧪 결과는', '제안한 방법의 높은 정확도를 보여줍니다.'];
  const text = [before, owned[0], owned[1] + suffix, after].join('\r\n');
  const location = locateAnchor(anchor, text);
  assert.equal(location.kind, 'attached');
  const next = renewAnchor(anchor, anchor, text, location)!;
  assert.deepEqual(next.selected, owned);
  assert.equal(next.endLine, 2);
  assert.equal(next.logicalRange!.endCharacter, owned[1].length);
  assert.ok(validAnchor(next));
  const joined = `${before}\n${original}${suffix}\n${after}`;
  const joinedLocation = locateAnchor(next, joined);
  const rewrapped = renewAnchor(next, anchor, joined, joinedLocation)!;
  assert.deepEqual(rewrapped.selected, [original]);
  assert.equal(rewrapped.logicalRange!.endCharacter, original.length);
});

test('logical ranges preserve explicit starting columns and reject malformed saved bounds', () => {
  const prefix = 'Earlier text. ';
  const text = `${before}\n${prefix}${original}${suffix}\n${after}`;
  const anchor = createAnchor('main.tex', text, 1, 1, null,
    { startCharacter: prefix.length, endCharacter: prefix.length + original.length });
  assert.deepEqual(anchor.selected, [original]);
  assert.ok(validAnchor(anchor));
  const updated = text.replace('show', 'showed');
  const location = locateAnchor(anchor, updated);
  assert.equal(location.kind, 'attached');
  const next = renewAnchor(anchor, anchor, updated, location)!;
  assert.deepEqual(next.selected, [original.replace('show', 'showed')]);
  assert.equal(next.logicalRange!.startCharacter, prefix.length);
  for (const logicalRange of [null, [], { startCharacter: -1, endCharacter: original.length },
    { startCharacter: 0, endCharacter: 1 }, { startCharacter: 0.5, endCharacter: original.length },
    { startCharacter: 0, endCharacter: Infinity }]) {
    assert.equal(validAnchor({ ...anchor, logicalRange }), false);
  }
  assert.throws(() => createAnchor('main.tex', text, 1, 1, null, { startCharacter: 0, endCharacter: text.length }), /logical/);
});

test('logical endpoints retain edited terminal punctuation and complete Unicode characters', () => {
  for (const [original, edited] of [
    ['The results show a significant improvement.', 'The results show a significant improvement!'],
    ['The results identify the experiment 🧪', 'The results identify the experiment 🧭']
  ]) {
    const identity = createAnchor('main.tex', `${before}\n${original}\n${after}`, 1, 1, null);
    const text = `${before}\n${edited}${suffix}\n${after}`;
    const next = renewAnchor(identity, identity, text, locateAnchor(identity, text))!;
    assert.deepEqual(next.selected, [edited]);
    assert.equal(next.logicalRange!.endCharacter, edited.length);
  }
});

test('local references retain only A-prime through persistence and later suffix edits', () => {
  const revision = '11111111-1111-4111-8111-111111111111';
  const tracker = new LocalTracking();
  tracker.locate('paper:thread', identity, revision, paper);
  const passage = original.replace('show', 'showed');
  const text = `${before}\n${passage}${suffix}\n${after}`;
  tracker.locate('paper:thread', identity, revision, text);
  const local = tracker.get('paper:thread', revision)!.anchor;
  assert.deepEqual(local.selected, [passage]);
  const restored = new LocalTracking(JSON.parse(JSON.stringify(tracker.snapshot())));
  restored.locate('paper:thread', identity, revision, text.replace(suffix, ' A different appended sentence.'));
  assert.deepEqual(restored.get('paper:thread', revision)!.anchor.selected, [passage]);
  const safe = structuredClone(restored.get('paper:thread', revision));
  restored.locate('paper:thread', identity, revision, `${before}\n${suffix.trim()}\n${after}`);
  assert.deepEqual(restored.get('paper:thread', revision), safe);
});
