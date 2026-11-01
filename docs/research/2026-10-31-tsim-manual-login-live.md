# TSim 手动登录实测

2026-10-31，用户授权用其提供的账号凭据测试。密码未写入文件、命令行参数或证据文档。

- 固定 API origin 的 multipart `/agent/login` 返回 HTTP 200、success=true；`/agent/profile` 返回有效身份与套餐查询权限。独立诊断会话随后退出。
- 当前源码 `examples/tsim_login_probe.rs` 经 stdin 接收凭据，运行真实 `Service::login`、ReqwestExecutor 与独立 Windows 凭据库槽位；输出 credential_roundtrip=ok、login_confirmed=true、probe_logout_ok=true。诊断槽位已清理。
- 原有 `vbk/release/windows-auth-diagnostics-ece045a/vbk-host.exe` 原生设置页实际填写并提交后，显示“已登录：meru”，密码框消失；保留此客户端会话给用户使用。没有发送客户消息。
- 此次未复现用户此前的持续报错。上述结果不证明旧错误根因已解决，也不等于新源码已打包部署。
- 浏览器会话自动获取仍未完成；当前会话没有可用的 ego-browser，未替换浏览器工具进行验收。现有会话导入入口不能等同于自动获取。

前一轮表单修复处理了自动填充不触发 input 事件时无法提交，以及失败后旧身份残留；14 项设置测试、52 项宿主助手测试、typecheck 与 bundle 已通过。此次实测对象是旧预览，不能把它记为新表单代码的桌面验收。
