import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { chromium, Frame } from 'playwright-core';
import { ReviewStore } from '../../src/store';
import { createSelectionAnchor } from '../../src/anchor';
import { EditTracking, enableEditTracking } from '../../src/editTracking';

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function editTrackingTests(app: any, store: ReviewStore): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitex', vscode.workspace.workspaceFolders![0].uri);
  const previous = config.inspect<boolean>('autoSyncOnSave')?.workspaceFolderValue;
  await config.update('autoSyncOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder);
  const filename = path.join(store.root, 'editor-tracking.tex');
  const original = 'Earlier sentence. The selected target. Following sentence.\nDestination: \n';
  await writeFile(filename, original);
  const document = await vscode.workspace.openTextDocument(filename);
  let editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
  const selected = 'The selected target.', start = original.indexOf(selected);
  editor.selection = new vscode.Selection(0, start, 0, start + selected.length);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.GITEX_CDP_PORT}`);
  try {
    await app.addComment('Review the exact dragged text');
    const created = (await store.threads()).find(thread => thread.anchor.path === 'editor-tracking.tex')!;
    const key = `${store.root}:${created.id}`;
    const item = () => app.getChildren().find((item: any) => item.key === key);
    const current = async () => (await store.threads()).find(thread => thread.id === created.id)!;
    const range = () => app.nativeThreads.get(key).range as vscode.Range;
    assert.deepEqual(created.anchor.selected, [selected]);
    assert.equal(range().start.character, start); assert.equal(range().end.character, start + selected.length);
    await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'Added prefix. ')); await app.refresh();
    assert.equal(range().start.character, start + 14);
    await app.open(item());
    assert.equal(vscode.window.activeTextEditor!.document.getText(vscode.window.activeTextEditor!.selection), selected, 'source navigation selects the logical passage');
    editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const middle = document.lineAt(0).text.indexOf('selected');
    await editor.edit(edit => edit.insert(new vscode.Position(0, middle), 'New independent text. ')); await app.refresh();
    assert.equal(document.getText(range()), 'The ');
    await app.reply({ thread: app.nativeThreads.get(key), text: 'Keep the leading fragment' });
    let saved = await current();
    assert.deepEqual(saved.anchor.selected, ['The ']);
    assert.equal(saved.anchor.tracking!.fragments.length, 2);
    assert.deepEqual(saved.identityAnchor.selected, [selected]);
    await app.reviewThread(item());
    let frame: Frame | undefined;
    await until(async () => {
      for (const page of browser.contexts()[0].pages()) {
        for (const candidate of page.frames()) {
          if (await candidate.locator('#original-selection').count().catch(() => 0)) { frame = candidate; return true; }
        }
      }
      return false;
    }, 'original selection in review');
    await until(async () => (await frame!.locator('#original-selection').textContent()) === selected, 'the complete original target');

    // Reconnect to an exact substring, then cut and paste it using actual editor changes.
    editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const moving = 'selected target.', movingStart = document.lineAt(0).text.indexOf(moving);
    editor.selection = new vscode.Selection(0, movingStart + moving.length, 0, movingStart);
    await app.moveComment(item());
    saved = await current();
    assert.deepEqual(saved.anchor.selected, [moving]); assert.equal(saved.anchorHistory.at(-1)!.kind, 'move');
    await editor.edit(edit => edit.delete(new vscode.Range(0, movingStart, 0, movingStart + moving.length)));
    await app.refresh(); assert.equal(item().location.kind, 'uncertain');
    await editor.edit(edit => edit.insert(new vscode.Position(1, 13), moving));
    await app.refresh();
    assert.equal(item().location.kind, 'attached'); assert.equal(range().start.line, 1);
    assert.equal(range().start.character, 13); assert.equal(document.getText(range()), moving);
    await vscode.commands.executeCommand('undo'); await app.refresh();
    assert.equal(item().location.kind, 'uncertain');
    await vscode.commands.executeCommand('undo'); await app.refresh();
    assert.equal(item().location.kind, 'attached'); assert.equal(range().start.line, 0);
    await vscode.commands.executeCommand('redo'); await vscode.commands.executeCommand('redo'); await app.refresh();
    assert.equal(range().start.line, 1);
    await document.save(); await app.persistLocalTracking();
    const restored = new EditTracking(JSON.parse(JSON.stringify(app.editTracking.snapshot())));
    assert.equal(restored.locate(key, saved.anchorRevision, document.getText()).kind, 'attached');
    await app.reply({ thread: app.nativeThreads.get(key), text: 'The move survives sharing' });
    saved = await current(); assert.equal(saved.anchor.startLine, 1);
    assert.deepEqual(saved.identityAnchor.selected, [moving]);

    // The real gutter retains the drag even though VS Code collapses editor selection on click.
    const gutterFile = path.join(store.root, 'gutter-selection.tex');
    await writeFile(gutterFile, 'Before. Gutter target. After.\n');
    const gutterDoc = await vscode.workspace.openTextDocument(gutterFile);
    const gutterEditor = await vscode.window.showTextDocument(gutterDoc, { viewColumn: vscode.ViewColumn.One, preview: false });
    gutterEditor.selection = new vscode.Selection(0, 8, 0, 22);
    await app.refresh();
    const page = browser.contexts()[0].pages().find(page => page.url().startsWith('vscode-file:'))!;
    const line = page.locator('.view-line').filter({ hasText: 'Before. Gutter target. After.' }).first();
    await line.waitFor({ state: 'visible' });
    const box = (await line.boundingBox())!;
    await page.mouse.move(box.x - 12, box.y + box.height / 2);
    const source = line.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " monaco-editor ")][1]');
    const glyph = source.locator('.comment-range-glyph.line-hover');
    await glyph.waitFor({ state: 'visible' });
    await glyph.click();
    const form = page.locator('.review-widget .comment-form').filter({ has: page.locator('textarea.inputarea') }).last();
    const input = form.locator('textarea.inputarea');
    await input.waitFor({ state: 'visible' });
    await input.pressSequentially('Created through the real gutter');
    await form.getByRole('button', { name: 'Reply', exact: true }).click();
    await until(async () => (await store.threads()).some(thread => thread.anchor.path === 'gutter-selection.tex'), 'gutter save');
    const gutterReview = (await store.threads()).find(thread => thread.anchor.path === 'gutter-selection.tex')!;
    assert.deepEqual(gutterReview.anchor.selected, ['Gutter target.']);

    // A collaborator publishes review metadata before this client pulls their paper.
    const pendingFile = path.join(store.root, 'pending-document.tex');
    const oldText = 'This is the earlier paper.\n';
    const futureText = 'The collaborator added a new reviewed result.\n';
    await writeFile(pendingFile, oldText);
    await store.git.text(['add', 'pending-document.tex']);
    await store.git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Pending test baseline']);
    await store.git.text(['push', 'origin', 'main']);
    const peer = new ReviewStore(path.join(path.dirname(store.root), 'peer'));
    await peer.git.text(['pull', '--ff-only', 'origin', 'main']);
    await writeFile(path.join(peer.root, 'pending-document.tex'), futureText);
    await peer.git.text(['add', 'pending-document.tex']);
    await peer.git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Future paper']);
    await peer.git.text(['push', 'origin', 'main']);
    const futureAnchor = enableEditTracking(createSelectionAnchor('pending-document.tex', futureText,
      { start: { line: 0, character: 0 }, end: { line: 0, character: futureText.trimEnd().length } }, await peer.head()), futureText);
    const pendingId = await peer.create(futureAnchor, 'Review ahead of the paper', futureText);
    await peer.sync(); await store.pull();
    const pendingDoc = await vscode.workspace.openTextDocument(pendingFile);
    await vscode.window.showTextDocument(pendingDoc, { viewColumn: vscode.ViewColumn.One, preview: false });
    await app.refresh();
    const pendingKey = `${store.root}:${pendingId}`;
    const pendingItem = () => app.getChildren().find((item: any) => item.key === pendingKey);
    assert.equal(pendingItem().location.kind, 'pending'); assert.equal(app.nativeThreads.has(pendingKey), false);
    assert.match(app.getTreeItem(pendingItem()).description, /Pending document/);
    await app.reviewThread(pendingItem());
    await until(async () => (await frame!.locator('#match-state').textContent()) === 'Pending document', 'pending badge');
    assert.match((await frame!.locator('.context-note').textContent())!, /Pull the paper source/);
    await app.panelAction(pendingItem(), { type: 'reply', body: 'Waiting for the paper', requestId: 'pending-reply' });
    assert.deepEqual((await store.threads()).find(thread => thread.id === pendingId)!.anchor, futureAnchor);
    await store.git.text(['fetch', 'origin', 'main']); await app.refresh();
    assert.equal(pendingItem().location.kind, 'pending', 'fetching commits without updating the paper does not reveal the comment');
    await store.git.text(['pull', '--ff-only', 'origin', 'main']);
    await until(async () => pendingDoc.getText() === futureText, 'pulled document in editor');
    await app.refresh();
    assert.equal(pendingItem().location.kind, 'attached'); assert.ok(app.nativeThreads.has(pendingKey));
    console.log('GiTex editor tracking: exact selection, shifts, split identity, manual moves, cut/paste, undo/redo, persistence, native gutter, pending document UI and paper pull passed.');
  } finally {
    for (const panel of app.panels.values()) { panel.dispose(); }
    await browser.close();
    await config.update('autoSyncOnSave', previous, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}
