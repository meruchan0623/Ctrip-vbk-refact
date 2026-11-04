# 2026-11-03 桌面实现复核与并行修复

后续状态：本文件以下为第一批冻结记录；最新搜索/媒体/系统修复、1282/285测试及新构建见[第二批记录](2026-11-03-search-media-system-followup.md)。旧源快照和旧产物hash保留作历史证据。

状态：进行中。基线 `26b035f` 加既有未提交工作区；本轮保留全部既有改动。此记录不代表全部计划功能或目标机验收通过。

用户确认另一项优化继续使用原目录，因此本轮已迁至 独立工作树 `../Ctrip-vbk-final-audit`，分支 `codex/final-audit-20261103`。迁移后的修复不回写原目录。以下最终验证只适用于该隔离副本。

## 本轮收口验证

- 前端完整测试 **1249/1249**，失败/跳过均 0；类型检查通过。完整日志 `/tmp/vbk-final-audit-ui-tests.log`。
- 宿主 lib **262/262**；核心 workspace 全通过，包含崩溃/持久化故障模型；其中一个标为手动执行的 release 性能基准保持 ignored，不能计为已运行。
- 核心与宿主 `clippy --all-targets -- -D warnings` 均通过，`cargo fmt --check`、`git diff --check` 通过。已修未使用模块编译、旧风格及 MSRV 告警，未放宽整体门禁。
- 安全门禁 **193/193** 正反例，六类源码门禁零违规；`release-scan ui/bundle` clean；最终 UI bundle 1,484,618 bytes。
- X11 依用户选择完成精确 SDK 终态 4/6/8 接线；停止 SDK 自身连接检测/补偿、会话轮询与迟到 RPC，复用 auth_invalid 退出。状态 5 和普通网络故障不会误作被踢。独立 SDK 回归 **89/89**，其中终态专项 10 项。官方公开 SDK 同 SHA 源码证实 disconnect 停止补偿；未做真实在线互踢实验。
- 新诊断与目录命令完成设置限定 ACL；诊断导出只含版本/平台及日志时间、级别，不含正文、账号、凭据或数据库。它不是完整故障报告/崩溃恢复的完成证明。
- 自启动与截图/主窗快捷键已注册宿主插件、接入保存失败回滚；快捷键可编辑并显示当前确认值。原生 OS 成效仍待验。
- ego-browser TaskSpace 23 在隔离副本本地 mock UI 验证：alarm 计时刷新保留同一按钮与焦点，语义点击“全部清除”后为 0；设置快捷键填写/保存成功且输入焦点保留。没有连接宿主、没有更改真实系统快捷键。截图 `.runtime/setting-shortcuts-ego.png`。
- macOS arm64 `.app` 构建成功，22.88 MiB，路径 `vbk/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/VBooking 商家客户端.app`。可执行文件 SHA256 `62bb9bc7341bdf04d5ff42f4148c58f1b29f7867ea4ea0f56654bcfbd78071dd`。临时 adhoc/linker 签名，无 TeamIdentifier，不是已签名公证发布包；未替换 `/Applications` 正在使用的客户端。
- 构建后源快照 `.runtime/final-source-manifest.json`：1156 文件，manifest SHA256 `56aba43aad8e8e5286753b850556fc621ce767ce8e33fe798fb83c822a76f1fb`，基线 HEAD `26b035f5717ecf864df17a485d46ada92274e250`。之后本报告/进度文件追加验收结果，产品源码保持该构建状态。

本轮曾出现的所有可复现审查缺陷已在指定范围修复并复审；这不等于后述计划缺口关闭。SDK 活跃 handle 期间被外部静默清除公开监听器仍无健康探针；整个账号生命周期不等同全局事务。服务端搜索完整契约与下一步见[搜索缺口](../research/2026-11-03-server-search-contract-gap.md)。

## 对照与范围

- 重新核对已安装官方 Mac 1.2.13 的 `imWindow-BaGPtUvK.js`、`BaseController-B_9ex1XX.js`，摘要与 11-03 研究证据一致。原生 AX 当前主窗实际加载 `/Applications/旅游商家桌面版.app/Contents/Resources/app.asar.unpacked/dist/src/pages/main/index.html`。
- 当前自制客户端运行于 `/Applications/VBooking 商家客户端.app`，与本次源码修复不是同一产物。被动观察确认双账号、会话与套餐视图，存在保留草稿；本轮没有退出或替换此进程，也没有发送客户消息。
- 当前范围仍以 web-only 决定及 11-02 改进计划为准。服务端搜索和通知翻译属于 I-23/B2；群主转交在 `peripheral-actions.md` 标 X20，但正式 X20 只明确列 I-30h/i，归属存在歧义，不能默认为已完成或永久取消。线路推荐为旧文档条件能力，尚无当前完整契约/验收。
- 旧 PROGRESS/BLOCKED 中“本环境宿主不可编译”不再描述本机现状：本轮基线宿主 241 项及 browser bridge 1 项测试通过。

## 本轮发现与处理

| 分块 | 发现 | 处理/证据状态 |
| --- | --- | --- |
| 消息展示 | 普通文本 JSON 可误触发隐藏；遗漏 visibleRule/CTL01 方向规则；历史 citemsgid 引用丢失 | 适配层修复及回归；真实目标包待验 |
| 通知 | translateIQMessage 仍为 unsupported，官方资源已有请求/响应形状 | 按静态契约接线，非中文启用，失败保留原文；真实返回效果待验 |
| 成员 | 普通成员也出现转交能力，提交前不重读本人主客服权限 | 已实现普通主客服分支收紧权限及重读；群主分支不冒充已实现 |
| 导航 | 提醒定位等待列表时切换账号可能应用迟到结果 | 加账号选择代次与列表归属检查，独立审查中 |
| 设置 | 分组回滚覆盖别的成功字段；同字段连续失败回滚到未保存值 | 字段级 confirmed/pending ledger；独立穷举 96 例成功失败与回复顺序通过 |
| IM/提醒 | 重启缺首条可推后起点；相同时间戳或越冻结边界迟到 ACK 可误清；local_id 跨会话误认发送证据 | 已加回归修复，独立复审继续 |
| 批量提醒 | HideAll 只传 gid/round/version，跨账号碰撞；行键身份不足 | 完整 WaitingRoundRef，IPC 契约升至 v2，旧 payload 拒绝 |
| 登录 | 恢复覆盖新 attempt；并发索引写乱序；过期取消关闭当前登录窗 | 启动恢复门、写入串行、attempt 绑定原窗口及登录创建串行，独立复审中 |
| 系统设置 | 自启动/全局快捷键仅保存未接系统 | 宿主接线、可编辑快捷键与失败回滚已完成；OS实际验收待做 |
| 诊断/存储 | 导出 diag 窗及 file:///data-dir 按钮必被宿主拒绝；cache_mb=0 不是真实清缓存 | 两条窄命令已接线；假清缓存禁用并说明 |
| 搜索 | placeholder 声称聊天记录/日期，实际仅过滤当前已加载会话；服务端 helper 无 UI/RPC 消费 | 先纠正文案；服务端四类搜索仍待完整接线及契约样本 |

## 验证记录

- 基线前端：1168/1169，通过类型检查；唯一失败是头像断言仍针对已移除侧卡。迁移到实际聊天标题栏并保留身份隔离断言。
- 中间整树前端：1194/1194（无跳过）；随后仍有新增修复，须在收口后重跑。
- 适配层：590/590；核心 workspace 全过；最终核心 IM 106 项、alarm/IPC 34 项；宿主 HideAll DTO 定向测试通过。
- 安全门禁：193/193 正反例，源码六类门禁零违规；UI bundle 生成成功（中间源码）。
- 浏览器仅通过 ego-browser TaskSpace 23 访问本机 mock UI，验证账号选择、会话展开、通知视图；演示数据证据不替代官方 SDK 或 Tauri 目标包。
- 宿主 `clippy --all-targets -- -D warnings` 未通过：包含未使用 chrome_login 模块、既有风格/MSRV告警，以及并行写入测试文件尚未完成时的暂态缺文件。须最终重核，不能称门禁全绿。

## 未满足的整体关口

Windows 目标机矩阵、72 小时双账号长稳、自然到达/资源冲突决策、强提醒焦点与睡眠恢复、受控媒体/翻译读回、签名发布与更新基础设施、Windows 截图、截图标注/OCR/增强条件能力及服务端搜索均不能由本轮单测替代。后续逐项记录实现与实际产物证据，不用本报告关闭它们。
