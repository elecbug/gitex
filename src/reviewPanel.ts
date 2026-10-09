import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { ReviewThread } from './model';
import { Location } from './anchor';

export interface ReviewContext {
  repository: string;
  location: Location;
  sync: 'automatic' | 'manual' | 'failed';
  status: string;
}

export type ReviewAction = { type: 'ready' | 'source' } |
  { type: 'edit'; commentId: string; body: string; basedOn: string; requestId: string } |
  { type: 'reply'; body: string; requestId: string } |
  { type: 'move'; requestId: string } |
  { type: 'resolve'; resolved: boolean; requestId: string };

/** Review editing and history with drafts preserved across updates. */
export class ReviewPanel implements vscode.Disposable {
  readonly panel: vscode.WebviewPanel;
  private readonly listeners: vscode.Disposable[] = [];
  private ready = false;
  private readonly drafts = new Map<string, { key: string; commentId: string; body: string; basedOn: string }>();

  constructor(extensionUri: vscode.Uri, public key: string, onAction: (key: string, action: ReviewAction) => Promise<void>, onClose: () => void) {
    this.panel = vscode.window.createWebviewPanel('gitex.review', 'GiTex Review', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] });
    const nonce = randomBytes(16).toString('hex');
    const script = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'review.js'));
    const style = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'review.css'));
    this.panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource}; script-src 'nonce-${nonce}';">
      <meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${style}"></head>
      <body><main class="review-shell">
      <header class="app-header"><span class="brand">GiTex<span class="brand-divider" aria-hidden="true">/</span><span class="brand-section">Review</span></span>
      <span id="thread-state" class="badge" hidden></span></header>
      <p id="error" class="error-banner" role="alert"></p>
      <div id="thread"><p class="loading" role="status">Loading review…</p></div>
      </main>
      <script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.listeners.push(this.panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!validAction(message)) { return; }
      try {
        if (message.type === 'ready') { this.ready = true; }
        await onAction(message.type === 'ready' ? this.key : (message as ReviewAction & { key: string }).key, message);
        this.sendDraft();
        if ('requestId' in message) { await this.panel.webview.postMessage({ type: 'saved', requestId: message.requestId }); }
      } catch (error) {
        await this.panel.webview.postMessage({ type: 'error', requestId: 'requestId' in message ? message.requestId : undefined,
          key: 'key' in message ? message.key : this.key, message: error instanceof Error ? error.message : String(error) });
      }
    }), this.panel.onDidDispose(() => { this.listeners.forEach(listener => listener.dispose()); onClose(); }));
  }

  update(review: ReviewThread, context: ReviewContext): void {
    void this.panel.webview.postMessage({ type: 'render', key: this.key, review, context });
    this.sendDraft();
  }

  preserveDraft(commentId: string, body: string, basedOn: string): void {
    this.drafts.set(`${this.key}:${commentId}`, { key: this.key, commentId, body, basedOn });
    this.sendDraft();
  }

  private sendDraft(): void {
    if (!this.ready) { return; }
    for (const [id, draft] of this.drafts) {
      if (draft.key !== this.key) { continue; }
      void this.panel.webview.postMessage({ type: 'draft', ...draft });
      this.drafts.delete(id);
    }
  }

  dispose(): void { this.panel.dispose(); }
}

function validAction(value: unknown): value is ReviewAction {
  if (!value || typeof value !== 'object') { return false; }
  const event = value as Record<string, unknown>;
  if (event.type === 'ready') { return true; }
  if (typeof event.key !== 'string') { return false; }
  if (event.type === 'source') { return true; }
  if (event.type === 'move') { return typeof event.requestId === 'string'; }
  if (event.type === 'resolve') { return typeof event.resolved === 'boolean' && typeof event.requestId === 'string'; }
  if (typeof event.body !== 'string' || !event.body.trim() || event.body.length > 100_000 || typeof event.requestId !== 'string') { return false; }
  return event.type === 'reply' || (event.type === 'edit' && typeof event.commentId === 'string' && typeof event.basedOn === 'string');
}
