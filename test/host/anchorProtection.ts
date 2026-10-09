import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { ReviewStore } from '../../src/store';

export async function anchorProtectionTests(app: any, store: ReviewStore): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitex', vscode.workspace.workspaceFolders![0].uri);
  const previous = config.inspect<boolean>('autoSyncOnSave')?.workspaceFolderValue;
  await config.update('autoSyncOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder);
  const before = 'We evaluated the protocol using an independent validation dataset.';
  const original = 'The results show a significant improvement.';
  const after = 'Further analysis describes the independent measurements in detail.';
  const filename = path.join(store.root, 'anchor-protection.tex');
  await writeFile(filename, `${before}\n${original}\n${after}`);
  const document = await vscode.workspace.openTextDocument(filename);
  const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
  editor.selection = new vscode.Selection(1, 0, 1, original.length);
  const head = await store.head(), index = await store.git.text(['write-tree']);
  try {
    await app.addComment('Keep the identity of the original sentence');
    const created = (await store.threads()).find(thread => thread.anchor.path === 'anchor-protection.tex')!;
    const key = `${store.root}:${created.id}`;
    const item = () => app.getChildren().find((item: any) => item.key === key);
    const current = async () => (await store.threads()).find(thread => thread.id === created.id)!;
    const update = async (text: string, line = 1) => {
      await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      await editor.edit(edit => edit.replace(document.lineAt(line).range, text));
      await app.refresh();
    };
    const revised = original.replace('show', 'showed');
    await update(revised + ' However, the overhead is considerable.');
    assert.equal(item().location.kind, 'attached');
    assert.deepEqual(app.localTracking.get(key, created.anchorRevision).anchor.selected, [revised]);
    assert.equal(app.nativeThreads.get(key).range.start.line, 1);
    assert.equal(app.nativeThreads.get(key).range.end.line, 1, 'the native widget still uses a whole-line source range');
    await vscode.commands.executeCommand('gitex.reply', { thread: app.nativeThreads.get(key), text: 'Inline reply keeps only A-prime' });
    let saved = await current();
    assert.deepEqual(saved.anchor.selected, [revised]);
    assert.equal(saved.anchor.logicalRange!.endCharacter, revised.length);
    assert.deepEqual(saved.identityAnchor, created.anchor);

    await update(revised + ' Additional measurements are now available.');
    const native = app.nativeThreads.get(key).comments[0];
    await vscode.commands.executeCommand('gitex.editComment', native);
    native.body = 'An inline edit still reviews only the original sentence';
    await vscode.commands.executeCommand('gitex.saveComment', native);
    saved = await current();
    assert.deepEqual(saved.anchor.selected, [revised]);
    assert.deepEqual(saved.identityAnchor, created.anchor);
    const stable = structuredClone(saved.anchor);
    const revision = saved.anchorRevision;
    await update(revised.replace('significant', 'substantial') + ' Additional measurements are now available.');
    assert.equal(item().location.kind, 'attached', 'display attachment can be weaker than renewal evidence');
    await app.panelAction(item(), { type: 'reply', body: 'Panel reply must not promote drift', requestId: 'protect-identity' });
    saved = await current();
    assert.deepEqual(saved.anchor, stable);
    assert.equal(saved.anchorRevision, revision);
    assert.equal(saved.comments.at(-1)!.body, 'Panel reply must not promote drift');
    assert.deepEqual(saved.anchorHistory.map(entry => entry.anchor.selected[0]), [original, revised, revised]);

    editor.selection = new vscode.Selection(2, 0, 2, after.length);
    await app.moveComment(item());
    saved = await current();
    assert.deepEqual(saved.identityAnchor.selected, [after], 'an explicit move is the only way to reset identity');
    assert.equal(saved.anchorHistory.at(-1)!.kind, 'move');
    await update(after + ' This suffix must remain outside the anchor.', 2);
    await app.panelAction(item(), { type: 'reply', body: 'Track the explicitly chosen new target', requestId: 'protect-moved' });
    saved = await current();
    assert.deepEqual(saved.anchor.selected, [after]);
    assert.deepEqual(saved.identityAnchor.selected, [after]);
    assert.equal(await store.head(), head); assert.equal(await store.git.text(['write-tree']), index);
    assert.equal(document.isDirty, true);
    console.log('GiTex anchor protection: exact logical prefixes, local and shared renewal, inline replies/edits, panel saves, fixed identity, and explicit moves passed.');
  } finally {
    for (const panel of app.panels.values()) { panel.dispose(); }
    await config.update('autoSyncOnSave', previous, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}
