import { createContextMenu } from '../../packages/ui-kit/src/context-menu.ts';
export type { ContextMenuAction as MessageMenuAction } from '../../packages/ui-kit/src/context-menu.ts';
export function createMessageContextMenu() { return createContextMenu('msg-context-menu', '消息操作'); }
