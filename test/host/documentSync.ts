import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { createAnchor, documentHash } from '../../src/anchor';
import { enableEditTracking } from '../../src/editTracking';
import { ReviewStore } from '../../src/store';

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function documentSyncTests(app: any, store: ReviewStore): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitex', vscode.workspace.workspaceFolders![0].uri);
  const previous = config.inspect<boolean>('autoSyncOnSave')?.workspaceFolderValue;
  await config.update('autoSyncOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder);
  const file = 'sync-order.tex', filename = path.join(store.root, file);
  const baseline = 'Opening.\nOld result.\nClosing.\n';
  const draft = 'Opening.\nNew reviewed result.\nClosing.\n';
  const committed = '% Final introduction\n' + draft + '% Final notes\n';
  const peer = new ReviewStore(path.join(path.dirname(store.root), 'peer'));
  try {
    await writeFile(filename, baseline);
    await store.git.text(['add', file]);
    await store.git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Sync ordering baseline']);
    const oldHead = (await store.head())!;
    await store.git.text(['push', 'origin', 'main']);
    await peer.git.text(['pull', '--ff-only', 'origin', 'main']);
    const document = await vscode.workspace.openTextDocument(filename);
    let editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
    // Establish this buffer's clean baseline before metadata arrives.
    await app.refresh();
    const anchor = enableEditTracking(createAnchor(file, draft, 1, 1, await peer.head()), draft);
    const id = await peer.create(anchor, 'Published before the paper commit', draft);
    await peer.sync(); await store.pull(); await app.refresh();
    const key = `${store.root}:${id}`;
    const item = () => app.getChildren().find((entry: any) => entry.key === key);
    const hidden = () => {
      assert.equal(item().location.kind, 'pending');
      assert.equal(app.nativeThreads.has(key), false);
      assert.equal(app.highlightedRanges(document).filter((entry: any) => entry.item.key === key).length, 0);
    };
    hidden();
    await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '% My unsaved note\n'));
    const dirtyText = document.getText();
    await app.refresh();
    await writeFile(path.join(peer.root, file), committed);
    await peer.git.text(['add', file]);
    await peer.git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Finish and publish reviewed draft']);
    await peer.git.text(['push', 'origin', 'main']);
    const delayedAnchor = enableEditTracking(createAnchor(file, committed, 2, 2, await peer.head()), committed);
    const delayedId = await peer.create(delayedAnchor, 'The paper arrives before this review', committed);
    await store.git.text(['fetch', 'origin', 'main']); await app.refresh(); hidden();
    await store.git.text(['pull', '--ff-only', 'origin', 'main']);
    const futureHead = (await store.head())!;
    assert.equal(await readFile(filename, 'utf8'), committed);
    assert.equal(document.getText(), dirtyText, 'the editor still has the old unsaved paper after disk/HEAD changed');
    await app.refresh(); hidden();
    await app.panelAction(item(), { type: 'reply', body: 'Waiting while reconciling my paper', requestId: 'dirty-wait' });
    assert.deepEqual((await store.threads()).find(thread => thread.id === id)!.anchor, anchor, 'pending replies cannot publish a backwards reference');
    assert.equal(document.getText(), dirtyText, 'comment saving preserves the dirty editor');

    editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await until(() => document.getText() === committed && !document.isDirty, 'paper reconciliation');
    await app.refresh();
    assert.equal(item().location.kind, 'attached');
    assert.equal(document.getText(app.nativeThreads.get(key).range), 'New reviewed result.');
    assert.equal((await store.threads()).some(thread => thread.id === delayedId), false);
    await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '% Local edit on the received paper\n'));
    await peer.sync(); await store.pull(); await app.refresh();
    const delayedKey = `${store.root}:${delayedId}`;
    const delayed = app.getChildren().find((entry: any) => entry.key === delayedKey);
    assert.equal(delayed.location.kind, 'attached', 'paper-first reviews attach through already received history despite later local edits');
    assert.equal(document.getText(app.nativeThreads.get(delayedKey).range), 'New reviewed result.');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await until(() => document.getText() === committed && !document.isDirty, 'discard test-only local edit');
    await app.refresh();

    // Already-tracked comments must be checked again after going backwards.
    await store.git.text(['checkout', '--detach', oldHead]);
    await until(() => document.getText() === baseline, 'older checkout in editor');
    await app.refresh(); hidden();
    await store.git.text(['checkout', 'main']);
    await until(() => document.getText() === committed, 'return to current branch');
    await app.refresh();
    assert.equal(item().location.kind, 'attached');

    // A HEAD-only change must refresh a pending thread even without a text event.
    await store.git.text(['checkout', '--detach', oldHead]);
    await until(() => document.getText() === baseline, 'second older checkout');
    await app.refresh(); hidden();
    await writeFile(filename, committed);
    await until(() => document.getText() === committed, 'working copy ahead of its branch');
    await app.refresh(); hidden();
    const version = document.version;
    await store.git.text(['reset', '--soft', futureHead]);
    await until(() => item().location.kind === 'attached', 'HEAD watcher releases pending without a source edit');
    assert.equal(document.version, version);
    await store.git.text(['reset', '--mixed', futureHead]);
    await store.git.text(['checkout', 'main']);

    // A source edit during asynchronous preparation must not rewind the tracker
    // or publish an obsolete source snapshot with an otherwise fresh comment.
    const originalPrepare = app.prepareReview;
    let edited = false;
    app.prepareReview = async (...args: any[]) => {
      await originalPrepare.apply(app, args);
      if (!edited) {
        edited = true;
        await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '% Typed during save\n'));
      }
    };
    try {
      const reference = await app.currentAnchor(item());
      assert.ok(reference, 'a source edit during preparation must keep its attached reference');
      assert.equal(reference.text, document.getText());
      assert.equal(reference.anchor.documentHash, documentHash(document.getText()));
      assert.deepEqual(reference.anchor.selected, ['New reviewed result.']);
      assert.equal(app.editTracking.text(key), document.getText());
    } finally { app.prepareReview = originalPrepare; }
    await document.save(); await app.refresh();
    console.log('GiTex document sync: metadata-first, paper-first, augmented draft commit, fetch-only, dirty buffer, pending reply, branch rollback, HEAD-only refresh and concurrent source edits passed.');
  } finally { await config.update('autoSyncOnSave', previous, vscode.ConfigurationTarget.WorkspaceFolder); }
}
