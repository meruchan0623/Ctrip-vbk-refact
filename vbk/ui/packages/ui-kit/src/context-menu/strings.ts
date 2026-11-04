/** Context-menu copy (shared by every window's edit and message menus). */
// Not `as const`: the default `label` parameter must stay `string` for callers passing their own label.
export const CONTEXT_MENU_STRINGS: Record<'defaultLabel' | 'editLabel' | 'cut' | 'copy' | 'paste' | 'selectAll', string> = {
  defaultLabel: '操作菜单',
  editLabel: '编辑',
  cut: '剪切',
  copy: '复制',
  paste: '粘贴',
  selectAll: '全选',
};
