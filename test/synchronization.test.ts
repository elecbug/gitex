import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAnchor } from '../src/anchor';
import { enableEditTracking } from '../src/editTracking';
import { Git } from '../src/git';
import { ReviewStore, LOCAL_REF, REMOTE_REF } from '../src/store';
import { ReviewTransport } from '../src/reviewTransport';

const allow = async () => {};
const paper = 'Opening.\nReviewed passage.\nClosing.\n';
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Local operation was blocked by network or approval.')), 4_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gitex-transport-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bare = path.join(dir, 'paper.git'), root = new Git(dir);
  await root.text(['init', '--bare', '--initial-branch=main', bare]);
  await root.text(['clone', bare, path.join(dir, 'alice')]);
  const a = new ReviewStore(path.join(dir, 'alice'));
  await a.git.text(['config', 'user.name', 'Alice']);
  await a.git.text(['config', 'user.email', 'alice@test.invalid']);
  await writeFile(path.join(a.root, 'main.tex'), paper);
  await a.git.text(['add', 'main.tex']);
  await a.git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Paper']);
  await a.git.text(['push', '-u', 'origin', 'main']);
  const h1 = (await a.head())!;
  const anchor = enableEditTracking(createAnchor('main.tex', paper, 1, 1, h1), paper);
  const id = await a.create(anchor, 'Review', paper);
  await a.sync('origin', h1, allow);
  await root.text(['clone', bare, path.join(dir, 'bob')]);
  const b = new ReviewStore(path.join(dir, 'bob'));
  await b.git.text(['config', 'user.name', 'Bob']);
  await b.git.text(['config', 'user.email', 'bob@test.invalid']);
  await b.pull();
  return { dir, bare, root, a, b, id, h1 };
}

test('publication requires an explicit policy before any network or local mutation', async t => {
  const { a, id } = await fixture(t);
  await a.reply(id, 'Local only');
  const tip = await a.git.ref(LOCAL_REF);
  const run = a.git.run.bind(a.git);
  a.git.run = async (args, input) => {
    assert.ok(!['ls-remote', 'fetch', 'push', 'commit-tree', 'update-ref'].includes(args[0]));
    return run(args, input);
  };
  await assert.rejects(a.sync(), /publication policy is required/);
  assert.equal(await a.git.ref(LOCAL_REF), tip);
});

test('same-store saves continue during approval; only the approved tip is published', async t => {
  const { a, b, id, bare } = await fixture(t);
  await a.reply(id, 'Approved reply');
  const entered = signal(), release = signal();
  let approved = '';
  const sync = a.sync('origin', undefined, async publication => {
    approved = publication.tip; entered.resolve(); await release.promise;
  });
  try {
    await promptly(entered.promise);
    await promptly(a.reply(id, 'Saved while approving'));
  } finally { release.resolve(); }
  const result = await sync;
  assert.equal(result.publishedTip, approved);
  assert.notEqual(result.localTip, result.publishedTip);
  assert.equal(result.localTip, await a.git.ref(LOCAL_REF));
  assert.equal(await new Git(bare).ref(REMOTE_REF), approved);
  await b.pull();
  assert.deepEqual((await b.threads())[0].comments.map(c => c.body), ['Review', 'Approved reply']);
  assert.equal(result.threads[0].comments.at(-1)!.body, 'Saved while approving');
  const next = await a.sync('origin', undefined, allow);
  assert.equal(next.localTip, next.publishedTip);
  await b.pull(); assert.equal((await b.threads())[0].comments.length, 3);
});

for (const operation of ['ls-remote', 'fetch', 'push']) {
  test(`same-store saves continue while ${operation} is delayed`, async t => {
    const { a, b, id } = await fixture(t);
    await a.reply(id, 'Before sync');
    const entered = signal(), release = signal();
    const run = a.git.run.bind(a.git);
    let intercepted = false;
    a.git.run = async (args, input) => {
      if (args[0] === operation && !intercepted) {
        intercepted = true; entered.resolve(); await release.promise;
      }
      return run(args, input);
    };
    const sync = a.sync('origin', undefined, allow);
    try {
      await promptly(entered.promise);
      await promptly(a.reply(id, `During ${operation}`));
    } finally { release.resolve(); }
    const result = await sync;
    assert.equal(result.threads[0].comments.length, 3);
    await b.pull();
    assert.equal((await b.threads())[0].comments.length, operation === 'push' ? 2 : 3);
    assert.equal(result.localTip !== result.publishedTip, operation === 'push');
  });
}

test('sync receives the push destination, while pull continues using the fetch destination', async t => {
  const { a, b, id, dir, root, bare } = await fixture(t);
  const destination = path.join(dir, 'publication.git');
  await root.text(['clone', '--bare', bare, destination]);
  await a.git.text(['remote', 'set-url', '--push', 'origin', destination]);
  await b.git.text(['remote', 'set-url', 'origin', destination]);
  await b.reply(id, 'Only at push destination'); await b.sync('origin', undefined, allow);
  await a.pull(); assert.equal((await a.threads())[0].comments.length, 1);
  await a.reply(id, 'Local work');
  const original = await new Git(bare).ref(REMOTE_REF);
  await a.sync('origin', undefined, allow);
  await b.pull();
  assert.deepEqual(new Set((await b.threads())[0].comments.map(c => c.body)), new Set(['Review', 'Only at push destination', 'Local work']));
  assert.equal(await new Git(bare).ref(REMOTE_REF), original);
});

test('changing the remote during approval cannot redirect the approved publication', async t => {
  const { a, id, bare, dir, root } = await fixture(t);
  const other = path.join(dir, 'other.git');
  await root.text(['clone', '--bare', bare, other]);
  const previous = await new Git(other).ref(REMOTE_REF);
  await a.reply(id, 'Pinned destination');
  const result = await a.sync('origin', undefined, async () => {
    await a.git.text(['remote', 'set-url', '--push', 'origin', other]);
  });
  assert.equal(await new Git(bare).ref(REMOTE_REF), result.publishedTip);
  assert.equal(await new Git(other).ref(REMOTE_REF), previous);
  await a.sync('origin', undefined, allow);
  assert.equal(await new Git(other).ref(REMOTE_REF), await a.git.ref(LOCAL_REF));
});

test('simultaneous receives hold independent refs and clean them after validation failures', async t => {
  const { a } = await fixture(t);
  const transport = new ReviewTransport(a.git);
  const endpoint = await transport.endpoint('origin', 'fetch');
  const entered = signal(), release = signal();
  let tip: string | null = null;
  const first = transport.snapshot(endpoint, async received => {
    tip = received; entered.resolve(); await release.promise; return received;
  });
  try {
    await promptly(entered.promise);
    await assert.rejects(transport.snapshot(endpoint, async received => {
      assert.equal(received, tip);
      const refs = (await a.git.text(['for-each-ref', '--format=%(refname)', 'refs/gitex/transfers/'])).split('\n');
      assert.equal(refs.length, 2);
      throw new Error('Invalid archive');
    }), /Invalid archive/);
    assert.equal((await a.git.text(['for-each-ref', '--format=%(refname)', 'refs/gitex/transfers/'])).split('\n').length, 1);
  } finally { release.resolve(); }
  assert.equal(await first, tip);
  assert.equal(await a.git.text(['for-each-ref', '--format=%(refname)', 'refs/gitex/transfers/']), '');
});
