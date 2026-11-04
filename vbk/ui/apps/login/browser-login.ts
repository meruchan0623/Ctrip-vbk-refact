import { LOGIN_STRINGS as S } from './strings.ts';
import { AccountCommands } from '../../packages/ipc/src/commands.ts';
export interface BrowserChoice { id: string; label: string }
export interface BrowserLoginState { choices: BrowserChoice[]; selected: string; busy: boolean; message: string }
export function createBrowserLogin(options: {
  attempt: () => string | null;
  invoke: (command: string, payload: Record<string, unknown>) => Promise<unknown>;
  update: (state: BrowserLoginState) => void;
}) {
  let generation = 0;
  let verifying = false;
  let discovering: { ticket: number; foreground: boolean; promise: Promise<void> } | null = null;
  let state: BrowserLoginState = { choices: [], selected: '', busy: false, message: '' };
  const publish = (patch: Partial<BrowserLoginState>) => {
    const next = { ...state, ...patch };
    if (next.busy === state.busy && next.selected === state.selected && next.message === state.message && next.choices.length === state.choices.length && next.choices.every((choice, i) => choice.id === state.choices[i]?.id && choice.label === state.choices[i]?.label)) return;
    state = next; options.update(state);
  };
  async function connect(id = state.selected): Promise<void> {
    const attempt = options.attempt();
    if (state.busy || !attempt || !state.choices.some(p => p.id === id)) return;
    const ticket = ++generation;
    verifying = true;
    publish({ selected: id, busy: true, message: S.browserImporting });
    try {
      await options.invoke(AccountCommands.BROWSER_CONNECT, { attempt_id: attempt, profile_id: id });
      if (ticket === generation) publish({ busy: false, message: S.browserVerifying });
    } catch {
      verifying = false;
      if (ticket === generation) publish({ busy: false, message: S.browserUnavailable });
    }
  }
  async function discover(background = false): Promise<void> {
    if (discovering) {
      // A manual refresh adopts the background read without starting a second IPC.
      // Its caller awaits completion and receives foreground progress/error feedback.
      if (discovering.ticket !== generation || background) return;
      if (!background) {
        discovering.foreground = true;
        publish({ busy: true, message: S.browserDiscovering });
      }
      return discovering.promise;
    }
    if (state.busy || (background && verifying)) return;
    const flight = { ticket: ++generation, foreground: !background, promise: Promise.resolve() };
    discovering = flight;
    if (flight.foreground) publish({ busy: true, message: S.browserDiscovering });
    flight.promise = (async () => {
      try {
        const value = await options.invoke(AccountCommands.BROWSER_PROFILES, {});
        if (flight.ticket !== generation) return;
        if (!Array.isArray(value) || value.length > 64 || !value.every(p => p && typeof p.id === 'string' && typeof p.label === 'string')) throw new Error('invalid profiles');
        const choices = value as BrowserChoice[];
        publish({ choices, selected: choices.some(p => p.id === state.selected) ? state.selected : choices.length === 1 ? choices[0]!.id : '', busy: false, message: choices.length > 1 ? S.browserChooseLoggedIn : choices.length ? '' : S.browserAuthorize });
        // Even a single offer requires explicit selection in this window.
      } catch {
        if (flight.foreground && flight.ticket === generation) publish({ busy: false, message: S.browserNotReady });
      } finally { if (discovering === flight) discovering = null; }
    })();
    return flight.promise;
  }
  return { discover, connect, select(id: string) { if (!state.busy) publish({ selected: id }); }, cancel() { generation++; }, get state() { return state; } };
}

/** Manual mode stays manual; hidden windows resume discovery on visibilitychange. */
export function shouldDiscoverBrowsers(search: string, visibility: DocumentVisibilityState, closing: boolean): boolean {
  return new URLSearchParams(search).get('browser') !== 'manual' && visibility !== 'hidden' && !closing;
}
