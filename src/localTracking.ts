import { Anchor, createAnchor, documentHash, locateAnchor, Location } from './anchor';
import { validAnchor } from './model';

export interface LocalReference { basedOn: string; anchor: Anchor; updatedAt: string }
export interface LocalTrackingState { version: 1; entries: [string, LocalReference][] }
const revisionId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Disposable local hints. Shared events are never modified by source editing. */
export class LocalTracking {
  private readonly live = new Map<string, LocalReference>();
  private readonly saved = new Map<string, LocalReference>();
  generation = 0;

  constructor(state?: unknown) {
    const data = state as Partial<LocalTrackingState> | undefined;
    if (data?.version !== 1 || !Array.isArray(data.entries)) { return; }
    for (const entry of data.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') { continue; }
      const value = entry[1];
      if (!value || !revisionId.test(value.basedOn) || !validAnchor(value.anchor) ||
          typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) { continue; }
      this.live.set(entry[0], value); this.saved.set(entry[0], value);
    }
  }

  get(key: string, basedOn: string): LocalReference | undefined {
    const value = this.live.get(key);
    return value?.basedOn === basedOn ? value : undefined;
  }

  snapshot(): LocalTrackingState { return { version: 1, entries: [...this.saved] }; }

  locate(key: string, anchor: Anchor, basedOn: string, text: string, persist = true): Location {
    let local = this.live.get(key);
    if (local && (local.basedOn !== basedOn || local.anchor.path !== anchor.path)) {
      this.live.delete(key); local = undefined;
      if (this.saved.delete(key)) { this.generation++; }
    }
    const shared = locateAnchor(anchor, text);
    // An exact return to the shared snapshot (including undo/discard) supersedes local hints.
    let location = shared;
    if (local && documentHash(text) !== anchor.documentHash) {
      const recent = locateAnchor(local.anchor, text);
      if (shared.kind === 'attached' && recent.kind === 'attached' &&
          (shared.endLine < recent.startLine || recent.endLine < shared.startLine) ||
          shared.kind === 'uncertain' && recent.kind === 'uncertain' && shared.estimatedLine !== recent.estimatedLine) {
        location = { kind: 'outdated', reason: 'Shared and local references point to different passages. Review the saved references and reconnect manually.' };
      } else if (shared.kind !== 'attached' && recent.kind !== 'outdated' &&
          (recent.kind === 'attached' || shared.kind === 'outdated')) {
        location = { ...recent, source: 'local' };
      }
    }
    // Never turn an estimate or a conflict into the reference for the next edit.
    if (location.kind === 'attached') {
      const next = createAnchor(anchor.path, text, location.startLine, location.endLine, anchor.baseCommit);
      if (!local || JSON.stringify(local.anchor) !== JSON.stringify(next)) {
        local = { basedOn, anchor: next, updatedAt: new Date().toISOString() };
        this.live.set(key, local);
      }
    }
    // Save the last reliable hint when the source is saved, even if it has since
    // become uncertain. Unsaved editing alone never replaces the persisted hint.
    if (persist && local && this.saved.get(key) !== local) { this.saved.set(key, local); this.generation++; }
    return location;
  }
}
