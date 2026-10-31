# 已读回执绑定当前可见消息与服务身份

基线：7b7cbb6（包含已独立验收的首次列表前 pending preview 修复）。独立快照开发，不操作主仓库 index、Cargo target 或线上客户消息。

原问题：实际 upsertConversation 在首屏 loading/error、消息列表为空时仍发回执；仅 gid 的适配器又在执行时选择最新消息。第一次实际回归为 1 !== 0。已删除预览/打开会话的即时回执，统一重绘与锚点恢复后检查可见唯一 DOM 行、首屏 loaded、完整账号/环境/代次/gid、窗口焦点及无遮罩；滚动/恢复焦点同样重新核验。

后续实际反例：同 gid 的客户/服务 A（消息时间高）换成 B（时间低）后，latest 仍 A，旧 expected_message_id 仍被 SDK 接受。现强制 expected_context_revision 与 expected_message_id；前者复用已有 opaque assistant_context_revision，必须与后端当前服务一致，后者必须精确匹配当前 latest。目标 room 还必须与权威会话 row 的 room 一致，所有 epoch 均检查，不能信任 SDK 被旧帧覆盖的房间缓存。SDK await 后再核服务/运行代次，迟到成功不背书新服务。任何 ack 都不清本地未读。

历史来源：首屏请求捕获 revision，通过 im_message_page 的可选 expected_context_revision 由后端在请求前后验证；UI 返回后还核当前 revision，history entry 和 DOM 消息窗格保存来源 revision。旧 history 不能仅因最新预览到达而被贴上新身份；显式重开新 revision 会清旧消息缓存再读取。earlier 请求与完成也核来源。无 revision 的纯历史只读调用仍兼容，但不能提供自动已读凭据。

存储与迟到来源：ConversationStore 使用单调服务 epoch，A→B→A 也不能复用 A 的旧证据；身份变化清旧 latest，权威新 row 可以建立更低时间的 B 目标。所有服务（包括首次观察的 epoch=1）只允许权威会话 row 的内嵌最新消息推进已读目标。gid-only 历史、补偿、实时或未读响应不证明新服务归属，因此不推进目标，可能延迟自动已读直到官方列表追上；历史展示与可确认已读范围分开。历史 RPC 的 epoch 校验拒绝跨服务在途响应；未读刷新在写 count 前核请求时 epoch/运行代次，身份切换先失效旧 count。初始 pending preview 保留原有客户/房间/thread/时间围栏，通过后只提升预览，不把其 ID 当成当前服务的已读凭据。

去重：每个完整账号/会话/服务 scope 保留全部已尝试目标集合，不自动淘汰；结果不明不因重绘/焦点/自动切换重试。用户显式重开可释放该 scope 已结束尝试，不能释放在途尝试。独立审查发现原全局 256 项淘汰会忘记其他会话的未知结果；257 scope 反例旧目标发送 2 次，修改后 1 次。记录随尝试目标数量增长，用户显式重开可释放本 scope 已结束记录；不能以更晚目标推断此前未知结果。

证据：actual-upsert 真红→绿；实际 RPC missing-target/missing-context/same-gid-old-customer 真红→绿；store/history 对照旧实现四个反例 0/4，新专项 28/28；覆盖 A→B→A、duplicate row、gid-only 高时间污染、旧 history/未读完成、首次服务错误 SDK room、在途回执切服务、实际 UI 首屏/earlier 来源。当前最终全量结果及独立复审结论由交接记录补齐。

限制：未进行原生已读实测或 Cargo 构建；host 参数透传由集成 owner 随最终包验证。本任务没有向客户发送消息或已读回执，不能将模拟回归写作实机通过。

读恢复补强：会话投影新增可选 read_target_message_id，session 来自当前 store latest，host 原样透传，UI 只对这一个目标的唯一可见 DOM 行发回执，不从混合历史最高时间推断。null/缺失禁止自动已读；非字符串、空白、超过 512 个 UTF-16 单位拒绝。复用 gid 后，未获当前目标确认的实时/补偿消息可作为同 gid 历史展示，但不能覆盖当前服务 preview。实际 A→B→迟到 A-high→权威 B-new 回归验证最终 preview/frontier 都是 B；UI 保留更高时间 A 历史时仍能选择可见的 B 目标。新增 host metadata 边界回归，交集成 owner 运行。

最终独立复审：无剩余可证 P1/P2；80/80 专项通过。独立完整 session→visible helper→actual RPC 链路在 A→B→迟到 A-high→B 权威列表后，preview、frontier、UI 选择、SDK 提交均为 B-authoritative-new，未提交 A 回执。最终前端全套及 bundle 见交接日志 service-read-tests.log，Rust/native 仍由集成 owner 验证。

合并复审追加两个实际 P2 后的增量：首次直接加载 B 时历史 A-high 也能污染 epoch1 frontier；现移除所有 gid-only noteMessage 入口，所有 epoch 统一 row-only。root 原样脚本从 frontier A/SDK[A] 真红变为 frontier B/SDK[]（仅 A 可见）。另同 scope 等时间权威 A→B→A、SDK 每次抛不确定结果，last-target 去重会发[A,B,A]；改持久集合后原样脚本只发[A,B]且无显式 retry。新正式回归覆盖实际 session/history/helper/RPC、SDK/补偿/未读不推进，以及显式重开才允许再次 A。

移除 previewTime 大于目标时间的推断门禁：只检查精确权威 frontier 的可见性，旧高时间预览不能阻塞已确认可见 B。权威 frontier 已更新但新 ID 尚未渲染时仍零调用；后端始终将同一 expected_message_id 原样传 SDK，不用更晚最新消息替换，且不本地清未读。
