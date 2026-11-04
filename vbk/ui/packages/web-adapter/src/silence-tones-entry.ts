/**
 * Bundle entry (`ui/bundle/adapter/silence-tones.js`): the init script of the
 * built-in browser's tabs, which never get the adapter. `acct-*` webviews
 * install the same silencer from `boot.ts`.
 */

import { installToneSilencer, type ToneSilencerWindow } from './silence-tones.ts';

const pageWindow = (globalThis as { window?: unknown }).window;
if (typeof pageWindow === 'object' && pageWindow !== null) {
  installToneSilencer(pageWindow as ToneSilencerWindow);
}
