import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { ReviewStore } from '../reviewStore';

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function nonLatexTests(app: any, store: ReviewStore): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(store.root))!;
  const config = vscode.workspace.getConfiguration('gitex', folder.uri);
  const previous = config.inspect<boolean>('enableNonLatexFiles');
  const save = config.inspect<boolean>('autoSyncOnSave')?.workspaceFolderValue;
  assert.equal(previous?.defaultValue, false);
  assert.equal(config.get('enableNonLatexFiles'), false);
  const markdownFile = path.join(store.root, 'general-review.md');
  const codeFile = path.join(store.root, 'general-review.py');
  const noteFile = path.join(store.root, 'NOTES');
  await writeFile(markdownFile, 'Opening.\nMarkdown target.\n\nClosing.\n');
  await writeFile(codeFile, 'value = "Code target."\nprint(value)\n');
  await writeFile(noteFile, 'General note.\n');
  const markdown = await vscode.workspace.openTextDocument(markdownFile);
  const code = await vscode.workspace.openTextDocument(codeFile);
  let editor = await vscode.window.showTextDocument(markdown, { preview: false, viewColumn: vscode.ViewColumn.One });
  editor.selection = new vscode.Selection(1, 0, 1, markdown.lineAt(1).text.length);
  await app.refresh();
  const count = (await store.threads()).length;
  await assert.rejects(app.addComment('Blocked by default'), /Enable Non Latex Files/);
  assert.deepEqual(await app.controller.commentingRangeProvider.provideCommentingRanges(markdown), []);
  assert.equal((await store.threads()).length, count);
  const gutter = app.controller.createCommentThread(markdown.uri, editor.selection, []);
  try { await assert.rejects(app.reply({ thread: gutter, text: 'Blocked gutter reply' }), /Enable Non Latex Files/); }
  finally { gutter.dispose(); }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.GITEX_CDP_PORT}`);
  try {
    await config.update('autoSyncOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update('enableNonLatexFiles', true, vscode.ConfigurationTarget.WorkspaceFolder);
    await app.refresh();
    const ranges = await app.controller.commentingRangeProvider.provideCommentingRanges(markdown);
    assert.ok(ranges.some((range: vscode.Range) => range.contains(editor.selection)), 'enabled files offer gutter ranges');
    assert.ok(!ranges.some((range: vscode.Range) => range.contains(new vscode.Position(2, 0))), 'blank lines remain blocked');
    // Exercise the actual keybinding after a live setting change, without reloading VS Code.
    await vscode.window.showTextDocument(markdown, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    const page = browser.contexts()[0].pages().find(page => page.url().startsWith('vscode-file:'))!;
    await page.keyboard.press('Control+Shift+/');
    const prompt = page.locator('.quick-input-widget input:visible');
    await prompt.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await prompt.getAttribute('placeholder'), 'Explain this change or leave a review…');
    await prompt.fill('General file review'); await prompt.press('Enter');
    const review = async () => (await store.threads()).find(thread => thread.comments[0].body === 'General file review');
    await until(async () => !!await review(), 'shortcut creates a Markdown review');
    const id = (await review())!.id, key = `${store.root}:${id}`;
    await until(() => app.nativeThreads.has(key), 'Markdown inline widget');
    assert.deepEqual((await review())!.anchor.selected, ['Markdown target.']);
    assert.ok(app.highlightedRanges(markdown).some((highlight: any) => highlight.item.key === key));
    editor = await vscode.window.showTextDocument(markdown, vscode.ViewColumn.One);
    await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'Preface.\n'));
    await until(() => app.nativeThreads.get(key)?.range.start.line === 2, 'Markdown edits track the target');
    assert.equal(markdown.getText(app.nativeThreads.get(key).range), 'Markdown target.');

    editor = await vscode.window.showTextDocument(code, { preview: false, viewColumn: vscode.ViewColumn.One });
    const start = code.lineAt(0).text.indexOf('Code target.');
    editor.selection = new vscode.Selection(0, start, 0, start + 'Code target.'.length);
    await app.refresh();
    await app.moveComment(app.getChildren().find((item: any) => item.review.id === id));
    assert.equal((await review())!.anchor.path, 'general-review.py');
    assert.deepEqual((await review())!.anchor.selected, ['Code target.']);
    assert.equal(app.nativeThreads.get(key).uri.toString(), code.uri.toString());
    assert.ok(app.highlightedRanges(code).some((highlight: any) => highlight.item.key === key));

    const note = await vscode.workspace.openTextDocument(noteFile);
    editor = await vscode.window.showTextDocument(note, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await app.addComment('Extensionless file review');
    assert.ok((await store.threads()).some(thread => thread.anchor.path === 'NOTES'));
    await app.sync(app.repositories.get(store.root));
    const peer = new ReviewStore(path.join(path.dirname(store.root), 'peer'));
    await peer.pull();
    assert.equal((await peer.threads()).find(thread => thread.id === id)!.anchor.path, 'general-review.py', 'generic paths use ordinary review sync');

    // A disabled folder overrides an enabled workspace, including the editor UI.
    await vscode.workspace.getConfiguration('gitex').update('enableNonLatexFiles', true, vscode.ConfigurationTarget.Workspace);
    await config.update('enableNonLatexFiles', false, vscode.ConfigurationTarget.WorkspaceFolder);
    editor = await vscode.window.showTextDocument(code, vscode.ViewColumn.One);
    await app.refresh();
    assert.deepEqual(await app.controller.commentingRangeProvider.provideCommentingRanges(code), []);
    assert.equal(app.nativeThreads.has(key), false);
    assert.deepEqual(app.highlightedRanges(code), []);
    assert.ok(app.getChildren().some((item: any) => item.review.id === id), 'disabling keeps the review in Explorer');
    await assert.rejects(app.addComment('Disabled again'), /Enable Non Latex Files/);
    await assert.rejects(app.moveComment(app.getChildren().find((item: any) => item.review.id === id)), /Enable Non Latex Files/);
    assert.equal(app.supportsFile(vscode.Uri.file(path.join(store.root, 'main.tex'))), true);
    assert.equal(app.supportsFile(vscode.Uri.parse('untitled:general.md')), false);
    await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '# Edited while disabled\n'));
    await config.update('enableNonLatexFiles', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await app.refresh();
    assert.equal(app.nativeThreads.get(key).range.start.line, 1, 'workspace setting restores and reconciles the existing review');
    assert.equal(code.getText(app.nativeThreads.get(key).range), 'Code target.');
    console.log('GiTex non-LaTeX files: disabled default, shortcut, gutter, tracking, cross-file moves, extensionless paths, sync, folder override and live toggle preservation passed.');
  } finally {
    await config.update('enableNonLatexFiles', previous?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration('gitex').update('enableNonLatexFiles', previous?.workspaceValue, vscode.ConfigurationTarget.Workspace);
    await config.update('autoSyncOnSave', save, vscode.ConfigurationTarget.WorkspaceFolder);
    await app.refresh(); await browser.close();
  }
}
