import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, Frame } from 'playwright-core';
import { ReviewStore } from '../../src/store';

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function uncertainTests(app: any, store: ReviewStore): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitex', vscode.workspace.workspaceFolders![0].uri);
  const previous = config.inspect<boolean>('autoSyncOnSave')?.workspaceFolderValue;
  await config.update('autoSyncOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder);
  const before = 'We evaluated the protocol on the independent validation dataset.';
  const selected = 'The results show a substantial improvement.';
  const after = 'Further analysis is needed to explain the observed performance.';
  const paper = `${before}\n${selected}\n${after}\n`;
  const filename = path.join(store.root, 'context.tex');
  await writeFile(filename, paper);
  const document = await vscode.workspace.openTextDocument(filename);
  let editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
  editor.selection = new vscode.Selection(1, 0, 1, selected.length);
  await app.addComment('Verify the original result');
  const review = (await store.threads()).find(thread => thread.anchor.path === 'context.tex')!;
  const key = `${store.root}:${review.id}`;
  const current = async () => (await store.threads()).find(thread => thread.id === review.id)!;
  const item = () => app.getChildren().find((item: any) => item.key === key);
  const setText = async (text: string) => {
    editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length), text));
    await app.refresh();
  };
  assert.deepEqual(review.anchor.sentenceContext, { before, after });
  const head = await store.head(), index = await store.git.text(['write-tree']);
  const remote = await store.git.text(['ls-remote', '--heads', 'origin', 'refs/heads/gitex-comments']);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.GITEX_CDP_PORT}`);
  try {
    await setText(`${before}\n${after}\n`);
    assert.equal(item().location.kind, 'uncertain');
    const native = app.nativeThreads.get(key) as vscode.CommentThread;
    assert.equal(native.range!.start.line, 1);
    assert.match(native.label!, /Uncertain/);
    assert.match(native.comments[0].label!, /Uncertain/);
    assert.match(app.getTreeItem(item()).description, /~2.*Uncertain/);
    native.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    // The decoration's link opens the same review tab using a key, not untrusted HTML.
    await vscode.commands.executeCommand('gitex.reviewThread', key);
    let frame: Frame | undefined;
    await until(async () => {
      for (const page of browser.contexts()[0].pages()) {
        for (const candidate of page.frames()) {
          if (await candidate.locator('#match-state').count().catch(() => 0)) { frame = candidate; return true; }
        }
      }
      return false;
    }, 'uncertain review panel');
    const view = frame!;
    await until(async () => await view.locator('#match-state').textContent() === 'Uncertain', 'uncertain badge');
    assert.equal(await view.locator('.passage-content pre').textContent(), selected);
    assert.equal(await view.locator('.passage-content').isVisible(), true, 'saved reference is expanded for an estimate');
    await view.locator('.passage .surroundings > summary').click();
    assert.ok((await view.locator('.passage .surroundings').textContent())!.includes(before));
    await view.getByRole('button', { name: 'Open estimated location', exact: true }).click();
    await until(async () => vscode.window.activeTextEditor?.document === document, 'source navigation from estimated location');
    assert.equal(vscode.window.activeTextEditor!.selection.start.line, 1);
    assert.deepEqual((await current()).anchor, review.anchor, 'opening an estimate must not save it');
    const captures = process.env.GITEX_REVIEW_SCREENSHOT_DIR;
    if (captures) {
      await mkdir(captures, { recursive: true });
      await view.page().screenshot({ path: path.join(captures, 'review-uncertain.png') });
    }
    await app.panelAction(item(), { type: 'reply', body: 'Reply while the passage is missing', requestId: 'uncertain-reply' });
    const comment = app.nativeThreads.get(key).comments[0];
    await app.editComment(comment); comment.body = 'Edited while the passage is missing';
    await app.saveComment(comment);
    assert.deepEqual((await current()).anchor, review.anchor, 'reply and edit must not turn estimated text into the reference');
    assert.equal((await current()).anchorHistory.length, 1);

    const resolved = view.getByRole('checkbox', { name: 'Resolved', exact: true });
    await resolved.check();
    await until(async () => !app.nativeThreads.has(key), 'resolved estimate hidden in source');
    assert.ok(item(), 'resolved estimates remain in Explorer');
    await resolved.uncheck();
    await until(async () => app.nativeThreads.has(key), 'reopened estimate visible');
    await setText(`${before}\n${after}\n\n${before}\n${after}\n`);
    assert.equal(item().location.kind, 'outdated');
    assert.equal(app.nativeThreads.has(key), false, 'ambiguous context is sidebar-only');
    await setText(paper);
    assert.equal(item().location.kind, 'attached', 'restoring the original text restores identity');
    assert.equal((await current()).anchorHistory.length, 1, 'document edits never migrate persisted anchors');
    await setText(`${before}\n${after}\n`);
    editor.selection = new vscode.Selection(1, 0, 1, after.length);
    await view.getByRole('button', { name: 'Move to editor selection', exact: true }).click();
    await until(async () => (await current()).anchorHistory.length === 2, 'explicit reconnection');
    await until(async () => item().location.kind === 'attached', 'reattached location');
    const moved = await current();
    assert.deepEqual(moved.anchor.selected, [after]);
    assert.deepEqual(moved.anchorHistory.at(-1)!.from, review.anchor);
    assert.equal(moved.anchorHistory.at(-1)!.kind, 'move');
    assert.equal(await store.head(), head); assert.equal(await store.git.text(['write-tree']), index);
    assert.equal(await store.git.text(['ls-remote', '--heads', 'origin', 'refs/heads/gitex-comments']), remote);
    assert.ok(document.isDirty);
    console.log('GiTex context tracking: uncertain editor marker, saved sentences, source navigation, no automatic rebasing, resolve, outdated recovery and recorded manual reconnection passed.');
  } finally {
    for (const panel of app.panels.values()) { panel.dispose(); }
    await browser.close();
    await config.update('autoSyncOnSave', previous, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}
