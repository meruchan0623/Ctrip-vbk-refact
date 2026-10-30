/**
 * Endpoint specs used by this package (docs/api/README.md table). Paths are
 * verbatim, including case and `.json` suffixes: `getConversationList` and
 * `getConversationList.json` are different endpoints and are polled
 * separately by the two official entries.
 */

import { endpoint } from './soa.ts';

export const M = 'm.ctrip.com';
export const SEC_M = 'sec-m.ctrip.com';
export const ONLINE = 'online.ctrip.com';

export const Endpoints = {
  // conversation list (two variants)
  CONVERSATION_LIST: endpoint('getConversationList', M, '16037/getConversationList', 'read'),
  CONVERSATION_LIST_JSON: endpoint('getConversationList.json', M, '16037/getConversationList.json', 'read'),
  CONVERSATION_INFO_BY_GID_LIST: endpoint('getConversationInfoByGidList', M, '16037/getConversationInfoByGidList', 'read'),
  SEARCH_CONVERSATION: endpoint('searchConversation', M, '16037/searchConversation', 'read'),
  // messages
  RECENT_MESSAGES: endpoint('getRecentMessages', M, '11679/getRecentMessages', 'read'),
  MESSAGE_LIST: endpoint('getMessageList', M, '16037/getMessageList', 'read'),
  BATCH_TRANSLATE: endpoint('batchTranslateByMsgIds', M, '11679/batchTranslateByMsgIds', 'read'),
  // identity / members
  MY_INFO: endpoint('GetMyInfo.json', M, '11679/GetMyInfo.json', 'read'),
  CHECK_MEMBER_STATUS: endpoint('checkMemberStatus', M, '13500/checkMemberStatus', 'read'),
  CURRENT_USER_INFO: endpoint('getCurrentUserInfo', ONLINE, '12405/getCurrentUserInfo', 'read'),
  LOGIN_ADVISOR_OPEN_INFO: endpoint('getLoginAdvisorOpenInfo', M, '11419/getLoginAdvisorOpenInfo', 'read'),
  // writes
  SET_WORKSHEET_STAR: endpoint('setWorkSheetStar', M, '16037/setWorkSheetStar', 'write'),
  SEND_CARD_MESSAGE: endpoint('sendCardMessageForOffline', ONLINE, '15529/sendCardMessageForOffline', 'write'),
  UPLOAD_TOKEN_CREATE: endpoint('uploadTokenCreate', M, '16037/uploadTokenCreate', 'write'),
  SYNC_VEN_AGENT_INFO: endpoint('syncVenAgentInfo', M, '16037/syncVenAgentInfo', 'write'),
  FINISH_CONVERSATION: endpoint('finishConversation', M, '16037/finishConversation', 'write'),
  START_CHAT_B2C: endpoint('startChatB2C', M, '16037/startChatB2C', 'may_create_conversation'),
  // orders
  SEARCH_ORDER_LIST: endpoint('searchorderlist', SEC_M, '14361/searchorderlist', 'read'),
  CREATE_IM_CHAT: endpoint('createimchat', SEC_M, '14361/createimchat', 'may_create_conversation'),
  // settings
  LIST_NOTICE_RECEIVE_CONFIG: endpoint('listNoticeReceiveConfig', ONLINE, '17092/listNoticeReceiveConfig', 'read'),
  AGENT_WORKING_SCHEDULE: endpoint('getAgentWorkingSchedule', M, '16037/getAgentWorkingSchedule', 'read'),
  VEN_AGENT_BY_UID: endpoint('getVenAgentByUid', M, '16037/getVenAgentByUid', 'read'),
  CUSTOMER_SCRIPTS: endpoint('getCustomerScripts', M, '16037/getCustomerScripts', 'read'),
  // agent work status (static call chain: {head, agentStatus}; read back via getConversationList.currentStatus)
  SET_VEN_AGENT_STATUS: endpoint('setVenAgentStatus', M, '16037/setVenAgentStatus', 'write'),
  // notice centre (IQ); getIQConversations has a live sample, the other two are static call sites only
  IQ_CONVERSATIONS: endpoint('getIQConversations', M, '11679/getIQConversations', 'read'),
  IQ_MESSAGES: endpoint('getIQMessages', M, '11679/getIQMessages', 'read'),
  PUT_ADVICE_READ_IQ: endpoint('putAdviceofreadIQMessage', M, '11679/putAdviceofreadIQMessage', 'write'),
  // chat read receipt over HTTP exactly as the SDK sends it (evidence 71)
  PUT_ADVICE_READ_BY_MSG_ID: endpoint('PutAdviceOfReadByMsgId.json', M, '11679/PutAdviceOfReadByMsgId.json', 'write'),
} as const;
