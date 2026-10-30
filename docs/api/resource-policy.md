# 主界面图片与媒体资源策略（2026-10-31）

主界面同时受 `vbk/ui/apps/main/index.html` 的 CSP meta 与 `vbk/src-tauri/tauri.conf.json` 的宿主 CSP 约束。多个策略共同执行时，资源必须分别满足每层策略；只放宽宿主无法越过 HTML 的限制。

第 3 轮包的主 HTML 仍为 `img-src 'self' data:`，且没有 `media-src`，视频回落 `default-src 'self'`。这会阻止远程官方头像和视频，即使宿主已允许对应域名。主代理另通过 ego-browser 捕获真实 meta 拒绝官方头像及 `img-src` violation，原始证据保存在 `/tmp/vbk-goal-20261031/round3-ego-resource-red.json`。本文编制者未操作浏览器或原生窗口，也不复制该原始文件内容。

本修复令主 HTML 与工作树宿主策略对齐：

- `img-src` 保留 `'self' data:`，仅额外允许 HTTPS 的 `*.c-ctrip.com`、`*.tripcdn.com`、`*.ctrip.com`。
- `media-src` 明确为 `'self'` 加上述三个 HTTPS 域，避免回落到仅本地的 default-src。
- 不修改主 HTML 的 script、style、font、connect、object、base 策略，不开放任意远程脚本、任意连接、HTTP资源或通配所有来源。
- 不添加 blob/data 视频、未知域名或文件系统协议；后续确有真实契约需要时另以证据扩展。

**提交依赖**：本轮开始时宿主的这条域名 allowlist 仅存在于继承工作树，HEAD 仍缺图片域名与 media-src。资源修复提交必须同时包含该宿主 CSP 精确行、主 HTML meta、新回归及本文，否则从独立提交检出的两层交集仍会阻止资源。宿主行由主代理精确暂存，本任务只修改 HTML，不覆盖宿主配置。

`vbk/ui/apps/main/resource-policy.test.ts` 直接读取真实 HTML 与宿主 JSON，按这两份配置所使用的 source 形式检查交集：官方域的 HTTPS 图片/视频允许，非官方域、伪后缀、HTTP、远程 script/connect 拒绝；任意一层退回限制策略都必须检测为阻止。该离线检查是所用策略子集的验证器，不冒充完整浏览器 CSP 引擎。

| 检查 | 实际结果 | 本机日志 |
| --- | --- | --- |
| 修复前真实 HTML + 工作树宿主交集 | 2失败、2通过：图片和媒体被meta阻止 | `/tmp/vbk-resource-policy-red.log` |
| 两层策略对齐后 | 4通过、0失败/跳过 | `/tmp/vbk-resource-policy-green.log` |
| 将内存中的meta故障注入回旧策略 | 再次2失败、2通过，证明放行断言可反证检测故障 | `/tmp/vbk-resource-policy-fault-red.log` |

故障注入仅更改测试输入的内存副本，不修改文件。所有资源地址均为官方域上的合成路径，测试不请求网络。

这里只证明离线策略对齐。头像是否实际加载、视频是否仍有授权/URL/编解码等问题，必须由主代理后续 ego-browser 真实策略验证及新包原生第 4 轮验收分别确认；不将 CSP 修复记为所有头像和视频已恢复。

主代理随后从仅暂存内容导出独立副本，typecheck、4项回归和bundle通过，再由ego-browser p2加载该副本实际HTML。对同一已从官方页面观测到的头像，修复前loaded=false并有img-src violation；修复后loaded=true、naturalWidth=480且无此violation。绿证据 `/tmp/vbk-goal-20261031/round3-ego-resource-green.json`。这验证实际Chromium页面加载，不代替下一轮原生WKWebView图片/视频验收。
