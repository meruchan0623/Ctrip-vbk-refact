//! Endpoint registry (plan NET-01, §3 "EndpointPolicy / AppError").
//!
//! Every one of the 72 `method + host + path` combinations in
//! `docs/api/README.md` is registered with its authentication template,
//! side-effect class, retry policy, response envelope and scope. Anything
//! not registered is refused; anything registered but out of scope is
//! refused by `assert_in_scope`. Writes and conversation-creating requests
//! are never retryable (`retryable` is a hint; it can never authorise a
//! resend of an unknown write).

use std::collections::HashMap;

use contracts::AppError;

use crate::soa::net_codes;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Method {
    Get,
    Post,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
        }
    }

    pub fn parse(s: &str) -> Option<Method> {
        if s.eq_ignore_ascii_case("GET") {
            Some(Method::Get)
        } else if s.eq_ignore_ascii_case("POST") {
            Some(Method::Post)
        } else {
            None
        }
    }
}

/// Which identity/authorisation template the request carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AuthKind {
    /// Browser cookie session of the account profile + web business `head`
    /// (`cver:"2"`, `appId:"900004"`, `protocal`, `VBK`).
    CookieSession,
    /// IM SDK request: cookie session + SDK `head` (`cver:"1.0.7"`,
    /// `protocol:"https:"`, lower-case `vbk`). Not interchangeable with the
    /// web business head.
    SdkHead,
    /// `Authorization: Nephele {rand}/{time}/{channel}/{base64("token:"+t)}`
    /// + `Content-MD5` with a token from `16037/uploadTokenCreate`.
    NepheleToken,
    /// No cookie / authorization observed.
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SideEffect {
    ReadOnly,
    Write,
    /// May create a conversation/worksheet on the server; a timeout is an
    /// unknown outcome that must be read back, never replayed.
    MayCreateConversation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RetryPolicy {
    /// Registered idempotent read: bounded retry on connect errors,
    /// timeouts and 502/503/504 only (archive §4.8).
    SafeRead,
    Never,
}

/// Response envelope the adapter must check (HTTP status alone is never
/// success).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ResponseKind {
    /// `ResponseStatus.Ack == "Success"` + endpoint fields.
    SoaAck,
    /// `SoaAck` and `bizResponseStatus.resultCode == "SUCCESS"`.
    SoaBizStatus,
    /// `SoaAck` and `response.errorCode == 0` (sec-m 14361 order service).
    SoaResponseErrorCode,
    /// Nephele `Code == 2000` with `Content.url/file_name`.
    NepheleCode,
    /// Authenticated HTML document (sidebar).
    Html,
    /// JSON without a known envelope; adapter validates its own fields.
    Raw,
}

/// Scope per the "范围" column of `docs/api/README.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EndpointScope {
    /// "网页消息/身份/联系入口及共享读取契约".
    Core,
    /// "头像设置只读旁证；用户已要求本轮不继续" — kept as evidence, not
    /// a product feature this round.
    SettingsReadback,
    /// The order → "IM 联系" entry (docs/dev/04): `searchorderlist` and
    /// `createimchat`. A refinement of the Core column text "联系入口".
    OrderContact,
    /// "页面自动辅助请求；不扩展为本项目功能".
    PageAuxiliaryNotInScope,
    /// "官方订单详情页内部读取旁证；不恢复完整订单管理".
    OrderDetailEvidenceNotInScope,
}

impl EndpointScope {
    pub fn is_in_scope(self) -> bool {
        matches!(self, EndpointScope::Core | EndpointScope::OrderContact)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointPolicy {
    /// Stable id for logs/config, e.g. `m:16037/getConversationList`.
    pub id: &'static str,
    pub method: Method,
    /// Exact host; https and default port only.
    pub host: &'static str,
    /// Exact path (no query).
    pub path: &'static str,
    pub auth: AuthKind,
    pub side_effect: SideEffect,
    pub retry: RetryPolicy,
    pub response_kind: ResponseKind,
    pub scope: EndpointScope,
}

impl EndpointPolicy {
    /// True only for registered read-only endpoints with `SafeRead`.
    pub fn retryable(&self) -> bool {
        self.side_effect == SideEffect::ReadOnly && self.retry == RetryPolicy::SafeRead
    }

    pub fn url(&self) -> String {
        format!("https://{}{}", self.host, self.path)
    }

    pub fn is_in_scope(&self) -> bool {
        self.scope.is_in_scope()
    }
}

const M: &str = "m.ctrip.com";
const ONLINE: &str = "online.ctrip.com";
const SECM: &str = "sec-m.ctrip.com";
const NEPHELE: &str = "nephele.ctrip.com";
const VBOOKING: &str = "vbooking.ctrip.com";

use AuthKind::{CookieSession as Cookie, NepheleToken, SdkHead};
use EndpointScope::{
    Core, OrderContact, OrderDetailEvidenceNotInScope as OrderEvidence,
    PageAuxiliaryNotInScope as PageAux, SettingsReadback,
};
use ResponseKind::{Html, NepheleCode, Raw, SoaAck, SoaBizStatus, SoaResponseErrorCode as SoaErr};
use SideEffect::{MayCreateConversation as MayCreate, ReadOnly, Write};

type Row = (
    &'static str,
    Method,
    &'static str,
    &'static str,
    AuthKind,
    SideEffect,
    ResponseKind,
    EndpointScope,
);

/// The 72 observed combinations (docs/api/README.md, 2026-10-30).
const TABLE: &[Row] = &[
    // --- m.ctrip.com --------------------------------------------------
    (
        "m:11419/getLoginAdvisorOpenInfo",
        Method::Post,
        M,
        "/restapi/soa2/11419/getLoginAdvisorOpenInfo",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:11679/GetMyInfo.json",
        Method::Post,
        M,
        "/restapi/soa2/11679/GetMyInfo.json",
        SdkHead,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:11679/PutAdviceOfReadByMsgId.json",
        Method::Post,
        M,
        "/restapi/soa2/11679/PutAdviceOfReadByMsgId.json",
        SdkHead,
        Write,
        SoaAck,
        Core,
    ),
    (
        "m:11679/SendMessage.json",
        Method::Post,
        M,
        "/restapi/soa2/11679/SendMessage.json",
        SdkHead,
        Write,
        SoaAck,
        Core,
    ),
    (
        "m:11679/batchTranslateByMsgIds",
        Method::Post,
        M,
        "/restapi/soa2/11679/batchTranslateByMsgIds",
        SdkHead,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:11679/getIQConversations",
        Method::Post,
        M,
        "/restapi/soa2/11679/getIQConversations",
        SdkHead,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:11679/getRecentMessages",
        Method::Post,
        M,
        "/restapi/soa2/11679/getRecentMessages",
        SdkHead,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:11679/recallMessage",
        Method::Post,
        M,
        "/restapi/soa2/11679/recallMessage",
        SdkHead,
        Write,
        SoaAck,
        Core,
    ),
    (
        "m:13500/checkMemberStatus",
        Method::Post,
        M,
        "/restapi/soa2/13500/checkMemberStatus",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:14735/getOrderDetailsForVbk",
        Method::Post,
        M,
        "/restapi/soa2/14735/getOrderDetailsForVbk",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:15529/getSessionEmpathyPhraseInfo",
        Method::Post,
        M,
        "/restapi/soa2/15529/getSessionEmpathyPhraseInfo",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:15529/getSessionUrls",
        Method::Post,
        M,
        "/restapi/soa2/15529/getSessionUrls",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:15529/queryToken",
        Method::Post,
        M,
        "/restapi/soa2/15529/queryToken",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:16037/checkSessionStatus",
        Method::Post,
        M,
        "/restapi/soa2/16037/checkSessionStatus",
        Cookie,
        ReadOnly,
        SoaBizStatus,
        Core,
    ),
    (
        "m:16037/finishConversation",
        Method::Post,
        M,
        "/restapi/soa2/16037/finishConversation",
        Cookie,
        Write,
        SoaBizStatus,
        Core,
    ),
    (
        "m:16037/getAgentWorkingSchedule",
        Method::Post,
        M,
        "/restapi/soa2/16037/getAgentWorkingSchedule",
        Cookie,
        ReadOnly,
        SoaBizStatus,
        Core,
    ),
    (
        "m:16037/getCategories",
        Method::Post,
        M,
        "/restapi/soa2/16037/getCategories",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:16037/getConversationInfoByGidList",
        Method::Post,
        M,
        "/restapi/soa2/16037/getConversationInfoByGidList",
        Cookie,
        ReadOnly,
        SoaBizStatus,
        Core,
    ),
    (
        "m:16037/getConversationList",
        Method::Post,
        M,
        "/restapi/soa2/16037/getConversationList",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:16037/getConversationList.json",
        Method::Post,
        M,
        "/restapi/soa2/16037/getConversationList.json",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:16037/getCustomerScripts",
        Method::Post,
        M,
        "/restapi/soa2/16037/getCustomerScripts",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:16037/getInviteCtripData",
        Method::Post,
        M,
        "/restapi/soa2/16037/getInviteCtripData",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:16037/getInviteMemberListBySkillGroup",
        Method::Post,
        M,
        "/restapi/soa2/16037/getInviteMemberListBySkillGroup",
        Cookie,
        ReadOnly,
        SoaBizStatus,
        Core,
    ),
    (
        "m:16037/getLatestConversationByGid",
        Method::Post,
        M,
        "/restapi/soa2/16037/getLatestConversationByGid",
        Cookie,
        ReadOnly,
        SoaBizStatus,
        Core,
    ),
    (
        "m:16037/getLatestSingleChat",
        Method::Post,
        M,
        "/restapi/soa2/16037/getLatestSingleChat",
        Cookie,
        ReadOnly,
        SoaBizStatus,
        Core,
    ),
    (
        "m:16037/getMessageList",
        Method::Post,
        M,
        "/restapi/soa2/16037/getMessageList",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:16037/getRemarkList",
        Method::Post,
        M,
        "/restapi/soa2/16037/getRemarkList",
        Cookie,
        ReadOnly,
        SoaBizStatus,
        Core,
    ),
    (
        "m:16037/getTimeZoneList",
        Method::Post,
        M,
        "/restapi/soa2/16037/getTimeZoneList",
        Cookie,
        ReadOnly,
        SoaBizStatus,
        SettingsReadback,
    ),
    (
        "m:16037/getVenAgentByUid",
        Method::Post,
        M,
        "/restapi/soa2/16037/getVenAgentByUid",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:16037/getVenAgentByUid.json",
        Method::Post,
        M,
        "/restapi/soa2/16037/getVenAgentByUid.json",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:16037/getWordsAboves",
        Method::Post,
        M,
        "/restapi/soa2/16037/getWordsAboves",
        Cookie,
        ReadOnly,
        SoaBizStatus,
        SettingsReadback,
    ),
    (
        "m:16037/inviteVenAgent",
        Method::Post,
        M,
        "/restapi/soa2/16037/inviteVenAgent",
        Cookie,
        Write,
        SoaAck,
        Core,
    ),
    (
        "m:16037/searchConversation",
        Method::Post,
        M,
        "/restapi/soa2/16037/searchConversation",
        Cookie,
        ReadOnly,
        SoaBizStatus,
        Core,
    ),
    (
        "m:16037/searchInviteMemberListBySkillGroup",
        Method::Post,
        M,
        "/restapi/soa2/16037/searchInviteMemberListBySkillGroup",
        Cookie,
        ReadOnly,
        SoaBizStatus,
        Core,
    ),
    (
        "m:16037/setWorkSheetStar",
        Method::Post,
        M,
        "/restapi/soa2/16037/setWorkSheetStar",
        Cookie,
        Write,
        SoaBizStatus,
        Core,
    ),
    (
        "m:16037/startChatB2C",
        Method::Post,
        M,
        "/restapi/soa2/16037/startChatB2C",
        Cookie,
        MayCreate,
        SoaBizStatus,
        Core,
    ),
    (
        "m:16037/syncVenAgentInfo",
        Method::Post,
        M,
        "/restapi/soa2/16037/syncVenAgentInfo",
        Cookie,
        Write,
        SoaAck,
        Core,
    ),
    (
        "m:16037/transferVenMaster",
        Method::Post,
        M,
        "/restapi/soa2/16037/transferVenMaster",
        Cookie,
        Write,
        SoaBizStatus,
        Core,
    ),
    (
        "m:16037/uploadTokenCreate",
        Method::Post,
        M,
        "/restapi/soa2/16037/uploadTokenCreate",
        Cookie,
        Write,
        SoaAck,
        Core,
    ),
    (
        "m:16163/saveLogInfo",
        Method::Post,
        M,
        "/restapi/soa2/16163/saveLogInfo",
        Cookie,
        Write,
        SoaAck,
        PageAux,
    ),
    (
        "m:18088/getAppConfig.json",
        Method::Post,
        M,
        "/restapi/soa2/18088/getAppConfig.json",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:20016/checkVBKRealNameAuthStatus",
        Method::Post,
        M,
        "/restapi/soa2/20016/checkVBKRealNameAuthStatus",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:22015/getSceneConfig",
        Method::Post,
        M,
        "/restapi/soa2/22015/getSceneConfig",
        Cookie,
        ReadOnly,
        SoaErr,
        Core,
    ),
    (
        "m:36709/createTUid",
        Method::Post,
        M,
        "/restapi/soa2/36709/createTUid",
        Cookie,
        Write,
        SoaAck,
        PageAux,
    ),
    // --- nephele.ctrip.com --------------------------------------------
    (
        "nephele:file/v1/api/upload",
        Method::Post,
        NEPHELE,
        "/file/v1/api/upload",
        AuthKind::None,
        Write,
        Raw,
        Core,
    ),
    (
        "nephele:image/v2/api/upload",
        Method::Post,
        NEPHELE,
        "/image/v2/api/upload",
        NepheleToken,
        Write,
        NepheleCode,
        Core,
    ),
    (
        "nephele:video/v1/api/proc",
        Method::Post,
        NEPHELE,
        "/video/v1/api/proc",
        Cookie,
        Write,
        Raw,
        Core,
    ),
    (
        "nephele:video/v3/api/upload",
        Method::Post,
        NEPHELE,
        "/video/v3/api/upload",
        NepheleToken,
        Write,
        NepheleCode,
        Core,
    ),
    // --- online.ctrip.com ---------------------------------------------
    (
        "online:12405/generateWaterMark",
        Method::Post,
        ONLINE,
        "/restapi/soa2/12405/generateWaterMark",
        Cookie,
        ReadOnly,
        SoaAck,
        PageAux,
    ),
    (
        "online:12405/getCurrentUserInfo",
        Method::Post,
        ONLINE,
        "/restapi/soa2/12405/getCurrentUserInfo",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "online:13191/validateTicket",
        Method::Post,
        ONLINE,
        "/restapi/soa2/13191/validateTicket",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "online:14894/ContactUs",
        Method::Post,
        ONLINE,
        "/restapi/soa2/14894/ContactUs",
        Cookie,
        ReadOnly,
        SoaAck,
        PageAux,
    ),
    (
        "online:14894/getDoorFunctionGuide",
        Method::Post,
        ONLINE,
        "/restapi/soa2/14894/getDoorFunctionGuide",
        Cookie,
        ReadOnly,
        SoaAck,
        PageAux,
    ),
    (
        "online:14894/getProviderBusinessLineList",
        Method::Post,
        ONLINE,
        "/restapi/soa2/14894/getProviderBusinessLineList",
        Cookie,
        ReadOnly,
        SoaAck,
        PageAux,
    ),
    (
        "online:15529/queryRecommendProductList",
        Method::Post,
        ONLINE,
        "/restapi/soa2/15529/queryRecommendProductList",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "online:15529/sendCardMessageForOffline",
        Method::Post,
        ONLINE,
        "/restapi/soa2/15529/sendCardMessageForOffline",
        Cookie,
        Write,
        SoaAck,
        Core,
    ),
    (
        "online:16566/queryCountByEid",
        Method::Post,
        ONLINE,
        "/restapi/soa2/16566/queryCountByEid",
        Cookie,
        ReadOnly,
        SoaAck,
        PageAux,
    ),
    (
        "online:16881/searchPop",
        Method::Post,
        ONLINE,
        "/restapi/soa2/16881/searchPop",
        Cookie,
        ReadOnly,
        SoaAck,
        PageAux,
    ),
    (
        "online:17092/listNoticeReceiveConfig",
        Method::Post,
        ONLINE,
        "/restapi/soa2/17092/listNoticeReceiveConfig",
        Cookie,
        ReadOnly,
        SoaAck,
        Core,
    ),
    // --- sec-m.ctrip.com ----------------------------------------------
    (
        "sec-m:11380/queryevent",
        Method::Post,
        SECM,
        "/restapi/soa2/11380/queryevent",
        Cookie,
        ReadOnly,
        SoaAck,
        PageAux,
    ),
    (
        "sec-m:14361/createimchat",
        Method::Post,
        SECM,
        "/restapi/soa2/14361/createimchat",
        Cookie,
        MayCreate,
        SoaErr,
        OrderContact,
    ),
    (
        "sec-m:14361/getdeliveryinfo",
        Method::Post,
        SECM,
        "/restapi/soa2/14361/getdeliveryinfo",
        Cookie,
        ReadOnly,
        SoaErr,
        OrderEvidence,
    ),
    (
        "sec-m:14361/getorderclient",
        Method::Post,
        SECM,
        "/restapi/soa2/14361/getorderclient",
        Cookie,
        ReadOnly,
        SoaErr,
        OrderEvidence,
    ),
    (
        "sec-m:14361/getorderinfo",
        Method::Post,
        SECM,
        "/restapi/soa2/14361/getorderinfo",
        Cookie,
        ReadOnly,
        Raw,
        OrderEvidence,
    ),
    (
        "sec-m:14361/getorderrefund",
        Method::Post,
        SECM,
        "/restapi/soa2/14361/getorderrefund",
        Cookie,
        ReadOnly,
        SoaErr,
        OrderEvidence,
    ),
    (
        "sec-m:14361/getordersettlement",
        Method::Post,
        SECM,
        "/restapi/soa2/14361/getordersettlement",
        Cookie,
        ReadOnly,
        SoaErr,
        OrderEvidence,
    ),
    (
        "sec-m:14361/getprocessloglist",
        Method::Post,
        SECM,
        "/restapi/soa2/14361/getprocessloglist",
        Cookie,
        ReadOnly,
        SoaErr,
        OrderEvidence,
    ),
    (
        "sec-m:14361/getsupreceiptcountbystatus",
        Method::Post,
        SECM,
        "/restapi/soa2/14361/getsupreceiptcountbystatus",
        Cookie,
        ReadOnly,
        SoaErr,
        OrderEvidence,
    ),
    (
        "sec-m:14361/queryordervoucher",
        Method::Post,
        SECM,
        "/restapi/soa2/14361/queryordervoucher",
        Cookie,
        ReadOnly,
        SoaErr,
        OrderEvidence,
    ),
    (
        "sec-m:14361/searchorderlist",
        Method::Post,
        SECM,
        "/restapi/soa2/14361/searchorderlist",
        Cookie,
        ReadOnly,
        SoaErr,
        OrderContact,
    ),
    // --- vbooking.ctrip.com (HTML documents) --------------------------
    (
        "vbooking:tour/im/ex-area/b",
        Method::Get,
        VBOOKING,
        "/tour/im/ex-area/b",
        Cookie,
        ReadOnly,
        Html,
        Core,
    ),
    (
        "vbooking:tour/im/ex-area/b/imExtraInfo",
        Method::Get,
        VBOOKING,
        "/tour/im/ex-area/b/imExtraInfo",
        Cookie,
        ReadOnly,
        Html,
        Core,
    ),
];

/// Supplement from the 2026-11-02 live capture of the official desktop
/// client and the rea static analysis (docs/reviews/2026-11-02-desktop-live-
/// capture-verification.md). Kept apart from the 72 rows of
/// `docs/api/README.md` so that table stays a verbatim mirror.
///
/// * `getMessageTranslate` / `getIQMessages` / `putAdviceofreadIQMessage` /
///   (spelling per the live evidence `message-notice-order-live-20261030.json`) /
///   `translateIQMessage`: paths from static call sites (rea FE, desktop
///   baseline 09-assistant); request shapes beyond what the web adapter
///   already uses are **not** captured.
/// * `28967/reportInjectFnInfo`, `ivbk/accountV2/restapi/ab`,
///   `tour/im/ex-area/qconfig/json`: page-auxiliary traffic of the official
///   page. They are evidence only (`assert_in_scope` refuses them); the
///   adapter never calls them.
const SUPPLEMENT: &[Row] = &[
    (
        "m:11679/getMessageTranslate",
        Method::Post,
        M,
        "/restapi/soa2/11679/getMessageTranslate",
        SdkHead,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:11679/getIQMessages",
        Method::Post,
        M,
        "/restapi/soa2/11679/getIQMessages",
        SdkHead,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:11679/putAdviceofreadIQMessage",
        Method::Post,
        M,
        "/restapi/soa2/11679/putAdviceofreadIQMessage",
        SdkHead,
        Write,
        SoaAck,
        Core,
    ),
    (
        "m:11679/translateIQMessage",
        Method::Post,
        M,
        "/restapi/soa2/11679/translateIQMessage",
        SdkHead,
        ReadOnly,
        SoaAck,
        Core,
    ),
    (
        "m:28967/reportInjectFnInfo",
        Method::Post,
        M,
        "/restapi/soa2/28967/reportInjectFnInfo",
        Cookie,
        Write,
        SoaAck,
        PageAux,
    ),
    (
        "vbooking:ivbk/accountV2/restapi/ab",
        Method::Post,
        VBOOKING,
        "/ivbk/accountV2/restapi/ab",
        Cookie,
        ReadOnly,
        Raw,
        PageAux,
    ),
    (
        "vbooking:tour/im/ex-area/qconfig/json",
        Method::Post,
        VBOOKING,
        "/tour/im/ex-area/qconfig/json",
        Cookie,
        ReadOnly,
        Raw,
        PageAux,
    ),
];

/// Development-only host aliases. Compiled only with the `test-endpoints`
/// feature; a release build contains none of these strings (plan I-24,
/// SEC-12 / F-07). The aliases are folded onto their production host before
/// lookup, so no test endpoint ever gets its own policy row.
#[cfg(feature = "test-endpoints")]
pub mod test_env {
    /// `(test host, production host)`; hosts per rea 02 section 5.2.
    pub const HOST_ALIASES: &[(&str, &str)] = &[
        ("gateway.m.fws.qa.nt.ctripcorp.com", "m.ctrip.com"),
        ("gateway.m.uat.qa.nt.ctripcorp.com", "m.ctrip.com"),
        (
            "vbooking.ctrip.fat29.qa.nt.ctripcorp.com",
            "vbooking.ctrip.com",
        ),
        (
            "vbooking.ctrip.fat30.qa.nt.ctripcorp.com",
            "vbooking.ctrip.com",
        ),
        (
            "vbooking.ctrip.fws.qa.nt.ctripcorp.com",
            "vbooking.ctrip.com",
        ),
        (
            "vbooking.ctrip.uat.qa.nt.ctripcorp.com",
            "vbooking.ctrip.com",
        ),
    ];

    pub fn production_host(host: &str) -> Option<&'static str> {
        HOST_ALIASES
            .iter()
            .find(|(t, _)| t.eq_ignore_ascii_case(host))
            .map(|&(_, p)| p)
    }
}

/// Which endpoint table this binary was built with.
pub const BUILD_PROFILE: &str = if cfg!(feature = "test-endpoints") {
    "test-endpoints"
} else {
    "production"
};

/// Release gate: true when `host` looks like one of the non-production
/// domains the reverse report found in the official bundle (FAT/UAT/FWS/QA
/// internals, `*.ctripcorp.com`, `tripqate`). Used by the table test and by
/// build scripts that scan artifacts.
///
/// Deliberately label-wise: the former dotted substrings (`".qa.nt."`,
/// `".uat."`, ...) were pooled next to each other in the production rlib and
/// the artifact scanner (`tools/release-scan.mjs`) flagged the detector
/// itself as a test host. No literal here contains a dot.
pub fn is_test_domain(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    let labels: Vec<&str> = h.split('.').collect();
    let qa_nt = labels.windows(2).any(|w| w[0] == "qa" && w[1] == "nt");
    qa_nt
        || labels.contains(&"uat")
        || labels.contains(&"fws")
        || labels.iter().any(|l| l.starts_with("fat"))
        || labels.iter().any(|l| l.contains("tripqate"))
        || h.ends_with(&["ctripcorp", "com"].join("."))
}

/// Registry of every observed endpoint.
#[derive(Debug, Clone)]
pub struct EndpointRegistry {
    policies: Vec<EndpointPolicy>,
    by_key: HashMap<(Method, String, String), usize>,
    by_id: HashMap<&'static str, usize>,
}

impl Default for EndpointRegistry {
    fn default() -> Self {
        Self::official()
    }
}

impl EndpointRegistry {
    /// Builds the registry from the observed table.
    pub fn official() -> Self {
        let total = TABLE.len() + SUPPLEMENT.len();
        let mut policies = Vec::with_capacity(total);
        let mut by_key = HashMap::with_capacity(total);
        let mut by_id = HashMap::with_capacity(total);
        for (i, row) in TABLE.iter().chain(SUPPLEMENT.iter()).enumerate() {
            let (id, method, host, path, auth, side_effect, response_kind, scope) = *row;
            let retry = match side_effect {
                SideEffect::ReadOnly => RetryPolicy::SafeRead,
                SideEffect::Write | SideEffect::MayCreateConversation => RetryPolicy::Never,
            };
            policies.push(EndpointPolicy {
                id,
                method,
                host,
                path,
                auth,
                side_effect,
                retry,
                response_kind,
                scope,
            });
            by_key.insert((method, host.to_string(), path.to_string()), i);
            by_id.insert(id, i);
        }
        Self {
            policies,
            by_key,
            by_id,
        }
    }

    pub fn len(&self) -> usize {
        self.policies.len()
    }

    pub fn is_empty(&self) -> bool {
        self.policies.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &EndpointPolicy> {
        self.policies.iter()
    }

    /// Exact lookup; host is compared case-insensitively, path exactly
    /// (query string must be stripped by the caller).
    pub fn lookup(&self, method: Method, host: &str, path: &str) -> Option<&EndpointPolicy> {
        #[cfg(feature = "test-endpoints")]
        let host = test_env::production_host(host).unwrap_or(host);
        let key = (method, host.to_ascii_lowercase(), path.to_string());
        self.by_key.get(&key).map(|&i| &self.policies[i])
    }

    pub fn by_id(&self, id: &str) -> Option<&EndpointPolicy> {
        self.by_id.get(id).map(|&i| &self.policies[i])
    }

    /// Resolves `id` and refuses endpoints that are unregistered
    /// (`net.endpoint_unregistered`) or outside the product scope
    /// (`net.endpoint_not_in_scope`).
    pub fn assert_in_scope(&self, id: &str) -> Result<&EndpointPolicy, AppError> {
        let p = self.by_id(id).ok_or_else(|| {
            AppError::new(
                net_codes::NET_ENDPOINT_UNREGISTERED,
                "endpoint is not registered",
            )
            .with_detail(id.to_string())
        })?;
        if !p.is_in_scope() {
            return Err(AppError::new(
                net_codes::NET_ENDPOINT_NOT_IN_SCOPE,
                "endpoint is registered as evidence only, not as a feature",
            )
            .with_detail(format!("{}:{:?}", p.id, p.scope)));
        }
        Ok(p)
    }

    /// `lookup` + scope check in one step for a concrete request.
    pub fn authorize(
        &self,
        method: Method,
        host: &str,
        path: &str,
    ) -> Result<&EndpointPolicy, AppError> {
        let p = self.lookup(method, host, path).ok_or_else(|| {
            AppError::new(
                net_codes::NET_ENDPOINT_UNREGISTERED,
                "endpoint is not registered",
            )
            .with_detail(format!("{} {host}{path}", method.as_str()))
        })?;
        self.assert_in_scope(p.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn registry_has_exactly_72_entries() {
        // 72 rows mirror docs/api/README.md; SUPPLEMENT is the 2026-11-02 live capture.
        assert_eq!(TABLE.len(), 72);
        let r = EndpointRegistry::official();
        let total = 72 + SUPPLEMENT.len();
        assert_eq!(r.len(), total);
        assert!(!r.is_empty());
        let ids: HashSet<&str> = r.iter().map(|p| p.id).collect();
        assert_eq!(ids.len(), total, "ids must be unique");
        let keys: HashSet<(Method, &str, &str)> =
            r.iter().map(|p| (p.method, p.host, p.path)).collect();
        assert_eq!(keys.len(), total, "method+host+path must be unique");
        assert_eq!(r.iter().filter(|p| p.method == Method::Get).count(), 2);
    }

    #[test]
    fn every_write_is_non_retryable() {
        let r = EndpointRegistry::official();
        for p in r.iter() {
            match p.side_effect {
                SideEffect::ReadOnly => {
                    assert_eq!(p.retry, RetryPolicy::SafeRead, "{}", p.id);
                    assert!(p.retryable(), "{}", p.id);
                }
                SideEffect::Write | SideEffect::MayCreateConversation => {
                    assert_eq!(p.retry, RetryPolicy::Never, "{}", p.id);
                    assert!(!p.retryable(), "{}", p.id);
                }
            }
            assert!(p.path.starts_with('/'));
            assert!(!p.path.contains('?'));
        }
    }

    #[test]
    fn lookup_is_exact() {
        let r = EndpointRegistry::official();
        let p = r
            .lookup(
                Method::Post,
                "m.ctrip.com",
                "/restapi/soa2/16037/getConversationList",
            )
            .expect("registered");
        assert_eq!(p.id, "m:16037/getConversationList");
        assert_eq!(p.response_kind, ResponseKind::SoaAck);
        assert_eq!(
            p.url(),
            "https://m.ctrip.com/restapi/soa2/16037/getConversationList"
        );
        assert!(r
            .lookup(
                Method::Get,
                "m.ctrip.com",
                "/restapi/soa2/16037/getConversationList"
            )
            .is_none());
        assert!(r
            .lookup(
                Method::Post,
                "m.ctrip.com",
                "/restapi/soa2/16037/getConversationList/"
            )
            .is_none());
        assert!(r
            .lookup(
                Method::Post,
                "evil.m.ctrip.com",
                "/restapi/soa2/16037/getConversationList"
            )
            .is_none());
        assert!(r
            .lookup(
                Method::Post,
                "M.CTRIP.COM",
                "/restapi/soa2/16037/getConversationList"
            )
            .is_some());
        let json = r
            .lookup(
                Method::Post,
                "m.ctrip.com",
                "/restapi/soa2/16037/getConversationList.json",
            )
            .expect(".json variant is separate");
        assert_eq!(json.id, "m:16037/getConversationList.json");
    }

    #[test]
    fn scope_per_readme_column() {
        let r = EndpointRegistry::official();
        // README column counts are over the 72 mirrored rows only.
        let count = |s: EndpointScope| TABLE.iter().filter(|row| row.7 == s).count();
        assert_eq!(count(EndpointScope::SettingsReadback), 2);
        assert_eq!(count(EndpointScope::PageAuxiliaryNotInScope), 9);
        assert_eq!(count(EndpointScope::OrderDetailEvidenceNotInScope), 8);
        assert_eq!(count(EndpointScope::OrderContact), 2);
        assert_eq!(count(EndpointScope::Core), 72 - 2 - 9 - 8 - 2);
        assert_eq!(
            TABLE.iter().filter(|row| row.7.is_in_scope()).count(),
            51 + 2
        );

        assert!(r.assert_in_scope("m:16037/getConversationList").is_ok());
        assert!(r.assert_in_scope("sec-m:14361/createimchat").is_ok());
        let e = r.assert_in_scope("m:16163/saveLogInfo").expect_err("aux");
        assert!(e.is(net_codes::NET_ENDPOINT_NOT_IN_SCOPE));
        let e = r
            .assert_in_scope("sec-m:14361/getorderrefund")
            .expect_err("evidence");
        assert!(e.is(net_codes::NET_ENDPOINT_NOT_IN_SCOPE));
        let e = r
            .assert_in_scope("m:16037/getTimeZoneList")
            .expect_err("settings");
        assert!(e.is(net_codes::NET_ENDPOINT_NOT_IN_SCOPE));
        let e = r.assert_in_scope("m:99999/nothing").expect_err("unknown");
        assert!(e.is(net_codes::NET_ENDPOINT_UNREGISTERED));
        assert!(r
            .authorize(Method::Post, "m.ctrip.com", "/restapi/soa2/99999/x")
            .is_err());
        assert!(r
            .authorize(Method::Get, "vbooking.ctrip.com", "/tour/im/ex-area/b")
            .is_ok());
    }

    #[test]
    fn auth_templates() {
        let r = EndpointRegistry::official();
        for p in r.iter() {
            if p.host == "nephele.ctrip.com" {
                assert_ne!(p.auth, AuthKind::SdkHead, "{}", p.id);
            }
            if p.path.contains("/11679/") {
                assert_eq!(p.auth, AuthKind::SdkHead, "{}", p.id);
            }
        }
        assert_eq!(
            r.by_id("nephele:image/v2/api/upload").map(|p| p.auth),
            Some(AuthKind::NepheleToken)
        );
        assert_eq!(
            r.by_id("nephele:file/v1/api/upload").map(|p| p.auth),
            Some(AuthKind::None)
        );
        assert_eq!(
            r.by_id("m:16037/setWorkSheetStar").map(|p| p.response_kind),
            Some(ResponseKind::SoaBizStatus)
        );
        assert_eq!(
            r.by_id("m:16037/startChatB2C").map(|p| p.side_effect),
            Some(SideEffect::MayCreateConversation)
        );
        assert_eq!(
            r.by_id("sec-m:14361/createimchat").map(|p| p.side_effect),
            Some(SideEffect::MayCreateConversation)
        );
        assert_eq!(
            r.by_id("sec-m:14361/searchorderlist")
                .map(|p| p.response_kind),
            Some(ResponseKind::SoaResponseErrorCode)
        );
    }

    #[test]
    fn release_table_has_no_test_domains() {
        let r = EndpointRegistry::official();
        for p in r.iter() {
            assert!(!is_test_domain(p.host), "{} -> {}", p.id, p.host);
            assert!(p.host.ends_with(".ctrip.com"), "{}", p.host);
        }
        #[cfg(not(feature = "test-endpoints"))]
        assert_eq!(BUILD_PROFILE, "production");
        assert!(is_test_domain("gateway.m.fws.qa.nt.ctripcorp.com"));
        assert!(is_test_domain("www.uat.tripqate.com"));
        assert!(is_test_domain("vbooking.ctrip.fat30.qa.nt.ctripcorp.com"));
        assert!(is_test_domain("GATEWAY.M.UAT.QA.NT.CTRIPCORP.COM"));
        assert!(is_test_domain("x.fat.ctrip.com"));
        assert!(!is_test_domain("m.ctrip.com"));
        assert!(!is_test_domain("im3.ctrip.com"));
        assert!(!is_test_domain("nephele.ctrip.com"));
        // an alias host is only resolvable in a build that opted in
        #[cfg(not(feature = "test-endpoints"))]
        assert!(r
            .lookup(
                Method::Post,
                "gateway.m.fws.qa.nt.ctripcorp.com",
                "/restapi/soa2/16037/getConversationList"
            )
            .is_none());
    }

    /// The detector's own literals must not look like a test host to the
    /// artifact scanner (`tools/release-scan.mjs`): no literal carries a dot,
    /// so no pooling order can form `.uat.`, `.fws.`, `qa.nt.` or `.nt.ctripcorp.com`.
    #[test]
    fn test_domain_detector_source_has_no_dotted_host_literals() {
        let src = include_str!("endpoint.rs");
        let start = src.find("pub fn is_test_domain").expect("fn");
        let body = &src[start..start + src[start..].find("\n}\n").expect("end")];
        for forbidden in [
            "\".qa.nt",
            "\".fat",
            "\".uat.",
            "\".fws.",
            "\"ctripcorp.com\"",
            "\".nt.",
        ] {
            assert!(
                !body.contains(forbidden),
                "detector literal {forbidden} would trip the release scan"
            );
        }
    }

    #[cfg(feature = "test-endpoints")]
    #[test]
    fn test_aliases_fold_onto_production_rows() {
        let r = EndpointRegistry::official();
        let p = r
            .lookup(
                Method::Post,
                "gateway.m.fws.qa.nt.ctripcorp.com",
                "/restapi/soa2/16037/getConversationList",
            )
            .expect("alias");
        assert_eq!(p.host, "m.ctrip.com");
        assert_eq!(BUILD_PROFILE, "test-endpoints");
    }

    #[test]
    fn live_capture_supplement_scopes() {
        let r = EndpointRegistry::official();
        // IQ reads/translation are product features; inject-report and the
        // page's A/B + qconfig traffic are evidence only.
        for id in [
            "m:11679/getMessageTranslate",
            "m:11679/getIQMessages",
            "m:11679/putAdviceofreadIQMessage",
            "m:11679/translateIQMessage",
        ] {
            let p = r.assert_in_scope(id).expect(id);
            assert_eq!(p.auth, AuthKind::SdkHead, "{id}");
        }
        assert!(!r
            .by_id("m:11679/putAdviceofreadIQMessage")
            .expect("row")
            .retryable());
        // The lower-case spelling once registered here never existed on the wire.
        assert!(r.by_id("m:11679/putadviceofreadIQMessage").is_none());
        for id in [
            "m:28967/reportInjectFnInfo",
            "vbooking:ivbk/accountV2/restapi/ab",
            "vbooking:tour/im/ex-area/qconfig/json",
        ] {
            let e = r.assert_in_scope(id).expect_err(id);
            assert!(e.is(net_codes::NET_ENDPOINT_NOT_IN_SCOPE), "{id}");
        }
        assert!(r
            .authorize(
                Method::Post,
                "m.ctrip.com",
                "/restapi/soa2/28967/reportInjectFnInfo"
            )
            .is_err());
    }
}
