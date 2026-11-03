/**
 * Single registration point for adapter features (plan I-30 access rule 2;
 * owner I-23). A sub-item adds one import and one array element here.
 *
 * Lives in its own file (not `index.ts`) because `rpc.ts` needs the list to
 * answer the host's `typing.*` / `recall.*` / `queue.*` ops and `index.ts`
 * re-exports `rpc.ts`; importing `index.ts` from `rpc.ts` would be a cycle.
 * `index.ts` re-exports this function so the public surface is unchanged.
 *
 * Stateful features are built fresh per call so an account switch never
 * shares throttles or trackers.
 */

import type { AdapterFeature } from './features.ts';
import { createTypingFeature } from './typingState.ts';
import { recallFeature } from './recall.ts';
import { voiceFeature } from './voice.ts';
import { queueFeature } from './queueStatus.ts';

export function createAdapterFeatures(): readonly AdapterFeature[] {
  return [createTypingFeature(), recallFeature, voiceFeature, queueFeature];
}
