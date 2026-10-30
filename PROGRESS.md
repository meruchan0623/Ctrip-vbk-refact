# VBooking 消息面板对齐（2026-10-31）

## 当前执行断点：2026-10-31 /goal 任务 0
- 已读三份断点文档并完成 7 行开工回执；保留 24 个跟踪改动及 6 个未跟踪文件，HEAD 00efc740。
- 基线复核：TS 202、核心 Rust 300、宿主 58，失败/跳过均 0；typecheck、diff 检查通过。TS 原始输出 /tmp/vbk-goal-baseline-ts.tap。
- ego-browser 复用 TaskSpace 1/p1，网页登录有效，标题客户与侧栏订单双核成功；本轮已由真实iframe解析gid（见下），尚未出站。
- 旧客户端 PID 7441，仍为 release/macos；新旧 hash 与重勘记录一致。官方 1.2.12、安装器 0.7.5、助手 0.3.2。
- 官方原生连接本轮失败为 NSOSStatusErrorDomain -1712 errAETimeout；助手日志末态 attached=true / auth=failed / phase=failed / verified-editor。
- 统一展示出口未读防护已提交 `c806ad7674f803c7b4c7751705ef63f49219ed39`，真实回归红 `0 !== 3`→绿1项；完整工作树TS203通过。独立暂存快照TS190（HEAD189+新增1，未包含继承成果）、typecheck、bundle:ui通过。
- 独立评审指出的宿主ACK强清零已在ab0b751修复；原生端到端未读验收未完成。
- 三端复核：自制旧包登录/消息面板原生可读，助手原生仍 timeoutReached。官方订单/客户双核后由实际侧栏 iframe 解析gid，原值仅存 /tmp/vbk-goal-20261031/controlled-frame.json。
- 迁移文档独立只写 docs/integration/tsim-cs.md 与 tools/contracts/tsim-integration-example.json。
- 回执完整性提交 `3a9dcda3bf583c92ed571cf82f5ea1472c968122`：专项红6绿1→绿7通过；独立全测实际190通过/1失败，误未拦提交且正文误报，已由 `263ad0b` 后续提交迁移旧畸形码契约并加不重发判据；重新导出暂存快照typecheck、TS191/0失败/0skip、bundle:ui通过，不重写历史。
- SDK Promise桥无损ID校验已提交 `2b4ee14`，联合测试红→绿，独立暂存快照TS192/typecheck/bundle通过。SDK disposed写保护已提交 `e3f5aef`，独立快照typecheck/2tests/bundle通过；历史preview防回滚已离线红→绿且独立复核，待独立提交；session代次栅栏已接入，真实session stop/start旧请求离线零发送已被独立复核，待行为提交。
- 宿主不再ACK强清零，独立行为提交 `ab0b751`；独立快照bundle+宿主58通过，当前新增cache回归通过。TSim迁移材料/合成契约提交 `c91e72d`。
- 周边新数据/宿主已接通，UI实现与独立复核中；额外修复畸形host回执unknown、metadata补全导致journal重放（先2次!=1次失败，再绿30/30），尚未整体提交/实机。
- 16位订单校验与高亮已提交 `dde2d0b`；暂存快照typecheck/18tests/bundle通过，临时旧实现反证红→绿。
- 任务0已完成复核，准确保留原生/认证阻塞；完整轮数1/6（实机受阻，不能称通过），第1轮已完成typecheck、TS242/核心300/宿主63（0fail/skip）、bundle和diff检查；tauri app/dmg构建完成，新包已从target/bundle启动PID33871，二进制hash6c5da79b…3a811b、DMG hash79ef5d28…047ef9；钥匙串经用户处理后账号已恢复，第1轮实机未通过，已记录断点。冻结源码HEAD dde2d0b + dirty manifest SHA256 0014cb6de1ff67f255f45e156810b37a990a7a620a67a8cfa79adc38a3e6f60d，清单/tmp/vbk-goal-20261031/round1-source-manifest.json。

- 02:52受控双核及真实gid复核完成；新包发送一次合成测试标记C后transport断开，超时转unknown，网页刷新仍不可见。未重发。官方发W后原生加载旧页可见同正文/发送者/时间，服务端ID尚未跨端核对；旧页补全订单来源，滚动停留历史位置。网络反复断开与误导排队文案进入下一轮修复。

- 官方当前SDK源码经ego只读核实发送字段/回调及已读回调与桥接错配；第2轮准备先补真实边界红绿修复。成员官方过滤/机器人本地化规则亦已取得源码证据，待接续。

- 第1轮实机证据已提交 `3760382`，独立评审确认真实SDK发送/已读回调错配为P1；不能归结为纯网络。离线误导排队提示独立提交 `24b10f2`，暂存快照typecheck/bundle通过；第2轮SDK契约及附件错误出站保护在红绿修复中。

- 附件伪文本出站保护已提交 `439d9de`：红7失败→绿8；独立暂存快照typecheck/8tests/bundle通过，独立执行真实main三个发送入口12组均零IPC且保留草稿引用附件。媒体仍未实现。

- 房间路由独立提交 `25816ac`：旧实现反向回归把self当房间失败，新暂存typecheck/2tests/bundle及独立评审通过。SDK独立评审新发现raw -2先rejected会与内部HTTP兜底冲突，正在保留红证据修复；未将该未通过块提交。

- 账号/代次与草稿迟到结果隔离提交 `8cb02a8`，独立暂存13tests/typecheck/bundle及真实入口复核通过；初始账号刷新不自动开首会话提交 `84016ec`，真实函数红→绿2项；只读服务端消息ID入口提交 `990dcb4`，独立typecheck/bundle通过，供下一轮原生ID读回。
- SDK连续评审发现3类生命周期边界后已换通道矩阵路线：48格初次60pass/5fail（连既有共65），捕到排队旧事件及畸形HTTP兼容响应；正在统一结算和绑定屏障修复，无线上重发。

- SDK 回调契约与生命周期屏障已提交 `18c0ed3`：独立暂存副本 TS284/284、typecheck/bundle通过；专项67/67，独立评审无剩余可证P1/P2。工作树全套TS323通过，第2轮即将冻结构建；媒体/实机仍未完成。

- 第2轮门禁通过：typecheck、TS323/核心300/宿主63（0失败/跳过）、bundle、diff及Tauri app/dmg。冻结HEAD `18c0ed3a07df4ea6e249b81b19045b8b1ff27138` + dirty，273文件manifest SHA256 `2926be1e038d249ab43c45e2f51065f9626660266feeb9ffe0a27b1ec7164619`。实际新包PID48183，binary SHA256 `1e5281fc5d73be72de8e9c9f30e3abed2378fa3493264f021aa4ac0806e79528`，DMG `df2941402323ed71d039b63acb81d055e42d89d3f5305c20606343d9725b0b6a`；启动后账号恢复待核验。

- 第2轮用户解除钥匙串后，原生C03:31:44 confirmed且官方可见，同服务端ID已逐字核对；官方W03:35:27在原生40秒仍无自动到达，历史加载后同ID可见。整轮仍未通过，实时/视频/成员等继续阻塞；未知发送重启账本P1与核验入口P2新增，正在修复。
- 离线真实adapter合成契约入口已提交 `c316b94`，六场景通过；独立暂存副本注入void误确认故障后退出1，恢复后退出0，临时红绿证据已保留。第二轮产物起始证据提交 `8f63476`。

- 同步消息帧/单聊身份路由提交 `58f46fd`：官方SDK源码核实sys_muc/sys_mam映射，真实入口新回归5/5，独立暂存全TS289/typecheck/bundle通过，保留裸群地址未知发送者与旧测试迁移证据。此修复未证明第2轮W实时缺失根因。
- 钥匙串标记元数据探测提交 `e49ca90`：实际Registry不可用回归红→绿、空结果分类0/1失败→绿，独立暂存核心301/宿主59/bundle通过及独立安全评审。访问失败保留引用/profile；第3轮新包启动效果待核验，当前运行包仍是第2轮。

- 用户新增商户消息靠右要求已提交 `fa45301`：独立暂存typecheck/7tests/bundle通过，真实messageRow五类消息双商户角色与system经独立评审，同事消息无本人重试权限；第3轮原生视觉待验。

- 单聊组合层动态selfUid接缝提交 `65117a8`：真实入口红→绿及静态旧身份突变反证，独立9tests/typecheck/bundle与评审通过。
- 宿主持久发送屏障提交 `79e5e50`：初始6项红、拒绝理由回显另红→绿；独立暂存宿主72/专项13及bundle通过，评审无该块未修P1/P2；unknown UI与新包重启仍待验。
- 用户新增每个人接口头像：已ego重读成员接口HTTP200/AckSuccess并与DOM比对，正补本人UID校验/资料优先级及UI回执不擦除/加载失败占位；未称整体完成。

- 接口人员资料foundation提交 `2b73b74`：独立12tests/typecheck/bundle与只读评审通过；当前正在补齐消息DTO/UI头像显示及同sender合并防串人。

## 上轮状态（历史）：用户要求重勘并重写 leader 目标
- 已停止上一轮新代码实施；当前进行任务书交付，保留未提交改动。
- 以 `docs/research/2026-10-31-environment-resurvey.md` 为最新环境/测试基线：插件已恢复为0.7.5且挂载，旧缺载荷结论失效；TSim认证及原生视觉仍待核验。
- 最新测试：TypeScript 202、核心 Rust 300、宿主58 全通过；新包生成但当前运行的仍是旧包。
- 独立评审已确认历史加载未读数伪清零问题，未修复；周边API仅函数落盘，未接线。
- 后续目标增加持续按行为本地提交、同步文档，并把本仓库建设为未来 TSim_CS 携程客服平台接入示例；TSim_CS 当前只读参考。

以下保留上一轮过程记录，冲突时以上述最新环境重勘为准。

## 目标与授权
- 直接完成实现、测试、打包与视觉/程序评审；不只交付任务书。
- 官方网页、旅游商家桌面版及原有自制插件是对照；消息/身份准确性优先于视觉。
- 唯一出站测试范围：订单 `1359049237105048`，客户 `_tihk******doml43`。其它会话只读。
- 默认保留本产品多账号/强提醒结构，以真实字段对齐消息、列表、侧栏；不编造未读、成员数或订单信息。

## 分工
- 主代理：ego-browser TaskSpace 1 / p1 官方取证、集成、安全边界、打包、实机测试及独立复核。
- data_contracts：web-adapter、IPC、Rust display/adapter/DTO，以及新命令注册精确增量。
- ui_alignment：main UI、ui-kit；与数据 owner 协调合约。
- desktop_plugin_evidence：官方安装/插件只读诊断与研究记录。
- 不回退他人修改；共享接缝先协调；仅主代理创建子代理。

## 已实测基线
- git 工作区开始时干净。
- Node 22.14.0，低于 package engines 22.18；原 npm test 因 .ts 加载失败。兼容执行 `node --experimental-strip-types --test 'ui/**/*.test.ts'` 为189通过。
- `npm run typecheck` 通过；`cargo test --workspace` 完整通过。
- 当前客户端 release/macos 中 app 已登录并可通过原生 UI 读取。
- 官方网页 ego-browser 登录可用；受控 gid 已由实际订单侧栏及网络确认（原始含业务数据的证据仅存 /tmp/vbk-parity-20261031）。

## 已确认差异 / 进行中
- 会话错误使用产品 groupTitle；消息发送者无姓名/头像。
- 历史缓存误当完整历史；缺分页；旧消息显示发送中；撤回原文未隐藏；内部 session_status 可见。
- fromJid 的 room 地址未用于发送目标与补偿 gid，导致发送前失败。
- 16位订单校验/高亮失败；图片仅显示URL；侧栏字段不完整；草稿与历史滚动行为待修。
- 官方桌面版 CUA 连接超时；安装签名有效，进程运行；插件0.6.0回执残留但当前官方包不含启动器/助手，不能宣称插件在线运行。

## 验收纪律
- 不删除/跳过测试、不降低断言、不把 mock 演示当真实收发验收。
- 浏览器验收只能用 ego-browser；已有 Playwright smoke 不执行，另做 ego 实测。
- 每轮按数据→UI→打包→实机读回推进；同一失败三次改路线并记录。
- 不将凭据、签名URL、客户正文提交到仓库；测试使用脱敏最小样本。
- 完成时明确已证实、未证实和实际产物路径；继续任务先读本文件。
