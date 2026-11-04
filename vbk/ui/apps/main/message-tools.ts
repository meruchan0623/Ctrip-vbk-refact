import type { AccountContext, SendDisposition } from '../../packages/ipc/src/contracts.ts';
import type { UiConversation, UiMessage } from '../../packages/ipc/src/client.ts';
import { h } from '../../packages/ui-kit/src/h.ts';
import { messageToolsText as t } from '../../packages/ui-kit/src/message-tools/strings.ts';

export interface SavedEmoji {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly thumbnail: string | null;
  readonly created_at_ms: number;
  readonly rank: number;
  readonly width?: number;
  readonly height?: number;
}
export interface MessageToolMenuAction {
  readonly id: string;
  readonly label: string;
  readonly run: () => void | Promise<void>;
}
export interface MessageToolOptions {
  current(account: AccountContext): boolean;
  conversations(): readonly UiConversation[];
  invoke<T>(command: string, payload: Record<string, unknown>): Promise<T>;
  toast(message: string): void;
  nextLocalId(): string;
  validTarget?(account: AccountContext, gid: string): boolean;
  menu?(x: number, y: number, actions: readonly MessageToolMenuAction[], container?: HTMLElement): void;
  preview?(account: AccountContext, id: string): void;
}

function sameAccount(a: AccountContext, b: AccountContext): boolean {
  return a.account_id === b.account_id && a.environment === b.environment && a.session_generation === b.session_generation;
}
function activeTarget(options: MessageToolOptions, account: AccountContext, gid: string): UiConversation | undefined {
  const conv = options.conversations().find(c => c.gid === gid && sameAccount(c.account, account));
  return options.current(account) && conv?.status === 'active' && (options.validTarget?.(account, gid) ?? true) ? conv : undefined;
}
function feedback(disposition: SendDisposition): string {
  if (disposition?.kind === 'confirmed') return t('messageTools.feedback.sent');
  if (disposition?.kind === 'rejected') return disposition.reason ? t('messageTools.feedback.rejectedReason', { reason: disposition.reason }) : t('messageTools.feedback.rejected');
  return t('messageTools.feedback.unknown');
}
function showDialog(dialog: HTMLDialogElement, target?: HTMLElement | null): void {
  document.body.append(dialog);
  dialog.showModal();
  (target ?? dialog.querySelector<HTMLElement>('button, input'))?.focus({ preventScroll: true });
}
function closeDialog(dialog: HTMLDialogElement | null, previous: HTMLElement | null): void {
  if (!dialog) return;
  if (dialog.open) dialog.close();
  dialog.remove();
  if (previous?.isConnected) previous.focus({ preventScroll: true });
}
function stopDialogEvents(dialog: HTMLDialogElement, close: () => void): void {
  dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); close(); });
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
}

/** A forward is an explicit operation per selected active destination. */
export function createForwardDialog(options: MessageToolOptions) {
  let dialog: HTMLDialogElement | null = null;
  let previousFocus: HTMLElement | null = null;
  let generation = 0;
  function close(): void {
    generation++;
    closeDialog(dialog, previousFocus); dialog = null; previousFocus = null;
  }
  function open(message: UiMessage, account: AccountContext): void {
    close();
    if (!message.message_id || !options.current(account)) return;
    const source = options.conversations().find(c => c.gid === message.gid && sameAccount(c.account, account));
    if (!source) return;
    const sourceRevision = source.assistant_context_revision;
    const sourceId = message.message_id;
    const ownGeneration = ++generation;
    let busy = false;
    let selected = new Set<string>();
    const results = new Map<string, string>();
    const attempted = new Set<string>();
    let query = '';
    const snapshot = options.conversations().filter(c => activeTarget(options, account, c.gid)).map(c => ({ gid: c.gid, title: c.title, revision: c.assistant_context_revision }));
    const sourceCurrent = () => generation === ownGeneration && options.current(account)
      && options.conversations().some(c => c.gid === message.gid && sameAccount(c.account, account) && c.assistant_context_revision === sourceRevision);
    const own = h('dialog', { class: 'message-tools-dialog message-tools-forward', 'aria-label': t('messageTools.forward.title') });
    dialog = own; previousFocus = document.activeElement as HTMLElement | null;
    const list = h('div', { class: 'message-tools-list', role: 'group', 'aria-label': t('messageTools.forward.list') });
    const status = h('div', { class: 'message-tools-status', role: 'status', 'aria-live': 'polite' });
    const sendButton = h('button', { class: 'btn pri message-tools-send', type: 'button', disabled: true, onclick: () => void send() }, t('messageTools.forward.send'));
    const search = h('input', { class: 'inp message-tools-search', type: 'search', placeholder: t('messageTools.forward.search'), 'aria-label': t('messageTools.forward.search'), oninput: (event: Event) => { query = (event.target as HTMLInputElement).value; renderList(); } });
    const cancel = h('button', { type: 'button', class: 'btn', onclick: close }, t('messageTools.forward.cancel'));
    const summary = message.kind === 'text' ? message.text : message.kind === 'image' ? t('messageTools.summary.image') : message.kind === 'video' ? t('messageTools.summary.video') : message.kind === 'voice' ? t('messageTools.summary.voice') : message.kind === 'file' ? t('messageTools.summary.file', { name: message.media_filename || message.text }) : t('messageTools.summary.card');
    own.append(
      h('header', { class: 'message-tools-header' }, h('h2', null, t('messageTools.forward.title')), h('button', { class: 'ibtn', type: 'button', 'aria-label': t('messageTools.forward.close'), onclick: close }, '×')),
      h('div', { class: 'message-tools-summary' }, summary), search, list, status,
      h('footer', { class: 'message-tools-footer' }, h('span', { class: 'message-tools-count' }), cancel, sendButton),
    );
    function renderList(): void {
      const match = query.trim().toLocaleLowerCase();
      const visible = snapshot.filter(c => !match || c.title.toLocaleLowerCase().includes(match));
      list.replaceChildren(...(visible.length ? visible.map(c => {
        const result = results.get(c.gid);
        const check = h('input', { type: 'checkbox', checked: selected.has(c.gid), disabled: busy || attempted.has(c.gid), 'aria-label': t('messageTools.forward.selectConversation', { title: c.title }), onchange: (e: Event) => {
          if ((e.target as HTMLInputElement).checked) selected.add(c.gid); else selected.delete(c.gid);
          update();
        } });
        return h('label', { class: 'message-tools-conversation', dataset: { gid: c.gid }, ondblclick: (event: MouseEvent) => {
          event.preventDefault();
          if (busy || attempted.has(c.gid)) return;
          selected = new Set([c.gid]); void send();
        } }, check,
          h('span', { class: 'message-tools-avatar', 'aria-hidden': 'true' }, (c.title.trim()[0] || t('messageTools.forward.avatarFallback')).toUpperCase()),
          h('span', { class: 'message-tools-conversation-name' }, c.title),
          result ? h('span', { class: 'message-tools-result' }, result) : null);
      }) : [h('p', { class: 'message-tools-empty' }, snapshot.length ? t('messageTools.forward.noMatch') : t('messageTools.forward.empty'))]));
      update();
    }
    function update(): void {
      const count = [...selected].filter(gid => !attempted.has(gid)).length;
      sendButton.disabled = busy || count === 0;
      sendButton.textContent = busy ? t('messageTools.forward.sending') : t('messageTools.forward.send');
      own.querySelector<HTMLElement>('.message-tools-count')!.textContent = count ? t('messageTools.forward.selectedCount', { count }) : '';
      search.disabled = busy;
    }
    async function send(): Promise<void> {
      if (busy || !sourceCurrent()) return;
      const targets = snapshot.filter(c => selected.has(c.gid) && !attempted.has(c.gid));
      if (!targets.length) return;
      busy = true; status.textContent = ''; renderList();
      for (const target of targets) {
        if (!sourceCurrent()) break;
        const live = activeTarget(options, account, target.gid);
        if (!live || live.assistant_context_revision !== target.revision) {
          attempted.add(target.gid); results.set(target.gid, t('messageTools.forward.revisionChanged')); renderList(); continue;
        }
        attempted.add(target.gid);
        results.set(target.gid, t('messageTools.forward.sending')); renderList();
        try {
          const disposition = await options.invoke<SendDisposition>('im_forward_message', {
            account, source_gid: message.gid, message_id: sourceId, gid: target.gid,
            local_id: options.nextLocalId(), ...(target.revision ? { target_context_revision: target.revision } : {}),
          });
          results.set(target.gid, feedback(disposition));
        } catch { results.set(target.gid, t('messageTools.feedback.unknown')); }
        if (!sourceCurrent()) break;
        renderList();
      }
      busy = false;
      if (!sourceCurrent()) return;
      const allSent = targets.every(c => results.get(c.gid) === t('messageTools.feedback.sent'));
      if (allSent) { close(); options.toast(t('messageTools.forward.done', { count: targets.length })); return; }
      status.textContent = t('messageTools.forward.partialUnconfirmed'); renderList();
    }
    stopDialogEvents(own, close); renderList(); showDialog(own, search);
  }
  return { open, close };
}

/** Locally saved images; host owns the records and validates all writes. */
export function createSavedEmojiPanel(options: MessageToolOptions) {
  let dialog: HTMLDialogElement | null = null;
  let previousFocus: HTMLElement | null = null;
  let generation = 0;
  function close(): void { generation++; closeDialog(dialog, previousFocus); dialog = null; previousFocus = null; }
  async function add(message: UiMessage, account: AccountContext): Promise<void> {
    if (message.kind !== 'image' || !message.message_id || !options.current(account)) return;
    try {
      await options.invoke<SavedEmoji[]>('im_add_saved_emoji', { account, gid: message.gid, message_id: message.message_id });
      if (options.current(account)) options.toast(t('messageTools.emoji.added'));
    } catch { if (options.current(account)) options.toast(t('messageTools.emoji.addFailed')); }
  }
  async function open(account: AccountContext, gid: string): Promise<void> {
    close();
    const target = activeTarget(options, account, gid);
    if (!target) return;
    const revision = target.assistant_context_revision;
    const ownGeneration = ++generation;
    const valid = () => generation === ownGeneration && !!activeTarget(options, account, gid) && activeTarget(options, account, gid)?.assistant_context_revision === revision;
    let busy = false;
    let items: SavedEmoji[] = [], query = '', deleteId: string | null = null, editId: string | null = null;
    let attempts = new Set<string>();
    const own = h('dialog', { class: 'message-tools-dialog saved-emoji-dialog', 'aria-label': t('messageTools.emoji.title') });
    dialog = own; previousFocus = document.activeElement as HTMLElement | null;
    const status = h('div', { class: 'message-tools-status', role: 'status', 'aria-live': 'polite' }, t('messageTools.emoji.loading'));
    const list = h('div', { class: 'saved-emoji-grid', 'aria-label': t('messageTools.emoji.listLabel') });
    const footer = h('footer', { class: 'saved-emoji-footer' });
    const search = h('input', { class: 'inp message-tools-search', type: 'search', placeholder: t('messageTools.emoji.search'), 'aria-label': t('messageTools.emoji.search'), oninput: (event: Event) => { query = (event.target as HTMLInputElement).value; render(); } });
    own.append(h('header', { class: 'message-tools-header' }, h('h2', null, t('messageTools.emoji.title')), h('button', { class: 'ibtn', type: 'button', 'aria-label': t('messageTools.emoji.close'), onclick: close }, '×')), search, list, status, footer);
    stopDialogEvents(own, close); showDialog(own, search);
    function currentItem(id: string): SavedEmoji | undefined { return items.find(item => item.id === id); }
    async function modify(id: string, action: 'rename' | 'front' | 'delete', name?: string): Promise<void> {
      if (busy || !valid() || !currentItem(id)) return;
      busy = true; status.textContent = t('messageTools.emoji.saving'); render();
      try {
        const result = await options.invoke<SavedEmoji[]>('im_update_saved_emoji', { account, id, action, ...(name === undefined ? {} : { name }) });
        if (!valid()) return;
        if (!Array.isArray(result)) throw new Error('invalid emoji list');
        items = result; deleteId = editId = null; status.textContent = action === 'delete' ? t('messageTools.emoji.deleted') : t('messageTools.emoji.saved');
      } catch { if (valid()) status.textContent = t('messageTools.emoji.saveFailed'); }
      finally { busy = false; if (valid()) render(); }
    }
    async function send(item: SavedEmoji): Promise<void> {
      if (busy || !valid() || !currentItem(item.id) || attempts.has(item.id)) return;
      busy = true; attempts.add(item.id); status.textContent = t('messageTools.emoji.sending'); render();
      try {
        const result = await options.invoke<SendDisposition>('im_send_saved_emoji', { account, gid, id: item.id, local_id: options.nextLocalId(), ...(revision ? { target_context_revision: revision } : {}) });
        if (!valid()) return;
        if (result?.kind === 'confirmed') { close(); options.toast(t('messageTools.emoji.sent')); return; }
        status.textContent = feedback(result);
      } catch { if (valid()) status.textContent = t('messageTools.feedback.unknown'); }
      finally { busy = false; if (valid()) render(); }
    }
    function menu(item: SavedEmoji, e: MouseEvent): void {
      if (busy || !valid() || !options.menu) return;
      e.preventDefault(); e.stopPropagation();
      options.menu(e.clientX, e.clientY, [
        { id: 'front', label: t('messageTools.emoji.menuFront'), run: () => modify(item.id, 'front') },
        { id: 'preview', label: t('messageTools.emoji.menuPreview'), run: () => { if (valid() && currentItem(item.id)) options.preview?.(account, item.id); } },
        { id: 'rename', label: t('messageTools.emoji.menuRename'), run: () => { if (valid() && currentItem(item.id)) { editId = item.id; deleteId = null; render(); own.querySelector<HTMLInputElement>('.saved-emoji-name')?.focus(); } } },
        { id: 'delete', label: t('messageTools.emoji.menuDelete'), run: () => { if (valid() && currentItem(item.id)) { deleteId = item.id; editId = null; render(); } } },
      ], own);
    }
    function render(): void {
      const filtered = items.filter(item => !query.trim() || item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
      list.replaceChildren(...(filtered.length ? filtered.map(item => h('button', {
        type: 'button', class: 'saved-emoji-item', title: t('messageTools.emoji.itemTitle', { name: item.name || t('messageTools.emoji.defaultName') }), disabled: busy || attempts.has(item.id),
        'aria-label': t('messageTools.emoji.itemLabel', { name: item.name || t('messageTools.emoji.unnamed') }), 'aria-haspopup': 'menu', dataset: { emojiId: item.id }, onclick: () => void send(item), oncontextmenu: (e: MouseEvent) => menu(item, e),
        onkeydown: (event: KeyboardEvent) => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
          event.preventDefault(); event.stopPropagation();
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          menu(item, new MouseEvent('contextmenu', { clientX: rect.left, clientY: rect.bottom, cancelable: true }));
        },
      }, h('img', { src: item.thumbnail || item.url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }), h('span', null, item.name || t('messageTools.emoji.unnamed')))) : [h('p', { class: 'message-tools-empty' }, query ? t('messageTools.emoji.noMatch') : t('messageTools.emoji.empty')) ]));
      footer.replaceChildren();
      const editing = editId && currentItem(editId);
      if (editing) {
        const input = h('input', { class: 'inp saved-emoji-name', value: editing.name, maxlength: 80, 'aria-label': t('messageTools.emoji.nameLabel') });
        const save = () => { const value = input.value.trim(); if (!value) { status.textContent = t('messageTools.emoji.nameRequired'); return; } void modify(editing.id, 'rename', value); };
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
        footer.append(input, h('button', { class: 'btn', type: 'button', disabled: busy, onclick: () => { editId = null; render(); } }, t('messageTools.forward.cancel')), h('button', { class: 'btn pri', type: 'button', disabled: busy, onclick: save }, t('messageTools.emoji.save')));
      } else if (deleteId && currentItem(deleteId)) {
        const selected = deleteId;
        footer.append(h('span', null, t('messageTools.emoji.deleteConfirm')), h('button', { class: 'btn', type: 'button', disabled: busy, onclick: () => { deleteId = null; render(); } }, t('messageTools.forward.cancel')), h('button', { class: 'btn dan', type: 'button', disabled: busy, onclick: () => void modify(selected, 'delete') }, t('messageTools.emoji.menuDelete')));
      } else footer.append(h('span', null, t('messageTools.emoji.hint')));
    }
    try {
      const result = await options.invoke<SavedEmoji[]>('im_saved_emojis', { account });
      if (!valid()) return;
      if (!Array.isArray(result)) throw new Error('invalid emoji list');
      items = result; status.textContent = '';
    } catch { if (valid()) status.textContent = t('messageTools.emoji.loadFailed'); }
    if (valid()) render();
  }
  return { open, close, add };
}
