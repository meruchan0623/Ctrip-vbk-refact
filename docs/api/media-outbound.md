# 附件选择、上传与单次消息提交

2026-10-31 Windows第6轮实现。此文描述候选源码契约，真实平台上传、三端读回和新包验收尚未通过；最终提交/包身份以当轮运行记录为准。运行依赖已登录的官方页面、官方SDK和本地Tauri宿主，不是脱离浏览器的携程API。

## 入口与归属

`media_pick{account,gid,kind}`与`media_screenshot{account,gid}`只从主窗口准入，先在对应账号页面获取目标凭据，再打开本地选择器。返回的opaque attachment含id、basename、kind、MIME、size、内容SHA256及完整AccountContext/gid；本地路径不离开宿主。对话框返回后重新核对账号、session_generation及页面目标；UI另核对选择实例、gid、草稿版本。旧会话或旧选择的晚到结果不能进入新composer。

页面目标绑定room、订单、客户、service session、conversationType/serviceType、thread、conversationKey、worksheet、本人UID、AccountContext及页面运行代次。一个字符串别名不能代替gid；缺必要身份字段拒绝。目标凭据和本地附件有5分钟期限，过期需重新选择，不复用旧授权。

宿主读取文件时冻结有界bytes，并校验读取前后长度/修改时间；Windows读取句柄禁止并发写/删除。SHA256覆盖冻结内容，同名异内容为不同附件；选择后路径被替换不会替换已冻结的消息意图。仅允许由宿主登记的附件ID，UI不能传任意路径或外部URL要求上传。

资源限额为宿主4个live bytes快照/128条轻量metadata；页面16个active target、合计20MiB暂存bytes/128条transfer，均设5分钟有效期，后续登记/选择时惰性清理，不设定时回收器，空闲快照可能仍驻内存。取消选择、登记失败、发送完成及UI放弃旧归属会释放本地资源；`media.release`撤销该目标的后续准入，竞争请求的`media.discard`只丢自己的暂存transfer而不撤销赢家目标。终态释放active target与bytes，保留轻量单次attempt信息至TTL；这些释放绝不清持久账本，也不解除unknown重传/重发屏障。

首版所有种类每个附件上限10MiB，这是本客户端资源限制，低于部分官方静态限制。图片按PNG/JPEG/GIF/WebP内容头识别并实际解码取尺寸；视频为可解码MP4，实际metadata时长必须大于0且不超过180秒。一般非空文件保留原bytes/name，PDF内容头识别为application/pdf，其它采用application/octet-stream，不因扩展名伪称内容类型。Windows截图捕获仍返回HOST_UNSUPPORTED；截图按钮未完成不能算媒体功能已完整。

## 传输与持久屏障

主命令 `im_send_media{account,gid,local_id,attachment_id}`与文本共享稳定environment/account/local_id命名空间；改变种类、bytes摘要、MIME、basename、size、gid或完整目标摘要不能复用同一意图。附件从宿主以不超过256KiB的base64块，经已有定向account WebView RPC桥传入页面；逐块校验顺序、长度、总量、目标和最终SHA256。没有新增远端文件读取权限、asset路径、localhost服务或通用URL代理。

| 持久阶段 | 才可执行的下一步 | 重启/重复请求 |
|---|---|---|
| upload_started | 一次token/上传链；完整文件/目录同步必须成功 | 不重新上传；write_started=false，不能拿消息历史未找到作为未上传证据 |
| uploaded + canonical消息payload SHA256 | 再次完整目标重核，准备SDK消息 | 不重传也不发送；资源URL只在当前进程内存中，重启不靠磁盘签名URL恢复 |
| write_started +同一payload摘要 | 一次SDK提交 | 不重发；无权威回执为unknown |
| completed | 显示明确confirmed或rejected结果 | 仅回放结果，不能再次触发上游 |

任一落盘/目录同步/目标校验失败关闭下一步。上传成功不是消息confirmed；HTTP200和缺少有效服务端ID也不是confirmed。上传回包丢失、SDK异常或回执丢失保持unknown。unknown只允许无副作用核验，不能用历史刷新间接标已读或清除账本；第1轮旧unknown仍不能补造。

图片沿用im_business/img token与image/v2原bytes签名链；文件沿用file/v1原bytes独立上传，不套图片签名；视频沿用im/video token、v3上传及v1 proc链。图片scene已对照本机官方静态前端和历史44证据，详见[Windows重核](../research/2026-10-31-windows-resurvey.md)。每个网络步骤只有一次尝试，前后重核目标；视频proc失败也不重新上传。只接受官方允许域的HTTPS资源，并按对应种类校验canonical消息：file.filename对应本地basename；video.filename来自官方上传回包，宿主要求非空而不冒充本地文件名；图片协议没有size字段，不能声称已核对该字段。

正文、路径、token、资源URL和附件原bytes不落出站账本；持久内容为归属、local_id、阶段、时间、hash和结果。字段扩展兼容读取旧文本记录；旧文本write_started不能因新增send_started缺省false而被解释为未提交。回滚到不认识新媒体阶段的旧二进制会拒绝解析，应保留账本并停止写入，不能删记录或退回pending以便继续发送。

## UI与核验

选择受支持且归属正确的附件后，主发送仅调用媒体命令；文字与引用保留，按钮和提示明确“仅发送附件”。不会暗发第二条caption、拼文件名文本或绕过旧译文按钮的附件阻断。媒体消息没有文本重发按钮，busy和同附件已尝试屏障防双击；进度只显示准备/上传/提交等真实阶段，不伪造百分比。

上传尚未进入SDK的记录与消息提交结果分开显示。`im_unknown_outbound`的upload_started/uploaded记录含write_started=false，UI可读但不能选择消息页核验；write_started/unknown且true才可用既有专用lookup。核验找到唯一服务端记录也不自动结算、解锁或重发。

重复local_id先查账本，避免重新暂存/上传。仍有可核验原附件manifest时才可正常回放；同local_id换有效附件manifest或跨text/media类型拒绝。原附件已消失时回包标记`replay_only=true`，只能作为旧metadata核验，不能把当前新附件占位消息补confirmed、清空当前附件或解锁它；旧confirmed不证明新内容被发送。

移除本地附件只释放选择，不等于撤回上游资源/消息，更不能清除持久屏障。异步发送结果只能更新原账号/gid/local_id；不能清除用户后来编辑的文字/引用。客户端切账号后不将旧媒体回执、发送者或进度投影到新账号。

## 验证边界

必须保留所有旧未注册附件阻断、文本回执、草稿、引用撤回和unknown核验判据。新增覆盖实际UI入口、真实RPC/上传链、真实FileStore持久阶段和文件快照；故障注入需先红后恢复。最终计数、独立复审结论及产物hash写入当轮记录；本文件不将中途工作树绿态称为冻结验证。

未完成：真实受控图片/文件/视频的客户端→官方读回、官方→客户端自然接收、真实出站unknown的跨进程恢复、系统截图（Windows）、大视频分片、长期对象存储/病毒扫描/过期URL再授权与全平台权限。移植到TSim还需独立数据库attempt/资产服务和权限设计，见[迁移说明](../integration/tsim-cs.md)。
