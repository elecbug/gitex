import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { REMOTE_REF } from '../reviewStore';

export async function approveSnapshotSharing(app: any, repository: any, cancelFirst = false, action?: () => Thenable<unknown>): Promise<void> {
  // VS Code 1.90 refuses modal dialogs in extension-test mode. Inject only the
  // dialog response; exercise the real inspection, policy, sync, cancellation and push.
  const show = app.showSnapshotConfirmation;
  let allowed = !cancelFirst, prompts = 0;
  app.showSnapshotConfirmation = async (detail: string) => {
    prompts++; assert.match(detail, /complete document snapshots/);
    assert.match(detail, /remain in Git history/); assert.match(detail, /KiB before Git compression/);
    return allowed;
  };
  try {
    if (cancelFirst) {
      await assert.rejects(app.sync(repository), /cancelled/);
      assert.equal((await repository.store.git.run(['ls-remote', '--exit-code', '--heads', 'origin', REMOTE_REF])).code, 2);
      allowed = true;
    }
    await (action ? action() : app.sync(repository)); assert.equal(prompts, cancelFirst ? 2 : 1);
  } finally { app.showSnapshotConfirmation = show; }
}

export async function snapshotPrivacyTests(app: any, repository: any): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitex', repository.folder.uri);
  assert.equal(config.get('autoShareUncommittedSnapshots'), false);
  assert.match(app.syncErrors.get(repository.store.root), /first push/);
  assert.equal((await repository.store.git.run(['ls-remote', '--exit-code', '--heads', 'origin', REMOTE_REF])).code, 2);
  await approveSnapshotSharing(app, repository, true);
  const publication = { tip: 'a'.repeat(40), destinationKey: 'test-new-destination', bytes: 123, snapshots: [{ hash: 'b'.repeat(64), bytes: 123, committed: false }] };
  await assert.rejects(app.confirmPublication(repository, publication, true), /first push/);
  const destination = await repository.store.git.text(['remote', 'get-url', '--push', 'origin']);
  await assert.rejects(app.confirmPublication(repository, { ...publication, destinationKey: createHash('sha256').update(destination).digest('hex') }, true), /Uncommitted document snapshots/);
  // Explicit opt-in for subsequent scenarios that intentionally exercise automatic draft publication.
  await config.update('autoShareUncommittedSnapshots', true, vscode.ConfigurationTarget.WorkspaceFolder);
  console.log('GiTex snapshot privacy: first auto push held, disclosure content, cancellation without push, explicit approval and destination isolation passed.');
}
