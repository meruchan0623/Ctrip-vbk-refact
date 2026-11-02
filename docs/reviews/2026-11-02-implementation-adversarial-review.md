# 改进计划首轮落盘与对抗性审查记录

2026-11-02。对象：[基于 rea 逆向结论的改进开发计划](../plan/2026-11-02-reverse-driven-improvement-plan.md) 中可在云检查环境落地的 **A 类（代码门禁）与 B 类（本地基准）部分**，起点 `main@6f7ae82`。实施按 8 个模块并行，随后按内容分 6 路对抗性审查，发现即修并补先红后绿的回归测试。

> 本文是落盘与审查记录，不是验收结论。宿主 `vbk/src-tauri` 在本环境**无法编译**（无 crate 注册表、无 WebView），所有宿主侧改动只做逐行类型/借用自查与 `rustfmt`，须在目标机 `cargo test` 后才算落盘。全部 C 类（目标机读回）验收与 X1–X22 决策项均未执行，见 §4。

## 1. 最终门禁状态（合并后实跑）

| 检查 | 结果 |
| --- | --- |
| `cargo test --offline --workspace` | 516 通过，0 失败（起点 321） |
| `cargo clippy --offline --workspace --all-targets -- -D warnings` | 0 错（起点 13 错） |
| `cargo fmt --all --check` | 干净（起点有差异） |
| `npm run typecheck` | 0 错 |
| `npm test`（`node --test`） | 932 通过，0 失败（起点 751） |
| `node tools/gates/run.mjs` | 6 类门禁，夹具 178/178 行为正确，现有源码树 0 违规 |
| `node tools/release-scan.mjs ui/bundle` | clean（实跑 `bundle.mjs` 后） |
| 宿主 `src-tauri` | **未编译**（环境限制） |

新增 std-only crate：`core-transport`（传输监督状态机）、`core-diag`（脱敏日志与诊断扫描）、`core-update`（更新密钥状态与深链解析）。

## 2. 各工作项落盘状态

状态：**A** 已完成并有测试；**B** 代码落盘但宿主未编译/未实机；**X** 被阻塞（原因）。

| 工作项 | 状态 | 要点 |
| --- | --- | --- |
| I-00 门禁先绿 | A | clippy/fmt/typeRoots/smoke 全部修复 |
| I-01 macOS 夹具 | B | `browser_storage.rs` 夹具 canonicalize；195/195 待 macOS 实跑 |
| I-02 源码级安全门禁 | A | 6 类门禁（TLS/调试、DOM sink、CSP、四方一致性与能力矩阵、DevTools/启动参数、口令字段）；审查实跑 100 个探针漏报 62 个已全部修掉并写成夹具 |
| I-03 契约版本握手 | A/B | `CONTRACT_VERSION` 两侧镜像、`contract_hello`；审查发现握手只在 `commands.rs` 生效（P0），已并入 `HostState::authorize`，宿主未编译 |
| I-04a 持久化出主线程 | A/B | `core-store::queue` 有界队列、专用线程、合并写、回执、故障模型 A/B/C 测试；`state.rs` W1/W2 改锁内快照+锁外入队（宿主未编译）。审查修复：过期作业无回执导致 `persist_failed` 永久为真、store panic 静默丢作业 |
| I-04b 锁顺序 | A/X | `lock_order.rs` 纯函数+环检测；锁外 emit 在 `adapter.rs` 未做（owner 规则） |
| I-05b 传输监督 | A/X | `core-transport` 状态机，18 场景 + 属性测试（3000 随机序列）；审查修复粗粒度 tick 绕开退避、`Resumed` 误计失败、终态期间丢网络事件。**未接入 adapter.rs**：前置 X11 决策文件不存在 |
| I-06 适配器请求节奏 | A | 官方 loop 活跃时零自发 `getConversationList`；审查修复「静默饿死」（只数请求不看响应体、不分 `.json` 变体） |
| I-07 会话计数口径 | X | 等 X1；只有占位文档 |
| I-08 / I-28a / I-28b | A | 行身份 `rows.rs`、消息区窗口化、`mergeHistoryIncremental`；审查修复桥接丢行、索引 O(n²log n)（11k 行 49 s → 0.09 s）、NaN 时间戳下增量≠全量 |
| I-09 草稿 | A/X | `draft-book` 内存端口测试通过；宿主无 `DRAFT_LOAD/SAVE` 命令，真正落盘未接通 |
| I-10 强提醒 | B/X | `Pacer` 500 ms 翻转、勿扰解除改本地日界；提示音 `rodio` 无依赖未做；实机 20/20 未做 |
| I-10a 日志与脱敏 | A | `core-diag`；审查修复 5 个 P1 漏掩（家目录用户名、保留文件名未再脱敏、`--password=` 起始、常量盐可查表、UTF-16 日志判干净） |
| I-14 媒体链路 | A/B | 契约 v1 冻结并有契约测试；限额双侧镜像；journal 保留策略与屏障独立错误码（宿主未编译）；分片上传未做 |
| I-15 翻译 | A/X | `getMessageTranslate` 请求构造 + 500 ms 防抖，只回填草稿；注入前后 `fnInfo` 对比未做 |
| I-19 更新器 | A/X | `core-update` key-status 验证与安装状态机；安装前校验原型需 X14/证书 |
| I-20 系统集成 | A/B | 深链解析器（模糊 1 万 + 30 条敌意样本）、autostart 默认 false；`integration.rs` 未接线未编译 |
| I-18 发布 | B | `release.yml`、空 entitlements、release-scan；从未运行，需 X6 证书 |
| I-23 B2 读取 | A | 快捷回复/搜索/星标/转接/结束，字段逐项对照附录 A；`FeatureContext`/`registry` 冻结 |
| I-24 端点收敛 | A | 测试域名只在 `test-endpoints` feature；审查发现生产 rlib 字符串池化出 `.qa.nt..uat.` 已修 |
| I-25 core-store 部分 | A | `schema_version` 迁移、CAS、公共 `write_atomic`、quarantine、索引上限 |
| I-29 B1 部分 | A | `data-fid` 焦点、`#live`、`companion-card.ts:70` 改 DOM API，DOM sink 允许清单已清空（严格零命中）；审查后发布包剔除 mock（`mock-loader` 间接层） |
| I-30a–d | A/B | 四条宿主命令五方注册；审查发现页面 rpc 未接分发器（实机全部 `unknown op`）已修；`feature://fact` 宿主事件未实现 |

## 3. 对抗性审查发现汇总

6 路审查共报告 P0 ×1、P1 ×18、P2 ×26；其中 P0 1/1、P1 15/18、P2 14/26 已在本轮修复并附回归测试。审查逐字段核对以下接口与附录 A 一致：`getConversationList`、`getRecentMessages`、`PutAdviceOfReadByMsgId`、`getCategories`、`getCustomerScripts`、`searchConversation`、`setWorkSheetStar`（groupId 数字）、`transferVenMaster`（groupId 字符串）、`finishConversation`、`recallMessage`、`getMessageTranslate`、`uploadTokenCreate` → nephele image v2 / file v1。

审查判定**不成立**的担忧：outbound journal 与持久化队列的 `cas_conflict`（目录不同、无共享文档）；`createTauriIpc` 并发首调用竞态；fetch 钩子 official/adapter 分类可被调用栈欺骗（分类依据是持有钩子前的原生 fetch）。

### 3.1 跨模块 P1 的处置（同日第二轮已修 3/4）

| 位置 | 问题 | 处置 |
| --- | --- | --- |
| `state.rs` `persist_failed()` | 无调用方，发送屏障未关闭、UI 无提示 | **已修**：新增错误码 `store.persist_failed`；`im_send_text` 在 journal reserve 前、`im_send_media` 在任何暂存/上传前经 `HostState::persist_barrier()` 拒绝；`UiAccountSnapshot.persist_failed` 字段，调度 tick 边沿翻转时重发 `account://changed`，主窗显示「本地保存失败，发送已暂停」并禁用发送，回执成功自动恢复。TS 测试 6 项、core-store 4 项 |
| `login.rs` `unlock_after_reauth` | 生产从未调用，logout 后命名空间跨重启只读 | **已修**：`JobPayload::Unlock`（Kind::Lock，保序、幂等、有回执）；`HostState::unlock_namespace` 在 `publish_identity` 接纳与 `resume_quick_login` 两处入队 |
| 草稿宿主命令 | `DRAFT_LOAD/SAVE` 不存在 | **已修**：`core-store::drafts::DraftBook`（首存 version=1、CAS、删除、跨 namespace 不可见、重启读回）；宿主 `features/draft.rs` 的 `im_draft_load/save` 五方注册，不持 Cores 锁写盘。顺带修正 `main.ts` 从 `UiCommands` 探测 `DRAFT_*` 的错误（该键永不存在，端口此前恒为空） |
| `feature://fact` | typing/排队/撤回广播的宿主→主窗事件无代码 | 未修：需宿主 adapter 事实 → 主窗事件通道设计，归集成负责人 |

第二轮合并后门禁：cargo test 528、clippy 0 错、fmt 干净、npm test 943、门禁 0 违规、release-scan clean。合并后的首次 `cargo test --workspace` 出现过 1 次失败（364 通过后中止），随后 22 次全量/分 crate 重跑均未复现、无 panic 输出；按未定位的偶发记录，不视为已排除。宿主侧新增函数（`persist_barrier`、`unlock_namespace`、`features::draft::*`、`scheduler::run` 边沿段、`login::on_identity` 两处调用）仍**未编译**。

### 3.2 需用户拍板（本轮按默认值执行，未替用户决定）

1. 设置页 `display.zoom`/`display.gpu` 只存储不生效：宿主实现还是删除。
2. 勿扰「到明天」= 下一个本地 08:00（凌晨设置当天解除）。
3. 已完成发送记录保留 2000 条 / 30 天；媒体暂存上限 20 → 60 MiB。
4. 适配器在官方轮询活跃但未见全量时自拉一次（硬指标「0」的唯一例外）；补偿起点取 `min(now−2min, 水位)`。
5. 补偿循环生产默认永不自停（`6f7ae82` 既有行为，与计划「5 分钟自停」冲突）。
6. 已读回执一次超时后本页生命周期内不再补发（官方每次打开都重发）。
7. `worksheetStar` 的 `numericGid` 限 15 位而实机 gid 19 位：是否照官方发精度已丢的 JS Number。
8. 退避达上限后抖动恒为 0（单调下限+上限的必然结果）。

## 4. 未执行项（不得据本文宣称完成）

- 全部 C 类验收：I-05a 节流原型矩阵、72 小时长稳、I-06 30 桶抓包、I-10 双平台 20/20、I-14 ②–⑤、I-08 30 次采样、签名/公证/安装、实机截图。
- 需用户决策：X1、X2、X4、X6、X11（阻塞 I-05b 接入）、X13–X22。
- 宿主 `src-tauri` 全部改动的编译与 `cargo test`（CI 的 host job 已由 `cargo check` 升级为 `cargo test`，首跑即验证）。
- `release.yml` 从未运行；`cargo-auditable` runner、entitlements 检查需首跑确认。

## 5. 方法留痕

- 实施与审查各自在独立 git worktree 进行，合并时的三处冲突（`Cargo.toml` members、`core-im/lib.rs` 注释、alarm 能力白名单测试）与两项计划要求的集成动作（四条宿主命令五方注册、DOM sink 允许清单清空）由集成提交完成。
- 计划 §1.1 的 fsync 口径需更正：每次 `commit` 实测 4 次 fsync（`create_durable_dir_all` 每次重同步已存在目录），不是 2 次；`httpEndpointCount` 实为 95（`putAdviceofreadIQMessage` 重复条目已合并）。
