# 第七批：账号生命周期与设置持久化

状态：本批限定修复、独立复审和 macOS arm64 候选已完成；完整目标未完成。隔离副本基于第六批冻结清单继续。

## 账号生命周期

独立审查确认原 outbound store 未联动 logout/reauth 磁盘锁。旧发送步骤在网络等待后直接取得 journal，不一定重新校验完整账号代次；旧 cleanup 不能被泛化为锁稳定 namespace。实现范围为 adapter/login/state/outbound_journal、core-account 凭据状态步骤与锁序声明；本批生命周期修复已冻结并通过限定范围的独立复审。

另发现 persist_barrier 只收集失败回执，不等待 Unlock 工作完成；不能把它用作“解锁已落盘”的证据。现改为等待真实队列回执后才进入 Ready；双 store 失败关闭写入能力并传播错误。AuthInvalid 在 state.push_fact 的真实转换已纳入统一授权锁。

验收矩阵包含旧代等待后重登、新代不被旧 cleanup 锁住、主队列阻塞、双 store 的 lock/unlock 故障、Cores 不受磁盘锁等待阻塞、迟到确认不清新草稿、各发送阶段中断后不重发，以及错误账号/环境/视图无副作用。登录专项 35/35（其中生命周期 13 项）、core-account 29/29、锁顺序 11/11 已由独立审查者重跑通过；这些是本地确定性故障与竞态测试，不替代真实平台故障矩阵。

## 设置持久化

PrefsModule::save 已改为 core_store::write_atomic 的文件 fsync、rename、目录 fsync。提醒快照仅在落盘成功后推进；失败保留差异供后续调度重试，设置命令传播保存错误。新测试覆盖父路径不可写后恢复及 BeforeWrite/BeforeSyncAll/BeforeSyncDir 故障。独立审查另发现旧调度快照可能覆盖刚成功保存的新设置，现以 reminder_sync 门包住采样和持久化，设置命令同门串行；Cores 不跨磁盘 IO。实际宿主专项 12/12，独立限定复审通过。运行时设置在持久化失败后仍已生效，错误代表未确认落盘，调度可重试，不承诺运行时回滚。

当前设置 UI 已对 GPU、系统 DND、代理切换、缓存天数显示系统管理或暂未支持；这些兼容字段仍缺运行时消费者。I24 系统代理与其他原计划功能仍保留为缺口，不将禁用 UI 视为功能实现。

## 并行后续

SafeNamespaceIo 已接入主 FileStore 与 peripheral journal，外围 writer lock 以不跟随链接、只读打开和排他锁串行；已冻结并通过限定独立验收，具体证据见下文。附件文案作为 I29 首批迁移到统一词表，保留协议值和业务行为；现系统只有中文词表，没有第二语言或语言切换机制，本批不声称完成完整国际化。

生命周期进一步发现既有登录 profile marker 在持 Cores 时操作 Keychain；现已将凭据 stage/promote/delete 移到锁外，以完整上下文与操作票据校验回填。core-account 纯内存步骤通过独立复审；Keychain stage 成功至回执落盘之间崩溃仍可能遗留孤儿 staged 项，尚无完整回收证明。

## 前端冻结检查

附件文案首批归表：完整前端1387/1387，typecheck与UI构建通过（`/tmp/vbk-round7-ui-tests.log`）。ego-browser空间3/p1复验截图确认后附件名、发送和重新载入文案显示正常，无attachment.*键泄漏；截图 `.runtime/round7-i18n-attachment.png` 已目视检查。仍为合成本地mock，未发送真实消息，非原生截图验收。独立复审已通过：实际替换脚本与词典46/46对应，main540/540、专项3/3、typecheck通过，CAS/访问票据/旧确认保护保持。未保存本批前独立源码快照，因此不宣称完整历史基线等价，不将混合git diff冒充本批精确差异。

## 启动失败与代理接缝

独立审查确认主store/持久线程不可用时，原setup会以None继续且屏障看似健康。现生产启动要求store及持久线程均可用；失败时只显示非阻塞原生错误提示，确认后退出，不初始化账号/adapter/scheduler。冷启动/Opened/第二实例深链在HostState存在前仅有界排队、不显示主窗；Dock重开也不显示失败壳。源码及编译通过，原生故障弹窗已实测；确认按钮退出未验收，具体限制见下文。

I24：reqwest0.12.28原关闭default features且未启用system-proxy，实际只读环境变量代理。现显式打开system-proxy，锁新增system-configuration0.7.0/sys0.6.0，图片下载不再强制no_proxy。cargo check和feature tree确认macOS系统配置代码进入构建；TLS、固定域名/源、无重定向等原约束保留。没有实现代理切换UI，不宣称PAC/WPAD、系统认证代理或真实收发已验收。修改前基线保存`.runtime/round7-proxy-baseline`，已通过独立复核。

## 本轮独立与原生证据补充

主provider 4/4、peripheral 21/21独立通过；最小Windows cfg harness编译了实际provider/peripheral模块（DTO/display stub），非完整宿主或Windows原生运行。代理小改独立通过，assistant HTTP 5/5、media viewer 6/6；与保存的基线相比仅feature、两依赖及图片no_proxy移除，安全边界未变。

宿主生命周期初版381/381、核心workspace测试通过。整workspace严格Clippy发现core-account新增2处生产unwrap及15处测试unwrap，已由owner改结构化错误/明确expect；随后workspace严格Clippy和core-account29/29通过。

独立复审随后发现P1：exit/auth-invalid在放开生命周期锁后按账号重新查找并销毁窗口及写metadata，会伤及刚重登录的新代窗口。已改为锁内解绑/更新旧代 metadata 并捕获旧实例，锁外仅清理捕获实例。随后补齐 retiring-label 防止旧 native 实例重授权，以及导航回调捕获原始 ViewContext、在解析和撤销两处核验来源，避免迟到回调借用新代上下文。三项 P1 均通过独立复验。

原生存储启动故障：独立identifier `tech.tsim.vbk.audit.r7storage`、新app-data目录中regular-file state阻塞、冷启动vbkdesk://focus参数。实际看到启动错误对话框且未显示业务窗口，日志记录startup blocked，sentinel未变。系统对话框由UserNotificationCenter托管，原生自动化工具拒绝访问该系统应用；没有点击OK或宣称退出按钮验收。只读OS截屏已目视确认；测试PID已结束，新建测试bundle/data已清理，现有安装应用未动。证据`.runtime/round7-native-startup/`，仅保留局部提示图、日志和测试binary SHA，未保留整个桌面截图。

## 官方桌面只读复看

通过原生应用接口读取 `/Applications/旅游商家桌面版.app` 的当前消息页，没有切账号、点会话或提交操作。确认现界面仍包含多账号标签、处理中/已完成列表、聊天记录搜索与标记、隐藏翻译、截图/文件工具、用户信息与咨询来源/轨迹、产品推荐、订单详情入口。只记录功能类别，不在文档复制客户消息、账号或订单标识；本次可视观察不代替网络契约或写入读回验证。条件功能（例如总结消息）仍按原计划的范围决策处理。

## 底层来源身份后续

只读审查发现 vendor IPC 两种 transport 与 page-load 回调将来源降为 label，再查询当前实例；给定旧回调迟到交付与同 label 替换，可能误归属新实例。source-derived harness 3/3 证明该路由行为，但尚未原生复现系统迟到交付。跨原生实例身份保护已冻结，独立生产 helper harness 13/13、来源清单 143 项中仅 4 个上游文件修改、宿主 check 通过；同一 native 实例跨文档缺可信 document ID，是独立未闭合边界，不能用调用方自报 nonce 宣称修复。当前远程能力仍限定五个 adapter 命令及 event listen/unlisten。

本轮门禁复跑：193/193 fixture，当前树 6 项门禁零违规。完整目标仍未完成；第六批候选不包含本批任何改动。

## 升级状态语义与输入状态契约

core-update 的 `Stage::Installed` 原来只依据 `launch_installer()` 返回成功，无法证明安装已完成；现改为 `InstallerHandedOff`，事件明确为 `InstallerLaunch`。未添加虚构的安装完成回执或重启恢复，真实宿主升级链仍缺失。该范围 43/43、严格 Clippy 及独立复审通过；复审发现的旧操作名失效断言已改为四种失败路径的精确调用序列。I19 文档统一为归档先验 minisign、只在隔离目录解包供平台验签、通过后才执行/替换，原生两平台原型要求不变。

输入状态的公开网页 SDK 静态合同已确认，哈希与既有取证相同；生产 RPC 的空 SDK 对象导致既有入口始终 unsupported。可选 facade 接线及会话失效测试已冻结并通过限定独立复审；SDK 成功仅代表 socket handoff，不能当服务端或接收方送达证明。未调用真实客户发送。

同实例跨文档的进一步只读证据：fallback 回复经 `webview.eval` 在执行时的当前文档运行；实际 core.js 的 callback ID 为每文档随机 u32，强制 ID 碰撞的 Node VM 测试可令旧回复进入新回调。脚本层测试不等于原生导航复现。回复关联 token 可降低该路由风险，但不是入站来源证明；完整原生发放文档能力和导航撤销时序仍需设计与平台验证。本轮跨实例修复不覆盖此项。

升级发布侧已有仓库根 `.github/workflows/release.yml`，提供跨平台构建、签名校验和人工审核 draft release；不能因 vbk 子目录未见而认定不存在。它尚不生成 minisign 更新签名、更新清单、key-status 或 feed，发布侧验签也不证明客户端安装前验签。

全量复跑：宿主 384/384；前端首跑 1403/1404，唯一失败为源码契约测试在首个 `cfg(test)` 属性截断，遗漏后续生产授权方法。扫描边界改为测试模块后专项 6/6、全量 1404/1404。独立审查另发现 typing 旧超时会释放较新请求的节流槽，随后已改为唯一 attempt token 释放节流槽；独立原始交错探针通过，相关生命周期和 typing 测试 45/45。最终整树前端 1406/1406、typecheck、UI 构建、门禁 193/193 零违规及 UI 发布扫描通过。核心 workspace 严格 Clippy 再次通过，macOS arm64 候选已构建并通过发布扫描。

## 本批产物

候选：`vbk/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/VBooking 商家客户端.app`，25,435,255 bytes；可执行文件 SHA256 `eb10fb4e14e5b9d0f04e09db03963c7b797685d30c29f99c1f0dfcd3e18c61fe`。应用标识已核对为 `tech.tsim.vbk.client`，未使用启动故障测试标识。构建日志 `/tmp/vbk-round7-app-build.log`，扫描报告 `.runtime/round7-app-release-scan.json`。未发布、未替换现有安装应用。

最终源码清单及实际源码归档保存为 `.runtime/round7-source-manifest.json` 与 `.runtime/round7-source-snapshot.tar.gz`，用于后续精确基线比较；不包含 target、node_modules、dist、bundle 或运行时数据。完整目标仍保留同实例跨文档、平台实机矩阵、真实媒体/翻译样本、签名升级与其余计划缺口，不能以本批通过替代。
