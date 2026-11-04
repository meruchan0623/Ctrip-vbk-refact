# 同一原生实例跨文档的 adapter admission 设计

状态：**未实现、待独立复审、未做原生/浏览器验收**。2026-11-03 只读调查。本文不替代已经实施的跨原生实例身份修复。

## 决策与可证明边界

现有 Tauri/Wry 公共回调不足以兼容且严格地建立 document identity。候选架构需要补充 runtime 的主框架导航生命周期、短原子提交门以及带预期导航代次的 eval，随后在现有五个 adapter 命令上实施 host 发放的 document capability。接口关联和平台时序尚未证明，不能称为已经证明的“最小完整可实施路径”。它不是 renderer 自报 document ID；也不构成对恶意官方页面的隔离沙箱。

仅在当前 API 上可以实施响应串文档防护和保守拒绝；不能据此声明同实例旧文档入站已经封闭。特别纠正上一轮概念方案：当前 eval challenge 不带原生导航代次，不能单独作为可靠 admission。它可能在旧文档仍存活的 provisional 阶段执行，或排队后落到另一个文档。

远程权限仍为 adapter_ready / adapter_identity / adapter_push_fact / adapter_push_display / adapter_reply 和 event listen / unlisten 两项权限；不新增远程命令、事件权限或任意 eval 权限。现有事件主题是 adapter://request，两项 event 权限不是两个业务事件主题。

## 当前调用链证据

- `vendor/tauri-2.12.5/src/ipc/protocol.rs` fallback responder 的 `responder_eval` 调 `Webview::eval`；后者的 dispatcher EvaluateScript 只含 webview_id，没有 document/nav ID。macOS Wry `wkwebview/mod.rs::eval` 调当前 WKWebView 的 evaluateJavaScript。旧回复可能在新文档执行。
- `vendor/tauri-2.12.5/scripts/core.js` 每文档创建 callback Map，callback ID 为随机 u32。新文档通常找不到旧 ID 并警告；ID 碰撞则可以调用新文档 callback。不能把“通常 no-op”当隔离。
- 本机锁定 Wry 0.57.1。`wkwebview/navigation.rs::did_commit_navigation` 把 commit 转成 Started；`webview2/mod.rs` 把 ContentLoading 转成 Started。它们都不是完整的导航前撤销接口。
- macOS `navigation.rs::navigation_policy` 对 action 调 URL-only callback，没有过滤 targetFrame；runtime-wry 继续只转发 URL。不能区分 main-frame 与 iframe，也丢弃请求 method/body、redirect/导航标识。
- 初始化脚本在 document start 重跑；静态初始化字符串中的随机常量若在 native 创建时生成，只是 instance secret，不是每文档 secret。
- `src-tauri/src/profiles.rs::open_profile_window` 当前允许 HTTPS/about/blob/data 并继续导航；不能把本地 tauri.conf.json CSP 当成官方 HTTPS 页的文档限制。官方响应自己的 CSP 仍适用；IPC custom protocol 失败会 fallback postMessage，两个 transport 必须同等保护。

## 所需原生/runtime 接缝

以下均为拟新增内部接口，不是当前已支持的 API：

1. 每个原生创建的 InstanceId（跨实例补丁负责，本文复用）。
2. 主框架生命周期：BeforeMainNavigation、Committed、Failed/Cancelled、Destroyed；携带 native navigation identity/单调 ticket，能关联 redirects，能区分 main frame、subframe 和 same-document。Before 必须在允许真实文档替换前同步撤销 admission；不能只把现有 Started 改名。
3. 拟议 `eval_if_committed(instance, navigation, script)` 只能承诺在 runtime UI/native 队列调用 eval 前核验当前 revision。WK evaluateJavaScript / Windows ExecuteScript 后续仍经过 WebContent 异步队列，因此该比较不能证明脚本不会落到其他文档。必须同时有下节的 JS 执行时 sentinel/target 校验、单调 challenge revision 和返回 host 的 proof/ACK 核验。
4. 原生撤销和 host 最终短状态提交必须共用 DocAdmission 提交门；“可查询 gate + 发布前再比较”仍有 TOCTOU，不能只靠 host 异步 event 通知后才撤销。

macOS 可从 WKNavigationAction 的 frame 信息区分框架，但当前 policy action 与 commit 的 WKNavigation 之间没有已证的一一关联：当前 Wry 未接 didStartProvisional/redirect/fail，action 与 WKNavigation 也没有向上提供共享 ID。候选设计必须拆开 policy 同步撤销 fence 与 didStartProvisional 后保留的 WKNavigation ticket；后续 commit/fail 只匹配被保留的 ticket。重叠、缺失、取消关联不明时保持关闭，不能按“最近 ticket”或 URL 兜底。WKNavigation 本身也不是 IPC document ID。

Windows 的 NavigationStarting / ContentLoading / Completed 提供 NavigationId，SourceChanged 提供 IsNewDocument，但当前 Wry 丢弃相关参数。需要新增接线并原生验证事件顺序。两平台的 same-document、同 URL reload、redirect、back-forward/BFCache 均须先做生命周期 probe；未证明关联前只能保守重建或人工恢复，且要明确可用性代价。其他平台同样不能凭 URL 比较开放 admission。

## host 状态机

键为真实 InstanceId。记录：ViewContext、lifecycle_revision、native_navigation、phase、challenge、active_capability、可选 AccountContext/boot_epoch。旧票据的回调永远不能创建新记录。

| phase | 允许动作 | 转移 |
| --- | --- | --- |
| Created / Provisional | 无应用事实/身份/请求；READY只能有界等待或拒绝 | 原生主文档 commit -> Committed |
| Committed | host 生成一次随机 challenge，以 checked eval + 执行时 sentinel/revision guard 尝试激活目标文档 | -> Challenging |
| Challenging | 仅携正确 challenge 的 READY proof；不接受触发初始化的旧 payload | proof/ACK 在 DocAdmission 门内核 instance/nav/revision -> Admitted |
| Admitted | READY可获取同一文档的已有 boot；其余命令还需账号及业务校验 | main BeforeNavigation -> Provisional |
| Retired / Destroyed | 全拒绝；清除challenge/能力/监听/在途RPC | 终态 |

BeforeMainNavigation 在原生侧进入短 DocAdmission 门，同步递增 lifecycle_revision、关闭 capability/challenge/boot admission，并逻辑作废旧文档监听和在途 RPC。门外异步清理host表；只有最终提交也进入同一门才能保证旧消息不会发布。iframe 导航不撤销主文档身份；same-document 只有在原生已确认不替换文档时才保留。无法判别就暂停，不能凭 URL 相同恢复。

commit 只接受匹配的 native navigation，生成新 host challenge；不依据 URL 或 READY 自报值开放。失败/取消后旧文档可能仍显示，也不自动恢复旧 capability：需要 native 证明存活 committed document 后重新 challenge。BFCache 恢复同样走 fresh challenge，不复用旧授权。资源/超时/重试数量必须有界。

challenge 必须通过下面的执行时文档防护后，由该文档重新发 READY proof；在所有门与平台关联契约成立前，不能声称 proof 已证明正确文档接收。host 不通过原始无能力 READY 的 responder 返回 capability/账号，也不拿其旧 identity payload 继续发布。能力仅由可信初始化桥封装进命令 metadata，不作为任意 app payload 中的自报 id。challenge proof 不新增 command，复用 READY 子协议。安装/激活桥必须先于 adapter boot；boot 可以排队等待，但不能静默继续无 admission。

READY 的同一文档重试返回同一 boot，不反复 mint epoch。初次 account=null 后 IDENTITY 绑定成功，再次 READY只更新同一文档绑定结果；若业务确需新 stream epoch，单独明确幂等规则，不能让旧 READY 重签当前身份。

## JS 执行时防护和迟到 challenge

可信 document-start 桥为每个文档创建独立、不可替换的 sentinel，保存在闭包中；不能把 native 创建时嵌入的静态常量称为每文档 sentinel。初始 READY 携带 sentinel 只能作为目标关联提示，不授予权限。host 发出的激活脚本携预期 sentinel、原 instance/nav/revision 和 host 随机 challenge；脚本实际执行时先比较目标 sentinel，再在闭包中按单调 challenge revision 做 compare-and-set。旧 challenge 不得清除、覆盖或降级已经激活的新桥。

桥只在比较成功后发送 READY proof；host 在同一 DocAdmission 门内核验原 ticket、pending challenge 和 proof，随后返回 ACK。桥处理 ACK 时也需核原 sentinel/revision；在匹配 ACK 到达前，SDK session/推送/host请求执行保持关闭。导航、取消、超时或新 challenge 均使旧 proof/ACK 失效，不按当前 label 重新取 ticket。

这是对偶然迟到脚本和旧文档异步工作的关联防护，不是宣称 renderer 自报 sentinel 可信。授权依据是 host 随机 challenge 的受约束发放、执行时 target guard 与原生 gate 的联合校验；前提仍包含可信初始化桥和可证明的平台导航关联。同realm恶意代码、sentinel安装顺序/原生执行细节尚未验证，不在此推导为安全证明。fallback回复、Channel及事件JS同样需要执行时目标guard；只在host出队检查不够。

## DocAdmission 短提交门与锁序

必须覆盖如下反例：旧 identity 已在生命周期/出站事务中核验 ticket，随后原生 Before 关闭 admission，旧 identity 才写入 Cores。单独查询 gate 或最后一次无锁比较不能防止该发布。

候选门规定：Before 撤销，以及“核原 AdmissionTicket + 短内存状态 mutation”的最终提交共用同一个线性化点。二者只有一个先成功；若 mutation 先提交则它发生于撤销之前，若撤销先提交则 mutation 必须拒绝。门内不得做 IO、await、native/eval调用、SDK/网络请求，或等待生命周期/出站/存储锁。

拟定锁序为：现有 lifecycle -> outbound -> 具体 Cores/cache/pending/event-listener 域锁 -> DocAdmission 门。保持现有域锁的已证顺序；涉及多个域时先明确其顺序，不能临时倒置。host先获得需要的域锁，再短暂进门比较并执行纯内存提交；DocAdmission门内不再获取上述任何锁。原生Before只拿DocAdmission门并改小状态，退出后安排异步host清理，绝不同步等life/outbound，避免UI等待长事务。

Keychain、fsync、磁盘和其他慢工作必须在门外stage，完成后仍使用原ticket进入短提交；不得重新获取当前ticket把旧stage升级。stage产物必须在提交前保持不可见/不可用，失败或失效后可清理。若现有事务无法将外部写入与短状态提交分开，需要先重构；不能把已生效的外部副作用称为未发布。已触达上游的出站操作保持unknown/核验语义，不因导航声称撤回。

门内只记录带ticket的后续通知/清理意图；门外emit/native调用再次走执行时guard。不能为了把emit塞进原子区而在门内调用native。门持有时间和嵌套锁顺序须通过专项测试/测量核实，当前仅为设计要求。

## 五个命令的落点

现有集中入口是 `ui/packages/web-adapter/src/boot.ts::call`；reply 在 `startRequestListener` 中另行调用 host.invoke，必须同时覆盖，不能只改 call。

| 命令 | 当前页面调用 | host 必须校验/绑定 |
| --- | --- | --- |
| READY | boot 初次 READY；身份后 account=null 时 bounded retry | proof前无副作用；原子绑定 instance/nav/revision/capability/boot，重试幂等 |
| IDENTITY | readIdentity 后 call(IDENTITY) | admission先于登录/存储事务；慢stage后在DocAdmission门内核原票据并短提交；不得借当前 label 的新 binding |
| PUSH_FACT | invokeForAdapter 把 im_push_fact 映射到 adapter_push_fact；Bridge队列后发送 | 每次真实发送带原文档capability；BridgeFault同样先核文档，再核boot lease；普通fact仍核完整账号和cursor，旧队列不得升级到新capability |
| PUSH_DISPLAY | createPageSession 的 pushDisplay callback | 写 display/agent-status/emit 前核 admission；当前 bound_caller 账号检查继续保留 |
| REPLY | startRequestListener 中 session.rpc.handle(...).then(reply)，另有notReadyReply | PendingEntry增加精确文档绑定，complete核 account+document+req_id；旧文档reply不能完成新文档pending |

所有 host helper 要接收不可变 AdmissionTicket；await 后/事务最终发布必须在短提交门内比较该 ticket 并完成短 mutation，不按当前 label 重新签发。已进入上游的写操作在导航时不能伪称撤回或失败：维持现有 unknown/核验语义，不能因 handshake 自动重发。

## host -> page 与回复

`adapter.rs::request_inner` 当前取 label，`dispatch_pending` 的 PendingEntry只有account，事件只有req_id/op/args。需在登记pending时固定 admitted document，消息携document绑定，投递前再核ticket。页面在执行任何SDK动作前核匹配；异步SDK结果只回复原ticket。

现有 boot 在 READY 前订阅事件，session=null时发送notReadyReply。改造后未admitted监听不得执行SDK，也不能用旧notReadyReply完成其他文档pending。可以在激活后订阅并await真实listen完成，但页面gate和await本身不是host注册隔离。

vendor event plugin 的 listen/unlisten 是async命令，初检通过后仍可能延迟进入 listen_js/unlisten_js。最终JS安装、host listener-cache注册、删除、emit/销毁清理均须保留不可变ticket和精确scope，不能在future恢复时重新取当前文档。旧注册future不得向新文档安装监听；旧unlisten不得删除新文档条目。注册与删除的内存变更须在对应域锁 + DocAdmission短门内提交；JS执行仍核sentinel/revision；emit在门内记录ticket，门外受guard投递。

并行产品补丁已增加ReplyDocument/source关联、作用域删除和JS包裹；本文不将复审前“全表按id删除”的旧基线当成现状。ReplyDocument回复关联措施并不代替上述原生Admission提交门，也不证明旧async注册future无法在撤销后写缓存。

fallback eval 的JS必须在执行时核文档token，再调用runCallback。Channel响应及event listener分发也要绑定文档。custom-protocol HTTP response原本返回原fetch context，但host副作用仍必须查admission；不能因HTTP responder正确而跳过入站防线。原生异步回复应携旧ticket，不因账号/label仍相同而重新授权。

## iframe、登录和 recreate

当前URL-only on_navigation若对每次回调撤销，然后等待主文档commit，iframe导航可能永远等不到对应main commit而卡住。若定时challenge恢复，又可能在主导航尚provisional、旧文档仍可执行时把旧文档重新授权。故“所有导航撤销 + debounce/eval恢复”不是证明完整的兼容方案。

把所有导航变成recreate也不透明：会误处理iframe，缺method/body不能重放POST，丢SDK运行态、在途操作及页面瞬时登录状态，并改变后台恢复目前的reload语义。仅当前接口可采用的强保证是极保守单文档模式：拒绝额外导航、用户显式重新登录/重建；它应作为降级产品选择，不能当兼容修复。

候选的最小完整改造范围：仅给acct-*补上述runtime主框架生命周期、执行时guard、DocAdmission提交门和五command/event统一ticket；目标是保持官方登录/子框架导航行为，不引入代理页面、不重写官方CSP、不新增远程ACL。平台关联尚未证明，不能把这个范围描述为已证可实施的完整路径。login-remote仍走现有无adapter权限登录流程；其候选/退出生命周期继续遵守已实施的账号源身份检查。

## same-realm 威胁边界

当前adapter依赖官方main-world SDK、fetch/XHR和DOM，官方页面本就能调用获准的五个命令。闭包保存capability/捕获原始transport减少误用，不创造对恶意同realm页面的安全隔离。页面可替换SDK、对当前桥发起合法调用，事件callback也在同realm；document能力不能让host信任业务内容本身。

本文目标是旧文档异步队列/响应不被当作当前文档，不是抵御被攻陷官方站点。若需后者，应加入平台isolated world/native channel及严格main-world SDK代理；当前Tauri/Wry API和现有boot不足以证明。这是独立架构成本，不能用不可写window属性或renderer随机nonce替代。

## 分阶段与验收

1. 最小实际第一段是每平台仅做生命周期probe：主框架/iframe、reload、重叠导航、redirect、取消/失败、same-document、BFCache以及队列延迟矩阵。先证明关联能力；不能先按猜测接完整admission。macOS action撤销fence与retained WKNavigation ticket的关联须独立过审。
2. 可独立先做回复token fence和pending文档绑定，只声明减少串回复。下一段实现并测试DocAdmission短提交门；然后接checked eval + JS执行时sentinel/target guard +单调challenge revision + proof/ACK门内核验。
3. 最后把五command、event最终注册/删除/emit与pending全部统一到原不可变ticket。旧队列只取消或保留unknown，不升级票据。没有平台接缝证据与原子门时不启用“完整document admission”声明。
4. 本机harness至少覆盖：旧proof/ACK晚到、旧challenge不能覆盖新桥、新READY不重签、eval在UI核验后到WebContent执行前换文档、旧identity核验后Before撤销再mutation、磁盘stage后撤销、旧listen/unlisten future最终提交、旧emit排队跨commit、两个transport、销毁及限额。断言撤销与mutation线性化、门内无慢操作、UI不等life/outbound；不能只测最终比较返回false。
5. Native验收另证真实框架分类和事件顺序：macOS/Windows iframe不撤销主session、POST登录不丢body、redirect不循环、重叠/取消不猜最近导航、新文档admission前零事实/零SDK命令、导航中出站不自动重试。脚本VM或mock runtime不能替代这些结果。

本轮仅阅读产品源码、写本设计文档；没有实施以上状态机，没有浏览器/原生应用操作。前轮实际core.js的Node VM三例只验证回复callback行为，不是完整admission实现测试。

修订依据：Round8独立设计复审（fix_review）指出native eval异步队列、async event最终提交、Admission核验TOCTOU及macOS导航关联四项缺口。本文已纳入设计要求；这不代表对应平台实现已验证。
