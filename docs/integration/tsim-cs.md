# TSim_CS 携程渠道迁移准备

核对日期：2026-10-31。本文及 [合成契约示例](../../tools/contracts/tsim-integration-example.json) 是接入设计材料，**未将本示例整体接入 TSim_CS**，没有新增 TSim 路由、数据库迁移、在线消费者或生产发送器。TSim_CS、官方程序、原插件均只读。本次只读源码检查没有发生产请求或浏览器操作。

基线以 [环境重勘](../research/2026-10-31-environment-resurvey.md)、`PROGRESS.md`、`BLOCKED.md` 为准。`docs/api/README.md` 的“仅采集/准入关闭”是 10 月 30 日历史阶段记录，不能替代最新状态；72 个请求形态也不等于 72 项功能通过。运行旧 app、新源码测试与新包构建必须分别报告。

## 已核对的真实实现

下面 TSim 相对路径根为 `/Users/tashima_meru/Develop/TSim_CS`；核对 HEAD 为 `d35d830fe7c897fd93af897a585c83d94e3683af`，本机工作区源码可能另有未提交改动。符号比行号稳定；迁移前重新核对版本。以下是源码证据，均不证明线上版本一致。

| 来源文件与符号 | 已有行为与复用边界 |
| --- | --- |
| `central-backend/consumer_workspace/models.py`：`AgentThirdPartyCredential`、`KkdayOutboundAttempt`、`KkdayConversationMessageSnapshot` | KKday 凭据加密，绑定 agent/provider 与账号指纹；attempt 持久化 client ID、generation、phase、payload、租约与核验结果；快照按账号/供应商/generation/conversation 隔离。不是携程模型。 |
| `central-backend/consumer_workspace/services/kkday_outbound_dispatcher.py`：`_claim`、`_owned`、`_dispatch_cas_update`、`fenced_message_write_start_in_tx`、`_retry_or_fail`、`_has_unresolved_prior` | 租约/CAS 防旧 worker 写回；客户可见写入前设置持久边界；仅 not_started 可进入安全重试，不确定结果转 verification；未解决前序可阻塞同 lane。携程应借鉴边界，不能照搬 KKday 请求和 supplier 语义。 |
| 同文件：`build_preflight_metadata`、`attempt_identity_matches`、`cleanup_expired_kkday_outbound_assets` | 写前基线和身份核对；清理资产排除仍由非终态 attempt 持有的引用，数据库失败时关闭删除路径。 |
| `central-backend/consumer_workspace/services/kkday_confirmation_reconciler.py`：模块声明、`evaluate_confirmation`、`evaluate_confirmation_pages`、`reconcile_pending_kkday_attempts`、`_late_claimable_attempts` | 只读上游详情，绝不调用 add_message/upload_files/end_session；核对基线、方向、内容/文件等；有限期核验及晚到只读核验，不使超时命令重新可发送。 |
| `central-backend/consumer_workspace/api/routers/kkday_consumer_workspace.py`：`require_workspace`、`require_account_settings`、`require_workspace_reader`、`_identity_namespace`、`_resolve_consumer_read_context` | consumer_workspace 与个人账号设置权限、读取身份上下文有独立边界；不能把一个客服的读权限当作另一个账号的写权限。 |
| `central-backend/services/respondio_inbound_service.py`：`process_event`、`_find_or_create_customer`、`_find_or_create_conversation`、`_message_exists`、`_append_message`、`_enrich_history_message` | contact ID 定客户，绝不按 email/phone 合并；每 contact 一条长会话；消息外部 ID 查重并分配本地 seq；历史证据补充不提升为实时通知。携程 room/service session 不等同此长会话。 |
| `central-backend/database_models/models.py`：`Customer`、`Conversation`、`Message`、`RespondioWebhookEvent`、`RespondioMessageReconciliationJob` | respondio contact、external message、client message 有对应唯一约束/部分索引。当前 respondio 外部消息唯一键没有通用平台账号命名空间，不能直接把携程 ID 填入 respondio 字段。 |
| `central-backend/api/routers/respondio_webhook.py`：`receive_respondio_webhook`、`_verify_and_parse`、`persist_webhook_event` | 验签原始 body；event_id 审计 insert-only；队列满有 overflow 路径。不是携程已有 webhook，也不能将本示例 JSON POST 到该路由。 |
| `central-backend/services/respondio_message_reconciliation_service.py`：`is_reconciliation_candidate`、`enqueue_message_reconciliation`、`RespondioMessageReconciliationService._settle_success` | 处理 agent pending 且外部 ID 为数字的 respondio 消息；核对 external/contact/channel/traffic 与租约；这不是无外部 ID 的携程 unknown 通用对账器。 |
| `central-backend/api/routers/respondio_workspace.py`：`require_workspace`、`require_manage` | aggregated_workspace 与 aggregated_workspace_manage 权限区分；携程新动作须定义并落实自己的服务端授权。 |
| `central-backend/services/respondio_inbound_service.py`：`purge_webhook_events`、`WEBHOOK_EVENT_RETENTION_DAYS` | 目前 webhook 审计默认 30 天，不能外推为全部客户数据或携程保留期。 |

本仓库已有适配层：`vbk/ui/packages/web-adapter/src/send.ts` 的 `createSendIntent`/`submitIntent` 单次提交，按 localid 匹配回执，超时或 SDK 抛错为 unknown；`classifyAck` 已要求明确成功码和无损非空 tid，否则保持 unknown；只有明确非零整数错误码可判 rejected，见 [回执完整性](../api/send-ack.md)。持久化、服务端时间和权威读回仍需迁移实现，不能凭该枚举就证明完整证据。`history.ts` 的 `HistoryCursor`/`fetchHistoryPage` 是时间游标；`rpc.ts` 的 `sendOnce`/`outcomeError` 不盲重发；`peripheral.ts` 有周边函数，不代表端到端已接线。

## 身份与隔离契约（待实现的迁移目标）

所有 ID 作为不透明字符串，禁止经过 JS Number、按昵称/手机号/邮箱推导、跨账号碰撞合并。JSON 中 `synthetic-*` 仅为演示，不能通过真实接口校验。

| 概念 | 映射与限制 |
| --- | --- |
| tenant/workspace | TSim 部署的业务隔离域；每条映射、查询、唯一键带此域，不能只信客户端传值。 |
| platform account | 携程商家登录身份/账号指纹，绑定独立 Profile 与认证 generation；不是客服 ID。 |
| TSim agent / platform agent | TSim 操作者与携程当前客服分别保存；显示名无授权作用；上游 agentUid 等字段须从已鉴权身份读取并记录来源。 |
| customer | 携程客户 uid/JID 与本地 Customer 映射；不同平台账号下相同客户标识不默认合并，不能填到 respondio_contact_id。 |
| room | gid 与 room JID 分开保存，不能使用产品 groupTitle 或订单号作 gid；发送目标必须由当前会话事实提供。 |
| service session | sessionId、worksheetId、serviceType、conversationType 与 room 并存；结束/转接操作绑定当前服务会话和版本，不关闭整个客户长会话。 |
| order | 独立关联表记录平台账号、订单 ID、room/session 与来源；一 room 可有多订单；不拿订单 ID 当本地 conversation ID。 |
| message / attempt | 本地 Message ID、上游消息 tid/msgId、localid/client_message_id、attempt ID 分开；引用消息只允许同隔离域且可访问的上游 ID。 |

建议唯一键：身份映射 `(tenant, platform, account, upstream_kind, upstream_id)`；消息 `(tenant, platform, account, room, upstream_message_id)`；命令 `(tenant, platform, account, actor, client_message_id)` 并绑定不可变 payload hash。同幂等键不同 payload 明确 conflict。generation 是授权栅栏，**不放入长期消息去重键**，避免重新登录产生重复消息；游标/缓存则须绑定 generation，旧凭据缓存不可继续展示为当前授权事实。此设计尚无对应 TSim 数据库实现。

携程认证依赖官方登录页、独立账号 Profile、浏览器 Cookie/Origin、当前页面 SDK 与 SOA head；TSim Bearer 是另一套凭据，不能互换。见 [authentication](../api/authentication.md)、[transports](../api/transports.md)、[external-tsim](../api/external-tsim.md)。不把 Cookie、token、密码、SASL 或签名媒体 URL 写入 JSON、日志或通用 TSim channel_metadata；宿主保管凭据，前端只获最小可用状态。认证失败暂停写入，明确账号/generation，重新登录后先只读核验身份，再恢复订阅。

## 入站、发送与不确定结果

1. 入站事务先验证当前账号/room 权限，再按上游消息 ID upsert、合并来源/撤回状态，分配本地顺序并保存检查点。实时、轮询、补偿和历史共享去重；历史导入不计为新入站/未读。只有成功持久化整页后推进 checkpoint，失败重读原页。
2. 上游 `rangeMessage.isDone/lastMessageTime/messages` 与本地 seq 不混用。prev/endTime、next/beginTime 是上游时间游标；本地 seq 仅服务已落库消息。见 [分页证据](../api/transports.md)。同时间戳多消息边界尚未实测，需重叠窗口、ID 集合去重和可重读基线；不可自行加减 1 毫秒宣称全量无缺口。JSON `upstream_page_boundary` 仅记录一次页边界，`completeness=unverified` 明示不能当无遗漏水位。
3. 出站先持久化 intent/身份/payload hash/attempt，获取租约和版本，写前确认当前身份/目标/权限。在客户可见 SDK 调用前落 write_started 边界；崩溃在此之后即 unknown。上游没有已验证幂等保证，client ID 只是本地关联，不能宣称 exactly-once。
4. confirmed：回执关联当前 localid、明确成功、有效非空上游消息 ID；或同账号/room 的权威读回唯一匹配。只证明上游接受/存在，不证明客户已读。rejected：明确业务拒绝；记录来源和码，不能将任何异常当 rejected。unknown：超时、断链、SDK 抛错、成功但证据不完整或崩溃窗口；保留原 intent 和 attempt，不重发，不改键自动新建命令。
5. unknown 只读核验：在同账号和 room 范围按 upstream ID/localid 查详情；没有关联 ID 时结合写前基线、方向、发送者、时间窗、正文摘要/附件标识核验。仅同正文/邻近时间不足以确认。权限变更、多个候选、历史不完整均保持 unknown；核验有上限、退避、deadline，之后交人工只读处理，未找到不能断言未发送。晚到回执可收敛原 attempt，不再发送。恢复/回滚也保持该限制。
6. 并发命令按账号/room/session lane 排序；未解决 unknown 要阻止可能重复的后续同一意图，人工确需新消息须显式新意图且保留审计。已读回执与加载历史分离，不能加载即清零；环境重勘中的伪清零缺陷须以最新修复与回归证据验收，本文不宣称已修。

## 附件、订单及运营边界

- 上传与发送是两步；保存附件 mime/size/hash、安全资产引用、上传阶段和过期时间。图片/文件/视频使用各自上游资源契约与序列化，不能当文本 URL 发送；产品卡片走独立业务 API。见 [传输与媒体](../api/transports.md) 和 `send.ts::createMediaSendIntent/mediaMessageJson`。下载须校验允许域、重定向、大小和 MIME，并由服务端/宿主按当前身份取授权资源；过期 URL 重新授权获取，不能存签名 URL 作永久附件 ID。病毒扫描、长期对象存储和访问审计尚未实现。
- 订单侧栏 `/tour/im/ex-area/b` 是受鉴权 HTML/SSR，非 JSON API。订单详情请求样本不等于完整订单管理；退款/结算/凭证的写操作未纳入本示例。套餐查询 ID 与携程订单 ID 独立，`external-tsim.md` 中套餐查询权限/归属规则仍须遵守。
- 服务端授权必须逐动作核验 tenant/account/agent、读/发/上传/撤回/已读/邀请/转接/结束权限，UI 禁用不足为安全边界。区分 401 认证失效、403 权限不足、409 幂等/版本冲突、422 输入无效、429 限流和 5xx/网络未知；这是迁移分类建议，非承诺全部携程接口采用这些 HTTP 状态。业务 error 与 HTTP 200 分开解释。
- 留存须在 TSim 落地前由业务确定正文、附件、审计与备份期限及删除责任。建议凭据不入业务表，正文/媒体最短必要保留，日志仅追踪 ID/阶段/脱敏错误/耗时；unknown 的核验证据与活动附件在解决前保护，删除失败报警。respondio 30 天只是其 webhook 审计现状。
- 可观测指标至少含账号认证状态、generation、入站延迟/页缺口、重复事件、attempt 各阶段、unknown 年龄、核验次数、隔离拒绝、上传孤儿和队列深度；仅用脱敏 trace/attempt ID 关联，禁止以客户正文作日志标签。

## 全平台能力盘点

“已验证”仅指表中证据层级；现有网页证据不代表本客户端或 TSim 实机通过。

| 能力 | 已验证证据 | 未实现/待调查 |
| --- | --- | --- |
| 登录/身份/多账号 | authentication 与重勘：官方网页登录有效，插件已挂载 | TSim 最新认证失败需重验；携程 TSim 渠道映射/隔离未实现 |
| 列表/历史/未读/补偿 | transports 分页与已读证据；adapter history/rpc 源码 | 同时间戳/长断线完整性待调查；伪清零按最新修复复验；TSim durable cursor 未实现 |
| 文本/引用/回执/撤回 | transports 35/40、validation 与 recall endpoint 证据；submitIntent | 新包实机、本轮真实收发未整体通过；持久 attempt/只读 unknown 对账未接入 TSim |
| 图片/文件/视频/产品卡片 | transports 33/39/44/68 网页证据；上传/发送函数 | TSim 资产服务、保留/扫描/鉴权、完整客户端媒体链路未验收 |
| 客户资料/来源/订单 | 侧栏 55/56 SSR 证据；getOrderDetailsForVbk/searchorderlist endpoint | 客户主档/订单绑定未迁移，完整订单操作不在示例中 |
| 快捷语/客服邀请/转接/结束 | 对应 docs/api/endpoints；peripheral 五组函数 | RPC/IPC/host/UI 接线按最新源码另验；TSim 权限与工作流未实现 |
| 标星/状态/工作时间/通知 | worksheetStar/settings/notice 等适配代码及对应接口目录 | 不逐项声称已实机通过；权限差异/恢复待调查；头像设置用户排除继续采集 |
| 翻译/套餐助手 | external-tsim：已核对源码契约 | 在线 TSim 认证、翻译/套餐归属未动态验收；不等于消息渠道集成 |
| 分配/标签/内部备注/搜索/AI辅助/统计 | respondio inbound/workspace 有自身实现，可作领域参照 | 携程同名能力不默认同语义；跨渠道统一权限、字段、自动化触发均待调查 |
| 历史语料/实时渠道 | respondio `_enrich_history_message` 区分历史通知 | 携程历史 CSV 导入不能算在线渠道；本次检查未发现可复用的携程在线 TSim 接入 |

## 分步迁移与验收

1. 固定源码/包/官方 SDK 指纹、记录工作区差异与脱敏证据；先修复并验证本地消息/未读/身份问题，新包实机结果单列。本次不修改只读参考项目。
2. 在未来单独获授权的 TSim 开发分支定义平台 adapter 接口与携程命名空间，设计账号/客户/room/session/order/message 映射表、幂等索引、持久 attempt/游标及版本化 migration；审阅隔离模型后才建表。不要复用 respondio_contact_id 或强行扩展 KKday 字段。
3. 实现只读账号握手/身份 generation 与最小权限：官方登录/Profile 保留在可信浏览器宿主，后端只接规范事件和授权引用。错误账号、过期 generation、篡改 room 均需拒绝；无凭据进入日志。
4. 先以白名单账号只读影子消费，验证实时+历史重复、重启重读、乱序、同时间戳边界、撤回与本地 seq；检查点与消息事务提交，和官方详情对账。影子消费不清上游未读、不触发 AI/客服出站。
5. 接附件授权引用与订单关联，验证过期、跨账号下载拒绝、多订单 room 与大整数 ID；确认数据留存和删除流程后再允许持久媒体。
6. 接持久发送器与只读 reconciler；用离线故障注入验证 SDK 调用前/后崩溃、回执丢失/晚到/错 localid、租约过期、幂等冲突、双 worker 与 unknown deadline；断言每意图最多一次不确定客户可见调用，unknown 核验没有发送 API。
7. 之后另获明确出站测试授权，在限定账号/会话做小规模真实发送、权威读回及权限验收；先文本后媒体/周边动作，逐项开 feature flag。不将 mock JSON、HTTP 200、测试通过或插件挂载作为在线接入验收。
8. 演练恢复：停写后导出脱敏水位/attempt 状态，重启先恢复身份并只读核验所有 write_started/unknown，再恢复安全 not_started 队列。数据库/资产恢复保持同幂等键、payload hash、generation 栅栏，不回放已开始命令。
9. 演练回滚：先禁写与自动化触发，停止新命令，保留原 attempt/水位/映射和资产；回退前端/adapter，官方客户端可继续人工使用，晚到事件仍以原 ID 去重。数据库采用兼容的增量迁移，未解决命令不能删除表/审计或倒退成 pending。人工继续操作要记录防双发交接，回滚不撤销已发生的上游消息。

示例 JSON 无网络目标与可执行路由，所有 ID 明显合成；只描述未来边界。校验 JSON 可解析只证明格式，不是 JSON Schema、线上兼容或 TSim 接入测试。


## 可离线运行的 adapter 契约演示

仓库根目录运行 `node --experimental-strip-types tools/contracts/run-vbooking-contract-demo.mts`。该入口直接执行当前真实 SDK glue 与 submitIntent，用合成 callback facade/时钟重现精度完整的 confirmed、明确 rejected、无回执/不安全 ID/销毁后的 unknown，以及 void 返回不确认已读。无浏览器和网络依赖；所有结果只写终端，不调用 TSim 或上游。

发送断言是应用层一次 facade 调用及零宿主额外 HTTP，不代表官方 SDK 内部 exactly-once；示例没有持久化或重启 reconciler，不能当成迁移第6步完成。JSON 映射仍为未实施提案，运行说明见 [契约工具](../../tools/contracts/README.md)。

## 示例宿主的持久发送边界（2026-10-31新增）

本仓库已在79e5e50把实际Tauri im_send_text接入独立FileStore账本，详见[宿主发送屏障](../api/outbound-journal.md)。稳定environment/account/local_id去重、不可变payload hash、write_started落盘/fsync、confirmed/rejected/unknown回放可供迁移第6步参考；generation仅作审计。故障测试使用真实FileStore，但不是TSim数据库实现。示例新增手动未知发送核验：im_unknown_outbound只列脱敏metadata，专用im_outbound_lookup仅返回最新页四个身份字段，不发事实/display广播，避免普通历史查询间接标已读；唯一gid/local_id/本人/服务端ID匹配可供人工核对，但账本仍保留unknown，不结算、不重发。它不是自动全量reconciler；新包UI与跨进程运行仍待验收。迁移时应保留这一无副作用查询边界，并另行设计持久核验审计。

未来dispatcher/reconciler应把这个准入边界替换为TSim事务与租约，保留原幂等键，不能直接把本地文件当正式共享数据库。Rejected的原始reason可能回显正文，需固定说明或脱敏后持久化；write_started代表已准入但不证明网络包已发。实例重启先读回不确定状态，不能转pending盲重发。现有离线adapter演示仍是纯内存回调演示，与这份宿主测试分别说明。


周边动作在eb67560通过独立的peripheral_journal持久准入：room/action未知屏障、token+目标摘要墓碑以及明确not_submitted分类详见[周边契约](../api/peripheral-actions.md)。它保守跨服务会话锁住unknown，当前没有核验后解锁UI；未来迁移须设计只读权威证据和审计解锁，不能删除账本、换token或改目标绕过。官方已接受与实际生效分别建模，不让客服面板刷新成为重试器。
