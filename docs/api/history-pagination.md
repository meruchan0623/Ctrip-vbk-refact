# 历史分页与实时合并

2026-10-31。IM_MESSAGE_PAGE → im_message_page → im.message_page → 官方getMessageList，返回items/has_more/before_ms。首次读取最新30条；旧页仅以服务器13位毫秒边界direction=prev/endTime请求。每个await后核验账号生命周期与完整服务归属；旧响应不投影到新的服务会话。宿主新命令验证账号但不抢焦点，返回后再次验证代次。

实时缓存包含一条消息不代表历史完整：传统im_messages同样读取服务器并合并，不能直接拿缓存当完整历史；页广播replace=false，宿主merge_thread保留请求途中实时到达的消息。HTTP本人且具有有效时间及无损服务端ID时显示confirmed，这不是客户已读。旧服务器/本地ID联合去重，仅限同gid；晚到unknown不能回退confirmed，桥接回显折叠既有server/local两份。

主界面首次开会话、手动加载更早页分别维护cursor/busy；重复点击不并发。合并后以滚动高度差恢复位置，异步恢复前再次检查账号及会话。账号切换清历史游标，保留现有引用撤回保护。真实upsert诊断fixture补齐新依赖，既有断言未删减。

完整性限制：边界依赖官方毫秒时间；同时间满页与无可推进时间仍未有真实接口证明，不能凭按钮状态声称全部历史齐全。官方isDone才是服务端结束证据，不能虚构游标。第4轮实机仅证明加载更早页未跳底，精确锚点未通过；第5轮继续验证。

离线证据：真实PageSession/RPC交错、宿主cache合并、45条mock分页与精确env/gen/cursor拒绝、真实openConversation/loadEarlier/upsert回归；独立暂存全TS与host输出见/tmp/vbk-goal-20261031/history-*.log及.tap。旧replace=true断言随部分页协议迁移为false，保留原字段/身份/时间判据并新增途中实时消息保留。

## Windows接续冻结

用户于2026-10-31要求停止执行并推送现有成果。新增发送者/冲突server ID隔离与逐消息像素锚点已保存在本块，但最终组合回归和独立复审尚未完成；本提交是接续快照，不代表历史完整性或滚动验收通过。切勿沿用此前TS444绿结果证明后续锚点增量。
