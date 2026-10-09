import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { chromium } from 'playwright-core';
import { ReviewStore } from '../../src/store';

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function inlineSyncTests(app: any, store: ReviewStore): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitex', vscode.workspace.workspaceFolders![0].uri);
  const previous = config.inspect<boolean>('autoSyncOnSave')?.workspaceFolderValue;
  await config.update('autoSyncOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder);
  const review = (await store.threads())[0];
  const key = `${store.root}:${review.id}`;
  const repository = app.repositories.get(store.root);
  const realSync = repository.store.sync.bind(repository.store);
  const peer = new ReviewStore(path.join(path.dirname(store.root), 'peer'));
  await peer.pull();
  await peer.reply(review.id, 'Remote reply received by inline Sync'); await peer.sync();
  await store.reply(review.id, 'Local reply published by inline Sync');
  await app.refresh();
  await app.open(app.getChildren().find((item: any) => item.key === key));
  const source = vscode.window.activeTextEditor!.document;
  const before = { head: await store.head(), index: await store.git.text(['write-tree']), text: source.getText() };
  for (const [threadKey, thread] of app.nativeThreads as Map<string, vscode.CommentThread>) {
    thread.collapsibleState = threadKey === key ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.GITEX_CDP_PORT}`);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  repository.store.sync = async (remote: string) => { started++; await barrier; return realSync(remote); };
  try {
    const page = browser.contexts()[0].pages().find(page => page.url().startsWith('vscode-file:'))!;
    assert.ok(page, 'VS Code workbench must be available');
    const widget = page.locator('.review-widget').filter({ hasText: 'Local reply published by inline Sync' });
    await widget.waitFor({ state: 'visible' });
    const form = widget.locator('.comment-form');
    const expand = form.locator('.review-thread-reply-button');
    if (await expand.isVisible()) { await expand.click(); }
    const sync = form.getByRole('button', { name: 'Sync', exact: true });
    const reply = form.getByRole('button', { name: 'Reply', exact: true });
    await sync.waitFor({ state: 'visible' });
    const replyBounds = await reply.boundingBox(); const syncBounds = await sync.boundingBox();
    assert.ok(replyBounds && syncBounds && Math.abs(syncBounds.y - replyBounds.y) < 3 &&
      Math.min(Math.abs(syncBounds.x + syncBounds.width - replyBounds.x), Math.abs(replyBounds.x + replyBounds.width - syncBounds.x)) < 10,
      `Sync must appear beside Reply: ${JSON.stringify({ replyBounds, syncBounds })}`);
    const input = form.locator('textarea.inputarea');
    await input.pressSequentially('An unsent inline reply');
    await until(() => sync.isDisabled(), 'Sync disabled for an unsent reply');
    assert.equal(started, 0);
    await input.press('Control+A'); await input.press('Backspace');
    await until(() => sync.isEnabled(), 'Sync available for an empty reply');
    await sync.click();
    await until(async () => started === 1, 'manual inline sync with automatic sync disabled');
    await until(async () => !(await form.getAttribute('class'))!.split(' ').includes('expand'), 'empty form reset before network completes');
    await expand.click();
    const draft = 'Draft typed while synchronization is pending';
    await input.pressSequentially(draft);
    const hasDraft = () => vscode.workspace.textDocuments.some(document => document.uri.scheme !== 'file' && document.getText() === draft);
    await until(async () => hasDraft(), 'pending inline reply document');
    release();
    await until(async () => (await store.threads())[0].comments.some(comment => comment.body === 'Remote reply received by inline Sync'), 'inline sync receives remote comments');
    await until(async () => (await peer.pull())[0].comments.some(comment => comment.body === 'Local reply published by inline Sync'), 'inline sync publishes saved comments');
    await until(async () => (await widget.textContent())!.replace(/\s/g, ' ').includes('Remote reply received by inline Sync'), 'updated native widget');
    assert.equal(started, 1);
    assert.ok(hasDraft(), 'typing during network sync must not be cleared when it finishes');
    assert.ok(!(await store.threads())[0].comments.some(comment => comment.body === draft || comment.body === 'An unsent inline reply'));
    assert.deepEqual({ head: await store.head(), index: await store.git.text(['write-tree']), text: source.getText() }, before);
    await input.press('Control+A'); await input.press('Backspace');
    console.log('GiTex inline Sync: button placement, pull + push, disabled auto sync, unsent drafts and paper preservation passed.');
  } finally {
    release(); repository.store.sync = realSync;
    await config.update('autoSyncOnSave', previous, vscode.ConfigurationTarget.WorkspaceFolder);
    await browser.close();
  }
}
