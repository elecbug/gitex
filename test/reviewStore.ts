import { ReviewStore as Store } from '../src/store';
import { PublicationGuard } from '../src/snapshotPrivacy';
export { LOCAL_REF, REMOTE_REF } from '../src/store';

/** Explicit test-only publication policy. Production extension stores always supply the real guard. */
export class ReviewStore extends Store {
  override sync(remote = 'origin', paperCommit?: string, beforePush: PublicationGuard = async () => {}): ReturnType<Store['sync']> {
    return super.sync(remote, paperCommit, beforePush);
  }
}
