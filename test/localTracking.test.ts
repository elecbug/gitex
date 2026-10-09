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

test('gradual source edits cannot walk the local reference away from its original identity', () => {
  const tracker = new LocalTracking();
  tracker.locate(key, anchor, revision, paper);
  let text = paper.replace('system', 'systems');
  assert.equal(tracker.locate(key, anchor, revision, text).kind, 'attached');
  const reliable = structuredClone(tracker.get(key, revision));
  assert.equal(reliable!.anchor.selected[0], selected.replace('system', 'systems'));
  for (const [from, to] of [['measures', 'estimates'], ['accuracy', 'latency'], ['validation', 'production'], ['dataset', 'workload']]) {
    // Modify only the selected sentence.
    const document = text.split('\n'); document[1] = document[1].replace(from, to); text = document.join('\n');
    tracker.locate(key, anchor, revision, text);
    assert.deepEqual(tracker.get(key, revision), reliable, 'weak sequential matches cannot renew the reference');
  }
  assert.notEqual(locateAnchor(anchor, text).kind, 'attached');
  assert.equal(tracker.locate(key, anchor, revision, text).kind, 'uncertain');
  assert.deepEqual(anchor.selected, [selected]);
});

test('appended passages renew local hints without rewriting the saved reference', () => {
  const tracker = new LocalTracking();
  const original = structuredClone(anchor);
  tracker.locate(key, anchor, revision, paper);
  // A source-only context change is allowed while the owned passage stays exact.
  const extended = selected + ' Additional measurements cover independent test conditions and longer evaluation periods.';
  const updated = `${recentBefore}\n${extended}\n${recentAfter}`;
  assert.equal(tracker.locate(key, anchor, revision, updated).kind, 'attached');
  assert.deepEqual(tracker.get(key, revision)!.anchor.selected, [selected]);
  assert.equal(tracker.get(key, revision)!.anchor.logicalRange!.endCharacter, selected.length);
  assert.deepEqual(anchor, original);
  const latest = structuredClone(tracker.get(key, revision));
  const location = tracker.locate(key, anchor, revision, deleted);
  assert.equal(location.kind, 'uncertain'); assert.equal(location.source, 'local');
  assert.deepEqual(tracker.get(key, revision), latest);
});

test('uncertain and conflicting results never become new local reference snapshots', () => {
  const tracker = new LocalTracking();
  tracker.locate(key, anchor, revision, recent);
  const latest = structuredClone(tracker.get(key, revision));
  assert.equal(tracker.locate(key, anchor, revision, deleted).kind, 'uncertain');
  assert.deepEqual(tracker.get(key, revision), latest);
  const conflicting = `${paper}\n\n\\section{Other}\n${recent}`;
  const location = tracker.locate(key, anchor, revision, conflicting);
  assert.equal(location.kind, 'uncertain');
  if (location.kind === 'uncertain') {
    assert.deepEqual(location.candidates?.map(candidate => [candidate.reference, candidate.estimatedLine]), [['saved', 1], ['local', 6]]);
  }
  assert.deepEqual(tracker.get(key, revision), latest);
});

test('disjoint saved and local estimates both survive deletion without updating either reference', () => {
  const tracker = new LocalTracking();
  tracker.locate(key, anchor, revision, recent);
  const latest = structuredClone(tracker.get(key, revision));
  const document = `${before}\n${after}\n\n\\section{Other}\n${recentBefore}\n${recentAfter}`;
  const location = tracker.locate(key, anchor, revision, document);
  assert.equal(location.kind, 'uncertain');
  if (location.kind === 'uncertain') {
    assert.deepEqual(location.candidates?.map(candidate => [candidate.reference, candidate.insertionLine]), [['saved', 1], ['local', 5]]);
    assert.match(location.reason, /Both candidates/);
  }
  assert.deepEqual(tracker.get(key, revision), latest);
  assert.deepEqual(new LocalTracking(tracker.snapshot()).locate(key, anchor, revision, document), location);
  assert.deepEqual(anchor.selected, [selected]);
});

test('an attached match and a disjoint estimate are retained as competing candidates', () => {
  const localAnchor = createAnchor('main.tex', `${recentBefore}\nTelescope measurements reveal the composition of distant stars.\n${recentAfter}`, 1, 1, null);
  const tracker = new LocalTracking({ version: 1, entries: [[key, { basedOn: revision, anchor: localAnchor, updatedAt: new Date().toISOString() }]] });
  const latest = structuredClone(tracker.get(key, revision));
  const location = tracker.locate(key, anchor, revision, `${paper}\n\n\\section{Other}\n${recentBefore}\n${recentAfter}`);
  assert.equal(location.kind, 'uncertain');
  if (location.kind === 'uncertain') {
    assert.equal(location.candidates?.length, 2);
    assert.equal(location.candidates![0].insertionLine, undefined);
    assert.equal(location.candidates![1].insertionLine, 6);
  }
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

test('overlapping shared and local estimates keep the recent position without promoting it', () => {
  const original = '\\section*{작은 생각}\n\n헬로\n\n랄랄루';
  const shared = createAnchor('main.tex', original, 2, 2, null);
  const tracker = new LocalTracking();
  tracker.locate(key, shared, revision, original);
  const edited = original.replace('헬로', '\n\n헬로');
  assert.equal(tracker.locate(key, shared, revision, edited).kind, 'attached');
  const recent = structuredClone(tracker.get(key, revision));
  const deleted = edited.replace('헬로', '');
  const sharedLocation = locateAnchor(shared, deleted);
  const localLocation = tracker.locate(key, shared, revision, deleted);
  assert.equal(sharedLocation.kind, 'uncertain');
  assert.equal(localLocation.kind, 'uncertain'); assert.equal(localLocation.source, 'local');
  if (sharedLocation.kind === 'uncertain' && localLocation.kind === 'uncertain') {
    assert.equal(sharedLocation.estimatedLine, 2); assert.equal(localLocation.estimatedLine, 4);
    assert.equal(localLocation.candidates, undefined, 'overlapping estimates must not duplicate markers');
  }
  assert.deepEqual(tracker.get(key, revision), recent, 'an estimate must never replace the last attached local context');
  assert.deepEqual(shared.selected, ['헬로']);
});
