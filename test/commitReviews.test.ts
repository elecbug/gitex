import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectPublication } from '../src/snapshotPrivacy';
import { createAnchor } from '../src/anchor';
import { enableEditTracking, EditTracking } from '../src/editTracking';
import { Git } from '../src/git';
import { materialize, parseEvent, reviewAtCommit } from '../src/model';
import { LOCAL_REF, REMOTE_REF, ReviewStore } from './reviewStore';

const paper = 'Opening.\nReviewed passage.\nClosing.\n';
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gitex-commits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bare = path.join(dir, 'paper.git'), root = new Git(dir);
  await root.text(['init', '--bare', '--initial-branch=main', bare]);
  await root.text(['clone', bare, path.join(dir, 'alice')]);
  const a = new ReviewStore(path.join(dir, 'alice'));
  await a.git.text(['config', 'user.name', 'Alice']); await a.git.text(['config', 'user.email', 'alice@test.invalid']);
  await writeFile(path.join(a.root, 'main.tex'), paper);
  await a.git.text(['add', 'main.tex']); await a.git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Paper one']);
  await a.git.text(['push', '-u', 'origin', 'main']);
  await root.text(['clone', bare, path.join(dir, 'bob')]);
  const b = new ReviewStore(path.join(dir, 'bob'));
  await b.git.text(['config', 'user.name', 'Bob']); await b.git.text(['config', 'user.email', 'bob@test.invalid']);
  const h1 = (await a.head())!;
  const anchor = enableEditTracking(createAnchor('main.tex', paper, 1, 1, h1), paper);
  const id = await a.create(anchor, 'First review', paper);
  const commit = async (text: string) => {
    await writeFile(path.join(a.root, 'main.tex'), text); await a.git.text(['add', 'main.tex']);
    await a.git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Next paper']); return (await a.head())!;
  };
  const view = async (store: ReviewStore, hash: string) => reviewAtCommit((await store.threads()).find(thread => thread.id === id)!, hash)!;
  return { a, b, bare, h1, anchor, id, commit, view };
}

test('display versions isolate future content, locations and resolved state; edits on old commits stay isolated', async t => {
  const { a, b, h1, id, commit, view } = await fixture(t);
  await a.sync(); await b.pull();
  const h2 = await commit('Preface.\n' + paper);
  await a.recordPaperCommit(h2);
  let current = await view(a, h2);
  await a.edit(id, id, 'Second-commit review', id);
  await a.setResolved(id, true);
  await a.move(id, enableEditTracking(createAnchor('main.tex', 'Preface.\n' + paper, 3, 3, h2), 'Preface.\n' + paper), current.anchorRevision, 'Preface.\n' + paper);
  await a.sync('origin', h2); await b.pull();
  assert.equal((await view(b, h1)).comments[0].body, 'First review');
  assert.equal((await view(b, h1)).resolved, false);
  assert.equal((await view(b, h1)).anchor.startLine, 1);
  assert.equal((await view(b, h2)).comments[0].body, 'Second-commit review');
  assert.equal((await view(b, h2)).resolved, true);
  assert.equal((await view(b, h2)).anchor.startLine, 3);
  await b.git.text(['config', 'user.email', 'alice@test.invalid']);
  await b.edit(id, id, 'Correction on the older paper', id);
  await b.reply(id, 'Only on paper one');
  await b.sync(); await a.pull();
  assert.equal((await view(a, h1)).comments[0].body, 'Correction on the older paper');
  current = await view(a, h2);
  assert.equal(current.comments[0].body, 'Second-commit review');
  assert.equal(current.comments.length, 1);
  assert.equal(current.resolved, true);
  assert.ok(current.paperHistory.some(record => record.paperCommit === h1 && record.comments[0].revision === id));
});

test('paper checkpoints use committed blobs, retain all threads and are idempotent without touching the working tree', async t => {
  const { a, h1, id, anchor, commit, view } = await fixture(t);
  const second = await a.create(anchor, 'Resolved review', paper); await a.setResolved(second, true);
  const h2 = await commit('Preface.\n' + paper);
  await writeFile(path.join(a.root, 'main.tex'), 'Staged unrelated document.\n'); await a.git.text(['add', 'main.tex']);
  await writeFile(path.join(a.root, 'main.tex'), 'Unstaged unrelated document.\n');
  const before = [await a.head(), await a.git.text(['write-tree']), await readFile(path.join(a.root, 'main.tex'), 'utf8')];
  const records = await a.recordPaperCommit(h2);
  for (const thread of records) {
    const record = thread.paperHistory.at(-1)!;
    assert.equal(record.paperCommit, h2); assert.equal(record.source, 'commit'); assert.equal(record.status, 'attached');
    assert.equal(record.anchor!.startLine, 2); assert.equal(await a.documentText(record.anchor!), 'Preface.\n' + paper);
  }
  assert.equal(reviewAtCommit(records.find(thread => thread.id === second)!, h2)!.resolved, true);
  const tip = await a.git.ref(LOCAL_REF); await a.recordPaperCommit(h2); assert.equal(await a.git.ref(LOCAL_REF), tip);
  assert.deepEqual([await a.head(), await a.git.text(['write-tree']), await readFile(path.join(a.root, 'main.tex'), 'utf8')], before);
  assert.equal((await view(a, h1)).comments[0].revisions.length, 1);
  assert.equal((await view(a, h2)).id, id);
  await a.git.text(['reset', '--hard', h2]);
  const h3 = await commit('');
  await a.recordPaperCommit(h3);
  assert.equal((await view(a, h3)).paperRecord!.status, 'outdated');
  const h4 = await commit('Further content.\n');
  assert.deepEqual(await a.paperCommitsSince(h2, h4), [h3, h4]);
});

test('exact editor hints preserve relocated identical passages for fresh recipients', async t => {
  const { a, b, id, anchor, commit, view } = await fixture(t);
  const tracker = new EditTracking(); tracker.seed(id, id, 'main.tex', anchor, paper);
  const cut = paper.replace('Reviewed passage.\n', '');
  tracker.change('main.tex', cut, [{ range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, text: '' }]);
  const moved = cut + 'Reviewed passage.\n';
  tracker.change('main.tex', moved, [{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }, text: 'Reviewed passage.\n' }]);
  const h2 = await commit(moved);
  const hint = tracker.reference(id, id, anchor, moved, h2)!;
  await a.recordPaperCommit(h2, new Map([[id, { basedOn: id, anchor: hint }]]));
  await a.sync('origin', h2); await b.pull();
  assert.deepEqual((await view(b, h2)).paperRecord!.anchor!.tracking, hint.tracking);
  assert.equal((await view(b, h2)).paperRecord!.anchor!.startLine, 2);
});

test('concurrent saves union only their own commit and preserve every revision', async t => {
  const { a, b, id, h1, commit, view } = await fixture(t);
  await a.sync(); await b.pull();
  await a.reply(id, 'Alice offline reply'); await b.reply(id, 'Bob offline reply');
  await a.sync(); await b.sync();
  await b.pull(); await b.sync(); await a.pull();
  assert.deepEqual((await view(a, h1)).comments.map(comment => comment.body), (await view(b, h1)).comments.map(comment => comment.body));
  assert.equal((await view(a, h1)).comments.length, 3);
  const h2 = await commit('New introduction.\n' + paper); await a.recordPaperCommit(h2);
  assert.equal((await view(a, h2)).comments.length, 3);
  await a.reply(id, 'Future only'); await a.sync(); await b.pull();
  assert.equal((await view(b, h1)).comments.length, 3);
  assert.equal((await view(b, h2)).comments.length, 4);
});

test('stale remote comments merge automatically before publication without losing either side', async t => {
  const { a, b, bare, id } = await fixture(t);
  await a.sync(); await b.pull();
  await a.reply(id, 'Local unpublished'); await b.reply(id, 'New remote'); await b.sync();
  const local = await a.git.ref(LOCAL_REF), remote = await new Git(bare).ref(REMOTE_REF);
  let pushes = 0; const run = a.git.run.bind(a.git);
  a.git.run = async (args, input) => { if (args[0] === 'push') { pushes++; } return run(args, input); };
  await a.sync();
  assert.equal(pushes, 1); assert.notEqual(await a.git.ref(LOCAL_REF), local); assert.notEqual(await new Git(bare).ref(REMOTE_REF), remote);
  await a.pull(); await a.sync(); await b.pull();
  assert.deepEqual(await a.threads(), await b.threads());
  assert.equal((await a.threads())[0].comments.length, 3);
});

test('older and detached paper versions synchronize their own comments without fetching or changing source', async t => {
  const { a, b, h1, commit, id, view } = await fixture(t);
  await a.sync(); await b.pull();
  await commit('Preface.\n' + paper); await a.git.text(['push', 'origin', 'main']);
  await b.reply(id, 'Older paper review');
  const commands: string[][] = [], run = b.git.run.bind(b.git);
  b.git.run = async (args, input) => { commands.push(args); return run(args, input); };
  await b.sync('origin', h1);
  assert.equal(await b.head(), h1);
  assert.equal(await b.git.ref('refs/remotes/origin/main'), h1);
  assert.ok(commands.filter(args => args[0] === 'fetch').every(args => args.some(arg => arg.includes('refs/heads/gitex-comments'))));
  await b.git.text(['checkout', '--detach', h1]);
  await b.reply(id, 'Detached review'); await b.sync(); await a.pull();
  assert.equal((await view(a, h1)).comments.at(-1)!.body, 'Detached review');
});

test('future-only reviews remain unassociated with an older checkout; malformed checkpoints fail closed', async t => {
  const { a, b, commit, h1 } = await fixture(t);
  const h2 = await commit('Preface.\n' + paper);
  const future = 'Preface.\n' + paper;
  const id = await a.create(enableEditTracking(createAnchor('main.tex', future, 2, 2, h2), future), 'New version only', future);
  await a.sync('origin', h2); await b.pull(); await b.recordPaperCommit(h1);
  const global = (await b.threads()).find(thread => thread.id === id)!;
  assert.equal(reviewAtCommit(global, h1), undefined);
  const record = global.paperHistory[0];
  assert.throws(() => parseEvent(JSON.stringify({ ...record, type: 'checkpoint', eventIds: [] })), /Invalid/);
  assert.throws(() => materialize([...global.events, { ...record, type: 'checkpoint', resolved: !record.resolved }]), /does not match/);
  assert.throws(() => materialize([...global.events, { ...record, type: 'checkpoint', eventIds: [record.id] }]), /ancestry/);
});

test('concurrent obsolete references cannot replace a manual move in later scoped saves', async t => {
  const { a, b, id, anchor, h1, view } = await fixture(t);
  await a.sync(); await b.pull();
  const moved = enableEditTracking(createAnchor('other.tex', 'Manual destination.\n', 0, 0, h1), 'Manual destination.\n');
  await a.move(id, moved, id, 'Manual destination.\n');
  await b.reply(id, 'Reply from old view', anchor, id, paper);
  await b.reply(id, 'Later old-view reply', anchor, id, paper);
  await a.sync(); await b.pull(); await b.sync(); await a.pull();
  assert.equal((await view(a, h1)).anchor.path, 'other.tex');
  await a.setResolved(id, true);
  assert.equal((await view(a, h1)).paperRecord!.anchor!.path, 'other.tex');
  assert.equal((await view(a, h1)).resolved, true);
});

test('racing commit observers produce one checkpoint per thread and never rewrite the original reference', async t => {
  const { a, id, commit, view, anchor } = await fixture(t);
  const h2 = await commit('Preface.\n' + paper);
  await Promise.all([a.recordPaperCommit(h2), new ReviewStore(a.root).recordPaperCommit(h2)]);
  const current = await view(a, h2);
  assert.equal(current.paperHistory.filter(record => record.paperCommit === h2).length, 1);
  assert.equal(current.anchorRevision, id);
  assert.deepEqual(current.identityAnchor, anchor);
});

test('legacy archives migrate without rewriting events and removed targets require a new reference', async t => {
  const { a, anchor, commit, h1 } = await fixture(t);
  // An explicit unscoped write represents a format-1/2 client event.
  const legacyId = await a.create(anchor, 'Legacy review', paper, null);
  const before = (await a.threads()).find(thread => thread.id === legacyId)!.events;
  await a.recordPaperCommit(h1);
  assert.deepEqual((await a.threads()).find(thread => thread.id === legacyId)!.events, before);
  const h2 = await commit(''); await a.recordPaperCommit(h2);
  const h3 = await commit(paper); await a.recordPaperCommit(h3);
  const old = (await a.threads()).find(thread => thread.id === legacyId)!;
  assert.equal(reviewAtCommit(old, h3)!.paperRecord!.status, 'outdated', 'reappearing text alone does not revive a finalized removal');
  await a.move(legacyId, { ...anchor, baseCommit: h3 }, legacyId, paper);
  assert.equal(reviewAtCommit((await a.threads()).find(thread => thread.id === legacyId)!, h3)!.paperRecord!.status, 'attached');
});

test('formats 1, 2 and 3 migrate to comment files without changing logical events', async t => {
  for (const version of [1, 2, 3]) {
    const { b, anchor, h1 } = await fixture(t);
    const reference = version > 1 ? anchor : createAnchor('main.tex', paper, 1, 1, h1);
    const id = await b.create(reference, 'Earlier archive', version > 1 ? paper : undefined, version === 3 ? h1 : null);
    const old = (await b.threads())[0];
    const events = [...old.events, ...old.paperHistory.map(record => ({ ...record, type: 'checkpoint' as const }))];
    const files: string[] = [];
    for (const event of events) {
      const oid = await b.git.text(['hash-object', '-w', '--stdin'], JSON.stringify(event));
      files.push(`100644 blob ${oid}\t${event.id}.json\n`);
    }
    const eventTree = await b.git.text(['mktree'], files.join(''));
    const marker = await b.git.text(['hash-object', '-w', '--stdin'], JSON.stringify({ format: 'gitex-comments', version }));
    const documents = version > 1 ? await b.git.text(['rev-parse', `${LOCAL_REF}:documents`]) : undefined;
    const tree = await b.git.text(['mktree'], `100644 blob ${marker}\t_gitex.json\n040000 tree ${eventTree}\tevents\n` + (documents ? `040000 tree ${documents}\tdocuments\n` : ''));
    const tip = await b.git.text(['-c', 'commit.gpgsign=false', 'commit-tree', tree], 'Legacy archive\n');
    await b.git.text(['update-ref', LOCAL_REF, tip]);
    assert.deepEqual((await b.threads())[0].events, old.events);
    await b.reply(id, 'Migrate on save');
    assert.equal(JSON.parse(await b.git.text(['show', `${LOCAL_REF}:_gitex.json`])).version, 4);
    const file = JSON.parse(await b.git.text(['show', `${LOCAL_REF}:comments/${id}.json`]));
    assert.deepEqual(file.events, old.events);
    assert.equal(reviewAtCommit((await b.threads())[0], h1)!.comments[0].body, 'Earlier archive');
  }
});

test('first publication includes ancestor replies received after a provisional paper checkpoint', async t => {
  const { a, b, id, h1, view } = await fixture(t);
  await a.sync(); await b.pull();
  await a.reply(id, 'Arrived before paper two'); await a.sync();
  await writeFile(path.join(b.root, 'main.tex'), 'Preface.\n' + paper);
  await b.git.text(['add', 'main.tex']); await b.git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Paper two']);
  const h2 = (await b.head())!;
  await b.recordPaperCommit(h2);
  assert.equal((await view(b, h2)).comments.length, 1);
  await b.sync();
  assert.deepEqual((await view(b, h2)).comments.map(comment => comment.body), ['First review', 'Arrived before paper two']);
  await a.reply(id, 'Later correction belongs to paper one'); await a.sync(); await b.sync();
  assert.equal((await view(b, h1)).comments.length, 3);
  assert.equal((await view(b, h2)).comments.length, 2, 'published copies do not follow later old-version edits');
});

test('paper merge inherits review events from both parent versions', async t => {
  const { a, id, h1, view } = await fixture(t);
  await a.sync();
  await a.git.text(['checkout', '-b', 'feature']);
  await writeFile(path.join(a.root, 'feature.txt'), 'Feature'); await a.git.text(['add', 'feature.txt']);
  await a.git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Feature paper']);
  const feature = (await a.head())!; await a.recordPaperCommit(feature); await a.reply(id, 'Feature review'); await a.sync();
  await a.git.text(['checkout', 'main']);
  await writeFile(path.join(a.root, 'main.txt'), 'Main'); await a.git.text(['add', 'main.txt']);
  await a.git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Main paper']);
  const main = (await a.head())!; await a.recordPaperCommit(main); await a.reply(id, 'Main review'); await a.sync();
  await a.git.text(['-c', 'commit.gpgsign=false', 'merge', '--no-ff', 'feature', '-m', 'Merge paper']);
  const merged = (await a.head())!; await a.recordPaperCommit(merged);
  assert.deepEqual(new Set((await view(a, merged)).comments.map(comment => comment.body)), new Set(['First review', 'Feature review', 'Main review']));
  assert.equal((await view(a, main)).comments.length, 2); assert.equal((await view(a, feature)).comments.length, 2);
  assert.equal((await view(a, h1)).comments.length, 1);
});

test('amended paper can explicitly reconnect a pending review while preserving its original version', async t => {
  const { a, anchor, h1, id, view } = await fixture(t);
  await a.sync();
  await a.git.text(['-c', 'commit.gpgsign=false', 'commit', '--amend', '--allow-empty', '-m', 'Rewritten paper']);
  const rewritten = (await a.head())!; await a.recordPaperCommit(rewritten);
  assert.equal(reviewAtCommit((await a.threads())[0], rewritten), undefined);
  await a.move(id, { ...anchor, baseCommit: rewritten }, id, paper, rewritten);
  assert.equal((await view(a, rewritten)).paperRecord!.status, 'attached');
  assert.equal((await view(a, rewritten)).anchorHistory.at(-1)!.kind, 'move');
  assert.equal((await view(a, h1)).anchorRevision, id);
});

test('a rejected first publication incorporates new ancestor reviews on the next automatic attempt', async t => {
  const { a, b, id, commit, view } = await fixture(t);
  await a.sync(); await b.pull();
  const h2 = await commit('Preface.\n' + paper); await a.recordPaperCommit(h2);
  const run = a.git.run.bind(a.git); let first = true;
  a.git.run = async (args, input) => {
    if (args[0] === 'push' && first) { first = false; await b.reply(id, 'Arrived during publication'); await b.sync(); }
    return run(args, input);
  };
  await a.sync();
  assert.equal((await view(a, h2)).comments.at(-1)!.body, 'Arrived during publication');
});

test('one file per comment contains all revisions; foreign authors may reply but cannot edit', async t => {
  const { a, b, id } = await fixture(t);
  await a.edit(id, id, 'Author edit', id); await a.sync(); await b.pull();
  const tip = await b.git.ref(LOCAL_REF);
  const revision = (await b.threads())[0].comments[0].revisions.at(-1)!.id;
  await assert.rejects(b.edit(id, id, 'Foreign edit', revision), /Only the original author/);
  assert.equal(await b.git.ref(LOCAL_REF), tip);
  await b.reply(id, 'Bob reply');
  const reply = (await b.threads())[0].comments[1]; await b.edit(id, reply.id, 'Bob edits own reply', reply.id);
  await b.sync(); await a.sync();
  const files = (await a.git.text(['ls-tree', '-r', '--name-only', LOCAL_REF])).split('\n');
  assert.equal(files.filter(file => file.startsWith('comments/')).length, 2);
  const own = JSON.parse(await a.git.text(['show', `${LOCAL_REF}:comments/${id}.json`]));
  assert.deepEqual(own.events.map((event: any) => event.body), ['First review', 'Author edit']);
  const global = (await a.threads())[0]; const edited = global.events.find(event => event.type === 'edit')!;
  assert.throws(() => materialize(global.events.map(event => event.id === edited.id ? { ...event, author: { name: 'Mallory', email: 'mallory@test.invalid' } } : event)), /Only the original author/);
});

test('published paper copies exclude threads created later on an older paper, including empty versions', async t => {
  for (const initiallyEmpty of [false, true]) {
    const { a, b, h1, anchor, commit } = await fixture(t);
    if (initiallyEmpty) { await a.git.text(['update-ref', '-d', LOCAL_REF]); }
    await a.sync(); await b.pull();
    const h2 = await commit('Preface.\n' + paper);
    await a.recordPaperCommit(h2); await a.sync();
    const late = await b.create(anchor, 'New thread on the older document', paper, h1); await b.sync(); await a.pull();
    await a.recordPaperCommit(h2); await a.sync();
    const global = (await a.threads()).find(thread => thread.id === late)!;
    assert.ok(reviewAtCommit(global, h1));
    assert.equal(reviewAtCommit(global, h2), undefined, 'publication freezes thread membership, not just existing thread bodies');
    await assert.rejects(a.reply(late, 'Implicitly import the old thread'), /another paper commit/);
    await a.git.text(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Copy a closed paper version']);
    const h3 = (await a.head())!; await a.recordPaperCommit(h3); await a.sync();
    assert.equal(reviewAtCommit((await a.threads()).find(thread => thread.id === late)!, h3), undefined, 'absence in a published parent is authoritative too');
    await a.git.text(['checkout', '--detach', h2]);
    await a.move(late, enableEditTracking(createAnchor('main.tex', 'Preface.\n' + paper, 2, 2, h2), 'Preface.\n' + paper), late, 'Preface.\n' + paper);
    assert.equal(reviewAtCommit((await a.threads()).find(thread => thread.id === late)!, h2)!.paperRecord!.status, 'attached', 'explicit reconnection remains available');
  }
});


test('ambiguous reconstructed ranges persist as uncertain checkpoints until an explicit move', async t => {
  const { a, commit } = await fixture(t);
  const repeated = 'Opening.\nRepeated target.\nRepeated target.\nClosing.\n';
  const h2 = await commit(repeated);
  const anchor = enableEditTracking(createAnchor('main.tex', repeated, 1, 1, h2), repeated);
  const id = await a.create(anchor, 'Which occurrence?', repeated);
  const h3 = await commit(repeated.replace('Repeated target.\n', ''));
  await a.recordPaperCommit(h3); await a.sync();
  let global = (await a.threads()).find(thread => thread.id === id)!;
  let view = reviewAtCommit(global, h3)!;
  assert.equal(view.paperRecord!.status, 'uncertain'); assert.equal(view.paperRecord!.anchor, undefined);
  await a.reply(id, 'Do not guess the target', undefined, undefined, undefined, h3);
  const h4 = await commit('Preface.\n' + repeated.replace('Repeated target.\n', ''));
  await a.recordPaperCommit(h4);
  global = (await a.threads()).find(thread => thread.id === id)!;
  assert.equal(reviewAtCommit(global, h4)!.paperRecord!.status, 'uncertain');
  const text = 'Preface.\n' + repeated.replace('Repeated target.\n', '');
  await a.move(id, enableEditTracking(createAnchor('main.tex', text, 2, 2, h4), text), view.anchorRevision, text, h4);
  view = reviewAtCommit((await a.threads()).find(thread => thread.id === id)!, h4)!;
  assert.equal(view.paperRecord!.status, 'attached');
});

test('late root comments and replies are disclosed without merging into a published descendant', async t => {
  const { a, b, h1, id, anchor, commit, view } = await fixture(t);
  await a.sync(); await b.pull();
  const h2 = await commit('Preface.\n' + paper); await a.recordPaperCommit(h2); await a.sync();
  const late = await b.create(anchor, 'Late root', paper);
  await b.reply(id, 'Late reply'); await b.sync(); await a.pull();
  const notices = await a.earlierReviewUpdates(h2);
  assert.deepEqual(notices.get(late), { commits: [h1], count: 1 });
  assert.deepEqual(notices.get(id), { commits: [h1], count: 1 });
  assert.equal((await view(a, h2)).comments.length, 1);
  assert.equal(reviewAtCommit((await a.threads()).find(thread => thread.id === late)!, h2), undefined);
  assert.equal((await a.earlierReviewUpdates(h1)).size, 0);
});

test('rebase does not borrow reviews from an unrelated rewritten commit; explicit reconnect preserves both views', async t => {
  const { a, h1, commit } = await fixture(t);
  const branchText = paper + 'Feature note.\n';
  const old = await commit(branchText);
  const anchor = enableEditTracking(createAnchor('main.tex', branchText, 3, 3, old), branchText);
  const id = await a.create(anchor, 'Review on old feature commit', branchText); await a.sync();
  await a.git.text(['checkout', '-b', 'new-base', h1]);
  const base = await commit('New introduction.\n' + paper);
  await a.git.text(['checkout', 'main']);
  await a.git.text(['-c', 'commit.gpgsign=false', 'rebase', '--onto', base, h1]);
  const head = (await a.head())!; assert.notEqual(head, old); await a.recordPaperCommit(head);
  let global = (await a.threads()).find(thread => thread.id === id)!;
  assert.equal(reviewAtCommit(global, head), undefined);
  assert.equal((await a.earlierReviewUpdates(head)).has(id), false, 'a rewritten sibling is not a late ancestor review');
  const text = 'New introduction.\n' + branchText;
  await a.move(id, enableEditTracking(createAnchor('main.tex', text, 4, 4, head), text), id, text, head);
  global = (await a.threads()).find(thread => thread.id === id)!;
  assert.ok(reviewAtCommit(global, old)); assert.equal(reviewAtCommit(global, head)!.paperRecord!.status, 'attached');
});

test('publication inspection runs after receive, blocks all pushes on cancellation and accounts for complete draft snapshots', async t => {
  const { a, b, bare, h1 } = await fixture(t);
  const draft = paper + 'Unpublished appendix and private notes.\n';
  const anchor = enableEditTracking(createAnchor('main.tex', draft, 1, 1, h1), draft);
  await a.create(anchor, 'Draft comment', draft);
  const remote = new Git(bare); let checked = 0;
  await assert.rejects(a.sync('origin', h1, async publication => {
    checked++; assert.equal(publication.snapshots.length, 2);
    assert.equal(publication.snapshots.filter(snapshot => !snapshot.committed).length, 1);
    assert.equal(publication.bytes, Buffer.byteLength(paper) + Buffer.byteLength(draft));
    assert.equal(await remote.ref(REMOTE_REF), null);
    throw new Error('Sharing declined');
  }), /Sharing declined/);
  assert.equal(checked, 1); assert.equal(await remote.ref(REMOTE_REF), null);
  assert.equal((await a.threads()).length, 2, 'local comments survive refusal');
  await a.sync('origin', h1, async publication => { assert.equal(publication.snapshots.length, 2); });
  await b.pull(); assert.equal(await b.documentText(anchor), draft);
  await a.reply((await a.threads())[0].id, 'No new snapshot');
  await a.sync('origin', h1, async publication => { assert.equal(publication.snapshots.length, 0); });
});

test('outgoing-history inspection includes snapshots removed from the tip and destination changes', async t => {
  const { a, h1, bare } = await fixture(t);
  await a.sync(); const remote = (await a.git.ref(LOCAL_REF))!;
  const privateText = paper + 'Private deleted draft.\n';
  const anchor = enableEditTracking(createAnchor('main.tex', privateText, 1, 1, h1), privateText);
  await a.create(anchor, 'Temporary snapshot', privateText);
  const middle = (await a.git.ref(LOCAL_REF))!;
  // A sanitized tip still sends its unsanitized parent. Inspection must walk the history.
  const oldTree = await a.git.text(['rev-parse', `${remote}^{tree}`]);
  const tip = await a.git.text(['commit-tree', oldTree, '-p', middle, '-m', 'Restored old tree']);
  const result = await inspectPublication(a.git, tip, remote, bare);
  assert.deepEqual(result.snapshots.map(snapshot => snapshot.hash), [anchor.documentHash]);
  assert.equal(result.snapshots[0].committed, false);
  assert.notEqual((await inspectPublication(a.git, tip, remote, bare + '-new')).destinationKey, result.destinationKey);
});

test('the approved metadata tip is pinned while another local writer adds a draft', async t => {
  const { a, b, h1 } = await fixture(t);
  const writer = new ReviewStore(a.root); let checked = 0;
  const draft = paper + 'New source written while the dialog was open.\n';
  const anchor = enableEditTracking(createAnchor('main.tex', draft, 1, 1, h1), draft);
  await a.sync('origin', h1, async publication => {
    checked++; assert.equal(publication.snapshots.some(snapshot => !snapshot.committed), false);
    await writer.create(anchor, 'Not approved yet', draft);
  });
  assert.equal(checked, 1); await b.pull(); assert.equal((await b.threads()).length, 1);
  assert.equal((await a.threads()).length, 2);
  await assert.rejects(a.sync('origin', h1, async publication => {
    assert.ok(publication.snapshots.some(snapshot => !snapshot.committed)); throw new Error('New approval required');
  }), /New approval required/);
});
