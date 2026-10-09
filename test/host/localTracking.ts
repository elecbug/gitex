import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { chromium, Frame } from 'playwright-core';
import { LocalTracking } from '../../src/localTracking';
import { LOCAL_REF, ReviewStore } from '../../src/store';

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function localTrackingTests(app: any, store: ReviewStore): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitex', vscode.workspace.workspaceFolders![0].uri);
  const previous = config.inspect<boolean>('autoSyncOnSave')?.workspaceFolderValue;
  await config.update('autoSyncOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder);
  const before = 'We evaluated the protocol on independent validation data.';
  const selected = 'The system measures accuracy across the validation dataset.';
  const after = 'Further analysis explains the measured performance differences.';
  const recentBefore = 'The lunar observatory records infrared spectra of distant galaxies.';
  const recentAfter = 'Archived telescope images are available through the public catalog.';
  const filename = path.join(store.root, 'local-context.tex');
  await writeFile(filename, `${before}\n${selected}\n${after}\n`);
  const document = await vscode.workspace.openTextDocument(filename);
  const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
  editor.selection = new vscode.Selection(1, 0, 1, selected.length);
  await app.addComment('Review using separate shared and local contexts');
  const review = (await store.threads()).find(thread => thread.anchor.path === 'local-context.tex')!;
  const key = `${store.root}:${review.id}`;
  const item = () => app.getChildren().find((item: any) => item.key === key);
  const local = () => app.localTracking.get(key, review.anchorRevision);
  const reference = await store.git.ref(LOCAL_REF);
  const head = await store.head(), index = await store.git.text(['write-tree']);
  const remote = await store.git.text(['ls-remote', '--heads', 'origin', 'refs/heads/gitex-comments']);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.GITEX_CDP_PORT}`);
  try {
    await editor.edit(edit => {
      edit.replace(document.lineAt(0).range, recentBefore);
      edit.replace(document.lineAt(2).range, recentAfter);
    });
    // Exercise the document-change event itself, before a manual refresh or save.
    await until(async () => local()?.anchor.sentenceContext.before === recentBefore, 'local context after typing');
    assert.equal(local().anchor.sentenceContext.after, recentAfter);
    const persisted = () => new LocalTracking(app.context.workspaceState.get('gitex.localTracking.v1'));
    assert.equal(persisted().get(key, review.anchorRevision)!.anchor.sentenceContext!.before, before,
      'unsaved source changes remain session-local');
    await editor.edit(edit => edit.delete(new vscode.Range(1, 0, 2, 0)));
    await app.refresh();
    assert.equal(item().location.kind, 'uncertain'); assert.equal(item().location.source, 'local');
    assert.match(app.nativeThreads.get(key).label, /Local context/);
    assert.equal(await store.git.ref(LOCAL_REF), reference, 'typing must not create shared review events');
    await document.save(); await app.persistLocalTracking();
    await until(async () => persisted().get(key, review.anchorRevision)?.anchor.sentenceContext?.before === recentBefore, 'persisted local context after source save');
    assert.equal(persisted().locate(key, review.anchor, review.anchorRevision, document.getText()).source, 'local');
    assert.deepEqual((await store.threads()).find(thread => thread.id === review.id)!.anchor, review.anchor);
    assert.equal(await store.git.ref(LOCAL_REF), reference);
    assert.equal(await store.head(), head); assert.equal(await store.git.text(['write-tree']), index);
    assert.equal(await store.git.text(['ls-remote', '--heads', 'origin', 'refs/heads/gitex-comments']), remote);

    await app.reviewThread(item());
    let frame: Frame | undefined;
    await until(async () => {
      for (const page of browser.contexts()[0].pages()) {
        for (const candidate of page.frames()) {
          if (await candidate.locator('#local-context').count().catch(() => 0)) { frame = candidate; return true; }
        }
      }
      return false;
    }, 'review with local context');
    const view = frame!;
    await until(async () => (await view.locator('#match-state').textContent()) === 'Uncertain · Local context', 'local source indicator');
    assert.ok((await view.locator('.passage .surroundings').textContent())!.includes(before));
    await view.locator('#local-context > summary').click();
    assert.ok((await view.locator('#local-context').textContent())!.includes(recentBefore));
    assert.ok((await view.locator('#local-context').textContent())!.includes(recentAfter));
    assert.equal(await view.locator('.passage-content pre').textContent(), selected);

    const endFile = path.join(store.root, 'local-end.tex');
    await writeFile(endFile, `${before}\n${selected}\n\\end{document}\n`);
    const endDocument = await vscode.workspace.openTextDocument(endFile);
    const endEditor = await vscode.window.showTextDocument(endDocument, { viewColumn: vscode.ViewColumn.One, preview: false });
    endEditor.selection = new vscode.Selection(1, 0, 1, selected.length);
    await app.addComment('Review the final paragraph');
    const endReview = (await store.threads()).find(thread => thread.anchor.path === 'local-end.tex')!;
    assert.equal(endReview.anchor.afterBoundary, 'document-end');
    const endKey = `${store.root}:${endReview.id}`;
    await endEditor.edit(edit => edit.replace(endDocument.lineAt(0).range, recentBefore));
    await until(async () => app.localTracking.get(endKey, endReview.anchorRevision)?.anchor.sentenceContext.before === recentBefore, 'local end context');
    await endEditor.edit(edit => edit.delete(new vscode.Range(1, 0, 2, 0)));
    await app.refresh();
    const endItem = () => app.getChildren().find((item: any) => item.key === endKey);
    assert.equal(endItem().location.kind, 'uncertain'); assert.equal(endItem().location.source, 'local');
    await app.reviewThread(endItem());
    await until(async () => (await view.locator('.passage .surroundings').textContent())!.includes('End of document (\\end{document})'), 'explicit document-end context');
    assert.ok((await view.locator('#local-context').textContent())!.includes('End of document'));
    await vscode.window.showTextDocument(endDocument, vscode.ViewColumn.One);
    endEditor.selection = new vscode.Selection(0, 0, 0, recentBefore.length);
    await app.moveComment(endItem());
    const moved = (await store.threads()).find(thread => thread.id === endReview.id)!;
    assert.equal(app.localTracking.get(endKey, endReview.anchorRevision), undefined);
    assert.equal(app.localTracking.get(endKey, moved.anchorRevision).basedOn, moved.anchorRevision);
    assert.deepEqual(moved.anchorHistory.at(-1)!.from, endReview.anchor);
    console.log('GiTex local tracking: live context updates, source-save persistence, restart recovery, separate UI, unchanged Git refs, document-end estimates and move invalidation passed.');
  } finally {
    for (const panel of app.panels.values()) { panel.dispose(); }
    await browser.close();
    await config.update('autoSyncOnSave', previous, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}
