/** Group-size and master pills: derived only from the member-interface cache, never from conversation rows. */
import type { UiConversation } from '../../packages/ipc/src/client.ts';
import type { PreloadedMembers } from './member-preload.ts';
import { conversationBusiness, isDone, sortConversations } from './viewmodel.ts';

export interface MemberPills {
  /** Members still in the group: the panel also lists status "2" leavers, which `present` excludes. Null while unknown, so no "0人" is ever guessed. */
  readonly count: number | null;
  readonly isMaster: boolean;
}

const NO_PILLS: MemberPills = { count: null, isMaster: false };

export function memberPills(finished: boolean, cached: Pick<PreloadedMembers, 'members' | 'self_is_master'> | null): MemberPills {
  if (finished || !cached) return NO_PILLS;
  const count = cached.members.filter(member => member.present !== false).length;
  return { count: count > 0 ? count : null, isMaster: cached.self_is_master === true };
}

/** Background-scan candidates: open conversations in list order, plus an open active one the list does not show. */
export function memberScanGids(conversations: readonly UiConversation[], activeGid: string | null): string[] {
  const open = conversations.filter(c => !isDone(c));
  const gids = sortConversations(open.filter(c => conversationBusiness(c) === 'customer')).map(c => c.gid);
  if (activeGid && !gids.includes(activeGid) && open.some(c => c.gid === activeGid)) gids.push(activeGid);
  return gids;
}
