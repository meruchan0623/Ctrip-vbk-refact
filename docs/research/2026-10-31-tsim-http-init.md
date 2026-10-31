# TSim HTTP 初始化失败时停止请求

已有 HTTP 执行器在安全配置的 ClientBuilder 失败后使用默认 Client 重试构造，会丢失 HTTPS-only、禁止重定向及明确超时配置。本轮向新客户端导入用户授权的浏览器会话前，必须关闭该降级路径。

初始化失败保留不可用状态，实际请求入口返回固定 `assistant.service_unavailable` 错误，不调用请求分派；上游错误内容不进入公开 DTO。初始化成功仍使用固定 TSim origin、禁止重定向、HTTPS-only、20 秒总超时、10 秒连接超时及流式响应上限。

回归使用包含 CRLF 的合成 user-agent 触发真实 reqwest ClientBuilder 错误，不访问外网；恢复旧默认 Client 降级后必须失败。测试同时核对失败时零分派、成功时一次分派和公开错误不含合成秘密。实际红绿与独立暂存检查结果在提交正文记录。
