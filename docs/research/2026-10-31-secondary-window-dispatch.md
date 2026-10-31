# Windows 设置窗口构造修复

本轮实际点击设置后出现白色窗口，AX仅有窗口外壳、没有页面内容。旧 `shell_open_window` 为同步命令，托盘回调也同步构造WebView；本地Tauri 2.12.5源码明确记录Windows同步命令/事件中构造WebView可能死锁。此为已修复的代码路径，尚不能仅凭源码确认该次现场根因。

`shell_open_window` 改为async；设置和更新窗口统一经 `dispatch_secondary_window` 的 `spawn_blocking` 构造。全局异步mutex覆盖“已有窗口查找→创建/聚焦”完整操作，避免并发打开破坏单例。托盘入口派发异步任务并记录构造错误；命令入口保留错误响应。主窗隐藏、次窗关闭和程序退出规则不变。

新增测试直接执行生产dispatcher：旧同步实现在线程身份断言失败（1失败/1通过，exit101），新实现2/2通过；并发构造峰值为1、构造错误类型仍可读回。完整Windows宿主128/128通过、无ignored。日志位于本机临时目录 `vbk-windows-20261031/r7-secondary-window-{red,green}.log` 和 `r7-window-host-full.log`，不入Git。

Sol/xhigh独立只读复审确认生产构造/聚焦在blocking worker内、锁覆盖检查及创建、shell/tray正确await，未发现本块P1/P2。真实窗口可用性待本轮新包重新打开验证。

主代理在基线 `cf03b48` 上精确暂存3个宿主文件与本文；独立checkout-index快照先npm ci/bundle，再执行完整Windows宿主测试，128/128通过、0失败/ignored、exit0。初次从无.git快照目录读取staged diff失败，已回原仓库重新读回并执行cached diff检查通过；该错误不计作成功门禁。快照测试没有纳入身份生命周期或订单查询WIP。
