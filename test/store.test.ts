import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createAnchor, locateAnchor, renewAnchor } from '../src/anchor';
import { Git } from '../src/git';
import { materialize, parseEvent, validPath } from '../src/model';
import { LOCAL_REF, REMOTE_REF, ReviewStore } from '../src/store';

const paper = '\\documentclass{article}\n\\begin{document}\nA shared result.\n\\end{document}\n';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gitex-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bare = path.join(dir, 'paper.git');
  const alice = path.join(dir, 'alice');
  const bob = path.join(dir, 'bob');
  const root = new Git(dir);
  await root.text(['init', '--bare', '--initial-branch=main', bare]);
  await root.text(['clone', bare, alice]);
  const a = new ReviewStore(alice);
  await a.git.text(['config', 'user.name', 'Alice']);
  await a.git.text(['config', 'user.email', 'alice@example.test']);
  await writeFile(path.join(alice, 'main.tex'), paper);
  await a.git.text(['add', 'main.tex']);
  await a.git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial paper']);
  await a.git.text(['push', '-u', 'origin', 'main']);
  await root.text(['clone', bare, bob]);
  const b = new ReviewStore(bob);
  await b.git.text(['config', 'user.name', 'Bob']);
  await b.git.text(['config', 'user.email', 'bob@example.test']);
  const anchor = createAnchor('main.tex', paper, 2, 2, await a.head());
  return { dir, bare, a, b, anchor };
}

test('comments round-trip through a bare repository without changing paper HEAD, index, or working files', async t => {
  const { a, b, bare, anchor } = await fixture(t);
  await writeFile(path.join(a.root, 'main.tex'), `${paper}% staged\n`);
  await a.git.text(['add', 'main.tex']);
  await writeFile(path.join(a.root, 'main.tex'), `${paper}% staged\n% unstaged\n`);
  const before = { head: await a.head(), index: await a.git.text(['write-tree']), status: await a.git.text(['status', '--porcelain=v1']),
    content: await readFile(path.join(a.root, 'main.tex'), 'utf8') };
  const id = await a.create(anchor, '수정 이유: 결과를 검토해주세요.');
  await a.sync();
  const received = await b.sync();
  assert.equal(received[0].id, id);
  assert.equal(received[0].comments[0].body, '수정 이유: 결과를 검토해주세요.');
  assert.equal(received[0].comments[0].author.name, 'Alice');
  assert.deepEqual({ head: await a.head(), index: await a.git.text(['write-tree']), status: await a.git.text(['status', '--porcelain=v1']),
    content: await readFile(path.join(a.root, 'main.tex'), 'utf8') }, before);
  assert.equal(await new Git(bare).ref('refs/heads/main'), before.head);
  assert.equal(locateAnchor(received[0].anchor, `Inserted paragraph\n${paper}`).kind, 'attached');
});

test('offline replies and concurrent resolve/reopen events converge without losing either reply', async t => {
  const { a, b, anchor } = await fixture(t);
  const id = await a.create(anchor, 'Check this result');
  await a.sync(); await b.sync();
  await a.reply(id, 'Alice reply'); await a.setResolved(id, true);
  await b.reply(id, 'Bob reply'); await b.setResolved(id, false);
  await a.sync(); await b.sync(); await a.sync();
  const left = await a.threads();
  assert.deepEqual(left, await b.threads());
  assert.equal(left[0].comments.length, 3);
  assert.deepEqual(new Set(left[0].comments.map(comment => comment.body)), new Set(['Check this result', 'Alice reply', 'Bob reply']));
  await a.setResolved(id, true); await a.sync(); await b.sync();
  assert.equal((await b.threads())[0].resolved, true);
  const before = await a.git.ref(LOCAL_REF);
  await a.sync();
  assert.equal(await a.git.ref(LOCAL_REF), before, 'an up-to-date sync must not create more commits');
});

test('simultaneous first publication retries a rejected push and preserves both users', async t => {
  const { a, b, anchor } = await fixture(t);
  await a.create(anchor, 'Alice starts offline');
  await b.create(anchor, 'Bob starts offline');
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  for (const store of [a, b]) {
    const run = store.git.run.bind(store.git);
    let first = true;
    store.git.run = async (args, input) => {
      if (args[0] === 'push' && first) {
        first = false;
        if (++arrived === 2) { release(); }
        await barrier;
      }
      return run(args, input);
    };
  }
  await Promise.all([a.sync(), b.sync()]);
  await a.sync(); await b.sync();
  assert.equal((await a.threads()).length, 2);
  assert.deepEqual(await a.threads(), await b.threads());
});

test('separate VS Code windows racing on a local ref preserve every comment', async t => {
  const { a, anchor } = await fixture(t);
  await Promise.all(Array.from({ length: 4 }, (_, i) => new ReviewStore(a.root).create(anchor, `Window ${i}`)));
  assert.equal((await a.threads()).length, 4);
});

test('network failure leaves offline comments available for the next sync', async t => {
  const { a, anchor, dir } = await fixture(t);
  const id = await a.create(anchor, 'Offline review');
  await a.git.text(['remote', 'add', 'unavailable', path.join(dir, 'does-not-exist.git')]);
  await assert.rejects(a.sync('unavailable'));
  assert.equal((await new ReviewStore(a.root).threads())[0].id, id);
  await a.sync();
});

test('an existing unrelated metadata branch is rejected without overwriting it', async t => {
  const { a, bare, anchor } = await fixture(t);
  await a.git.text(['push', 'origin', `HEAD:${REMOTE_REF}`]);
  const before = await new Git(bare).ref(REMOTE_REF);
  await a.create(anchor, 'Local review');
  await assert.rejects(a.sync(), /not a GiTex/);
  assert.equal(await new Git(bare).ref(REMOTE_REF), before);
  assert.equal((await a.threads()).length, 1);
});

test('a rejecting server hook surfaces its error and preserves local review data', async t => {
  const { a, bare, anchor } = await fixture(t);
  await writeFile(path.join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "Review branch is read-only" >&2\nexit 1\n', { mode: 0o755 });
  await a.create(anchor, 'Keep this even if the push fails');
  await assert.rejects(a.sync(), /read-only/);
  assert.equal((await a.threads()).length, 1);
  assert.equal(await new Git(bare).ref(REMOTE_REF), null);
});

test('comments work before the first paper commit and do not populate the working tree', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gitex-unborn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ReviewStore(dir);
  await store.git.text(['init', '--initial-branch=main']);
  await store.git.text(['config', 'user.name', 'Writer']);
  await store.git.text(['config', 'user.email', 'writer@example.test']);
  await store.create(createAnchor('main.tex', paper, 2, 2, null), 'Draft comment');
  assert.equal(await store.head(), null);
  assert.equal((await store.threads()).length, 1);
  assert.equal(await store.git.text(['status', '--porcelain']), '');
});

test('remote path traversal and malformed comments are rejected', () => {
  for (const value of ['../secret.tex', '/etc/passwd', 'a/../../secret', '.git/config', 'a\\secret', 'C:/secret']) { assert.equal(validPath(value), false); }
  assert.equal(validPath('chapters/결과.tex'), true);
  assert.throws(() => parseEvent('{"version":99}'), /Invalid/);
});

test('sentence context is optional and validated without changing the event version', () => {
  const anchor = createAnchor('main.tex', paper, 2, 2, null);
  const id = '11111111-1111-4111-8111-111111111111';
  const event = { version: 1, id, threadId: id, clock: 1, at: new Date().toISOString(), author: { name: 'Tester', email: 'test@example.test' }, type: 'create', body: 'Review', anchor };
  for (const sentenceContext of [undefined, { before: '', after: '' }, { before: 'Previous sentence.', after: 'Following sentence.' }]) {
    assert.equal(parseEvent(JSON.stringify({ ...event, anchor: { ...anchor, sentenceContext } })).version, 1);
  }
  for (const sentenceContext of [null, [], 'text', {}, { before: 3, after: '' }, { before: 'a\nb', after: '' }, { before: '', after: 'x'.repeat(4097) }]) {
    assert.throws(() => parseEvent(JSON.stringify({ ...event, anchor: { ...anchor, sentenceContext } })), /Invalid GiTex/);
  }
  for (const afterBoundary of [undefined, 'document-end', 'file-end']) {
    assert.equal(parseEvent(JSON.stringify({ ...event, anchor: { ...anchor, afterBoundary } })).version, 1);
  }
  for (const afterBoundary of [null, true, 'unknown', {}]) {
    assert.throws(() => parseEvent(JSON.stringify({ ...event, anchor: { ...anchor, afterBoundary } })), /Invalid GiTex/);
  }
});

test('legacy and sentence anchors coexist, sync, and upgrade on explicit saves with original history intact', async t => {
  const { a, b, anchor } = await fixture(t);
  const { sentenceContext, ...legacy } = anchor;
  const id = await a.create(legacy, 'Old review');
  await a.sync(); await b.pull();
  assert.equal((await b.threads())[0].anchor.sentenceContext, undefined);
  await b.reply(id, 'Save with sentence tracking', anchor, id);
  await b.sync(); await a.pull();
  const current = (await a.threads())[0];
  assert.deepEqual(current.anchor.sentenceContext, sentenceContext);
  assert.deepEqual(current.anchorHistory[0].anchor, legacy);
  assert.equal(current.anchorHistory.length, 2);
  assert.deepEqual(await a.threads(), await b.threads());
});

test('editing comments and replies preserves every version and the original author', async t => {
  const { a, b, anchor } = await fixture(t);
  const id = await a.create(anchor, 'Original comment');
  await a.reply(id, 'Original reply');
  const replyId = (await a.threads())[0].comments[1].id;
  await a.edit(id, id, 'First edit', id);
  await a.edit(id, replyId, 'Edited reply', replyId);
  await a.sync(); await b.pull();
  const current = (await b.threads())[0].comments[0];
  await b.edit(id, id, 'Second edit by Bob', current.revisions.at(-1)!.id);
  await b.sync(); await a.pull();
  const comments = (await a.threads())[0].comments;
  assert.equal(comments.length, 2);
  assert.equal(comments[0].body, 'Second edit by Bob');
  assert.equal(comments[0].author.name, 'Alice');
  assert.deepEqual(comments[0].revisions.map(revision => revision.body), ['Original comment', 'First edit', 'Second edit by Bob']);
  assert.equal(comments[0].revisions.at(-1)!.author.name, 'Bob');
  assert.deepEqual(comments[1].revisions.map(revision => revision.body), ['Original reply', 'Edited reply']);
  assert.deepEqual(await new ReviewStore(a.root).threads(), await b.threads());
});

test('concurrent offline edits converge and both conflicting versions remain in history', async t => {
  const { a, b, anchor } = await fixture(t);
  const id = await a.create(anchor, 'Shared original');
  await a.sync(); await b.pull();
  await a.edit(id, id, 'Alice version', id);
  await b.edit(id, id, 'Bob version', id);
  await a.sync(); await b.sync(); await a.pull();
  const comment = (await a.threads())[0].comments[0];
  assert.deepEqual(new Set(comment.revisions.map(revision => revision.body)), new Set(['Shared original', 'Alice version', 'Bob version']));
  assert.equal(comment.body, comment.revisions.at(-1)!.body);
  assert.deepEqual(await a.threads(), await b.threads());
});

test('a stale edit is rejected after pull, and an unchanged edit creates no event', async t => {
  const { a, b, anchor } = await fixture(t);
  const id = await a.create(anchor, 'Original');
  const initial = await a.git.ref(LOCAL_REF);
  await a.edit(id, id, 'Original', id);
  assert.equal(await a.git.ref(LOCAL_REF), initial);
  await a.sync(); await b.pull();
  await b.edit(id, id, 'Remote update', id); await b.sync(); await a.pull();
  const before = await a.git.ref(LOCAL_REF);
  await assert.rejects(a.edit(id, id, 'Draft based on original', id), /changed while you were editing/);
  assert.equal(await a.git.ref(LOCAL_REF), before);
  assert.equal((await a.threads())[0].comments[0].body, 'Remote update');
  await assert.rejects(a.edit(id, '11111111-1111-4111-8111-111111111111', 'Missing', id), /does not exist/);
});

test('pull merges remote edits with unpublished local work without pushing or touching the paper', async t => {
  const { a, b, bare, anchor } = await fixture(t);
  const id = await a.create(anchor, 'Shared original');
  await a.sync(); await b.pull();
  await a.reply(id, 'Unpublished local reply');
  await b.edit(id, id, 'Remote edit', id); await b.sync();
  const remoteBefore = await new Git(bare).ref(REMOTE_REF);
  await writeFile(path.join(a.root, 'main.tex'), paper + '% staged\n');
  await a.git.text(['add', 'main.tex']);
  await writeFile(path.join(a.root, 'main.tex'), paper + '% staged\n% unstaged\n');
  const head = await a.head();
  const index = await a.git.text(['write-tree']);
  const content = await readFile(path.join(a.root, 'main.tex'), 'utf8');
  const run = a.git.run.bind(a.git);
  a.git.run = async (args, input) => {
    assert.notEqual(args[0], 'push', 'pull must never publish local events');
    return run(args, input);
  };
  const threads = await a.pull();
  assert.equal(threads[0].comments[0].body, 'Remote edit');
  assert.equal(threads[0].comments[1].body, 'Unpublished local reply');
  assert.equal(await new Git(bare).ref(REMOTE_REF), remoteBefore);
  assert.equal(await a.head(), head);
  assert.equal(await a.git.text(['write-tree']), index);
  assert.equal(await readFile(path.join(a.root, 'main.tex'), 'utf8'), content);
});

test('pull from a remote without a comments branch does not publish local comments', async t => {
  const { a, bare, anchor } = await fixture(t);
  await a.create(anchor, 'Only local');
  await a.pull();
  assert.equal(await new Git(bare).ref(REMOTE_REF), null);
  assert.equal((await a.threads())[0].comments[0].body, 'Only local');
});

test('reply and edit snapshots renew tracking while preserving and synchronizing all references', async t => {
  const { a, b, anchor } = await fixture(t);
  const id = await a.create(anchor, 'Original review');
  const first = createAnchor('main.tex', paper.replace('A shared result.', 'A shared, verified result.'), 2, 2, await a.head());
  await a.reply(id, 'Reviewed the new wording', first);
  const second = createAnchor('main.tex', paper.replace('A shared result.', 'A verified experimental result.'), 2, 2, await a.head());
  await a.edit(id, id, 'Updated review', id, second);
  const thread = (await a.threads())[0];
  assert.deepEqual(thread.anchor, second);
  assert.deepEqual(thread.anchorHistory.map(entry => entry.anchor), [anchor, first, second]);
  await a.sync(); await b.pull();
  assert.deepEqual(await b.threads(), await a.threads());
  assert.equal(locateAnchor(thread.anchor, paper.replace('A shared result.', 'A verified experimental result!')).kind, 'attached');
});

test('concurrent reference updates converge without erasing either saved passage', async t => {
  const { a, b, anchor } = await fixture(t);
  const id = await a.create(anchor, 'Shared review'); await a.sync(); await b.pull();
  const left = createAnchor('main.tex', paper.replace('A shared result.', 'A shared result from Alice.'), 2, 2, await a.head());
  const right = createAnchor('main.tex', paper.replace('A shared result.', 'A shared result from Bob.'), 2, 2, await b.head());
  await a.reply(id, 'Alice update', left); await b.reply(id, 'Bob update', right);
  await a.sync(); await b.sync(); await a.pull();
  const thread = (await a.threads())[0];
  assert.equal(thread.anchorHistory.length, 3);
  assert.deepEqual(new Set(thread.anchorHistory.map(entry => entry.anchor.selected[0])), new Set([anchor.selected[0], left.selected[0], right.selected[0]]));
  assert.deepEqual(thread.anchor, thread.anchorHistory.at(-1)!.anchor);
  assert.deepEqual(thread.identityAnchor, anchor, 'concurrent automatic updates cannot replace the identity');
  assert.deepEqual(await a.threads(), await b.threads());
});

test('logical ranges and fixed identity survive shared saves, synchronization and reload', async t => {
  const { a, b } = await fixture(t);
  const before = 'We evaluated the protocol using an independent validation dataset.';
  const original = 'The results show a significant improvement.';
  const after = 'Further analysis describes the independent measurements in detail.';
  const paper = `${before}\n${original}\n${after}`;
  const identity = createAnchor('main.tex', paper, 1, 1, await a.head());
  const id = await a.create(identity, 'Review the original sentence');
  const edited = original.replace('show', 'showed');
  const text = `${before}\n${edited} However, the overhead is considerable.\n${after}`;
  const next = renewAnchor(identity, identity, text, locateAnchor(identity, text))!;
  await a.reply(id, 'Review the revised original sentence', next, id);
  await a.sync(); await b.pull();
  const loaded = (await new ReviewStore(b.root).threads())[0];
  assert.deepEqual(loaded.anchor.selected, [edited]);
  assert.deepEqual(loaded.anchor.logicalRange, { startCharacter: 0, endCharacter: edited.length });
  assert.deepEqual(loaded.identityAnchor, identity);
  assert.deepEqual(loaded.anchorHistory.map(entry => entry.anchor.selected), [[original], [edited]]);
  const changed = text.replace('significant', 'substantial');
  assert.equal(renewAnchor(loaded.anchor, loaded.identityAnchor, changed, locateAnchor(loaded.anchor, changed)), undefined);
  const previousRevision = loaded.anchorRevision;
  await b.reply(id, 'A reply without promoting a weak anchor');
  await b.sync(); await a.pull();
  const current = (await a.threads())[0];
  assert.equal(current.anchorRevision, previousRevision);
  assert.deepEqual(current.identityAnchor, identity);
  assert.deepEqual(await a.threads(), await b.threads());
});

test('invalid or stale saves cannot change the tracking reference', async t => {
  const { a, anchor } = await fixture(t);
  const id = await a.create(anchor, 'Original');
  const next = createAnchor('main.tex', paper.replace('A shared result.', 'A shared result with details.'), 2, 2, await a.head());
  await a.edit(id, id, 'Current revision', id);
  const before = await a.git.ref(LOCAL_REF);
  await assert.rejects(a.edit(id, id, 'Stale revision', id, next), /changed while/);
  await assert.rejects(a.reply(id, 'Wrong file', { ...next, path: 'other.tex' }), /cannot change the file path/);
  await assert.rejects(a.reply(id, 'Bad range', { ...next, endLine: -1 }), /Invalid GiTex/);
  assert.equal(await a.git.ref(LOCAL_REF), before);
  assert.deepEqual((await a.threads())[0].anchor, anchor);
});

test('saving unchanged comment text can refresh its reference without redundant snapshots', async t => {
  const { a, anchor } = await fixture(t);
  const id = await a.create(anchor, 'Original');
  const next = createAnchor('main.tex', paper.replace('A shared result.', 'A shared result with details.'), 2, 2, await a.head());
  await a.edit(id, id, 'Original', id, next);
  let thread = (await a.threads())[0];
  assert.equal(thread.anchorHistory.length, 2);
  const tip = await a.git.ref(LOCAL_REF);
  await a.edit(id, id, 'Original', thread.comments[0].revisions.at(-1)!.id, next);
  assert.equal(await a.git.ref(LOCAL_REF), tip);
  await a.reply(id, 'Same passage', next);
  thread = (await a.threads())[0];
  assert.equal(thread.anchorHistory.length, 2);
});

test('manual moves record every previous and new location without editing comments or the paper', async t => {
  const { a, b, anchor } = await fixture(t);
  const id = await a.create(anchor, 'Keep the review');
  await a.reply(id, 'Keep the reply'); await a.setResolved(id, true);
  const comments = (await a.threads())[0].comments;
  const head = await a.head(), index = await a.git.text(['write-tree']);
  const destination = createAnchor('appendix.tex', 'Heading\nA new passage\nSecond line\n', 1, 2, head);
  await a.move(id, destination, id);
  let current = (await a.threads())[0];
  const first = current.anchorHistory.at(-1)!;
  assert.equal(first.kind, 'move'); assert.deepEqual(first.from, anchor); assert.deepEqual(first.anchor, destination);
  assert.equal(first.author.name, 'Alice'); assert.ok(Number.isFinite(Date.parse(first.at)));
  await a.move(id, destination, current.anchorRevision); // Explicitly saving even the same destination is recorded.
  current = (await a.threads())[0];
  await a.move(id, anchor, current.anchorRevision);
  current = (await a.threads())[0];
  assert.equal(current.anchorHistory.filter(entry => entry.kind === 'move').length, 3);
  assert.deepEqual(current.anchorHistory.at(-1)!.from, destination);
  assert.deepEqual(current.comments, comments); assert.equal(current.resolved, true);
  await a.sync(); await b.pull();
  assert.deepEqual(await b.threads(), await a.threads());
  assert.equal(await a.head(), head); assert.equal(await a.git.text(['write-tree']), index);
  assert.equal(await readFile(path.join(a.root, 'main.tex'), 'utf8'), paper);
});

test('stale moves, invalid destinations, and stale automatic snapshots preserve the current location', async t => {
  const { a, anchor } = await fixture(t);
  const id = await a.create(anchor, 'Review');
  const next = createAnchor('main.tex', 'New result\nAnother result\n', 1, 1, await a.head());
  await a.move(id, next, id);
  const current = (await a.threads())[0];
  const tip = await a.git.ref(LOCAL_REF);
  await assert.rejects(a.move(id, anchor, id), /location changed/);
  await assert.rejects(a.move(id, { ...anchor, path: '../outside.tex' }, current.anchorRevision), /Invalid GiTex/);
  await assert.rejects(a.reply(id, 'Old view', anchor, id), /location changed/);
  assert.equal(await a.git.ref(LOCAL_REF), tip);
  assert.deepEqual((await a.threads())[0], current);
});

test('concurrent manual moves keep their own before/after references and converge', async t => {
  const { a, b, anchor } = await fixture(t);
  const id = await a.create(anchor, 'Shared'); await a.sync(); await b.pull();
  const left = createAnchor('left.tex', 'Left destination', 0, 0, await a.head());
  const right = createAnchor('right.tex', 'Right destination', 0, 0, await b.head());
  await a.move(id, left, id); await b.move(id, right, id);
  await a.sync(); await b.sync(); await a.pull();
  const current = (await a.threads())[0];
  const moves = current.anchorHistory.filter(entry => entry.kind === 'move');
  assert.equal(moves.length, 2);
  assert.deepEqual(new Set(moves.map(entry => entry.anchor.path)), new Set(['left.tex', 'right.tex']));
  for (const entry of moves) { assert.deepEqual(entry.from, anchor); assert.equal(entry.basedOn, id); }
  assert.equal(current.anchorRevision, moves.at(-1)!.id);
  assert.deepEqual(current.identityAnchor, moves.at(-1)!.anchor);
  assert.deepEqual(await a.threads(), await b.threads());
});

test('older automatic snapshots cannot undo a concurrent manual move in the same or another file', async t => {
  for (const destinationPath of ['main.tex', 'appendix.tex']) {
    const { a, b, anchor } = await fixture(t);
    const id = await a.create(anchor, 'Shared'); await a.sync(); await b.pull();
    const destination = createAnchor(destinationPath, 'A manually chosen new passage', 0, 0, await a.head());
    await a.move(id, destination, id);
    const move = (await a.threads())[0].anchorRevision;
    await b.reply(id, 'Increase the local clock');
    const oldUpdate = createAnchor('main.tex', paper.replace('shared', 'old shared'), 2, 2, await b.head());
    await b.reply(id, 'Saved offline at the old location', oldUpdate);
    await a.sync(); await b.sync(); await a.pull();
    let current = (await a.threads())[0];
    assert.equal(current.anchorRevision, move); assert.deepEqual(current.anchor, destination);
    assert.deepEqual(current.identityAnchor, destination);
    assert.ok(current.anchorHistory.some(entry => entry.anchor.selected[0] === oldUpdate.selected[0]));
    assert.notEqual(current.anchorHistory.at(-1)!.id, move, 'the current reference need not be the final history entry');
    assert.deepEqual(await a.threads(), await b.threads());
    const newer = createAnchor(destinationPath, 'A manually chosen new passage!', 0, 0, await b.head());
    await b.reply(id, 'Saved at the new location', newer, current.anchorRevision);
    await b.sync(); await a.pull();
    current = (await a.threads())[0];
    assert.deepEqual(current.anchor, newer);
    assert.deepEqual(current.identityAnchor, destination, 'automatic snapshots after a move keep the move identity');
  }
});

test('malformed or cross-thread move references are rejected during materialization', () => {
  const anchor = createAnchor('main.tex', paper, 2, 2, null);
  const first = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const moved = '33333333-3333-4333-8333-333333333333';
  const event = { version: 1, id: first, threadId: first, clock: 1, at: new Date().toISOString(), author: { name: 'Tester', email: 'tester@example.test' }, type: 'create', body: 'Comment', anchor };
  const move = { ...event, id: moved, clock: 2, type: 'move', basedOn: other };
  const parsed = parseEvent(JSON.stringify(move));
  assert.throws(() => materialize([parseEvent(JSON.stringify(event)), parseEvent(JSON.stringify({ ...event, id: other, threadId: other })), parsed]), /invalid tracking revision/);
  assert.throws(() => parseEvent(JSON.stringify({ ...move, basedOn: undefined })), /Invalid GiTex/);
  assert.throws(() => parseEvent(JSON.stringify({ ...move, anchor: undefined })), /Invalid GiTex/);
});
