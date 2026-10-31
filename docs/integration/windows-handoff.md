# Windows接续断点

2026-10-31，用户明确要求停止运行、分块提交并推送。分支feat/prototype-restore-macos，远端origin=https://github.com/meruchan0623/Ctrip-vbk-refact.git。本次仅保存与迁移成果，没有部署、合并或继续第5轮。

## 先恢复源码与环境

在Windows克隆仓库后切换同名远端分支，不从main另起旧基线。先读PROGRESS.md、BLOCKED.md、docs/research/2026-10-31-environment-resurvey.md、docs/research/2026-10-31-round4-runtime.md及能力矩阵。原Mac路径仅历史证据，不能作为Windows工作目录。安装Node 22.18以上、Rust稳定工具链/MSVC构建工具与Tauri 2所需WebView2；Windows宿主与持久化目录fsync支持尚未实测。

在vbk目录执行依赖安装与检查（没有npm锁文件时使用npm install）：

```powershell
npm install
npm run typecheck
node --experimental-strip-types --test 'ui/**/*.test.ts'
cargo test --workspace --quiet
cargo test --manifest-path src-tauri/Cargo.toml --quiet
npm run bundle:ui
npx tauri build --config src-tauri/tauri.windows.conf.json
git diff --check
```

此处是接续命令，不表示已在Windows执行。不要使用aarch64-apple-darwin目标在Windows冒充本机验收；新包必须另录源码SHA、产物hash、实际进程路径并真实启动。Mac钥匙串引用及登录态不随Git迁移，Windows需正常登录，不复制凭据、不绕过系统保护。此前第3、4轮Mac启动未弹钥匙串，只是两次观察。

## 已提交与当前验证边界

- 4911987：未知发送专用只读核验，独立TS446/宿主105/typecheck/bundle及独立评审通过。普通历史读取曾间接发已读，专用lookup真实组合由1次回执降为0；找到记录仍保留unknown，不重发、不清账本。
- c466fa9：历史分页、宿主/界面合并、发送者及冲突server ID隔离、逐消息像素锚点接续快照。提交前工作树typecheck通过，但最后组合测试/独立复审/新包未完成。旧TS444全绿不覆盖后续修复。
- 467b305：内存会话草稿与旧译文按钮归属复核；停止前已有真实入口12绿、旧实现5红证据，最终与历史组合仍须复验。
- a60581f：真实vendorName显示及可选来源备注透传，备注上游赋值仍未证实。
- 5120122：本人明确read/unread与无证据unknown、SDK本人确认、isPresent=false过滤及消息时间布局；完整实机待验。
- a677545：保留注释/测试模块位置整理。
- 更早身份、发送屏障、接口头像、商户靠右、撤回引用、后台调度、持续补偿、订单隔离及媒体显示提交均在分支历史中；对应直接文档在docs/api。完整TSim迁移说明与脱敏离线示例在docs/integration/tsim-cs.md、tools/contracts。

## 必须优先复验的真实失败

1. 历史local_id碰撞：本人confirmed server=S/local=L与客户server=C/local=L不能合并或借回执/原文；两个不同server ID同sender也不能仅凭local关联。检查history-merge.test.ts中actual upsert、server-first bridging等反例及Rust display.rs的alias/anchor回归。
2. 旧页广播先于RPC响应：旧算法height1000/top120，广播后height1300而响应后补delta0，最终top120，应420。现逐消息full-scope key和像素锚点已保存；history-merge.test.ts的新真实store/subscribe反馈时序测试需完整跑通，覆盖底部实时增长、用户主动滚动、贴底及账号切换。尺寸夹具不是视觉验收。
3. 旧译文闭包：A的脱离DOM按钮不能替换或发送到B；drafts-scope.test.ts保持全部12项，不降低断言。
4. 第4轮W仅在诊断刷新后收到，不能计自然实时。下一轮先固定受控订单/客户及iframe真实gid，再官方发唯一新标记，避免用诊断/历史/重连唤醒后宣称实时通过。随后只读采计数。

## 轮次、环境与未完成项

完整轮数4/6，第5轮未开始。第4轮包源码cb170df+dirty，TS399/核心301/宿主101及构建通过，包与hash见round4-runtime；当前对应PID90073已经退出。后续源码不属于该包。Mac app/dmg、原始AX/截图/网络与红绿日志留在本机/tmp或target，不进Git、不自动同步到Windows；文档保留脱敏摘要，正式回归源码可重跑。

ego原TaskSpace1已消失，当前只有另一个用户任务空间，不得擅自接管或把新空间当旧证据。用户已要求停止，因此此前申请新验收空间无需在本机继续；Windows恢复验收时按ego-browser技能重新建立授权目标。官方原生连接曾NSOSStatusErrorDomain -1712 errAETimeout，助手已安装挂载但TSim认证最新失败；不得沿用“插件未安装”。Windows需重新核对三端。

自然实时、真实未读回执、跨重启unknown读回、长视频、媒体出站、引用撤回双向、新包历史精确锚点、重连/账号切换仍未完整验收。官方原生与助手端证据不完整，不能称三端对齐。媒体上传/发送仍未完整接线；隐藏或阻断按钮不算完成。TSim_CS只读参照，未实施整体接入。

唯一允许出站仍是订单1359049237105048、客户_tihk******doml43，每轮先双核再从真实iframe解析gid，别名不是gid；其它会话仅无副作用读取。unknown不盲重发，第1轮旧unknown未入持久账本，不补造证据。保留原测试基线TS≥202、核心≥300、宿主≥58及零skip/ignored要求。最多继续第5、6轮；达不到条件仍如实留断点。
