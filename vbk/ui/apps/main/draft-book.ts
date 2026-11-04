/**
 * Drafts keyed by (account, conversation) (I-09 / D10). The agent's own unsent text
 * is remembered per persistent account identity (environment + account_id, not the
 * session generation) so an account switch, a re-login or a restart does not lose it.
 *
 * Persistence goes through a {@link DraftPort}. The host side is the `core-store`
 * draft repository (CAS by version); until the host exposes commands for it the book
 * runs with no port and keeps drafts for the renderer's lifetime only.
 */
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';

export interface DraftOwner { readonly environment: string; readonly account_id: string }
export type DraftMap = Readonly<Record<string, string>>;

export interface DraftPort {
  /** Every stored draft of one account, by conversation id. */
  load(owner: DraftOwner): Promise<DraftMap>;
  /** Replace one draft; empty text deletes it. */
  save(owner: DraftOwner, gid: string, text: string): Promise<void>;
}

export const draftOwnerOf = (account: DraftOwner): DraftOwner => ({ environment: account.environment, account_id: account.account_id });
export const draftOwnerKey = (account: DraftOwner): string => JSON.stringify([account.environment, account.account_id]);

export interface DraftBookOptions {
  readonly delayMs?: number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Persistence failures never block typing; they surface here and the draft stays dirty. */
  readonly onError?: (error: unknown) => void;
}

export function createDraftBook(port: DraftPort | null, options: DraftBookOptions = {}) {
  const delayMs = options.delayMs ?? 400;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  /** Latest known text per owner/gid (typed or loaded). */
  const cache = new Map<string, Map<string, string>>();
  /** Writes not yet acknowledged by the port. */
  const dirty = new Map<string, Map<string, string>>();
  const owners = new Map<string, DraftOwner>();
  const loaded = new Map<string, Promise<void>>();
  /** Owners whose stored state is fully known (load answered, or there is no port to ask). */
  const ready = new Set<string>();
  /** Conversations this session has written: the session copy is authoritative over stored text. */
  const written = new Map<string, Set<string>>();
  let timer: unknown = null;
  let chain: Promise<void> = Promise.resolve();

  const bucket = (map: Map<string, Map<string, string>>, key: string): Map<string, string> => {
    let found = map.get(key);
    if (!found) { found = new Map(); map.set(key, found); }
    return found;
  };

  function drain(): Promise<void> {
    if (!port) return Promise.resolve();
    chain = chain.then(async () => {
      for (const [key, entries] of [...dirty]) {
        const owner = owners.get(key)!;
        for (const [gid, text] of [...entries]) {
          try {
            await port.save(owner, gid, text);
            // A newer keystroke during the await keeps the entry dirty.
            if (entries.get(gid) === text) entries.delete(gid);
          } catch (error) { options.onError?.(error); }
        }
        if (entries.size === 0) dirty.delete(key);
      }
    });
    return chain;
  }

  function schedule(): void {
    if (!port || timer !== null) return;
    timer = setTimer(() => { timer = null; void drain(); }, delayMs);
  }

  return {
    /** Remember a draft. Empty text is a deliberate clear and is persisted as such. */
    write(account: DraftOwner, gid: string, text: string): void {
      const key = draftOwnerKey(account);
      owners.set(key, draftOwnerOf(account));
      let mine = written.get(key);
      if (!mine) { mine = new Set(); written.set(key, mine); }
      mine.add(gid);
      const before = cache.get(key)?.get(gid) ?? '';
      if (text === '') bucket(cache, key).delete(gid); else bucket(cache, key).set(gid, text);
      // Re-announcing a value the store already holds (e.g. a restored draft) is not a new write.
      if (!port || (ready.has(key) && before === text)) return;
      bucket(dirty, key).set(gid, text);
      schedule();
    },
    /** Drafts known for an account right now (no I/O). */
    read(account: DraftOwner): DraftMap { return Object.fromEntries(cache.get(draftOwnerKey(account)) ?? []); },
    /**
     * Load the account's stored drafts once and merge them under anything typed since:
     * text the user wrote (or cleared) before the load finished always wins.
     */
    async restore(account: DraftOwner): Promise<DraftMap> {
      const key = draftOwnerKey(account);
      owners.set(key, draftOwnerOf(account));
      if (port && !loaded.has(key)) {
        loaded.set(key, port.load(draftOwnerOf(account)).then(stored => {
          const mine = bucket(cache, key);
          ready.add(key);
          const overridden = written.get(key);
          for (const [gid, text] of Object.entries(stored)) if (!overridden?.has(gid) && text !== '') mine.set(gid, text);
        }, error => { options.onError?.(error); loaded.delete(key); }));
      }
      await loaded.get(key);
      return Object.fromEntries(cache.get(key) ?? []);
    },
    /** Write everything now (window hide / quit). Resolves when the port has answered. */
    async flush(): Promise<void> {
      if (timer !== null) { clearTimer(timer); timer = null; }
      await drain();
    },
    get pending(): number { let n = 0; for (const entries of dirty.values()) n += entries.size; return n; },
  };
}

export type DraftBook = ReturnType<typeof createDraftBook>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDraftVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Host adapter: the command names are supplied by the contract once the host registers them. */
export function createIpcDraftPort(
  invoke: (command: string, payload: unknown) => Promise<unknown>,
  commands: { readonly load: string; readonly save: string },
  context: (owner: DraftOwner) => AccountContext | null,
): DraftPort {
  const versions = new Map<string, number>();
  const versionKey = (owner: DraftOwner, gid: string): string => JSON.stringify([owner.environment, owner.account_id, gid]);
  return {
    async load(owner) {
      const account = context(owner);
      if (!account) throw new Error('draft.account_unavailable');
      const reply = await invoke(commands.load, { account });
      if (!isRecord(reply) || !Object.hasOwn(reply, 'drafts') || !Array.isArray(reply.drafts)) {
        throw new Error('draft.invalid_load_response');
      }
      const drafts = new Map<string, string>();
      const loadedVersions = new Map<string, number>();
      for (const row of reply.drafts) {
        if (!isRecord(row)
          || !Object.hasOwn(row, 'gid') || typeof row.gid !== 'string'
          || !Object.hasOwn(row, 'text') || typeof row.text !== 'string'
          || !Object.hasOwn(row, 'version') || !isDraftVersion(row.version)
          || drafts.has(row.gid)) {
          throw new Error('draft.invalid_load_response');
        }
        drafts.set(row.gid, row.text);
        loadedVersions.set(row.gid, row.version);
      }

      // Commit the new version snapshot only after every row passed validation.
      const ownerPrefix = `${JSON.stringify([owner.environment, owner.account_id]).slice(0, -1)},`;
      for (const key of versions.keys()) if (key.startsWith(ownerPrefix)) versions.delete(key);
      for (const [gid, version] of loadedVersions) versions.set(versionKey(owner, gid), version);
      return Object.fromEntries(drafts);
    },
    async save(owner, gid, text) {
      const account = context(owner);
      if (!account) throw new Error('draft.account_unavailable');
      const key = versionKey(owner, gid);
      const attempt = async (): Promise<void> => {
        const reply = await invoke(commands.save, { account, gid, text, expected_version: versions.get(key) ?? 0 });
        if (!isRecord(reply) || !Object.hasOwn(reply, 'version') || !isDraftVersion(reply.version)) {
          throw new Error('draft.invalid_save_response');
        }
        versions.set(key, reply.version);
      };
      try { await attempt(); } catch (error) {
        // Another window/process saved first: learn its version and write once more (last writer wins).
        if ((error as { code?: unknown } | null)?.code !== 'store.cas_conflict') throw error;
        await this.load(owner);
        await attempt();
      }
    },
  };
}
