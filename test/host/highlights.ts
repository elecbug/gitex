import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { chromium, Frame } from 'playwright-core';
import { EditTracking } from '../../src/editTracking';
import { ReviewStore } from '../../src/store';

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function highlightTests(app: any, store: ReviewStore): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitex', vscode.workspace.workspaceFolders![0].uri);
  const previous = config.inspect<boolean>('autoSyncOnSave')?.workspaceFolderValue;
  await config.update('autoSyncOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder);
  const themeConfig = vscode.workspace.getConfiguration('workbench');
  const previousTheme = themeConfig.inspect<string>('colorTheme')?.workspaceValue;
  const file = path.join(store.root, 'highlights.tex');
  await writeFile(file, 'Prefix. Alpha beta gamma. Suffix.\nDestination: \n');
  let document = await vscode.workspace.openTextDocument(file);
  let editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
  editor.selection = new vscode.Selection(0, 8, 0, 25);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.GITEX_CDP_PORT}`);
  try {
    await app.addComment('A shaded comment remains visible when collapsed');
    const created = (await store.threads()).find(thread => thread.anchor.path === 'highlights.tex')!;
    const key = `${store.root}:${created.id}`;
    const item = () => app.getChildren().find((item: any) => item.key === key);
    const highlights = () => app.highlightedRanges(document) as { range: vscode.Range; inserted: boolean }[];
    const excerpts = (inserted: boolean) => highlights().filter(value => value.inserted === inserted).map(value => document.getText(value.range));
    app.nativeThreads.get(key).collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    await editor.edit(edit => edit.insert(new vscode.Position(0, 14), 'INSERTED ')); await app.refresh();
    assert.deepEqual(excerpts(false), ['Alpha ', 'beta gamma.']);
    assert.deepEqual(excerpts(true), ['INSERTED ']);
    for (const panel of app.panels.values()) { panel.dispose(); }
    const page = browser.contexts()[0].pages().find(page => page.url().startsWith('vscode-file:'))!;
    const line = page.locator('.view-line').filter({ hasText: 'Alpha INSERTED beta gamma.' }).first();
    await line.waitFor({ state: 'visible' });
    const source = line.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " monaco-editor ")][1]');
    const colored = () => source.locator('.view-line span, .view-overlays .cdr').evaluateAll(elements => elements.map(element => ({ text: element.textContent ?? '',
      color: (globalThis as any).getComputedStyle(element).backgroundColor, border: (globalThis as any).getComputedStyle(element).borderStyle })).filter(value => value.color !== 'rgba(0, 0, 0, 0)' && value.color !== 'transparent'));
    for (const [theme, originalRgb, insertedRgb, screenshot] of [
      ['Default Dark Modern', '255, 224, 130', '127, 219, 255', 'dark'],
      ['Default Light Modern', '255, 241, 170', '201, 240, 255', 'light'],
      ['Default High Contrast', '255, 224, 130', '127, 219, 255', 'contrast']
    ]) {
      await themeConfig.update('colorTheme', theme, vscode.ConfigurationTarget.Workspace);
      await until(async () => {
        const colors = await colored();
        return colors.some(value => value.color.includes(originalRgb)) &&
          colors.some(value => value.color.includes(insertedRgb) && value.border.includes('dashed'));
      }, `bright original and inserted highlights in ${theme}`);
      await page.screenshot({ path: `/tmp/gitex-highlights-${screenshot}.png` });
    }
    await themeConfig.update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Workspace);
    const clickText = async (needle: string) => {
      const point = await line.evaluate((element, text) => {
        const browser = globalThis as any;
        const walker = browser.document.createTreeWalker(element, 4);
        let node;
        while ((node = walker.nextNode())) {
          const at = node.textContent.indexOf(text);
          if (at < 0) { continue; }
          const range = browser.document.createRange();
          range.setStart(node, at + 1); range.setEnd(node, at + 2);
          const box = range.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        }
        throw new Error(`No source text: ${text}`);
      }, needle);
      await page.mouse.click(point.x, point.y);
    };
    // Clicking either shade opens the same review, retaining the source editor's focus.
    await clickText('INSERTED');
    await until(async () => app.panels.has(key), 'review opened by inserted highlight click');
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), document.uri.toString(), 'the source retains focus');
    assert.equal(app.nativeThreads.get(key).collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
    let frame: Frame | undefined;
    await until(async () => {
      for (const candidate of page.frames()) {
        if (await candidate.locator('#comments').count().catch(() => 0)) { frame = candidate; return true; }
      }
      return false;
    }, 'clicked review panel');
    await until(async () => (await frame!.locator('#comments').textContent())!.includes(created.comments[0].body), 'clicked comment content');
    for (const panel of app.panels.values()) { panel.dispose(); }
    await clickText('Alpha');
    await until(async () => app.panels.has(key), 'review opened by original highlight click');
    for (const panel of app.panels.values()) { panel.dispose(); }
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    await app.openHighlightedComment({ textEditor: editor, selections: [new vscode.Selection(0, 9, 0, 9)], kind: vscode.TextEditorSelectionChangeKind.Keyboard });
    await app.openHighlightedComment({ textEditor: editor, selections: [new vscode.Selection(0, 9, 0, 12)], kind: vscode.TextEditorSelectionChangeKind.Mouse });
    assert.equal(app.panels.size, 0, 'keyboard movement and dragging do not open a review');
    await app.reply({ thread: app.nativeThreads.get(key), text: 'Keep the insertion colors in shared history' });
    let saved = (await store.threads()).find(thread => thread.id === created.id)!;
    assert.equal(saved.anchor.tracking!.insertions!.length, 1);
    await document.save(); await app.persistLocalTracking();
    const restored = new EditTracking(JSON.parse(JSON.stringify(app.editTracking.snapshot())));
    assert.equal(restored.highlights(key, saved.anchorRevision, document.getText()).inserted.length, 1);
    await app.setResolved(item(), true); assert.deepEqual(highlights(), []);
    await app.setResolved(item(), false); assert.equal(highlights().length, 3);

    // Save after cutting, then paste without ending the editor session.
    editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const start = document.lineAt(0).text.indexOf('beta gamma.');
    editor.selection = new vscode.Selection(0, start, 0, start + 11);
    await app.moveComment(item());
    await editor.edit(edit => edit.delete(new vscode.Range(0, start, 0, start + 11)));
    await document.save(); await app.refresh();
    assert.equal(item().location.kind, 'uncertain'); assert.deepEqual(highlights(), []);
    await editor.edit(edit => edit.insert(new vscode.Position(1, 13), 'beta gamma.'));
    await app.refresh(); assert.equal(item().location.kind, 'attached');
    assert.equal(app.nativeThreads.get(key).range.start.line, 1);
    assert.deepEqual(excerpts(false), ['beta gamma.']);
    await document.save();
    await app.reply({ thread: app.nativeThreads.get(key), text: 'Saved after pasting to the new position' });
    saved = (await store.threads()).find(thread => thread.id === created.id)!;
    assert.equal(saved.anchor.startLine, 1);
    await editor.edit(edit => edit.delete(new vscode.Range(1, 13, 1, 24)));
    await document.save(); await app.refresh();
    assert.equal(item().location.kind, 'uncertain');
    // A second tab for the same document keeps the session alive until the last tab closes.
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Two, preview: false });
    const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === document.uri.toString());
    assert.equal(tabs().length, 2);
    await vscode.window.tabGroups.close(tabs()[0]); await app.refresh();
    assert.equal(item().location.kind, 'uncertain');
    await vscode.window.tabGroups.close(tabs()); await app.refresh();
    assert.equal(item().location.kind, 'outdated'); assert.equal(app.nativeThreads.has(key), false);
    assert.match(app.getTreeItem(item()).description, /Outdated/);
    document = await vscode.workspace.openTextDocument(file);
    editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
    await app.refresh(); assert.equal(item().location.kind, 'outdated'); assert.deepEqual(highlights(), []);
    await editor.edit(edit => edit.insert(new vscode.Position(1, 13), 'beta gamma.')); await app.refresh();
    assert.equal(item().location.kind, 'outdated', 'a new session cannot reuse an expired cut');
    assert.deepEqual((await store.threads()).find(thread => thread.id === created.id)!.identityAnchor, saved.identityAnchor);
    console.log('GiTex highlights: persistent bright shading, insertion color, themes, mouse clicks, focus, resolved visibility, save/paste and final-tab Outdated lifecycle passed.');
  } finally {
    for (const panel of app.panels.values()) { panel.dispose(); }
    await browser.close();
    await themeConfig.update('colorTheme', previousTheme, vscode.ConfigurationTarget.Workspace);
    await config.update('autoSyncOnSave', previous, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}
