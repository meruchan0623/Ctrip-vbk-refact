# 第八批：文档回调关联与完整文案迁移

状态：本批实现及本地回归已收口，完整目标未完成。以第七批源码清单和实际归档为基线，在隔离副本继续。

## 文档回调

第七批仅解决跨原生实例误归属。同一 native 实例导航后，旧异步 eval 回复仍可能命中新文档的随机 u32 callback ID；Channel 和事件也需要同等关联。正在给回复、Channel、事件传播文档关联 token，保留公共 callback 协议和权限面。这仅用于输出关联，不证明入站调用来自可信当前文档。

入站来源设计见 [设计稿](2026-11-03-document-admission-design.md)，经独立挑战后已收紧为候选架构与平台接口验证计划，尚未实现，也未证明完整可行性。现有 URL-only 导航接口无法区分主框架和 iframe，commit 回调不足以在 provisional 阶段可靠撤销；不得把 renderer 自报 nonce 或普通 eval challenge 当成已完成的原生文档隔离。

## 文案与门禁

新增 TypeScript AST CJK 字面量审计，覆盖字符串、转义字面量、模板片段及 JSX；词表白名单为 i18n.ts、strings.ts 和测试来源。十项正反夹具已加入自测，当前门禁自测 203/203。独立审查发现 JSX 数字实体漏报与 String.raw 转义误报，已补一次实体解码与标准 raw 模板处理，独立复验通过。审计仍独立运行，尚未加入六项生产门禁，不能把现有零违规误称 CJK 零命中。

完整迁移仍有大量剩余项，包括发布包剔除的 mock 数据、主窗、套餐卡、搜索、恢复提示等。设置页 62 词条、套餐卡/套餐预览 60 词条已完成迁移，保留原中文、动态值和协议值，不增加语言切换；两组实际修改前快照已保存，独立复审已通过。当前独立审计 944 个字面量节点、29 个文件，其中 mock 250；数字包含业务字段与内部诊断，不等于用户文案数量。设置页 main/viewmodel 已零命中，HTML/CSS 不在 TypeScript 审计范围，HTML 标题未伪造归零。报告 `.runtime/round8-cjk-audit.json`。

## 系统设置范围核实

GPU、跟随系统/定时勿扰、缓存天数字段尚无运行时消费者；对应 UI 当前明确不提供可操作开关。计划未确定缓存删除范围或定时勿扰字段，不能自行删除持久聊天、草稿附件或 unknown journal。静态系统代理已接线，但不代表偏好开关或 PAC/WPAD 已实现，真实平台代理路径仍待验收。

前端整树 1418/1418、typecheck 和 UI 构建通过（`/tmp/vbk-round8-ui-tests.log`）。companion 独立专项 34/34、384 组基线渲染/复制差分一致；协议中文字段和 DOM 安全路径保持。

本地浏览器复验尝试通过 ego-browser 恢复既有空间 3，返回 `task space not found: 3`，未操作任何页面、未自行新建空间。已向用户请求另建替代空间；本批浏览器视觉验收尚未完成。

设置迁移独立专项 37/37、真实基线函数 29/29；62 词条及插值逐项一致，展开词条后三文件 AST 操作结构保持。安全错误白名单和 unknown 不回显保持。CJK 独立对抗用例 7/7、scanner 5/5、fixture 203/203；审计仍未接 runTree。

入站设计补齐三个待证明不变量：WebContent 执行时 guard 与 proof/ACK 复核；Before 撤销与最终短内存发布共用 Admission 提交门；异步事件注册/删除/分发同票据。macOS policy 与 WKNavigation 的关联尚未证明，必须先做平台生命周期探针，不能直接把“最近导航”当可信票据。

## 本批继续范围

回复关联实现已冻结，owner 的 51 项 Rust 与 17 项真实源码脚本组合测试、vendor 自身 lib/tests 和 host 严格 Clippy 均通过，正交独立复审。主窗仍有 230 个 CJK AST 节点（包含新增中文标点判定后的计数），正在按五个函数区域完整迁移；此前 1418/1418 不包含这批主窗修改，必须最终重跑。

独立 vendor 复审新增两项 P1：retained invoke 仍动态读取新 WindowProxy 的 IPC 对象；AppHandle emit 持 webviews 锁再进入新增 is_registered 检查可自锁。最终候选打包暂停，两项正修复并补实际调用链回归；此前局部组合绿测不能覆盖它们。

Intel Rust 标准库目标已补装，x86_64-apple-darwin 完整宿主 cargo check 已通过（`/tmp/vbk-round8-intel-check.log`）；这是编译预检，非最终 Intel 产物、正式签名或安装验收。

独立 AppHandle.emit 自锁探针已实际复现：仅在仓外 vendor 副本追加测试脚手架，编译成功后真实 mock AppHandle.emit 进入但 35 秒内不返回，已结束该独立探针进程。证据 `/tmp/vbk-reply-review.Nx8qRf/deadlock_probe.log` 与 `deadlock_probe.py`。未操作用户原生应用。修复后必须重跑同探针，不能用只调用底层 listeners 的测试代替。

主窗迁移块 1、2 已分别通过 86/86、158/158 定向测试；后续三个块仍在进行，不能据此宣称主窗或本批全部验收。

主窗五块已完成：218 处整句/静态值迁移、162 新词条，main CJK=0；完整前端 1422/1422、typecheck、UI build/bundle/发布扫描通过。当前全树 CJK 审计为 714 节点/28 文件（其中 mock 250），仍不是完整国际化验收。主窗独立 AST/原文核对进行中。

Channel 独立审查另外复现容量拒绝后的序号洞及过期 fetch 仅记录日志、Promise 不收敛；正在修复，不能将原 51+17 局部绿测当作这些问题的关闭证据。

底层修复代理被自动安全检查中止，提示 possible cybersecurity risk；未重试该代理。主代理接手核对落盘源码，并运行现成纯本地测试入口：vendor 自身严格 Clippy、56 项 Rust（33 IPC、10 event、13 instance）及 28 项实际源码脚本组合测试通过，日志 `/tmp/vbk-round8-final-vendor-tests.log`。这些不是原生浏览器验收。组合 fixture 已按真实 transport→core→event/global 顺序运行，修正此前不正确的测试装载顺序。

只读复审继续发现 global cleanup 返回 Promise 被丢弃，主代理已补同步异常/异步 rejection 处理，boot 14/14。当前累计修改 13 个原始 upstream 文件，provenance 白名单与最终候选仍待复核收口。

## 最终本地复核（优先于上述过程记录）

retained invoke、AppHandle.emit 锁重入、Channel 容量序号洞、TTL 失败不收敛、迟到取消订阅和全局 API 清理均已修复。callback ID 为不重用的有界 u32 分配，回复令牌只用于输出关联；不作为可信入站能力。容量在分配序号前检查；一次性回复失败走原错误 callback，流失败只发固定本地错误并清理自身回调，不伪造成功/结束或自动重试。

根代理运行现成项目入口：vendor 严格 Clippy、56 Rust + 28 JS、boot 14/14 全通过，host 严格 Clippy 与385项测试通过。独立普通只读复核未发现新的 P1/P2。自动安全检查中止代理后未重试原外部探测脚本；项目中的真实 AppHandle.emit 回归通过，不声称原仓外脚本独立动态复验通过。自动中止不会被更名绕过。

provenance 已收口：143 个原始 upstream 文件中准确13个修改，verify-patch.py 与 PATCH.md 已更新并验证通过。新增文档回复和实例测试单独记录。主窗独立547项、AST与原文核对已通过。连同第九批整树前端1442项、typecheck、构建和发布扫描通过。上述1418/1422与旧CJK数字均为历史中间状态。

第九批最终 CJK 报告为631节点/26文件，其中mock250，仍含中文协议字段和业务数据；main、设置、搜索与恢复模块已迁移，不代表全项目完成。用户已授权替代空间5，本地设置与主窗演示页面可加载；浏览器与原生验收边界见第九批记录。通用 macOS 构建正在进行，正式签名、真实平台故障矩阵和可信入站设计仍未完成。
