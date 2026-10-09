import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createAnchor, locateAnchor } from '../src/anchor';
import { Git } from '../src/git';
import { parseEvent, validPath } from '../src/model';
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
