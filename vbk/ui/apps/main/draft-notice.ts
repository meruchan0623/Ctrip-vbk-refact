import { ErrorCodes } from '../../packages/ipc/src/contracts.ts';

export type DraftRetryAction = () => Promise<void>;

export interface DraftFailureNoticeOptions {
  /** Render a fixed, non-sensitive notice and its retry action. */
  readonly notify: (retry: DraftRetryAction) => void;
  readonly retry: () => Promise<void> | void;
  readonly now?: () => number;
  readonly intervalMs?: number;
}

/** The account is restoring or re-logging in: no write failed, so there is nothing to report. */
function isAccountTransition(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === ErrorCodes.ACCOUNT_NOT_ONLINE || code === ErrorCodes.ACCOUNT_STALE_GENERATION;
}

/** Coalesce repeated storage failures without ever passing the underlying error to the UI. */
export function createDraftFailureNotice(options: DraftFailureNoticeOptions) {
  const now = options.now ?? Date.now;
  const intervalMs = Math.max(0, options.intervalMs ?? 5000);
  let lastNoticeAt = Number.NEGATIVE_INFINITY;
  let retrying = false;

  const retry: DraftRetryAction = () => {
    if (retrying) return Promise.resolve();
    retrying = true;
    return Promise.resolve()
      .then(() => options.retry())
      .catch(error => { onError(error); })
      .finally(() => { retrying = false; });
  };

  function onError(error: unknown): void {
    try {
      // The text stays dirty and is written once the account is online again.
      if (isAccountTransition(error)) return;
      const at = now();
      if (!retrying && at - lastNoticeAt < intervalMs) return;
      lastNoticeAt = at;
      // A view or timer failure must not escape through DraftBook's serialized write chain.
      try { options.notify(retry); } catch { /* Keep persistence independent of presentation. */ }
    } catch { /* The error callback itself must never poison the draft book. */ }
  }

  return { onError };
}
