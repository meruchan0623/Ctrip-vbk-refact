# 发送和翻译的账号代次隔离

2026-10-31。账号ID、环境与认证代次共同确定异步调用归属，room gid本身不能跨账号定位本地消息。

`main.ts::sendText`通过实际`settleAccountSend`调用一次IPC。成功和失败都先对账上述三元组，再更新消息；切账号、环境、重登录或退出后的迟到结果均不写入当前会话。`stillActive`同样检查代次，账号快照三元组变化时重置账号域状态并重新读取。不能仅凭相同gid接纳旧结果。

直接翻译发送及预览在成功/失败分支都检查账号三元组、当前gid及草稿版本，译文响应版本也必须匹配。由此阻止账号A的迟到译文通过当前账号B继续发送。该保护不取消已发出的上游请求，也不重发结果未知的消息。

`sendScope.test.ts`9项覆盖成功/失败各自在账号、环境、代次和退出后的丢弃，以及同代次正常完成。真实红绿输出为`/tmp/vbk-send-scope-red.log`与`/tmp/vbk-send-scope-green.log`。提交时从暂存快照进行类型检查、针对测试和构建；主界面的真实调用点独立复核，尚不声称多账号原生切换完整验收通过。

独立评审发现预览去抖窗口中translation对象仍指旧版本；新增`preview-scope.test.ts`直接执行main.ts实际预览函数，成功/失败两分支均先红`2 !== 1`，补编辑器draftVersion核对后绿。该测试只注入IPC/store环境，没有复制或替换被测函数。

## 历史预取期间的服务会话切换

发送在等待历史以获取实际room JID前，固定gid、sessionId、customerUid、conversationType、serviceType、threadId、conversationKey、worksheetId及页面上下文。等待返回后与真正submit前都重核；相同gid不代表相同客户或服务会话。已知room不得改变，未知room仅允许从原目标历史取得；身份变化返回adapter.not_ready且SDK零次提交，不自动转投新身份。

`send-identity-guard.test.ts`直接执行createRpc及真实历史投影microtask，覆盖各身份字段、已缓存room变化、原目标正常补全。提交已开始后的投影异常保留local_id屏障并返回unknown，不能因Promise异常删除memo后重复发送。六项回归及原发送组合98项通过；红→绿保存在/tmp/vbk-goal-20261031/send-identity-*，实际第4轮包尚不含此修复，下一轮重新构建验收。
