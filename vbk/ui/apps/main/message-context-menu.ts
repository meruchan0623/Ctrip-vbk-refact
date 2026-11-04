import { createContextMenu } from '../../packages/ui-kit/src/context-menu.ts';
export type { ContextMenuAction as MessageMenuAction } from '../../packages/ui-kit/src/context-menu.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
export function createMessageContextMenu() { return createContextMenu('msg-context-menu', t('orderMisc.menu.messageActions')); }
