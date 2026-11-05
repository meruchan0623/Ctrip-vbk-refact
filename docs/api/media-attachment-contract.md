# 媒体附件登记契约（v1，已冻结）

`ATTACHMENT_CONTRACT_VERSION = 1`

owner：I-14（媒体发送链路）。消费者：I-05b（恢复边界，依赖 `unknown` 语义）、I-30f/g/k（转发、评价、自动答复，新增 journal payload 类型须向 I-14 提变更）。

本文是契约的**正文**；`vbk/crates/core-im/src/media_contract.rs` 是它的机器可校验副本。该文件的契约测试会读取本文并核对每个字段名、错误码、限额数值与上传路由，任何一边漂移即测试失败（见末节）。TypeScript 侧镜像 `vbk/ui/packages/web-adapter/src/media-limits.ts` 由 `media-limits.test.ts` 读取本文做同样的核对。

**变更规则**：字段、错误码、`kind`/`stage` 取值、上传鉴权模型、限额或 `unknown` 语义的任何变化都必须同时 (1) 将 `ATTACHMENT_CONTRACT_VERSION` 加一，(2) 更新本文与契约测试，(3) 通知 I-05b。仅追加注释、示例、实现细节不算变更。

证据状态：限额与两种上传鉴权来自官方桌面版实机截获（`docs/reviews/2026-11-02-desktop-live-capture-verification.md` 第三轮、计划附录 A）；本客户端的真实上传→发送→读回仍是 C 类，未在目标机验证，见末节「未验证」。

## 1. 登记接口（v1 签名）

附件由宿主**登记并冻结**为不可变快照；本地路径、字节、资源 URL 不离开宿主，UI 只持有不透明的 `attachment_id`。

| 接口 | 形态 | 说明 |
|---|---|---|
| `media_pick` | Tauri 命令 `{kind, account, gid} -> Option<MediaAttachmentDto>` | 系统文件选择器；先取页面目标凭据再开选择器 |
| `media_release` | Tauri 命令 `{account, gid, attachment_id} -> ()` | 只释放本地选择；不撤回上游资源，不清 journal，不解除 `unknown` 屏障 |
| `im_send_media` | Tauri 命令 `{account, gid, local_id, attachment_id} -> MediaSendResult` | 唯一的媒体出站入口；全部语义见 §4、§5 |
| 登记函数（宿主内部） | `register_attachment(app: &AppHandle, path: PathBuf, kind: String, account: AccountContext, gid: String, target: MediaTarget) -> Result<MediaAttachmentDto, AppErrorDto>` | 位于 `shell.rs`，模块私有 |
| 内部读取 | `FrozenAttachment::read(path: &Path, kind: &str, account: &AccountContext, gid: &str, target: MediaTarget) -> Result<FrozenAttachment, AppError>` | 冻结有界字节，校验读取前后长度与修改时间，按内容头识别 MIME |

截图（原消费者 I-17）已取消，见[决定](../decisions/2026-11-05-no-screenshot.md)。

## 2. `MediaAttachmentDto`

Rust 类型 `media_outbound::AttachmentDto`（别名 `MediaAttachmentDto`），TS 类型 `UiAttachment`（`ui/packages/ipc/src/client.ts`）。线格式字段（全部必有）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `attachment_id` | string (UUID v4) | 宿主生成的不透明 ID；同路径重复选择得到不同 ID |
| `name` | string | 文件 basename，非空、≤ 512 字节、不含控制字符和路径分隔符 |
| `kind` | `"image"` \| `"file"` \| `"video"` | 种类；由调用者声明，宿主按内容头校验，不按扩展名推断 |
| `mime` | string | 由内容头得出：PNG/JPEG/GIF/WebP、`video/mp4`、`application/pdf`，其余文件一律 `application/octet-stream` |
| `size` | number | 冻结字节数；> 0 且满足 §3 的该种类上限 |
| `content_sha256` | string (64 hex) | 冻结内容摘要；同名异内容必不相同 |
| `owner` | object | 归属，见下 |
| `supported` | `true` | v1 恒为 `true`；不受支持的附件在登记阶段即拒绝，不会返回 `false` |

`owner` 的字段：`account`（完整 `AccountContext`：账号、环境、会话代次）与 `gid`。附件只能被同一账号、同一 `gid` 的 `im_send_media` 使用；附件与页面目标凭据均有 5 分钟有效期，过期须重新选择。

## 3. 限额（本地拒绝，先于任何暂存、上传、落账）

| 常量与值 | 含义 |
|---|---|
| `IMAGE_MAX_BYTES` = 10485760 | 图片 10 MiB（含） |
| `FILE_MAX_BYTES` = 31457280 | 文件 30 MiB（含） |
| `VIDEO_MAX_BYTES` = 314572800 | 视频 300 MiB（含） |
| `VIDEO_MAX_DURATION_MS` = 180000 | 视频时长 ≤ 3 分钟（含）；无法解出时长的视频一律拒绝 |
| `MAX_FILES_PER_SEND` = 10 | 单次发送动作 ≤ 10 个文件 |
| `VIDEO_CHUNK_BYTES` = 5242880 | 视频分片大小 5 MiB |
| `DIRECT_UPLOAD_MAX_BYTES` = 31457280 | 直传阈值 30 MiB（含）；更大的只能分片 |

实现：`core_im::media_limits`（`check_attachment`、`check_batch`、`plan_upload`、`chunk_range`、`check_sendable`，std-only 纯函数）与 TS 镜像 `media-limits.ts`。

**当前构建的真实能力**：直传路径已实现；**分片上传尚未实现**。因此 30 MiB 以上的视频虽在官方限额内，本构建以 `media.chunked_upload_unsupported` 在本地拒绝（nothing submitted），而不是假装能发。实现分片后删除 `check_sendable` 的第二步即可，不需升版本号（拒绝集合缩小，线格式不变）。

本地拒绝码（全部表示「未提交任何内容」）：

| 错误码 | 触发 |
|---|---|
| `media.invalid_attachment` | 格式、尺寸、归属、有效期不合法的通用拒绝（已有，保持不变） |
| `media.empty` | 大小为 0 |
| `media.too_large` | 超过该种类上限 |
| `media.video_too_long` | 视频时长 > 180000 ms |
| `media.video_duration_unknown` | 视频时长缺失或为 0 |
| `media.too_many_files` | 单次 > 10 个文件 |
| `media.chunked_upload_unsupported` | 在官方限额内，但需要分片而本构建未实现 |
| `media.unknown_kind` | `kind` 不是 `image`/`file`/`video` |

## 4. 上传鉴权：图片与文件是两个模型

不得共用一个 token 流程。

| 种类 | 取 token | 上传 | 头 |
|---|---|---|---|
| `image` | `POST m.ctrip.com/restapi/soa2/16037/uploadTokenCreate {channel:"im_business", type:"img"}` → `{token}` | `POST nephele.ctrip.com/image/v2/api/upload?channel=im_business&scene&rand`，原始字节（非 multipart） | `Authorization`、`Content-MD5`（字节的 MD5 十六进制）、`Content-Type` |
| `file` | **无** | `POST nephele.ctrip.com/file/v1/api/upload?channel&public`，原始字节 | **无** `Authorization`、**无** `Content-MD5` |
| `video` | `uploadTokenCreate {channel:"im", type:"video"}` | `POST nephele.ctrip.com/video/v3/api/upload?channel=im&rand`，随后 `/video/v1/api/proc` | `Authorization`、`Content-MD5` |

随后三者都以 XMPP `message type=send` 提交消息；同一 `local_id` 在 socket 失败回退 HTTP 时保持不变。上传成功不是消息 `confirmed`；HTTP 200 与缺少有效服务端 ID 也不是。视频行来自本客户端既有实现，官方桌面版本轮未截获视频上传，**视频鉴权模型是推断，标为未验证**。

代码侧模型：`core_im::media_contract::{UploadAuth, UploadRoute, upload_route}`；实际调用在 `web-adapter/src/upload.ts`（`uploadImage`、`uploadFile`、`uploadVideo`）。

## 5. `im_send_media` 结果与 `unknown` 语义

结果 `MediaSendResult` 线格式字段：`replay_only`（仅为真时出现）、`stage`、`kind`、`write_started`、`disposition`、`message`、`error`。

- `stage`：`prepare`（本地准备，尚无账本）、`upload`（上传阶段）、`send`（消息提交阶段）。
- `kind`：
  - `not_submitted`：未提交任何内容，**没有**账本记录。同一意图可复用同一 `local_id` 再次发送。
  - `confirmed`：有服务端消息 ID 的明确确认；终态。
  - `rejected`：明确拒绝（含上传被拒）；终态，仅回放，不再触达上游。
  - `unknown`：已开始写入但无权威回执。**不重放、不自动解决**。

规则（v1 冻结）：

1. **`unknown` 绝不重放。** 任何 `unknown` 记录——无论是上传阶段还是消息提交阶段——都不授权第二次上传或第二次 SDK 提交，包括进程重启、换账号代次、重复点击、同 `local_id` 重试。唯一允许的是只读核验（`im_unknown_outbound` 列出元数据，`im_outbound_lookup` 读最新页）；核验命中也不自动结算、不解锁、不重发。之后若要再发，是用户明确发起的**新意图**，使用新的 `local_id`。
2. 重发复用 `local_id`：同一意图（含传输回退）始终用同一 `local_id`；账本按 `local_id` 回放已记录的状态，不触发第二次上传/发送。`local_id` 若关联了不同种类、摘要、MIME、basename、size、gid 或目标摘要，返回 `im.intent_conflict`。
3. 上传阶段记录 `write_started = false`，消息阶段记录 `write_started = true`；`upload_started`/`uploaded` 的 `unknown` 不能用「消息页没找到」当作未上传的证据。
4. 原附件已不在时，回包带 `replay_only = true`，只作旧元数据核对，不能把当前新附件补成 `confirmed`。
5. 账本只存归属、`local_id`、阶段、时间、哈希与结果；不存正文、路径、token、资源 URL、字节。

代码侧：`core_im::media_contract::{next_action, Next, may_reach_upstream_again}`。

### 账本两类错误：独立于 `unknown`

- `im.journal_barrier_failed`：账本记录**已提交**，但随后的持久化屏障（文件/目录同步）失败。此时宿主既不回滚，也不把它说成 `unknown` 发送：本次调用不放行任何后续步骤（不上传、不提交），记录保留，之后同 `local_id` 的调用按记录回放。它与 `im.journal_io`（提交前的存储失败，记录未写入）不同。
- 已完成（`confirmed`/`rejected`）记录有保留上限：默认最近 2000 条且不超过 30 天，超出者在下次落账时删除；**`unknown` 与进行中的记录永不删除**。实现 `core_im::retention::prune_keys`。

其它账本码：`im.journal_unavailable`（存储不可用，未提交）、`im.journal_corrupt`（记录无效，禁止写入）、`im.intent_conflict`（见规则 2）。上传被拒时落账 `media.upload_rejected`。

## 6. 契约测试与未验证项

已锁定（`cargo test --offline -p core-im`、web-adapter 的 `media-limits.test.ts`）：版本号、DTO 与结果字段名、`stage`/`kind` 取值、全部错误码、限额常量与边界、直传阈值与 5 MiB 分片切分、图片/文件两种鉴权模型的差异与路由、`unknown`/`not_submitted` 的下一步语义、已完成记录保留且保留 `unknown` 的选择函数。

未验证（A 类代码已落盘，C 类需目标机/受控账号，不得视为完成）：

- 图片、文件、视频各 20 条（含边界值）真实发送并在官方网页读回（验收 ②）。
- 发送中途杀进程 20 次的 0 重放（验收 ③）；单元与进程重启测试覆盖账本，但不是实机。
- 文本 200 条 `confirmed` 与官方一致、`send_result` 时延基线（验收 ④⑤）；本项不改文本传输。
- 分片上传（> 30 MiB 的视频）未实现，见 §3。
- 视频上传鉴权模型未经官方桌面版截获印证。

## 2026-11-03 持久草稿扩展（第六批实现中）

此扩展保留媒体协议 v1 的现有字段与发送路径。`MediaAttachmentDto` 增加可选 `lease_id`：它是账号与会话隔离的本地持久引用，不是页面 token，也不能单独授权读取或发送。`attachment_id` 仍是当前登录代次、当前目标绑定下的短期句柄。

- `im_draft_load` 保留原 `gid/text/version`，增加 `attachment_version` 及最多一个 `attachments` 条目。条目包含 `lease_id/name/kind/mime/size/content_sha256/state`；状态为 `ready/missing/corrupt/pending`。`pending` 说明该资源仍有关联的未决发送，不能以新 local_id 再发。列表中的 `ready` 仅表示路径和长度快筛可进入恢复，不是内容校验或发送授权；恢复与发送预留仍完整验证摘要与长度。
- `im_draft_save` 仅更新文字，保留附件。文字版本与附件版本分别进行 CAS。
- `im_draft_attachment_save {account,gid,attachment_id|null,expected_version}` 仅更新附件引用，返回 `{attachment_version,attachments}`。非空句柄须属于当前账号代次与会话；空值是显式移除。附件变更成功提交后 UI 才发布新选择；冲突不能自动重放旧附件意图。
- `im_draft_attachment_restore {account,gid,lease_id}` 只恢复当前持久引用，并重新取得官方页面当前会话目标，校验本地内容长度、摘要、资源状态后发新短期句柄。缺件、损坏或未决发送均阻止恢复为可发附件。

文件先在账号隔离区域持久落定，再由同一 outbound store 事务更新草稿/租约引用；发送预留与 outbox 引用也共同提交。旧 unknown 账本留在原位置，不迁移或重发。发送确认时，仅原草稿仍匹配预留的租约与附件版本才清附件引用；后续新编辑与文字不受影响。未知发送保留引用，移除草稿不能解除 unknown 账本屏障。

旧文字草稿从主 store 一次性导入；目标记录和迁移标记共同提交，源保留且不双写。锁定、损坏或导入失败不得当作空草稿完成迁移。降级版本仍会看到旧源快照，不能把这一行为称为跨版本双向同步。

本节描述目标与当前接线契约，最终真实文件系统、浏览器与平台验收结果见第六批审查记录，不能仅凭契约文字认定功能已通过。
