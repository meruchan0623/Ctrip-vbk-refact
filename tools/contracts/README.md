# 接口证据工具

这里只维护采集、脱敏和文档生成，不包含产品实现，也不会批量重放业务写请求。

```bash
python3 tools/contracts/sanitize_evidence.py
python3 tools/contracts/audit_evidence.py
python3 tools/contracts/build_catalog.py
node --check tools/contracts/capture-support.mjs
```

`capture-support.mjs` 在 `ego-browser nodejs` heredoc 内使用。浏览器 API 以安装版本的 `ego-browser skill` 为准；复用同一任务空间，真实 UI 操作前 `begin(page)`，操作后 `collect(page, stage)`。它只监听与整理事件，不调用业务 fetch。需要二进制体和 CDP 清除响应的旁证时先 `observeXHR(page)`，任务结束恢复 observer。

`collect` 将 Network requestId 关联到响应/ExtraInfo。`requestHasPostData=false` 的无 body 请求与二进制 body 不可读取是不同情形。文件通过 XHR File/Blob 元数据和同次 loadend 响应补足；不能把文件伪装成 JSON 或 multipart。

保持实际类型与编码，动态字典键使用不可逆引用；协议 head 扩展采用严格常量白名单。不要保存原始 Cookie、Token、客户正文或原始 HAR 到仓库。原始请求可仅在当前页面内存中用于受控读回，结束时清理。

`build_catalog.py` 保留 Header、ExtraInfo、HTTP/Ack/业务错误不同的分支，不只按 body 去重。观测 schema 的 observedKeys/observedLength 不表示 required/minItems；未知默认值和条件不猜填。检查通过仅覆盖证据结构与脱敏，不代替真实业务或宿主验收。
