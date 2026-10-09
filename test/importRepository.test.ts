import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Git } from '../src/git';
import { importRepository } from '../src/importRepository';

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitex-import-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bare = path.join(dir, 'paper.git');
  const source = path.join(dir, 'source');
  const target = path.join(dir, 'target');
  await fs.mkdir(target);
  const git = new Git(dir);
  await git.text(['init', '--bare', '--initial-branch=paper', bare]);
  await git.text(['clone', bare, source]);
  const author = new Git(source);
  await author.text(['config', 'user.name', 'Import Tester']);
  await author.text(['config', 'user.email', 'import@example.test']);
  await fs.mkdir(path.join(source, 'chapters'));
  await fs.writeFile(path.join(source, 'main.tex'), 'Latest paper\n');
  await fs.writeFile(path.join(source, 'chapters', 'result.tex'), 'Shared result\n');
  await fs.writeFile(path.join(source, 'build.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const publish = async () => {
    await author.text(['add', '.']);
    await author.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Paper snapshot']);
    await author.text(['push', '-u', 'origin', 'paper']);
  };
  await publish();
  return { dir, bare, source, target, author, publish };
}

test('apply installs the latest default branch, history and origin directly in the folder', async t => {
  const { bare, target, source, author, publish } = await fixture(t);
  await fs.writeFile(path.join(source, 'main.tex'), 'A newer committed paper\n'); await publish();
  await importRepository(target, bare);
  const git = new Git(target);
  assert.equal(await git.ref('HEAD'), await author.ref('HEAD'));
  assert.equal(await git.text(['symbolic-ref', '--short', 'HEAD']), 'paper');
  assert.equal(await git.text(['rev-parse', '--abbrev-ref', '@{upstream}']), 'origin/paper');
  assert.equal(await git.text(['remote', 'get-url', 'origin']), bare);
  assert.equal(await git.text(['status', '--porcelain']), '');
  assert.equal(await fs.readFile(path.join(target, 'main.tex'), 'utf8'), 'A newer committed paper\n');
  assert.ok((await fs.lstat(path.join(target, '.git'))).isDirectory());
  if (process.platform !== 'win32') { assert.ok((await fs.stat(path.join(target, 'build.sh'))).mode & 0o111); }
  assert.ok(!(await fs.readdir(target)).some(name => name.startsWith('.gitex-import-')));
  await git.text(['fsck', '--full']);
});

test('apply preserves unrelated files, including files inside shared directories', async t => {
  const { bare, target } = await fixture(t);
  await fs.mkdir(path.join(target, 'chapters'));
  await fs.writeFile(path.join(target, 'chapters', 'notes.txt'), 'Local notes');
  await fs.writeFile(path.join(target, 'private.txt'), 'Private notes');
  await importRepository(target, path.relative(target, bare));
  assert.equal(await fs.readFile(path.join(target, 'chapters', 'notes.txt'), 'utf8'), 'Local notes');
  assert.equal(await fs.readFile(path.join(target, 'private.txt'), 'utf8'), 'Private notes');
  assert.equal(path.resolve(await new Git(target).text(['remote', 'get-url', 'origin'])), bare);
  assert.match(await new Git(target).text(['status', '--porcelain']), /\?\? private.txt/);
});

test('overlapping files and file/directory conflicts abort without populating the folder', async t => {
  const { bare, target } = await fixture(t);
  for (const kind of ['file', 'directory', 'ancestor']) {
    const conflict = path.join(target, kind === 'ancestor' ? 'chapters' : 'main.tex');
    if (kind === 'directory') { await fs.mkdir(conflict); }
    else { await fs.writeFile(conflict, 'Keep me'); }
    await assert.rejects(importRepository(target, bare), /Existing path conflicts/);
    assert.deepEqual(await fs.readdir(target), [path.basename(conflict)]);
    if (kind !== 'directory') { assert.equal(await fs.readFile(conflict, 'utf8'), 'Keep me'); }
    await fs.rm(conflict, { recursive: true });
  }
});

test('existing Git metadata and folders inside another repository are refused', async t => {
  const { bare, target } = await fixture(t);
  await fs.mkdir(path.join(target, '.git'));
  await assert.rejects(importRepository(target, bare), /already contains .git/);
  await fs.rmdir(path.join(target, '.git'));
  await fs.writeFile(path.join(target, '.git'), 'gitdir: elsewhere');
  await assert.rejects(importRepository(target, bare), /already contains .git/);
  await fs.unlink(path.join(target, '.git'));
  await new Git(target).text(['init']);
  const child = path.join(target, 'child'); await fs.mkdir(child);
  await assert.rejects(importRepository(child, bare), /already in a Git repository/);
  assert.deepEqual(await fs.readdir(child), []);
});

test('symlink ancestors are refused and their targets remain untouched', { skip: process.platform === 'win32' }, async t => {
  const { bare, dir, target } = await fixture(t);
  const outside = path.join(dir, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(target, 'chapters'));
  await assert.rejects(importRepository(target, bare), /Existing path conflicts/);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await fs.readdir(target), ['chapters']);
});

test('unsupported remote symlinks or gitlinks are detected before any checkout is applied', async t => {
  const { bare, target, author } = await fixture(t);
  const blob = await author.text(['hash-object', '-w', '--stdin'], '/outside');
  await author.text(['update-index', '--add', '--cacheinfo', `120000,${blob},shortcut`]);
  await author.text(['update-index', '--add', '--cacheinfo', `160000,${await author.ref('HEAD')},submodule`]);
  await author.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Unsupported paths']);
  await author.text(['push']);
  await assert.rejects(importRepository(target, bare), /regular files only/);
  assert.deepEqual(await fs.readdir(target), []);
});

test('missing remote, empty remote, or invalid default HEAD leaves no .git or staging files', async t => {
  const { dir, bare, target } = await fixture(t);
  const empty = path.join(dir, 'empty.git'); await new Git(dir).text(['init', '--bare', empty]);
  await new Git(bare).text(['symbolic-ref', 'HEAD', 'refs/heads/missing']);
  for (const address of [path.join(dir, 'absent.git'), empty, bare]) {
    await assert.rejects(importRepository(target, address));
    assert.deepEqual(await fs.readdir(target), []);
  }
});

test('rechecks conflicts and unsaved-editor validation immediately before applying', async t => {
  const { bare, target } = await fixture(t);
  await assert.rejects(importRepository(target, bare, () => { throw new Error('Unsaved editor'); }), /Unsaved editor/);
  assert.deepEqual(await fs.readdir(target), []);
  await assert.rejects(importRepository(target, bare, () => fs.writeFile(path.join(target, 'main.tex'), 'Created during fetch')), /Existing path conflicts/);
  assert.deepEqual(await fs.readdir(target), ['main.tex']);
  assert.equal(await fs.readFile(path.join(target, 'main.tex'), 'utf8'), 'Created during fetch');
});

test('an exclusive-write collision rolls back imported files and preserves a concurrent file', async t => {
  const { bare, target } = await fixture(t);
  // Simulate another process creating the destination after preflight and before its write.
  const nativeFs = require('node:fs/promises') as typeof fs;
  const link = nativeFs.link;
  t.mock.method(nativeFs, 'link', async (source: string, destination: string) => {
    if (destination === path.join(target, 'main.tex')) { await fs.writeFile(destination, 'Concurrent work'); }
    await link(source, destination);
  });
  await assert.rejects(importRepository(target, bare), /EEXIST/);
  assert.deepEqual(await fs.readdir(target), ['main.tex']);
  assert.equal(await fs.readFile(path.join(target, 'main.tex'), 'utf8'), 'Concurrent work');
});
