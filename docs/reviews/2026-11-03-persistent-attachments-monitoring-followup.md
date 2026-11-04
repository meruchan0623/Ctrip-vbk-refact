# 2026-11-03 第六批：附件持久引用、恢复监控和符号图

状态：本批候选已构建，整体目标未完成。在隔离副本继续；第五批已构建的产物与验证记录见 [第五批](2026-11-03-instance-recovery-queue-followup.md)。

## 本批范围

- 附件持久引用：当前切会话会释放临时附件。计划要求草稿与 outbox 共同持久引用，登出撤销访问但不能删除仍被引用的资源。正在核对统一事务与旧账本迁移策略，避免未知发送丢失导致重放。
- Windows 恢复监听：当前三处注册失败静默；补明确监控不可用状态与只重新注册监听的手动重试，不将注册重试当页面重载。
- 发布 source map：现 tsc 生成但发布 bundle 丢弃。保留准确外置图并剥离本机路径与 sourcesContent；adapter 拼接产物必须真实组合映射，不能套用原模块错误坐标。

独立 owner 分别负责恢复模块与共享状态 UI、bundle 工具及测试；附件共同契约由主代理先冻结。尚无本批最终测试或产物验收结论。

## 中间审查与验证（尚非本批验收完成）

附件已实现账号隔离的持久文件、字段级 CAS、原位旧文字草稿导入、未知发送引用保护和确认后的版本匹配清理。独立审查复现并修复了两个宿主缺陷：元数据仍跟随 namespace 符号链接，以及发送准备后才捕获版本会误清新编辑。新增 std-only NamespaceIo 接缝，outbound store 使用宿主目录句柄绑定后端；主 store 与 peripheral 仍为原后端，不能宣称整个程序所有存储均已加固。

另实测配额内 64×4MiB 草稿摘要原先全量扫描内容，debug 约 11 秒、优化编译约 1.06 秒（本机缓存文件系统基线，并非原生平台容量验收）。现摘要只做路径与长度快筛，增加单会话读取；恢复及发送保留完整摘要校验。实现方测试摘要读取内容为 0 字节，debug 全部约 65ms、单会话约 42ms，独立复测进行中。

符号图已通过独立复审：ESM 与拼接 adapter 均有准确外置映射，UTF-16、CR/CRLF/LF/LS/PS 真正抛错回查通过；不包含 sourcesContent、本机绝对路径或 mock。恢复监听三阶段失败、READY 与重试竞态各有明确状态；监听重试不重载页面、不提升账号代次。UI/Rust 恢复专项各 12 项通过；完整 Windows 编译仍在 ring C 依赖因缺 SDK assert.h 停止。

中间整树前端 1371/1371、宿主 359/359、宿主严格 Clippy、核心 workspace 测试通过；其后仍有 UI 复审修复和摘要优化，因此这些数字不能当本批最终冻结证明。日志 `/tmp/vbk-round6-ui-tests.log`、`/tmp/vbk-round6-host-tests.log`、`/tmp/vbk-round6-core-tests.log`。

空间 3/p1 的真实浏览器检查已通过：截图确认先 SAVE 一次且零 SEND；切到另一房间没有旧附件，返回保留文字与同 lease、换发新 handle；重新载入仅 RESTORE，不再 SAVE 或 SEND；注入 pending 摘要后发送按钮禁用，Enter 没有触发发送，并只显示核验入口。使用本地 mock 与合成 PNG，不是原生重启或上游发送验收。

## 仍未收口

独立 UI 审查发现的普通选择、legacy 保存、外层导航发布窗口、同代次账号 ABA、被阻挡重试丢行及旧发送确认取消新选择均已修复。账号/房间访问票据在实际 reset 时轮转，外层 await 再核验；旧确认只失效版本缓存，不撤销新选择。独立原始探针 5/5、相关仓库测试 85/85 通过。

outbound store 没有独立 logout/reauth 磁盘锁联动。当前命令入口及取得 journal mutex 后都校验完整账号代次，恢复返回前再校验；这不等于已证明生命周期与所有在途磁盘写原子串行。不能在通用 on_account_removed 中盲目落锁，因为该函数也在新身份发布后清理旧代次。已形成显式生命周期接缝方案，后续与迟到发送确认的账本保护一并审查。GC 的崩溃孤儿仍在下次选择时收集；正常 media_release 已接仅无引用资源清理，不删除草稿或 unknown 引用。

## 冻结验证与候选产物

最终前端 1384/1384、typecheck、核心 workspace 测试、宿主 360/360、两套严格 Clippy 全部通过；193/193 门禁夹具符合预期，实际树零违规，git diff --check 通过。日志 `/tmp/vbk-round6-final-ui-tests.log`、`/tmp/vbk-round6-final-host-tests.log`、`/tmp/vbk-round6-core-tests.log`。独立配额摘要基线 64×4MiB 优化编译读取全部约 34–38ms、单会话约 25–32ms，摘要不读 blob 内容。

Windows 最小 harness 编译实际 attachment_leases、outbound_journal、media_outbound 和 core-store 的 Windows cfg 成功；DTO/display 为 stub，未链接、未运行，也不等于完整宿主编译通过。

最终 UI 在 ego-browser 空间 3/p1 复验：确认截图 SAVE 一次，切回原会话并手动重新载入合计 RESTORE 两次，同 lease、不同临时 handle，文字保留、SEND 零次。截图 `.runtime/round6-final-attachment-restored.png`。首次重载模块资源失败导致空白，观察到 attachment-draft-book.js 资源状态 0；再次重载正常，尚不足归因产品缺陷。一次等待使用错误的 handle 前缀，随后实际状态确认 annotation-4 正常恢复；不计为产品失败。此处仍为 Chromium/mock，原生重启与真实发送未验收。

macOS arm64 候选构建成功，app 25,376,439 字节；可执行文件 SHA256 `4c5ef29275712e4d5ef38ce5667f769bfbf25dbec09a8bee57b498b7862d37fe`。路径 `vbk/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/VBooking 商家客户端.app`；UI bundle 与 app 发布扫描均 clean。未替换安装应用、未提交推送。源码清单保存 `.runtime/round6-source-manifest.json`。

下一批优先补 outbound 登出/重新登录磁盘锁生命周期与网络等待后的代次复核；本批候选并不消除此项及原计划其他剩余功能和原生验收缺口。
