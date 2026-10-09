import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { LOCAL_REF, ReviewStore } from '../../src/store';

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function blankLineTests(app: any, store: ReviewStore): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitex', vscode.workspace.workspaceFolders![0].uri);
  const previous = config.inspect<boolean>('autoSyncOnSave')?.workspaceFolderValue;
  await config.update('autoSyncOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder);
  const filename = path.join(store.root, 'blank-comments.tex');
  await writeFile(filename, '\n \t \nFirst commentable passage.\nSecond commentable passage.\n\n\t\nLast commentable passage.\n');
  const document = await vscode.workspace.openTextDocument(filename);
  const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
  await app.refresh();
  const ranges = () => app.controller.commentingRangeProvider.provideCommentingRanges(document) as vscode.Range[];
  const reference = await store.git.ref(LOCAL_REF);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.GITEX_CDP_PORT}`);
  try {
    assert.deepEqual(ranges().map(range => [range.start.line, range.end.line]), [[2, 3], [6, 6]]);
    for (const selection of [new vscode.Selection(0, 0, 0, 0), new vscode.Selection(1, 1, 1, 1),
      new vscode.Selection(2, 5, 2, 6), new vscode.Selection(0, 0, 2, 0), new vscode.Selection(2, 0, 0, 0), new vscode.Selection(7, 0, 7, 0)]) {
      editor.selection = selection;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          app.addComment().then(() => undefined, (error: Error) => error),
          new Promise(resolve => { timer = setTimeout(() => resolve('input-opened'), 1500); })
        ]);
        if (result === 'input-opened') { await vscode.commands.executeCommand('workbench.action.closeQuickOpen'); }
        assert.ok(result instanceof Error && /non-empty/.test(result.message), 'blank selections must fail before opening an input box');
      } finally { clearTimeout(timer); }
    }
    const page = browser.contexts()[0].pages().find(page => page.url().startsWith('vscode-file:'))!;
    const firstLine = page.locator('.view-line').filter({ hasText: 'First commentable passage.' }).first();
    await firstLine.waitFor({ state: 'visible' });
    const source = firstLine.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " monaco-editor ")][1]');
    const box = (await firstLine.boundingBox())!;
    const hover = async (line: number, enabled: boolean) => {
      await page.mouse.move(box.x - 12, box.y + (line - 2 + 0.5) * box.height);
      await until(async () => (await source.locator('.comment-range-glyph.line-hover').count() > 0) === enabled, `gutter affordance on line ${line + 1}`);
    };
    for (const line of [0, 1, 4, 5, 7]) {
      await hover(2, true); await hover(line, false);
      await page.mouse.click(box.x - 12, box.y + (line - 2 + 0.5) * box.height);
      assert.equal(await source.locator('.review-widget').count(), 0, 'clicking a blank gutter must not open a review input');
    }
    await editor.edit(edit => edit.replace(document.lineAt(2).range, '  '));
    assert.ok(!ranges().some(range => range.contains(new vscode.Position(2, 0))), 'live whitespace-only edits remove the new-comment range');
    await editor.edit(edit => edit.replace(document.lineAt(2).range, 'First commentable passage.'));
    assert.equal(await store.git.ref(LOCAL_REF), reference, 'rejected attempts create no review events');
    editor.selection = new vscode.Selection(1, 0, 3, 0);
    await app.addComment('A mixed selection still accepts comments');
    const review = (await store.threads()).find(thread => thread.anchor.path === 'blank-comments.tex')!;
    assert.deepEqual(review.anchor.selected, [' \t ', 'First commentable passage.']);
    console.log('GiTex blank lines: no input for empty/whitespace-only lines, gutter clicks blocked, live edits, selection boundaries and valid mixed selections passed.');
  } finally {
    await browser.close();
    await config.update('autoSyncOnSave', previous, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}
