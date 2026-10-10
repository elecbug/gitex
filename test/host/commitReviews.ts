import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { chromium, Frame } from 'playwright-core';
import { ReviewStore } from '../reviewStore';
import { createAnchor } from '../../src/anchor';
import { enableEditTracking } from '../../src/editTracking';
import { reviewAtCommit } from '../../src/model';

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await check()) { return; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function commitReviewTests(app: any, store: ReviewStore): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitex', vscode.workspace.workspaceFolders![0].uri);
  const save = config.inspect<boolean>('autoSyncOnSave')?.workspaceFolderValue;
  const commits = config.inspect<boolean>('autoSyncOnCommit')?.workspaceFolderValue;
  await config.update('autoSyncOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder);
  await config.update('autoSyncOnCommit', false, vscode.ConfigurationTarget.WorkspaceFolder);
  const peer = new ReviewStore(path.join(path.dirname(store.root), 'peer'));
  const file = path.join(store.root, 'commit-versions.tex');
  await writeFile(file, 'Opening.\nOriginal target.\nClosing.\n');
  await store.git.text(['add', 'commit-versions.tex']);
  await store.git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Commit version baseline']);
  await store.git.text(['push', 'origin', 'main']);
  await store.pull();
  const h1 = (await store.head())!;
  const document = await vscode.workspace.openTextDocument(file);
  let editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
  await app.refresh();
  editor.selection = new vscode.Selection(1, 0, 1, document.lineAt(1).text.length);
  await app.addComment('Review on version one');
  const id = (await store.threads()).find(thread => thread.anchor.path === 'commit-versions.tex')!.id;
  const key = `${store.root}:${id}`, item = () => app.getChildren().find((item: any) => item.key === key);
  await app.sync();
  await config.update('autoSyncOnCommit', true, vscode.ConfigurationTarget.WorkspaceFolder);
  await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'New preface.\n'));
  await document.save();
  await store.git.text(['add', 'commit-versions.tex']);
  await store.git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Record and auto-publish every review']);
  const h2 = (await store.head())!;
  // No app.refresh or explicit comment sync: the Git reference watcher is responsible.
  await until(async () => (await peer.pull()).find(thread => thread.id === id)?.paperHistory.some(record => record.paperCommit === h2) ?? false,
    'new commit automatically publishes versioned comments with autoSyncOnSave disabled');
  await until(() => item()?.paperCommit === h2 && item()?.location.startLine === 2, 'new paper version displayed');
  assert.equal(vscode.workspace.getConfiguration('gitex', vscode.workspace.workspaceFolders![0].uri).get('autoSyncOnSave'), false);
  const repo = app.repositories.get(store.root);
  assert.equal(app.syncErrors.get(store.root), undefined, 'comment sync does not require publishing the paper source');
  const records = await store.threads();
  const applicable = records.filter(thread => reviewAtCommit(thread, h1));
  assert.ok(applicable.length > 0);
  assert.ok(applicable.every(thread => thread.paperHistory.some(record => record.paperCommit === h2)), 'threads belonging to the parent version, including resolved threads, receive the new commit hash');
  assert.ok(records.filter(thread => !reviewAtCommit(thread, h1)).every(thread => !reviewAtCommit(thread, h2)), 'reviews from other paper versions remain pending');
  await config.update('autoSyncOnCommit', false, vscode.ConfigurationTarget.WorkspaceFolder);
  await app.panelAction(item(), { type: 'edit', commentId: id, basedOn: id, body: 'Review on version two', requestId: 'h2-edit' });
  await app.setResolved(item(), true);
  assert.equal(app.nativeThreads.has(key), false);
  await app.sync(repo);
  await app.reviewThread(item());
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.GITEX_CDP_PORT}`);
  try {
    let frame: Frame | undefined;
    await until(async () => {
      for (const page of browser.contexts()[0].pages()) {
        for (const candidate of page.frames()) {
          if (await candidate.locator('#paper-commit').count().catch(() => 0)) { frame = candidate; return true; }
        }
      }
      return false;
    }, 'commit review webview');
    await until(async () => (await frame!.locator('.body').first().textContent()) === 'Review on version two', 'second commit body');
    assert.match((await frame!.locator('#paper-commit').textContent())!, new RegExp(h2.slice(0, 12)));
    await frame!.locator('#reply').fill('Draft belonging to version two');
    await store.git.text(['checkout', '--detach', h1]);
    await until(() => document.getText().startsWith('Opening.'), 'earlier source checkout');
    await app.refresh();
    assert.equal(item().paperCommit, h1);
    assert.equal(item().review.comments[0].body, 'Review on version one');
    assert.equal(item().review.resolved, false);
    assert.ok(app.nativeThreads.has(key));
    assert.equal(document.getText(app.nativeThreads.get(key).range), 'Original target.');
    await until(async () => (await frame!.locator('.body').first().textContent()) === 'Review on version one', 'webview switches to earlier comment version');
    assert.equal(await frame!.locator('#reply').inputValue(), '', 'drafts stay with their document version');
    const native = app.nativeThreads.get(key).comments[0];
    await app.editComment(native);
    assert.equal(native.body, 'Review on version one', 'inline editing starts from the displayed version');
    await app.cancelEdit(native);
    await store.git.text(['checkout', 'main']);
    await until(() => document.getText().startsWith('New preface.'), 'return to latest source');
    await app.refresh();
    await until(async () => (await frame!.locator('#reply').inputValue()) === 'Draft belonging to version two', 'version-specific draft restored');
    assert.equal(item().review.resolved, true);
    assert.equal(reviewAtCommit((await store.threads()).find(thread => thread.id === id)!, h1)!.comments[0].body, 'Review on version one');
    await frame!.locator('#reply').fill('');
    const same = 'Repeated target.\nRepeated target.\n';
    const repeatedFile = path.join(store.root, 'checkpoint-cache.tex');
    await writeFile(repeatedFile, same); await store.git.text(['add', 'checkpoint-cache.tex']);
    await store.git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Repeated passage baseline']);
    const base = (await store.head())!;
    const repeatedId = await store.create(enableEditTracking(createAnchor('checkpoint-cache.tex', same, 0, 0, base), same), 'Follow the checkpoint geometry', same);
    const repeatedKey = `${store.root}:${repeatedId}`;
    const repeatedDoc = await vscode.workspace.openTextDocument(repeatedFile); await vscode.window.showTextDocument(repeatedDoc);
    await app.refresh(); assert.equal(app.nativeThreads.get(repeatedKey).range.start.line, 0);
    await store.git.text(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'New paper identity, same contents']);
    const next = (await store.head())!;
    const movedAnchor = enableEditTracking(createAnchor('checkpoint-cache.tex', same, 1, 1, next), same);
    await store.recordPaperCommit(next, new Map([[repeatedId, { basedOn: repeatedId, anchor: movedAnchor }]]));
    await app.refresh();
    assert.equal(app.nativeThreads.get(repeatedKey).range.start.line, 1, 'new checkpoint geometry invalidates an old local cache even with unchanged text and reference revision');
    const originalSource = 'Opening.\nOriginal target.\nClosing.\n';
    const olderAnchor = enableEditTracking(createAnchor('commit-versions.tex', originalSource, 1, 1, h1), originalSource);
    const lateId = await store.create(olderAnchor, 'Late review on the earlier paper', originalSource, h1);
    await store.reply(id, 'Late reply on version one', undefined, undefined, undefined, h1);
    const missingId = await store.create({ ...olderAnchor, path: 'late-uncommitted-file.tex' }, 'Late review of a file absent here', originalSource, h1);
    await app.refresh();
    const late = app.getChildren().find((candidate: any) => candidate.review.id === lateId);
    const absent = app.getChildren().find((candidate: any) => candidate.review.id === missingId);
    assert.equal(absent.notInherited, true, 'a missing file must not hide the late-review explanation');
    assert.match(app.getTreeItem(absent).description, /Not inherited/);
    assert.equal(late.notInherited, true); assert.equal(late.location.kind, 'pending');
    assert.equal(app.nativeThreads.has(late.key), false);
    assert.match(app.getTreeItem(late).description, /Not inherited/);
    assert.match(item().reviewNotice, new RegExp(h1.slice(0, 8)));
    assert.equal(item().review.comments.length, 1, 'late ancestor reply does not change the current discussion');
    await app.reviewThread(late);
    await until(async () => (await frame!.locator('#match-state').textContent()) === 'Not inherited', 'late-review badge');
    assert.match((await frame!.locator('.context-note').textContent())!, /Published inheritance is fixed/);
    assert.doesNotMatch((await frame!.locator('.context-note').textContent())!, /Use Git Pull/);
    console.log('GiTex late reviews: ancestor hashes, Not inherited badge, unchanged current discussion and no misleading pull instruction passed.');
    console.log('GiTex paper commit versions: watcher auto-push, all-thread records, independent paper versions, commit-scoped body/location/resolution, inline edits and webview drafts passed.');
  } finally {
    await browser.close();
    await config.update('autoSyncOnSave', save, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update('autoSyncOnCommit', commits, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}
