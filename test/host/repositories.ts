import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { Git } from '../../src/git';
import { ReviewStore } from '../../src/store';
import { createAnchor } from '../../src/anchor';
import { findRepository } from '../../src/repositories';

export async function repositoryTests(app: any, existing: ReviewStore): Promise<void> {
  const collection = path.join(path.dirname(existing.root), 'collection');
  const first = path.join(collection, 'research', '2026', 'first');
  const second = path.join(collection, 'research', 'second');
  const inner = path.join(first, 'appendix');
  const paper = 'An identical passage shared by different repositories.\n';
  const setup = async (root: string) => {
    await mkdir(root, { recursive: true });
    const store = new ReviewStore(root);
    await store.git.text(['init', '--initial-branch=main']);
    await store.git.text(['config', 'user.name', 'Repository Tester']);
    await store.git.text(['config', 'user.email', 'repositories@example.test']);
    await writeFile(path.join(root, 'main.tex'), paper);
    await store.git.text(['add', 'main.tex']);
    await store.git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Paper']);
    const bare = `${root}.git`;
    await store.git.text(['init', '--bare', '--initial-branch=main', bare]);
    await store.git.text(['remote', 'add', 'origin', bare]);
    const id = await store.create(createAnchor('main.tex', paper, 0, 0, await store.head()), `Review for ${path.basename(root)}`);
    return { store, id };
  };
  const a = await setup(first);
  const b = await setup(second);
  const nested = await setup(inner);
  const shadow = await a.store.create(createAnchor('appendix/main.tex', paper, 0, 0, await a.store.head()), 'Parent review must not annotate the nested repository');
  await writeFile(path.join(collection, 'notes.tex'), 'Outside all repositories');
  const foldersChanged = new Promise<void>(resolve => {
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => { subscription.dispose(); resolve(); });
  });
  assert.equal(vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders!.length, 0,
    { uri: vscode.Uri.file(collection), name: 'Papers' }), true);
  await foldersChanged;
  const config = vscode.workspace.getConfiguration('gitex', vscode.Uri.file(collection));
  await config.update('autoSyncOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder);
  await app.refresh();
  for (const root of [first, second, inner]) { assert.ok(app.repositories.has(root), `recursive discovery: ${root}`); }
  assert.equal(app.repositories.has(`${first}.git`), false, 'bare remotes are not editor repositories');

  const select = async (file: string) => {
    const expected = await findRepository(path.dirname(file));
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    editor.selection = new vscode.Selection(0, 0, 0, 1);
    // Verify the actual editor event updates the view, without invoking Refresh Comments.
    const deadline = Date.now() + 15_000;
    while (true) {
      const ready = app.contextUri?.fsPath === file && app.activeRoot === expected &&
        (expected ? app.getChildren().some((item: any) => item.repository.store.root === expected) &&
          app.getChildren().filter((item: any) => !item.review.resolved && item.location.kind === 'attached')
            .every((item: any) => app.nativeThreads.has(item.key)) &&
          [...app.nativeThreads.keys()].every((key: any) => key.startsWith(`${expected}:`)) :
          app.getChildren().length === 0 && app.nativeThreads.size === 0);
      if (ready) { break; }
      assert.ok(Date.now() < deadline, `automatic repository switch: ${file}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return editor;
  };
  const assertScope = (root: string) => {
    assert.equal(app.activeRoot, root);
    assert.ok(app.getChildren().length > 0);
    assert.ok(app.getChildren().every((item: any) => item.repository.store.root === root));
    assert.ok([...app.nativeThreads.keys()].every((key: any) => key.startsWith(`${root}:`)), 'inline widgets only belong to the selected repository');
    assert.match(app.status.tooltip, new RegExp(path.basename(root)));
  };
  await select(path.join(first, 'main.tex'));
  assertScope(first);
  assert.equal(app.tree.description, 'Papers/research/2026/first');
  assert.equal(app.getChildren().find((item: any) => item.review.id === shadow).location.kind, 'outdated');
  const aKey = `${first}:${a.id}`;
  const native = app.nativeThreads.get(aKey).comments[0];
  await app.editComment(native); native.body = 'Inline draft belonging to the first repository';
  const scanVersion = app.scannedVersion;
  await select(path.join(second, 'main.tex'));
  assertScope(second);
  assert.equal(app.scannedVersion, scanVersion, 'file selection reuses the recursive scan');
  assert.equal(native.mode, vscode.CommentMode.Editing, 'switching repositories retains the inline draft');
  await select(path.join(first, 'main.tex'));
  assertScope(first);
  assert.equal(app.nativeThreads.get(aKey).comments[0].body, 'Inline draft belonging to the first repository');
  await app.cancelEdit(native);

  const firstItem = app.getChildren().find((item: any) => item.review.id === a.id);
  await app.reviewThread(firstItem);
  assert.equal((await app.chooseRepository()).store.root, first, 'webview focus retains the selected source context');
  await select(path.join(second, 'main.tex'));
  const secondItem = app.getChildren()[0];
  await app.reviewThread(secondItem);
  assert.equal(app.panels.size, 1, 'repositories share the same reusable review tab');
  // A pending action from the previous view stays bound to its original repository.
  await app.panelAction(firstItem, { type: 'reply', body: 'Late reply for first', requestId: 'repository-reply' });
  assert.equal((await a.store.threads()).find(review => review.id === a.id)!.comments.length, 2);
  assert.equal((await b.store.threads())[0].comments.length, 1);
  assertScope(second);

  const calls: string[] = [];
  for (const root of [first, second, inner]) {
    const repository = app.repositories.get(root);
    for (const method of ['sync', 'pull'] as const) {
      const original = repository.store[method].bind(repository.store);
      repository.store[method] = async (...args: any[]) => { calls.push(`${method}:${root}`); return original(...args); };
    }
  }
  await config.update('autoSyncOnSave', true, vscode.ConfigurationTarget.WorkspaceFolder);
  await select(path.join(second, 'main.tex'));
  await app.addComment('A new comment saved only in second');
  await Promise.all([...app.syncs.values()]);
  assert.deepEqual(calls, [`sync:${second}`]);
  await app.pull(); await app.sync();
  assert.deepEqual(calls, [`sync:${second}`, `pull:${second}`, `sync:${second}`]);
  assert.equal((await b.store.threads()).length, 2);
  assert.equal(await a.store.git.text(['ls-remote', '--heads', 'origin', 'refs/heads/gitex-comments']), '');
  await select(path.join(inner, 'main.tex'));
  assertScope(inner);
  assert.equal(calls.length, 3, 'switching repositories does not access the remote');
  assert.equal(app.getChildren()[0].review.id, nested.id);
  assert.equal(app.getChildren()[0].location.kind, 'attached', 'an outer review of the same path cannot poison the document cache');
  await app.addComment('A new nested comment');
  await Promise.all([...app.syncs.values()]);
  assert.equal(calls.at(-1), `sync:${inner}`);
  assert.equal((await a.store.threads()).length, 2, 'nested comments do not enter the parent metadata');

  await select(path.join(collection, 'notes.tex'));
  assert.equal(app.getChildren().length, 0);
  assert.equal(app.nativeThreads.size, 0);
  await assert.rejects(app.chooseRepository(), /selected file is not in a Git working repository/);
  await select(path.join(first, 'main.tex'));
  await app.commentHistory(app.nativeThreads.get(aKey).comments[0]);
  await app.refresh();
  assertScope(first);
  assert.equal((await app.chooseRepository()).store.root, first, 'history documents retain their repository');

  // New repositories need no additional workspace folder or window reload.
  const freshRoot = path.join(collection, 'new', 'paper');
  const fresh = await setup(freshRoot);
  await select(path.join(freshRoot, 'main.tex'));
  assertScope(freshRoot);
  assert.equal(app.getChildren()[0].review.id, fresh.id);
  await rm(path.join(freshRoot, '.git'), { recursive: true });
  await vscode.commands.executeCommand('gitex.refresh');
  assert.equal(app.repositories.has(freshRoot), false);
  assert.equal(app.getChildren().length, 0);
  assert.equal(await new Git(collection).run(['rev-parse', '--show-toplevel']).then(result => result.code === 0), false);
  for (const panel of app.panels.values()) { panel.dispose(); }
  console.log('GiTex repositories: recursive discovery, active-file switching, nested ownership, sync routing, drafts and refresh passed.');
}
