# 双账号观察修复包 7b5d75a（Windows）

本轮接续用户的持续双账号观察授权。忙账号 Nay 不执行代理出站测试；用户自身正常处理会话与代理验收分开记录。官方程序、助手和 TSim 服务未修改或部署；本轮仅本地提交，没有推送。

## 本包变化

- `fba8a4b`：初始化旧列表不能覆盖期间到达的新广播。
- `9731e00`：可信服务端校时生产接线，失效时仍显示未知。
- `7b7cbb6`：首列表到达前的预览按完整身份暂存，同 gid 客户替换不能借用旧预览。
- `d3d6656`：客户/企业/未知业务分栏，保留官方 2573 例外规则；未知状态不算处理中。
- `240dac8`：完整快照移除会话后通知主窗口重读当前缓存，晚通知不能直接删新出现的同 gid。
- `7b5d75a`：回执绑定当前服务 revision、权威列表消息 ID 和真正可见的 DOM 行；隐藏、未加载、失败或旧身份历史不能自动已读。结果不明按完整 scope 保留目标集合，不因 A→B→A 自动重试。

此前已实际通过的设置、TSim 会话恢复、订单自动摘要和详情，以及两次历史分页修复均包含在本包。其历史实机证据见对应记录，不冒充本包重新验收。

## 独立验证

最终索引快照 `r8-visible-root-final` 与提交 `7b5d75a961cccfbe003a64ccd8d703e3004dbc6a` 的 archive 对照：707 个跟踪文件，dirty 为空。没有纳入共享工作树中其他对话的 browser-session、presence、companion-card 等未暂存工作。

```text
typecheck: exit 0
UI: 711 passed, 0 failed/cancelled/skipped/todo
root 原样独立反例: 2 passed, 0 failed/skipped
host: 178 passed, 0 failed/ignored
core: 312 passed, 0 failed/ignored
bundle: 6 HTML entries, 91 files; adapter 35 modules / 278937 bytes
git diff --cached --check: exit 0
Windows build: exit 0; release profile 1m 28s; NSIS 1 bundle
```

178 host/312 core 在 `r8-visible-root-v1` 实跑；最终增量只改 TS 与文档，143 个 Rust/build/ACL 合约文件逐字节一致后复用结果，最终 Windows 构建重新编译最终快照。不得将重复利用结果写作在最终目录重跑过 Cargo 测试。

独立复审关闭首次 epoch 被旧客户高时间历史污染、同 scope 未知回执 A→B→A 被重试两个 P2。两条真实 session→UI helper→RPC 反例旧版失败、修复版通过；额外 56 项针对性复核通过。审查范围内无未修 P1/P2。没有用真实客户回执验证这些负分支。

## 产物

目录：`vbk/release/windows-observation-7b5d75a/`（本机产物，不进 Git）。

| 文件 | 字节 | SHA256 |
|---|---:|---|
| `vbk-host.exe` | 21443584 | `ade73f758d0eccea7b6b9432ad1fb979c76b022e503017834ebb4b43ec87bf28` |
| `VBooking 商家客户端_0.1.0_x64-setup.exe` | 6802247 | `75e2d38389fce94ea01d8ea193729c06bcf89d45b98a3750a90c0bfa9c63d27a` |
| `source-manifest.json` | 115100 | `588aff0b41b4d01e4a7ddbde2ea2eb8dc93aad63331e6a0c8374d72568610ccd` |

构建日志、原样反例输出与各项检查日志在 `%TEMP%/vbk-windows-20261031/r8-*`。已知 PDB 同名和未使用 `data_store_id` 警告不影响本次退出码；没有修改构建或测试判据来消除警告。

## 运行与限制

15:43安装包生成后仍保留旧9731e00/PID71540。用户此前已确认自己正在操作 Nay；当前其他窗口遮挡输入区，被动 AX 显示空占位符，但不能据缓存树可靠排除最新草稿。未激活忙会话，已询问草稿/附件状态，等待确认后切换本包。安装器未执行。

原目标的完整三端矩阵、逐条无漏重/延迟、长时稳定性、媒体及双向发送验收仍未全部完成。官方桌面近30日缓存与当前服务端列表差额组成尚未完整证明，未知/未映射消息计数也不能直接认定为全部漏收或全部正常协议事件。
