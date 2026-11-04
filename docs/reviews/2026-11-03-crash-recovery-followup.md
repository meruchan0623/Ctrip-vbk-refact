# 2026-11-03 第四批：异常记录、恢复控制与更新信任模型

后续：[第五批实例恢复与消息队列记录](2026-11-03-instance-recovery-queue-followup.md)已补 macOS 实例回调接缝；本文保留第四批历史状态。

状态：隔离工作树持续实现，整体目标未完成；未提交、推送或替换运行中的应用。本记录优先于第三批关于本批模块的状态，本轮本地检查记录如下。

## 已实现

- Rust panic hook 仅写固定 39 字节的本次/上次异常观察标记，不接触 panic payload、路径、堆栈、账号和消息。独立零字节租约文件防止另一个进程轮换活跃标记。下次启动发现前次 Rust panic 时显示通用原生提示；用户主动导出诊断时只加入严格解析后重建的固定元数据。标记不证明正常退出，不覆盖强杀、断电或原生 abort。
- WebView 恢复模块按具体实例和单调故障代次注册状态；Windows 绑定 ProcessFailed token，提供有界退避与人工恢复。主窗和设置通过已确认的事件监听，再读取快照；旧事件、旧快照和旧确认不能覆盖新故障。重载成功只表示调用成功，不表示连接或编辑内容恢复。
- 宿主取消已经提交到页面的请求时保留 Unknown，不伪装成页面拒绝。真实页面拒绝仍为 Rejected；持久发送账本阻止进程重启或换账号代次后重放。
- 更新 key-status 的 Fresh 路径加入可信时间高水位检查；刷新不降低水位。并发更新的较旧序号或同序号不同内容不能覆盖已验证的撤销策略，只能按既有缓存期限规则使用当前可信缓存。此项仅修核心模型，宿主更新器仍未实现。

## 独立审查与限制

审查发现并修复了 pending 取消误分类、同窗口故障确认 ABA、事件订阅安装前的快照空隙、并发进程轮换 panic 标记、Fresh 路径时间回退及并发旧撤销策略覆盖。

macOS 的 Tauri 2.12.5 全局 terminate 回调在依赖内部按可复用 label 查找当前 WebView，可能把旧实例的迟到故障作用到新实例。已移除该不安全接线，保留 runtime-wry 按原 runtime ID 的默认 reload。macOS 自定义有界恢复及账号代次恢复仍未完成，下一步需修依赖层实例身份接缝；这不是将其从目标中删除。

Windows 浏览器环境重建、无响应处理、GPU 故障阈值策略仍未补齐；跨平台每类视图十次故障注入尚未执行。原生提示、真实画面恢复和未保存编辑均不由合成测试证明。截图像素验收仍因原 ego-browser 空间丢失等待用户允许替代空间。

## 验证记录

前端类型检查与整树测试 1307/1307；恢复 UI 专项 8/8；事件监听就绪专项通过。安全夹具 193/193、六类源码门禁零违规。UI bundle 140 个文件、1,590,645 bytes，release-scan clean。

宿主最终全量 318/318；核心 workspace 严格 Clippy 通过。标记专项 12/12、诊断专项 3/3；适配器专项 10/10；更新核心 42/42。日志 `/tmp/vbk-round4-ts-tests.log`、`/tmp/vbk-round4-final-host-tests.log`；扫描 `.runtime/round4-release-scan.json`。最终 macOS arm64 候选 app 构建成功，约 23.60 MiB；可执行文件 SHA-256 `8e30258b95e4dc742007f460af8eae4c077fd4c79c081b4a5af83c2ebf7701d3`。产物路径 `vbk/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/VBooking 商家客户端.app`，未替换运行包、未作为签名发布验收。源码清单 `.runtime/round4-source-manifest.json`。

Windows 交叉编译已实际尝试：安装 `x86_64-pc-windows-msvc` Rust target 成功，`cargo check --target x86_64-pc-windows-msvc --lib` 在 ring 的 C 代码处因缺 Windows SDK `assert.h` 失败，尚未检查到宿主 Windows 代码，不计 Windows 编译通过。

最终独立复审在本批已修范围内未发现剩余实证 P1/P2；真实双子进程探针验证租约拒绝第二写者、首进程退出后正确保留 previous_panic。UI 独立 14/14、marker 12/12、更新核心 42/42；不覆盖上列仍未实现或未实机验收的要求。最终核心/宿主严格 Clippy、格式和差异检查通过。
