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
    assert.equal(native.range!.start.line, 0, 'the comment widget sits after the preceding line, before the following sentence');
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
    // Rendering follows the extension-host save asynchronously. A native click
    // followed by the persisted state avoids check() asserting an interim render.
    await resolved.click();
    await until(async () => !app.nativeThreads.has(key) && (await current()).resolved &&
      await resolved.isChecked() && await resolved.isEnabled(), 'resolved estimate hidden in source');
    assert.ok(item(), 'resolved estimates remain in Explorer');
    await resolved.click();
    await until(async () => app.nativeThreads.has(key) && !(await current()).resolved &&
      !(await resolved.isChecked()) && await resolved.isEnabled(), 'reopened estimate visible');
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

    const heading = String.raw`\section*{작은 생각}`;
    const paragraph = '오늘은 바람이 살랑이고, 창밖의 구름은 천천히 흘러간다. 따뜻한 차 한 잔과 함께 잠시 쉬어 가도 좋겠다.';
    const following = '다음 날에는 새로운 실험 결과를 자세하게 살펴봅니다.';
    const latex = [heading, paragraph, ...Array(15).fill(''), following].join('\n');
    await setText(latex);
    editor.selection = new vscode.Selection(1, 0, 1, paragraph.length);
    await app.addComment('Track Korean prose below a LaTeX heading');
    const latexReview = (await store.threads()).find(thread => thread.comments[0].body === 'Track Korean prose below a LaTeX heading')!;
    assert.deepEqual(latexReview.anchor.sentenceContext, { before: heading, after: following });
    await setText(latex.replace(paragraph + '\n', ''));
    const latexItem = app.getChildren().find((item: any) => item.review.id === latexReview.id);
    assert.equal(latexItem.location.kind, 'uncertain');
    assert.match(app.nativeThreads.get(latexItem.key).label, /Uncertain/);
    await app.reviewThread(latexItem);
    await until(async () => (await view.locator('.passage-content pre').textContent()) === paragraph, 'Korean saved reference');
    assert.ok((await view.locator('.passage .surroundings').textContent())!.includes(heading));
    assert.ok((await view.locator('.passage .surroundings').textContent())!.includes(following));
    assert.deepEqual((await store.threads()).find(thread => thread.id === latexReview.id)!.anchor, latexReview.anchor);

    await setText(`${heading}\n헬로\n랄랄루`);
    editor.selection = new vscode.Selection(1, 0, 1, 2);
    await app.addComment('Capture short Korean context without punctuation');
    const shortReview = (await store.threads()).find(thread => thread.comments[0].body === 'Capture short Korean context without punctuation')!;
    assert.deepEqual(shortReview.anchor.sentenceContext, { before: heading, after: '랄랄루' });
    await app.reviewThread(app.getChildren().find((item: any) => item.review.id === shortReview.id));
    await until(async () => (await view.locator('.passage-content pre').textContent()) === '헬로', 'short Korean saved reference');
    await view.locator('.passage .surroundings > summary').click();
    const followingText = view.locator('.passage .surroundings pre').last();
    assert.equal(await followingText.textContent(), '랄랄루');
    assert.equal(await followingText.isVisible(), true, 'Following sentence must display unpunctuated prose');
    if (captures) { await view.page().screenshot({ path: path.join(captures, 'review-short-context.png') }); }

    const spaced = ['\\documentclass{article}', '\\usepackage{kotex}', '', '\\begin{document}', '',
      heading, '', '', '헬로', '', '', '랄랄루', '랄랄라.', '', '\\end{document}'].join('\n');
    const shortKey = `${store.root}:${shortReview.id}`;
    await setText(spaced);
    const shortLocal = structuredClone(app.localTracking.get(shortKey, shortReview.anchorRevision));
    assert.equal(shortLocal.anchor.sentenceContext.after, '랄랄루 랄랄라.');
    await setText(spaced.replace('헬로', ''));
    const estimated = app.getChildren().find((item: any) => item.key === shortKey);
    assert.equal(estimated.location.kind, 'uncertain'); assert.equal(estimated.location.estimatedLine, 8);
    assert.match(app.nativeThreads.get(shortKey).label, /Uncertain/);
    assert.equal(app.nativeThreads.get(shortKey).range.start.line, 8);
    await until(async () => (await view.locator('#match-state').textContent())!.startsWith('Uncertain'), 'short context estimate in review');
    assert.equal(await followingText.textContent(), '랄랄루', 'shared saved context is not rewritten');
    await view.locator('#local-context > summary').click();
    assert.equal(await view.locator('#local-context pre').last().textContent(), '랄랄루 랄랄라.');
    assert.deepEqual(app.localTracking.get(shortKey, shortReview.anchorRevision), shortLocal);
    assert.deepEqual((await store.threads()).find(thread => thread.id === shortReview.id)!.anchor, shortReview.anchor);
    if (captures) { await view.page().screenshot({ path: path.join(captures, 'review-short-estimated.png') }); }

    assert.equal(await store.head(), head); assert.equal(await store.git.text(['write-tree']), index);
    assert.equal(await store.git.text(['ls-remote', '--heads', 'origin', 'refs/heads/gitex-comments']), remote);
    assert.ok(document.isDirty);
    console.log('GiTex context tracking: uncertain editor marker, saved sentences, source navigation, no automatic rebasing, resolve, outdated recovery, manual reconnection, LaTeX headings, blank-line and unpunctuated Korean context passed.');
  } finally {
    for (const panel of app.panels.values()) { panel.dispose(); }
    await browser.close();
    await config.update('autoSyncOnSave', previous, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}
