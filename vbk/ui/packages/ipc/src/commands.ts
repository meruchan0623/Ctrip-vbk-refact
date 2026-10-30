/**
 * Command and event name mapping (archive §4.2): contract names use dots
 * (`notify.snapshot`), events are `<module>://<kebab-topic>`. Commands are
 * app-level Tauri commands named `<module>_<snake_action>` so that
 * `tauri_build` can autogenerate one `allow-<module>-<action>` permission per
 * command for the per-window capability files (`src-tauri/capabilities/`).
 * Windows never talk to each other directly; a window changes core state
 * through a command and the core emits to the target window.
 */

export const WindowLabels = {
  MAIN: 'main',
  ALARM: 'alarm',
  SETTING: 'setting',
  UPDATE: 'update',
  LOGIN: 'login',
} as const;

export type WindowLabel = (typeof WindowLabels)[keyof typeof WindowLabels];

/** Commands the `alarm` window is allowed to invoke (strong-alert §6). */
export const NotifyCommands = {
  SNAPSHOT: 'notify_snapshot',
  OPEN_CONVERSATION: 'notify_open_conversation',
  HIDE_ROUND: 'notify_hide_round',
  HIDE_ALL: 'notify_hide_all',
  SNOOZE: 'notify_snooze',
  SET_ENABLED: 'notify_set_enabled',
  SET_THRESHOLD: 'notify_set_threshold',
  SET_SOUND_ENABLED: 'notify_set_sound_enabled',
} as const;

/** Commands the `main` window uses for accounts and IM facts. */
export const AccountCommands = {
  SNAPSHOT: 'account_snapshot',
  START_LOGIN: 'account_start_login',
  SWITCH: 'account_switch',
  SUSPEND: 'account_suspend',
  LOGOUT: 'account_logout',
  FORGET: 'account_forget',
} as const;

export const ImCommands = {
  /** Web adapter → core: a bounded fact envelope. */
  PUSH_FACT: 'im_push_fact',
  CONVERSATION_SNAPSHOT: 'im_conversation_snapshot',
  /** Resolve a conversation for navigation (from alarm click). */
  LOCATE: 'im_locate_conversation',
} as const;

export const OrderCommands = {
  /** Validate an official `createimchat` URL before the host opens it. */
  VALIDATE_IM_URL: 'order_validate_im_url',
} as const;

export const PrefsCommands = {
  SNAPSHOT: 'prefs_snapshot',
} as const;

export const Events = {
  ACCOUNT_CHANGED: 'account://changed',
  ALARM_SNAPSHOT: 'notify://alarm-snapshot',
  IM_CONVERSATION_CHANGED: 'im://conversation-changed',
  IM_MESSAGE_NEW: 'im://message-new',
  NET_CLOCK: 'net://clock',
  PREFS_CHANGED: 'prefs://changed',
} as const;

export type EventName = (typeof Events)[keyof typeof Events];
