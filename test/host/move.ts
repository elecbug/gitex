import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { chromium, Frame } from 'playwright-core';
import { Git } from '../../src/git';
import { LOCAL_REF, REMOTE_REF, ReviewStore } from '../../src/store';

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function moveTests(app: any, store: ReviewStore): Promise<void> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.GITEX_CDP_PORT}`);
  const config = vscode.workspace.getConfiguration('gitex', vscode.workspace.workspaceFolders![0].uri);
  await config.update('autoSyncOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder);
  const original = (await store.threads())[0];
  const current = async () => (await store.threads()).find(thread => thread.id === original.id)!;
  const item = () => app.getChildren().find((item: any) => item.review.id === original.id);
  assert.equal(item().location.kind, 'outdated');
  assert.ok((await vscode.commands.getCommands()).includes('gitex.moveComment'));
  const target = path.join(store.root, 'moved.tex');
  const content = 'Heading\nMoved target line one.\nMoved target line two.\nAnother destination.\n';
  await writeFile(target, content);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
  let editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
  await editor.edit(edit => edit.replace(document.lineAt(1).range, 'Unsaved chosen target.'));
  editor.selection = new vscode.Selection(1, 0, 3, 0);
  const bare = await store.git.text(['remote', 'get-url', 'origin']);
  const remoteBefore = await new Git(bare).ref(REMOTE_REF);
  await vscode.commands.executeCommand('gitex.reviewThread', item());
  let frame: Frame | undefined;
  await until(async () => {
    for (const page of browser.contexts()[0].pages()) {
      for (const candidate of page.frames()) {
        if (await candidate.locator('#comments').count().catch(() => 0)) { frame = candidate; return true; }
      }
    }
    return false;
  }, 'review panel for relocation');
  const view = frame!;
  await view.locator('#reply').fill('Reply draft survives moving');
  await view.getByRole('button', { name: 'Move to editor selection', exact: true }).click();
  await until(async () => (await current()).anchor.path === 'moved.tex', 'move from outdated to selected passage');
  await until(async () => app.nativeThreads.get(item().key)?.uri.fsPath === target, 'new file widget');
  let moved = await current();
  assert.equal(moved.anchor.startLine, 1); assert.equal(moved.anchor.endLine, 2);
  assert.deepEqual(moved.anchor.selected, ['Unsaved chosen target.', 'Moved target line two.']);
  assert.deepEqual(moved.comments, original.comments);
  assert.deepEqual(moved.anchorHistory.at(-1)!.from, original.anchor);
  assert.equal(await view.locator('#reply').inputValue(), 'Reply draft survives moving');
  assert.equal(await new Git(bare).ref(REMOTE_REF), remoteBefore, 'disabled automatic sync leaves moves local');
  await view.locator('#tracking-history > summary').click();
  await until(async () => (await view.locator('#tracking-history').textContent())!.includes('Manual move'), 'manual move history');
  const history = (await view.locator('#tracking-history').textContent())!;
  assert.ok(history.includes('Previous reference: main.tex:'));
  assert.ok(history.includes('Moved to: moved.tex:2–3'));
  assert.ok(history.includes('Unsaved chosen target.'));

  const repository = item().repository;
  const realSync = repository.store.sync.bind(repository.store);
  let syncs = 0;
  repository.store.sync = async (remote: string) => { syncs++; return realSync(remote); };
  await config.update('autoSyncOnSave', true, vscode.ConfigurationTarget.WorkspaceFolder);
  editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  editor.selection = new vscode.Selection(1, 0, 3, 0);
  await vscode.commands.executeCommand('gitex.moveComment', item());
  await Promise.all([...app.syncs.values()]);
  assert.equal(syncs, 1, 'one automatic sync after a saved location move');
  moved = await current();
  assert.equal(moved.anchorHistory.filter(entry => entry.kind === 'move').length, 2, 'same-destination manual saves are recorded too');
  const peer = new ReviewStore(path.join(path.dirname(store.root), 'peer'));
  await peer.pull();
  assert.deepEqual((await peer.threads()).find(thread => thread.id === original.id)!.anchorHistory, moved.anchorHistory);

  await vscode.commands.executeCommand('gitex.resolve', item());
  editor.selection = new vscode.Selection(3, 0, 3, 0);
  await vscode.commands.executeCommand('gitex.moveComment', item());
  await Promise.all([...app.syncs.values()]);
  assert.equal(syncs, 2);
  moved = await current();
  assert.equal(moved.resolved, true); assert.equal(app.nativeThreads.has(item().key), false);
  assert.equal(moved.anchor.startLine, 3); assert.equal(moved.anchor.endLine, 3);
  await vscode.commands.executeCommand('gitex.reopen', item());
  assert.equal(app.nativeThreads.get(item().key).range.start.line, 3);

  const beforeInvalid = await store.git.ref(LOCAL_REF);
  editor.selection = new vscode.Selection(4, 0, 4, 0);
  await assert.rejects(app.moveComment(item()), /non-empty/);
  const movingItem = item();
  const outside = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(path.dirname(store.root), 'apply-target', 'notes.tex')));
  await vscode.window.showTextDocument(outside, vscode.ViewColumn.One);
  await assert.rejects(app.moveComment(movingItem), /same open Git repository/);
  assert.equal(await store.git.ref(LOCAL_REF), beforeInvalid);
  editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  await app.refresh();
  editor.selection = new vscode.Selection(3, 0, 3, 0);
  const native = app.nativeThreads.get(item().key).comments[0];
  await vscode.commands.executeCommand('gitex.editComment', native);
  native.body = 'Inline draft must not be lost';
  await assert.rejects(app.moveComment(item()), /Save or cancel the inline comment edit/);
  assert.equal(native.body, 'Inline draft must not be lost');
  await vscode.commands.executeCommand('gitex.cancelEdit', native);
  assert.equal(await store.git.ref(LOCAL_REF), beforeInvalid);
  assert.equal(document.isDirty, true);
  assert.equal(await readFile(target, 'utf8'), content, 'moving comments must not save or change the destination file');

  await editor.edit(edit => edit.replace(document.lineAt(3).range, 'Another destination!'));
  await app.panelAction(item(), { type: 'reply', body: 'Update at the manually chosen location', requestId: 'move-test' });
  await Promise.all([...app.syncs.values()]);
  assert.deepEqual((await current()).anchor.selected, ['Another destination!']);
  assert.equal((await current()).anchor.path, 'moved.tex');
  const previousWidget = app.nativeThreads.get(item().key);
  const main = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(store.root, 'main.tex')));
  editor = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
  editor.selection = new vscode.Selection(3, 0, 3, 0);
  await vscode.commands.executeCommand('gitex.moveComment', item());
  await Promise.all([...app.syncs.values()]);
  const returnedWidget = app.nativeThreads.get(item().key);
  assert.notEqual(returnedWidget, previousWidget, 'moving an attached comment across files recreates its native widget');
  assert.equal(returnedWidget.uri.fsPath, main.uri.fsPath);
  assert.equal((await current()).anchorHistory.filter(entry => entry.kind === 'move').length, 4);
  repository.store.sync = realSync;
  for (const panel of app.panels.values()) { panel.dispose(); }
  await browser.close();
  console.log('GiTex manual move tests: outdated recovery, cross-file selection, complete history, resolved state, drafts, validation, sync, and renewed tracking passed.');
}
