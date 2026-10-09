import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { Frame } from 'playwright-core';

/** Verify the real webview in VS Code's themes and split-editor widths. */
export async function reviewAppearance(view: Frame): Promise<void> {
  const config = vscode.workspace.getConfiguration('workbench');
  const previous = config.inspect<string>('colorTheme')?.workspaceValue;
  const captures = process.env.GITEX_REVIEW_SCREENSHOT_DIR;
  const previousViewport = view.page().viewportSize();
  await view.page().setViewportSize({ width: 1440, height: 1100 });
  if (captures) { await mkdir(captures, { recursive: true }); }
  try {
    for (const [theme, kind, width, name] of [
      ['Default Dark Modern', 'vscode-dark', 0.5, 'dark'],
      ['Default Light Modern', 'vscode-light', 0.5, 'light'],
      ['Default High Contrast', 'vscode-high-contrast', 0.25, 'narrow-contrast']
    ] as const) {
      await config.update('colorTheme', theme, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{ size: 1 - width }, { size: width }] });
      await view.waitForFunction(`document.body.classList.contains('${kind}')`);
      await view.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await view.evaluate('window.scrollTo(0, 0)');
      assert.equal(await view.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true,
        `review must not scroll horizontally in ${theme}`);
      assert.equal(await view.locator('#source').isVisible(), true);
      assert.equal(await view.getByRole('checkbox', { name: 'Resolved', exact: true }).isVisible(), true);
      if (captures) {
        const bounds = await (await view.frameElement()).boundingBox();
        assert.ok(bounds);
        await view.page().screenshot({ path: path.join(captures, `review-${name}.png`), clip: bounds });
      }
    }
  } finally {
    await config.update('colorTheme', previous, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{ size: 0.5 }, { size: 0.5 }] });
    if (previousViewport) { await view.page().setViewportSize(previousViewport); }
  }
}
