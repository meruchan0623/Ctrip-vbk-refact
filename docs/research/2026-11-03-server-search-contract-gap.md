# 服务端搜索：最终复核所得契约与缺口

2026-11-03 后续：完整只读搜索链路已按下述静态契约接线并通过本地/合成复审，详情见[第二批记录](../reviews/2026-11-03-search-media-system-followup.md)。真实样本缺口依旧存在；下方实现缺口清单为接线前记录。

2026-11-03，只读静态证据；不代表四种非空结果及分页已在当前网页实测。

官方 Mac 1.2.13 `/Applications/旅游商家桌面版.app/Contents/Resources/app.asar.unpacked/dist/js/`：

- `index-DKzkzNcK.js` 字符偏移 1997：content=0、customerName=1、orderId=2、all=3、time=4。
- `imWindow-BaGPtUvK.js` 的 `kyt`（2668700 起）：`POST 16037/searchConversation`，普通体 `{head,searchType,searchValue,pageNo}`；日期体（2670905）省略 searchValue，传本地日开始/结束毫秒，最近三个月至今天。
- `uyt`（2638184）：四组 `customerSearchList/contentSearchList/orderSearchList/dateSearchList`，条目 `{conversation,message?}`；单类按 `pageNo < pageInfo.pageCount` 判断更多，不按页长猜终止。all 模式每类展示前三条，“全部”切类别重查首页。
- `cyt`（2641345）：结果点击只初始化独立历史视图，携带 searchKeyword/message/lastMessageTime，不直接创建聊天、发送或标读。
- `uEe`（184657）：历史读取锚点±2000ms，向前 endTime/direction=prev、向后 beginTime/direction=next，pageSize=50。`z3e`（178523）按 msgId/messageId 定位滚动。

偏移为 Python 解码后 0 起 Unicode 字符偏移。现有真实网页样本直接支持 searchType=3、首页及 customerSearchList，见 `docs/api/endpoints/m.ctrip.com-16037-searchConversation-post.md`。

当前 `peripheral.ts::searchConversations` 只返回 customerSearchList、无条件要求非空文本且无完整 UI/RPC 消费；因此日期模式被错误拒绝，其他三组与分页信息丢失。主窗“搜索本地会话”只是缓存筛选，不能视为 I-23 服务端搜索完成。

实施边界：严格区分五类请求，返回四组与页数；原始会话留在账号作用域，用不透明令牌打开只读历史；不得复用会触发已读/重开的主聊天打开动作。账号、条件、页次变化须拒绝旧响应。订单模式补查只用真实返回 gid。需补真实四类非空响应、pageCount 类型/缺省、日期响应与同时间消息定位证据。
