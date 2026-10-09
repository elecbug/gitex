import { Anchor, documentHash, EstimateCandidate, locateAnchor, Location, renewAnchor } from './anchor';
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

  locate(key: string, anchor: Anchor, basedOn: string, text: string, persist = true, identity = anchor): Location {
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
      const savedCandidate = this.candidate(shared, 'saved'), localCandidate = this.candidate(recent, 'local');
      if (savedCandidate && localCandidate &&
          ((savedCandidate.estimatedRange?.endLine ?? savedCandidate.estimatedLine) < (localCandidate.estimatedRange?.startLine ?? localCandidate.estimatedLine) ||
           (localCandidate.estimatedRange?.endLine ?? localCandidate.estimatedLine) < (savedCandidate.estimatedRange?.startLine ?? savedCandidate.estimatedLine))) {
        location = { ...localCandidate, kind: 'uncertain', candidates: [savedCandidate, localCandidate],
          reason: 'Saved and local references suggest different locations. Both candidates are shown; review them and reconnect manually to confirm the passage.' };
      } else if (shared.kind !== 'attached' && recent.kind !== 'outdated' &&
          (recent.kind === 'attached' || shared.kind === 'outdated' ||
           shared.kind === 'uncertain' && recent.kind === 'uncertain' && (recent.confidence > shared.confidence ||
             recent.confidence === shared.confidence && recent.estimatedLine !== shared.estimatedLine))) {
        location = { ...recent, source: 'local' };
      }
    }
    // Never turn a weak attachment, estimate or conflict into the next reference.
    const next = renewAnchor(local?.anchor ?? anchor, identity, text, location);
    if (next && (!local || JSON.stringify(local.anchor) !== JSON.stringify(next))) {
      local = { basedOn, anchor: next, updatedAt: new Date().toISOString() };
      this.live.set(key, local);
    }
    // Save the last reliable hint when the source is saved, even if it has since
    // become uncertain. Unsaved editing alone never replaces the persisted hint.
    if (persist && local && this.saved.get(key) !== local) { this.saved.set(key, local); this.generation++; }
    return location;
  }

  private candidate(location: Location, reference: 'saved' | 'local'): EstimateCandidate | undefined {
    if (location.kind === 'outdated') { return undefined; }
    return location.kind === 'uncertain' ? { ...location, reference } : {
      reference, estimatedLine: location.startLine, estimatedRange: { startLine: location.startLine, endLine: location.endLine },
      confidence: location.similarity ?? 1, reason: 'This reference matches text here, but the other reference points to another location.'
    };
  }
}
