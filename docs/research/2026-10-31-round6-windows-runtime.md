# 第6轮 Windows 运行记录（满轮停止，未通过整体验收）

2026-10-31，Asia/Shanghai。沿用原6轮上限，本次为最后一轮；构建和本轮可执行的原生验收已结束，按目标要求停止新增修复。整体验收未通过，未完成项目不由离线绿态替代。

## 冻结与验证

分支`feat/prototype-restore-macos`，源码`7bd269077eea568c4d66070b2c432634aa4b35b6`。独立快照`%TEMP%/vbk-windows-20261031/round6-source`，dirty=[]；643文件manifest SHA256 `c06ab51d62db69079912eb60eb026e3f2713a205c2d7809e8d1703419e204bcc`。Sol/xhigh独立重新计算643/643 hash一致，source-sha与manifest匹配。

本轮纳入`9771a80`媒体冻结附件/分阶段持久屏障，以及`fcd7b03`无ID系统行条件性滚动指纹；完整契约见[媒体](../api/media-outbound.md)、[历史](../api/history-pagination.md)。媒体独立暂存531TS/126host，历史独立暂存536TS/typecheck/bundle通过；独立评审在两块范围内无未修P1/P2，不代表全目标无缺口。

| 命令 | 本轮独立源码快照结果 |
|---|---|
| npm ci | 退出0 |
| npm run bundle:ui（host编译前置） | 退出0，避免干净快照缺frontendDist |
| npm run typecheck | 退出0 |
| node --experimental-strip-types --test 'ui/**/*.test.ts' | 536 passed，0 failed/cancelled/skipped/todo，退出0 |
| cargo test --workspace --quiet | 304 passed，0 failed/ignored，退出0 |
| cargo test --manifest-path src-tauri/Cargo.toml --quiet | 126 passed，0 failed/ignored，退出0；子进程屏障测试输出不重复计数 |
| npm run bundle:ui | 退出0，5 HTML entries/81 files、adapter35 modules |
| npx tauri build --config src-tauri/tauri.windows.conf.json | 退出0；release编译1m31s，x64 NSIS产物已生成 |
| git diff --check（冻结work-tree） | 退出0 |

实际命令stdout/stderr经Tee持续输出，完整日志为本机`%TEMP%/vbk-windows-20261031/round6-*.log`；界面截断不代表日志缺失。Windows交接host114与Mac115差异仍是原macOS条件测试；新增Windows文件屏障及媒体测试后126，无删除或ignored。既有Windows data_store_id未用与PDB同名警告仍保留。

## 产物与实际进程

产物位于`C:/Develop/Ctrip-vbk-refact/vbk/release/windows-round6-7bd2690/`，均为ignored生成物，不进Git：

| 文件 | bytes | SHA256 |
|---|---:|---|
| vbk-host.exe | 20,517,376 | 72111798daed2db6a31efb9c7a2d0ccbc770e046a611ca759634c1851932318b |
| VBooking 商家客户端_0.1.0_x64-setup.exe | 6,616,022 | 2bd8bcbd800bca102a4d7982a0bde665ae7acec52d75591b5f0e049c88ca72bd |

先确认旧第5轮输入框为空并核实PID14828路径，再停止该本任务进程；未停止官方程序。12:17:56.959202+08启动第6轮复制exe，实际PID58224，ExecutablePath为上述目录下vbk-host.exe，运行文件hash再次匹配。Sol/xhigh独立重算两产物hash、核进程路径/创建时间及旧PID消失均一致；该评审没有操作UI。安装器未执行，不能称NSIS安装/升级已验。

## 本轮原生与网页

- 12:18新包自动恢复Meru登录及已连接状态，无再次输入凭据；未自动选择会话。账号/列表头像可见，列表仍11处理中/9完成。只筛选授权客户并打开该会话，标题及右侧订单再次双核成功，商户消息右侧和接口头像可见；这是旧消息读回，不是本轮发送回执。
- 12:18:43顶部可见18:33:52撤回行约y166，下方为其它撤回行和视频；12:18:58加载旧页后视图显示18:21订单卡/18:22系统行，原锚点仍未保持，实机失败重现。来源Trip-App、产品、日期、金额补全可见。条件性无ID指纹修复没有解决该现场问题，不再宣称已找准根因。
- 12:19图片和一般文件原生选择器均打开，选择本地合成PNG及TXT后显示对应文件名、“仅发送附件，文字/引用保留”和“发送附件”；分别移除后回到空输入框/普通发送。只验证选择登记与UI路径，没有点击发送附件，未上传。
- 12:20将合成TXT从视频入口选入，实际AX显示`失败：attachment format, size, scope or lifetime is invalid (nothing submitted)`，无附件登记。视频选择器仍列出比当前MP4实现更多的扩展名，不能据选择器宣称支持全部格式；有效MP4实际解码/上传未验。Windows截图源码仍HOST_UNSUPPORTED，本轮点击未取得成功捕获证据。
- Edge唯一专用页最终仍为官方登录，二维码过期；此前正常导航仍重定向登录，用户登录回复不代替页面认证。网页当轮订单/客户/gid未取得，双向出站暂停；Windows第5、6轮出站消息和附件上传均为0。未复制Cookie、密码或Mac秘密。

本轮原生截图及AX是本聊天CUA工具的直接输出，未另存成磁盘截图，不能引用不存在的图片路径。官方置顶提醒偶尔覆盖新包左上角，受遮挡区域不记视觉通过。网络/SDK真实发送证据缺失，不用离线日志冒充。

本地合成fixtures位于ignored `vbk/release/round6-fixtures/`：PNG2727bytes，SHA256 `f833e884178a1d283dcda8cc87f41f9976b3298b381c9d17a200ad816dfd50ad`；TXT83bytes，SHA256 `3f8937011b980a01d3e55605d7e8ecf23dfb488d5f1ebc210c0c32197870257c`。不含客户数据；仅作本地选择测试。

## 未完成边界

第5、6轮精确分页位置丢失、官方11/24与新包11/9计数差异仍开着。无ID系统行修复仅证明条件性缺口，尚未确认现场ID；官方缓存合并源码不能代替本轮HTTP haveRest证据。自然双向和服务端ID、媒体上传/读回、客户已读、真实unknown重启、引用撤回、重连/切账号、强提醒和完整三端矩阵仍未完成。Windows截图、大视频分片、推荐/完整来源轨迹等仍未实现；TSim仅只读比对与迁移准备，无写入/部署。Mac只保留历史包，不算新版验证。

两块源码独立评审无未修P1/P2，属于局部审查结论；现场分页失败及全目标缺口优先于此结论。没有第7轮、没有push/合并/部署；后续如另行授权继续，先从Edge有效登录、真实分页行身份/布局与列表HTTP证据接续，禁止盲重发旧unknown。

## 本地提交与红绿证据

| 提交 | 行为 | 直接离线验证 |
|---|---|---|
| 98311bf | 锁定Windows构建依赖 | 干净快照npm ci/typecheck/bundle |
| 1a32e8d | 译文请求实例归属 | 原12保留，13绿3红→16绿；独立24交错 |
| e21a6e9 | 身份补全后的双向唯一锚点 | 原15保留至21；top120≠420及反向碰撞故障红→绿 |
| a3fbb22 | Windows严格文件/目录同步屏障 | 核心304/宿主115，真实共享句柄与跨进程unknown红→绿 |
| 060627a、0626330、7bd2690 | Windows环境、第5轮构建和登录后证据 | 独立记录/文档链接核验，真实差异保留 |
| 9771a80 | 冻结附件、分阶段持久上传/发送 | 暂存531TS/126host，UI/RPC/资源释放/legacy/三阶段重启故障红→绿 |
| fcd7b03 | 无ID系统行条件性滚动指纹 | 暂存536TS，26专项；故障3红→26绿，独立11额外组合 |

媒体红绿日志包括`media-ui-before.log`、`media-upload-seam-before.log`、`media-replay-only-fault.log`、`r6-media-ts-fault-red.log`、`r6-media-target-release-red.log`、`r6-media-rust-fault-red.log`及对应green/final日志；历史为`history-system-fingerprint-{before,fault,after,all-tests}.log`。均在本机`%TEMP%/vbk-windows-20261031/`，不进Git；阶段回归未降低既有判据、未新增skip/todo。
