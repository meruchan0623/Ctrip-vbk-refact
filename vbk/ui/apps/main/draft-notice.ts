export type DraftRetryAction = () => Promise<void>;

export interface DraftFailureNoticeOptions {
  /** Render a fixed, non-sensitive notice and its retry action. */
  readonly notify: (retry: DraftRetryAction) => void;
  readonly retry: () => Promise<void> | void;
  readonly now?: () => number;
  readonly intervalMs?: number;
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

  function onError(_error: unknown): void {
    try {
      const at = now();
      if (!retrying && at - lastNoticeAt < intervalMs) return;
      lastNoticeAt = at;
      // A view or timer failure must not escape through DraftBook's serialized write chain.
      try { options.notify(retry); } catch { /* Keep persistence independent of presentation. */ }
    } catch { /* The error callback itself must never poison the draft book. */ }
  }

  return { onError };
}
