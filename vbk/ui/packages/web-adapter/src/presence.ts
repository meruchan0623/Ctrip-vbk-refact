import type { AgentStatus } from '../../ipc/src/client.ts';
import type { AdapterDeps } from './deps.ts';

export const AGENT_STATUS_TTL_MS = 15_000;
export interface StatusRead {
  commit(status: AgentStatus): boolean;
  fail(): void;
}

/** Server work status, independent of socket connectivity. Request tickets are
 * invalidated by writes, lifecycle changes and newer observations. */
export function createPresence(deps: Pick<AdapterDeps, 'now' | 'setTimeout' | 'clearTimeout'>, publish: (status: AgentStatus, confirmed: boolean) => void) {
  let status: AgentStatus = 'getoff';
  let confirmed = false;
  let active = false;
  let writing = false;
  let revision = 0;
  let issued = 0;
  let accepted = 0;
  let expires = 0;
  let timer: unknown = null;
  const clear = () => { if (timer !== null) deps.clearTimeout(timer); timer = null; };
  const invalidate = () => {
    revision++;
    clear();
    confirmed = false;
    expires = 0;
    publish(status, false);
  };
  return {
    current() {
      if (confirmed && deps.now() >= expires) invalidate();
      return { status, confirmed };
    },
    invalidate,
    start() { active = true; writing = false; invalidate(); },
    stop() { active = false; writing = false; invalidate(); },
    beginWrite() {
      if (!active || writing) return false;
      writing = true;
      invalidate();
      return true;
    },
    endWrite() { writing = false; },
    captureRead(writeback = false): StatusRead {
      const version = revision, sequence = ++issued;
      const started = deps.now();
      const allowed = active && (!writing || writeback);
      const current = () => allowed && active && revision === version && sequence >= accepted;
      return {
        commit(next) {
          if (!current()) return false;
          const age = deps.now() - started;
          if (age < 0 || age >= AGENT_STATUS_TTL_MS) { invalidate(); return false; }
          accepted = sequence;
          status = next;
          confirmed = true;
          expires = started + AGENT_STATUS_TTL_MS;
          clear();
          timer = deps.setTimeout(invalidate, expires - deps.now());
          publish(status, true);
          return true;
        },
        fail() { if (current()) invalidate(); },
      };
    },
  };
}
