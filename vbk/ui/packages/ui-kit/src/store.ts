/**
 * Tiny observable store. State is treated as immutable: `set`/`update`
 * replace the whole value and notify subscribers synchronously with
 * `(next, prev)`. Subscribers added during notification run on the next
 * change only.
 */

export type Listener<S> = (state: S, prev: S) => void;

export interface Store<S> {
  get(): S;
  set(next: S): void;
  update(fn: (state: S) => S): void;
  /** Shallow-merge helper for object states. */
  patch(partial: Partial<S>): void;
  subscribe(listener: Listener<S>): () => void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<Listener<S>>();
  let notifying = false;
  const pending: Array<[S, S]> = [];

  function notify(next: S, prev: S): void {
    pending.push([next, prev]);
    if (notifying) return;
    notifying = true;
    try {
      while (pending.length > 0) {
        const item = pending.shift();
        if (!item) break;
        for (const l of Array.from(listeners)) l(item[0], item[1]);
      }
    } finally {
      notifying = false;
    }
  }

  return {
    get: () => state,
    set(next) {
      if (Object.is(next, state)) return;
      const prev = state;
      state = next;
      notify(next, prev);
    },
    update(fn) {
      this.set(fn(state));
    },
    patch(partial) {
      this.set({ ...state, ...partial });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Coalesces many synchronous changes into one callback per microtask. */
export function subscribeBatched<S>(store: Store<S>, fn: (state: S) => void): () => void {
  let scheduled = false;
  return store.subscribe(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      fn(store.get());
    });
  });
}
