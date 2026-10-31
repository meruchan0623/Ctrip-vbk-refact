export interface ComposerInputContext { readonly scope: string; readonly version: number }

/** Hold browser-owned IME preedit outside the store until composition is committed. */
export function createComposerInput(options: {
  context: () => ComposerInputContext | null;
  invalidateTranslation: () => void;
  commit: (value: string) => void;
  refresh: () => void;
}) {
  let session: { node: HTMLTextAreaElement; context: ComposerInputContext } | null = null;
  const revoked = new WeakSet<HTMLTextAreaElement>();
  const matches = (context: ComposerInputContext): boolean => {
    const now = options.context();
    return !!now && now.scope === context.scope && now.version === context.version;
  };
  const active = (): boolean => !!session && session.node.isConnected && matches(session.context);
  return {
    active,
    // State still advances while rendering waits. A changed owner/version renders immediately.
    deferRender: active,
    bind(scope: string | null) {
      const usable = (node: HTMLTextAreaElement): boolean => !!scope && node.isConnected && !revoked.has(node) && options.context()?.scope === scope;
      const nodeOf = (event: Event): HTMLTextAreaElement => event.currentTarget as HTMLTextAreaElement;
      return {
        oncompositionstart(event: Event): void {
          const node = nodeOf(event);
          if (!usable(node)) return;
          options.invalidateTranslation();
          const context = options.context();
          if (context && context.scope === scope) session = { node, context };
        },
        oninput(event: Event): void {
          const node = nodeOf(event);
          if (!usable(node) || (event as InputEvent).isComposing || session?.node === node) return;
          options.commit(node.value);
        },
        oncompositionend(event: Event): void {
          const node = nodeOf(event), ended = session;
          if (!ended || ended.node !== node) return;
          const valid = usable(node) && matches(ended.context);
          session = null;
          if (valid) options.commit(node.value);
          else revoked.add(node);
          options.refresh();
        },
        onblur(event: Event): void {
          const node = nodeOf(event);
          if (session?.node !== node) return;
          // If the platform did not deliver compositionend, don't publish unfinished preedit.
          session = null;
          revoked.add(node);
          options.refresh();
        },
      };
    },
  };
}
