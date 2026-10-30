# 第4轮新包运行与诊断断点

日期：2026-10-31，Asia/Singapore。结论：未通过完整验收，已用4/6轮。源码评审发现P1/P2后暂停本客户端后续发送；没有观察到实际错投。

## 源码、产物与门禁

冻结HEAD `cb170df6bb209d2fa19c87977dd375d64b092a29` 加保留工作树，307文件manifest SHA256 `6e85ba537eb6f3d8f01f3a5372caa7be6b842b11f278df7e5e11569783e142fd`。后续修复不属于此包。

在vbk执行typecheck、Node strip-types完整测试、cargo workspace、cargo host、bundle:ui、tauri aarch64-macOS build和diff检查均通过。TS399 / 核心301 / 宿主101，0失败、跳过或ignored。原始输出 `/tmp/vbk-goal-20261031/round4-{ts.tap,core.log,host.log,build.log}`。

- 实际新进程PID90073，路径 `vbk/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/VBooking 商家客户端.app/Contents/MacOS/vbk-host`，旧PID80117已退出。
- binary SHA256 `cbce354dd154199a52810a9ff34f159ead7b26f94d2bbe992fa14c1b5d73f32f`，运行路径hash相同。
- DMG `vbk/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/VBooking 商家客户端_0.1.0_aarch64.dmg`，SHA256 `de3e8bddb54ef0ad6970500b90c464bac798b0875396763cd77ba57bf64b1018`。

## 原生观察

05:23启动后自动恢复Meru和12个会话，无新的钥匙串交互；连同第3轮共两次观察，不保证永久免提示。账号、列表、聊天头部、消息和客户侧卡API头像实际加载，先前CSP拒绝已解除。本人消息位于右侧；商户同事此前第3轮右侧已观察，本轮其头像仍待历史核验。成员列表本人、客户、Trip机器人3个接口头像均实际显示，机器人名称仍是raw本地化key。既有短视频已实际点击播放，原生Pause与进度0.31可见；媒体发送仍未实现。

## 受控文本及诊断

两端重新核对授权订单与客户后，从官方iframe解析实际gid，与原记录一致。仅对该会话发送合成标记。

- 05:25:05客户端C一次：原生confirmed，官方聊天行可见，getMessageList只读读回一条，双方服务端消息ID字符串一致。无客户已读证据。
- 05:30:21官方W一次：05:31:07关闭诊断后原生已见，正文、发送者、时间及服务端ID一致；没有加载历史或点击重连，但期间两次刷新诊断，因此不能称自然实时接收通过。

诊断三次均run_generation=1/binding_generation=2，未发生换代；所有decode/apply/账号过滤拒绝计数为0。

| 诊断捕获时间 | SDK消息累计 | SDK最后帧时间 | 补偿成功累计 | 补偿行累计 | 最后补偿结果时间 | UI写入累计 |
|---|---:|---|---:|---:|---|---:|
| 05:30:00 | 4 | 05:25:06 | 4 | 209 | 05:25:06 | 2 |
| 05:30:41 | 11 | 05:30:00 | 5 | 222 | 05:30:01 | 2 |
| 05:31:07 | 11 | 05:30:41 | 7 | 224 | 05:30:42 | 3 |

第二至第三次快照间SDK消息11→11、补偿行222→224、UI写入2→3，支持W经补偿进入的判断；计数不带消息ID，不能单独唯一归因。结果时间集中在前次诊断RPC之后，提示隐藏WebView可能被RPC唤醒。现有host未设置background_throttling；所用Tauri文档说明隐藏页面默认限制定时器。另有已知替代解释：补偿循环默认connected运行300000ms后主动mode=stopped，因此首条stopped不能单独作为WK挂起证据。此为待实机反证的诊断，不能据此断言唯一根因或已修复。

临时原始证据：round4-C/W-id-comparison.json、round4-C/W-official-messages.json、round4-*-native*.ax.txt、round4-diagnostics-{pre-W,post-W,final-W}.json。只提交本脱敏摘要，客户原文、实际gid/ID及资源URL留在/tmp。

## 独立评审及下一断点

Sol/xhigh针对冻结diff与真实入口反例确认：P1历史await后同gid会话身份切换仍发送；P2撤回引用残留原文、history相同local_id重复、实时订单卡未更新摘要、旧订单卡打开当前另一订单侧栏。已有32项相关测试通过不代表覆盖这些反例。P1源码a0b4416、引用完整链02d4125、后台调度d1d071d与持续补偿34470c1已分别完成独立门禁和评审；历史与订单块接续中。后续第5轮须重建并验证，不复用本轮旧包宣称修复成功。

官方桌面CUA超时、助手认证失败仍未解决；附件发送、完整引用撤回/重连/unknown只读核验及三端全面匹配仍未完成。
