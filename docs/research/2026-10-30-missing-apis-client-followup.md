# 客户端缺失接口补充观测

2026-10-30（新加坡时间）。本次尝试启动并连接 `/Applications/旅游商家桌面版.app`：应用清单最初显示未运行；按路径调用 `cua.getApp` 后返回 `timeoutReached`，但进程和 renderer 随后已启动。再次按路径和应用名连接均超时；bundle ID 因多个安装副本而歧义。未读取窗口，也未点击公告、商服、工作台、数据页或会话。因此没有页面动作与请求的关联证据，也没有触发发送、结束会话、修改状态或设置。

启动后的本地 Chromium 调试端口为 127.0.0.1:53240（此前记录的 59001 当时未监听）。仅在现有端口对 target 启用 CDP Network 被动监听，未使用 CDP 操作界面、执行脚本或导航。独立 Node 网络流量不在覆盖范围内。监听发生在启动后的自然活动中，无法判断各请求是否由初始化、定时器或其他本地动作产生。

- 16:50:48–16:51:43 的记录中，Home target 对 `https://vbooking.ctrip.com/qconfig/jsonp` 发出 5 次 GET，均观察到 HTTP 200。首轮为避免泄露统一删除查询串，故不能判断其中是否请求 `businessMenu.properties`，HTTP 200 也不证明业务响应成功。证据：[脱敏网络记录](evidence/missing-apis-client-20261030-network.json)。
- 后续约 45 秒仅匹配 `qconfig/jsonp`、`16881/searchPop`、`16881/queryProviderUncompletedDetail`，没有匹配请求。不能由此推断接口不存在或未被其他页面使用。[筛选结果](evidence/missing-apis-client-20261030-qconfig.json)。
- 保存的记录仅含 SOA/qconfig 路径、方法、时间、状态、target 标题和请求字段类型；没有保留查询值、Cookie、票据、消息正文或响应值。其他请求已从文件移除。未截取可能包含私人会话的截图。

缺少可连接的原生窗口使 UI 关联抓包未完成；公告、商服、BI、最近使用及星标/评价均不能依据本次监听作动态验收。若恢复窗口操作，应先启用脱敏监听，再逐页只读导航并标注时间；涉及会话写操作仍需专用测试会话。
