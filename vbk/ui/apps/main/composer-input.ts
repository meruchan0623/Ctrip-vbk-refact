export interface ComposerInputContext { readonly scope: string; readonly version: number }

/**
 * Operator-facing text for the local media rejection codes of
 * docs/api/media-attachment-contract.md (v1). Every one means "nothing was
 * submitted"; the host prefixes `error` with the code (`media.too_large: ...`).
 * Returns null for any other text so callers keep their own wording.
 */
const MEDIA_LIMIT_NOTICE: Readonly<Record<string, string>> = {
  'media.empty': '附件是空的，未发送。',
  'media.too_large': '附件超过大小上限（图片 10 MB、文件 30 MB、视频 300 MB），未发送。',
  'media.video_too_long': '视频超过 3 分钟，未发送。',
  'media.video_duration_unknown': '无法读取视频时长，未发送。',
  'media.too_many_files': '一次最多发送 10 个文件，未发送。',
  'media.chunked_upload_unsupported': '该视频超过 30 MB，当前版本暂不支持大视频分片上传，未发送。',
  'media.unknown_kind': '不支持的附件类型，未发送。',
};
export function mediaLimitNotice(error: string | null | undefined): string | null {
  const match = typeof error === 'string' ? /^(media\.[a-z_]+)(?::|$)/.exec(error) : null;
  return match ? MEDIA_LIMIT_NOTICE[match[1]!] ?? null : null;
}

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
