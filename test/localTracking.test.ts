import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnchor, locateAnchor } from '../src/anchor';
import { LocalTracking } from '../src/localTracking';

const revision = '11111111-1111-4111-8111-111111111111';
const nextRevision = '22222222-2222-4222-8222-222222222222';
const key = `/paper:${revision}`;
const before = 'We evaluated the protocol on independent validation data.';
const selected = 'The system measures accuracy across the validation dataset.';
const after = 'Further analysis explains the measured performance differences.';
const paper = `${before}\n${selected}\n${after}`;
const anchor = createAnchor('main.tex', paper, 1, 1, null);
const recentBefore = 'The lunar observatory records infrared spectra of distant galaxies.';
const recentAfter = 'Archived telescope images are available through the public catalog.';
const recent = `${recentBefore}\n${selected}\n${recentAfter}`;
const deleted = `${recentBefore}\n${recentAfter}`;

test('source edits update local context and recover locations without changing the shared reference', () => {
  const tracker = new LocalTracking();
  const original = structuredClone(anchor);
  tracker.locate(key, anchor, revision, paper);
  assert.equal(tracker.locate(key, anchor, revision, recent).kind, 'attached');
  assert.equal(tracker.get(key, revision)!.anchor.sentenceContext!.before, recentBefore);
  assert.equal(locateAnchor(anchor, deleted).kind, 'outdated');
  const location = tracker.locate(key, anchor, revision, deleted);
  assert.equal(location.kind, 'uncertain'); assert.equal(location.source, 'local');
  if (location.kind === 'uncertain') { assert.equal(location.estimatedLine, 1); assert.ok(location.confidence >= 0.85); }
  assert.deepEqual(anchor, original);
});

test('gradual source edits use recent reliable text while the original snapshot stays unchanged', () => {
  const tracker = new LocalTracking();
  tracker.locate(key, anchor, revision, paper);
  let text = paper;
  for (const [from, to] of [['system', 'engine'], ['measures', 'estimates'], ['accuracy', 'latency'], ['validation', 'production'], ['dataset', 'workload']]) {
    // Modify only the selected sentence.
    const document = text.split('\n'); document[1] = document[1].replace(from, to); text = document.join('\n');
    assert.equal(tracker.locate(key, anchor, revision, text).kind, 'attached');
  }
  assert.notEqual(locateAnchor(anchor, text).kind, 'attached');
  assert.equal(tracker.locate(key, anchor, revision, text).source, 'local');
  assert.equal(tracker.get(key, revision)!.anchor.selected[0], text.split('\n')[1]);
  assert.deepEqual(anchor.selected, [selected]);
});

test('uncertain and conflicting results never become new local reference snapshots', () => {
  const tracker = new LocalTracking();
  tracker.locate(key, anchor, revision, recent);
  const latest = structuredClone(tracker.get(key, revision));
  assert.equal(tracker.locate(key, anchor, revision, deleted).kind, 'uncertain');
  assert.deepEqual(tracker.get(key, revision), latest);
  const conflicting = `${paper}\n\n\\section{Other}\n${recent}`;
  assert.equal(tracker.locate(key, anchor, revision, conflicting).kind, 'outdated');
  assert.deepEqual(tracker.get(key, revision), latest);
});

test('persistent hints survive a restart; unsaved hints stay in the current session until source save', () => {
  const tracker = new LocalTracking();
  tracker.locate(key, anchor, revision, paper, true);
  tracker.locate(key, anchor, revision, recent, false);
  assert.equal(tracker.get(key, revision)!.anchor.sentenceContext!.before, recentBefore);
  assert.equal(new LocalTracking(tracker.snapshot()).get(key, revision)!.anchor.sentenceContext!.before, before);
  tracker.locate(key, anchor, revision, deleted, true);
  const restored = new LocalTracking(JSON.parse(JSON.stringify(tracker.snapshot())));
  assert.equal(restored.locate(key, anchor, revision, deleted).source, 'local');
  assert.equal(restored.get(key, revision)!.anchor.sentenceContext!.before, recentBefore);
});

test('undo to the shared document restores its authoritative location and context', () => {
  const tracker = new LocalTracking();
  tracker.locate(key, anchor, revision, recent, false);
  assert.deepEqual(tracker.locate(key, anchor, revision, paper, true), { kind: 'attached', startLine: 1, endLine: 1 });
  assert.equal(tracker.get(key, revision)!.anchor.documentHash, anchor.documentHash);
});

test('shared revision changes invalidate old hints and repository keys isolate copies', () => {
  const tracker = new LocalTracking();
  tracker.locate(key, anchor, revision, recent);
  assert.equal(tracker.locate('/another-paper:' + revision, anchor, revision, deleted).kind, 'outdated');
  assert.equal(tracker.locate(key, anchor, nextRevision, deleted).kind, 'outdated');
  assert.equal(tracker.get(key, revision), undefined);
  assert.equal(tracker.snapshot().entries.length, 0);
  const moved = createAnchor('other.tex', recent, 1, 1, null);
  tracker.locate(key, moved, nextRevision, recent);
  assert.equal(tracker.get(key, nextRevision)!.anchor.path, 'other.tex');
});

test('local context includes an explicit end boundary and validates persisted records', () => {
  const tracker = new LocalTracking({ version: 1, entries: [['broken', { basedOn: revision, anchor: {}, updatedAt: 'bad' }], null] });
  assert.equal(tracker.snapshot().entries.length, 0);
  const document = `${recentBefore}\n${selected}\n\\end{document}`;
  tracker.locate(key, anchor, revision, document);
  assert.equal(tracker.get(key, revision)!.anchor.afterBoundary, 'document-end');
  const location = tracker.locate(key, anchor, revision, `${recentBefore}\n\\end{document}`);
  assert.equal(location.kind, 'uncertain'); assert.equal(location.source, 'local');
});

test('old empty sentence context gains unpunctuated local context without rewriting shared history', () => {
  const text = '\\section*{작은 생각}\n헬로\n랄랄루';
  const old = { ...createAnchor('main.tex', text, 1, 1, null), sentenceContext: { before: '\\section*{작은 생각}', after: '' } };
  const tracker = new LocalTracking({ version: 1, entries: [[key, { basedOn: revision, anchor: structuredClone(old), updatedAt: new Date().toISOString() }]] });
  assert.equal(tracker.locate(key, old, revision, text).kind, 'attached');
  assert.equal(tracker.get(key, revision)!.anchor.sentenceContext!.after, '랄랄루');
  assert.equal(old.sentenceContext.after, '');
});
