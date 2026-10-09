import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, Frame } from 'playwright-core';
import { LOCAL_REF, ReviewStore } from '../../src/store';

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function candidateTests(app: any, store: ReviewStore): Promise<void> {
  const folder = vscode.workspace.workspaceFolders![0].uri;
  const config = vscode.workspace.getConfiguration('gitex', folder);
  const previous = config.inspect<boolean>('autoSyncOnSave')?.workspaceFolderValue;
  const editorConfig = vscode.workspace.getConfiguration('editor', folder);
  const previousLenses = editorConfig.inspect<boolean>('codeLens')?.workspaceFolderValue;
  await config.update('autoSyncOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder);
  await editorConfig.update('codeLens', true, vscode.ConfigurationTarget.WorkspaceFolder);
  const before = 'We evaluated the protocol on independent validation data.';
  const target = 'The system measures accuracy across the validation dataset.';
  const after = 'Further analysis explains the measured performance differences.';
  const localBefore = 'The lunar observatory records infrared spectra of distant galaxies.';
  const localAfter = 'Archived telescope images are available through the public catalog.';
  const original = `${before}\n${target}\n${after}`;
  const filename = path.join(store.root, 'candidate-context.tex');
  await writeFile(filename, original);
  const document = await vscode.workspace.openTextDocument(filename);
  const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
  editor.selection = new vscode.Selection(1, 0, 1, target.length);
  await app.addComment('Compare both candidate locations');
  const review = (await store.threads()).find(thread => thread.anchor.path === 'candidate-context.tex')!;
  const key = `${store.root}:${review.id}`;
  const item = () => app.getChildren().find((item: any) => item.key === key);
  const setText = async (text: string) => {
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length), text));
    await app.refresh();
  };
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.GITEX_CDP_PORT}`);
  try {
    await app.reviewThread(item());
    let frame: Frame | undefined;
    await until(async () => {
      for (const page of browser.contexts()[0].pages()) {
        for (const candidate of page.frames()) {
          if (await candidate.locator('#candidate-locations').count().catch(() => 0)) { frame = candidate; return true; }
        }
      }
      return false;
    }, 'candidate review panel');
    const view = frame!;
    await view.locator('#reply').fill('Unsent reply shared by both candidates');
    const native = app.nativeThreads.get(key).comments[0];
    await app.editComment(native); native.body = 'Inline edit retained across both candidates';
    await setText(`${localBefore}\n${target}\n${localAfter}`);
    const local = structuredClone(app.localTracking.get(key, review.anchorRevision));
    await setText(`${original}\n\n\\section{Other}\n${localBefore}\n${target}\n${localAfter}`);
    assert.equal(item().location.kind, 'uncertain'); assert.equal(item().location.candidates.length, 2);
    assert.deepEqual(app.provideEstimateLenses(document).map((lens: vscode.CodeLens) => lens.range.start.line), [1, 6]);
    const deleted = `${before}\n${after}\n\n\\section{Other}\n${localBefore}\n${localAfter}\n\\end{document}`;
    await setText(deleted);
    const reference = await store.git.ref(LOCAL_REF), head = await store.head(), index = await store.git.text(['write-tree']);
    const dirty = document.isDirty;
    const lenses = app.provideEstimateLenses(document) as vscode.CodeLens[];
    assert.deepEqual(lenses.map(lens => lens.range.start.line), [1, 5]);
    assert.ok(lenses[0].command!.title.includes('Saved reference candidate'));
    assert.ok(lenses[1].command!.title.includes('Local context candidate'));
    assert.deepEqual(lenses.map(lens => lens.command!.arguments), [[key], [key]]);
    assert.equal(app.nativeThreads.get(key).comments[0], native, 'both candidates share one editable thread');
    assert.equal(native.body, 'Inline edit retained across both candidates');
    assert.match(app.getTreeItem(item()).description, /~2 \/ ~6/);
    await until(async () => await view.locator('#match-state').textContent() === 'Uncertain · 2 candidates', 'two-candidate badge');
    assert.equal(await view.locator('#candidate-locations button').count(), 2);
    assert.equal(await view.locator('#reply').inputValue(), 'Unsent reply shared by both candidates');
    await view.getByRole('button', { name: 'Open saved candidate', exact: true }).click();
    await until(async () => vscode.window.activeTextEditor?.document === document && vscode.window.activeTextEditor.selection.start.line === 1, 'saved candidate navigation');
    await view.getByRole('button', { name: 'Open local candidate', exact: true }).click();
    await until(async () => vscode.window.activeTextEditor?.document === document && vscode.window.activeTextEditor.selection.start.line === 5, 'local candidate navigation');
    // Collapse the edit widget only for the screenshot; the draft remains on its shared object.
    app.nativeThreads.get(key).collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    await vscode.commands.executeCommand('workbench.action.closePanel');
    editor.revealRange(new vscode.Range(0, 0, 6, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    const page = view.page();
    const savedRow = page.locator('.codelens-decoration').filter({ hasText: 'Saved reference candidate' }).first();
    const localRow = page.locator('.codelens-decoration').filter({ hasText: 'Local context candidate' }).first();
    await until(async () => await savedRow.isVisible() && await localRow.isVisible(), 'both virtual rows in the source editor');
    for (const [row, text] of [[savedRow, after], [localRow, localAfter]] as const) {
      const box = await row.boundingBox();
      const following = await page.locator('.view-line').filter({ hasText: text }).first().boundingBox();
      assert.ok(box && following && box.y + box.height <= following.y + 1, 'the virtual row must precede the following sentence');
    }
    await savedRow.locator('a').first().click();
    assert.equal(app.panels.size, 1);
    assert.equal(await view.locator('#reply').inputValue(), 'Unsent reply shared by both candidates');
    await app.refresh();
    assert.equal(document.getText(), deleted); assert.equal(document.isDirty, dirty);
    assert.deepEqual(app.localTracking.get(key, review.anchorRevision), local);
    assert.deepEqual((await store.threads()).find(thread => thread.id === review.id)!.anchor, review.anchor);
    assert.equal(await store.git.ref(LOCAL_REF), reference); assert.equal(await store.head(), head);
    assert.equal(await store.git.text(['write-tree']), index);
    const captures = process.env.GITEX_REVIEW_SCREENSHOT_DIR;
    if (captures) { await mkdir(captures, { recursive: true }); await page.screenshot({ path: path.join(captures, 'review-two-candidates.png') }); }
    await app.setResolved(item(), true);
    assert.equal(app.provideEstimateLenses(document).length, 0);
    await until(async () => await page.locator('.codelens-decoration').filter({ hasText: 'Uncertain' }).count() === 0, 'resolved ghost rows removed');
    await app.setResolved(item(), false);
    assert.equal(app.provideEstimateLenses(document).length, 2);
    await app.cancelEdit(native);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(4, 0, 4, localBefore.length);
    await app.moveComment(item());
    assert.equal(item().location.kind, 'attached');
    assert.equal(app.provideEstimateLenses(document).length, 0);
    assert.equal((await store.threads()).find(thread => thread.id === review.id)!.anchorHistory.at(-1)!.kind, 'move');
    console.log('GiTex candidate locations: both shared/local markers, virtual gap rows, candidate navigation, one preserved draft, unchanged source/Git data, resolve and recorded reconnection passed.');
  } finally {
    for (const panel of app.panels.values()) { panel.dispose(); }
    await browser.close();
    await config.update('autoSyncOnSave', previous, vscode.ConfigurationTarget.WorkspaceFolder);
    await editorConfig.update('codeLens', previousLenses, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}
