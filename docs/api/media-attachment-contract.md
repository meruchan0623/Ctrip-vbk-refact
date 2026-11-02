# 附件登记契约 v1

2026-11-02 冻结。`ATTACHMENT_CONTRACT_VERSION = 1`，宿主常量位于 `vbk/src-tauri/src/media_outbound.rs`，适配器镜像位于 `vbk/ui/packages/web-adapter/src/media.ts`。本契约不改变既有 IPC 的字段名称；修改字段、所有权、期限或发送资格语义时必须升版本，并通知 I-17 截图与 I-05b 恢复链路负责人。

## 登记接口

截图和文件选择共用以下本地快照接口；此调用不上传、不发送：

```rust
pub fn FrozenAttachment::read(
    path: &std::path::Path,
    kind: &str, // "image" | "file" | "video"
    account: &contracts::AccountContext,
    gid: &str,
    target: MediaTarget,
) -> Result<FrozenAttachment, contracts::AppError>;
```

`MediaTarget { target_token: String, identity_sha256: String, sender_id: String }` 由原官方页面捕获并由宿主再次验证。`FrozenAttachment` 包含 `dto: MediaAttachmentDto`、`target: MediaTarget`、`bytes: Arc<Vec<u8>>`、`created_ms: i64`。`AttachmentDto` 是 `MediaAttachmentDto` 的兼容别名。调用方必须在读取结束后再次校验目标，才可插入宿主内存附件表；现有 `shell::register_attachment` 实现这一步。I-17 复用此调用链，不直接构造 DTO 或触发发送。

对外入口保持 `media_pick { account, gid, kind }`、`media_screenshot { account, gid }`，取消时返回 `null`；成功返回以下 DTO。`im_send_media { account, gid, attachment_id, local_id }` 消费已登记快照，选择成功不等于发送成功。

| MediaAttachmentDto 字段 | 类型 | v1 语义 |
| --- | --- | --- |
| attachment_id | string | 宿主生成的不透明 UUID，仅用于内存查找 |
| name | string | 原文件基本名，非空、最多 512 UTF-8 字节，不含路径分隔符与控制字符 |
| kind | string | image / file / video |
| mime | string | 从内容签名识别；普通未知文件为 application/octet-stream |
| size | integer | 快照原始字节数，正数 |
| content_sha256 | string | 原始字节 SHA-256，64 位十六进制 |
| owner | object | `{ account: { environment, account_id, session_generation }, gid }`；必须精确匹配 |
| supported | boolean | v1 成功登记时固定 true；不支持的输入在登记前报错 |

DTO 不含路径、原始字节、上传 URL 或 token。快照不可变，源文件修改不改变已选字节；同名不同内容得到不同 attachment_id 与摘要。有效期为登记后 5 分钟，不跨账号、环境、登录代次或会话使用；发送前重新核对完整订单、服务、会话、JID 与身份。出站日志只存摘要和恢复元数据，不持久化附件名、内容、路径、URL 或 token。

## 限额与传输证据

| 类型 | 官方限额 | v1 支持范围 | 上传鉴权 |
| --- | --- | --- | --- |
| 图片 | 10 MiB | 0 < size ≤ 10 MiB；PNG/JPEG/GIF/WebP，解码尺寸须有效 | uploadTokenCreate `{channel:"im_business",type:"img"}` → image/v2；独立 Nephele Authorization + Content-MD5 hex |
| 文件 | 30 MiB | 0 < size ≤ 30 MiB | file/v1?channel=im&public=1；原始字节，无 token 请求、Authorization、Content-MD5；fetch credentials=omit |
| 视频 | 300 MiB、≤180 秒 | 仅 MP4，0 < size ≤ 30 MiB，解码时长 >0 且 ≤180 秒 | 独立 `{channel:"im",type:"video"}` token → video/v3 直传 + video/v1/proc |

单次附件准备上限 10 个；宿主内存和适配器字节缓存均有限额。宿主向页面分批搬运字节，每块最多 256 KiB，必须连续 offset、完整长度并校验 SHA-256；这是本机 IPC 搬运，**不是视频服务端分片协议**。30–300 MiB 视频的服务端 5 MiB 分片请求、合并与恢复流程尚无已验证契约，因此本地返回 `media.video_chunking_unsupported`，不会获取 token 或上传任何字节。超过 300 MiB 一律无效。

证据：[图片授权值来源](evidence/2026-10-30/44-image-auth-value-proof.json)、[文件完整契约](evidence/2026-10-30/33-controlled-file-full-contract.json)、[小视频直传样本](evidence/2026-10-30/68-controlled-video-upload.json)、[官方桌面被动截获第三轮](../reviews/2026-11-02-desktop-live-capture-verification.md)、[REA 功能限额](../reverse/2026-11-01-rea/01-frontend.md#发送与输入)。文件无鉴权是已捕获接口契约，不推广到其他文件服务；视频小样本不证明大视频协议。

## 错误和未知状态

| 错误码 / 返回状态 | 意义与后续行为 |
| --- | --- |
| media.invalid_attachment | 类型、大小、内容签名、作用域、摘要或期限不合格；登记/发送前拒绝 |
| media.video_chunking_unsupported | 超过 30 MiB 的受限视频能力未验证；零上传，不猜测协议 |
| im.invalid_send | 缺少/非法 local_id、gid 或载荷；零新提交 |
| im.intent_conflict | local_id 已绑定其他载荷或媒体类型；零新提交 |
| im.journal_io / store.io | 无法读写防重放记录；失败关闭 |
| im.journal_corrupt / store.corrupt | 持久化内容不合法；失败关闭，不清空后重发 |
| im.journal_durability_barrier | 已有记录或 commit 后的 fsync 校验失败；独立存储错误，不伪装为上游 unknown；禁止继续上传/发送 |
| not_submitted | 本地解码、准备或权限验证失败，无本次媒体提交 |
| rejected | 收到明确业务拒绝；日志保存通用原因，避免存入回显的正文 |
| unknown | 上传/发送可能已到达服务端，但结果未验证；必须人工核对，禁止自动重放 |

journal 先持久化 `upload_started` 才准上传，持久化 `uploaded` 只记录消息体摘要，再持久化 `write_started` 才准 SDK 发送。每步 commit 后均执行 durability barrier。崩溃恢复中的 `upload_started`、`uploaded`、`write_started` 与 `unknown` 全部是人工核对记录，任何一条都不授权重放；不存在自动恢复上传/发送队列。状态名称保留故障发生阶段，不要求把所有阶段重写成字面量 unknown。

同一 `local_id` 的再次调用只读已有结果/恢复元数据，绝不再次调用上游。主动再核对、重新发送的人工决策不得通过恢复代码自动做出；官方 SDK 同一次发送中的 socket/HTTP 回退须保持原 local_id。成功上传只表示存在资源；只有有效 `send_result` 或读回获得的服务端 ID 能标记 confirmed。

每账号/环境保留最近 256 条完整 completed 记录（完成时间降序，同时间按 local_id 排序）。更旧 completed 原子压缩为 `outbound_completed_fences`：local_id 键及原载荷摘要、gid、媒体种类、发送阶段和终态；仍可读回原终态并拒绝载荷冲突。所有未完成/unknown 记录不修剪，防重放标记也不自动删除；因此完整历史有上限，但标记与未决记录总量仍随使用增长。这是避免保留期结束后旧 local_id 意外重发的必要边界。

## 契约验证与实机边界

Rust 契约测试锁定版本号、DTO 精确字段、owner、按类型大小、快照与过期规则；journal 测试覆盖真实文件重开、并发 local_id、崩溃阶段、完成记录压缩、unknown 保留与 barrier 专用错误。适配器测试覆盖两种独立鉴权、匿名文件请求、禁止重定向、10 个活动附件、30 MiB 文件边界、超限零网络、未知上传/发送单次执行。

以上为本地合成测试和既有官方证据；本轮不发送真实消息。图片/文件/视频各 20 条上传→发送→官方页面读回、300 MiB 分片、20 次实际 WebView 故障恢复均未验收，不能标为 I-14 完整实机通过。
