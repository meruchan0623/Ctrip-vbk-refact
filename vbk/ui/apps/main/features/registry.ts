/**
 * Single registration point of main-window features (plan I-23 / I-30 access
 * rule 1). A sub-item adds ONE import and ONE array element here; I-23 owns
 * this file and merges those lines. `main.ts` only calls
 * `createMainFeatureRuntime`.
 */

import { createFeatureRuntime, type FeatureRuntime, type RuntimeHost } from './runtime.ts';
import type { FeatureModule } from './context.ts';
import { createTypingIndicator } from './typing-indicator.ts';
import { createRecall } from './recall.ts';
import { createVoicePlayerModule } from './voice-player.ts';
import { createQueueBanner } from './queue-banner.ts';

export const FEATURES: readonly FeatureModule[] = [createTypingIndicator(), createRecall(), createVoicePlayerModule(), createQueueBanner()];

export function createMainFeatureRuntime(host: RuntimeHost): FeatureRuntime {
  return createFeatureRuntime(FEATURES, host);
}
