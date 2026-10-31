# 首列表返回前的会话预览（2026-10-31）

基线：864c54f8661c40fa5e1861a06b84cee3d0d4fcdf。本块只改 page session 的列表预览投影及专属测试；校时、主UI加载快照、列表分页另行验证和提交。

## 已复现问题

真实 createPageSession 中，首次 getConversationList 尚在等待时，SDK 已收到客户消息，消息显示通道已成功发出，ConversationStore.latestMessage 的时间为1700000009000。首列表返回旧行时间1700000000500后，原代码因尚无 displays 行可更新，展示仍回退旧预览和时间。独立评审脚本第二测试未经改写，在基线上真实失败，补丁后通过。补偿消息有相同的先消息、后列表时序，使用同一修复路径。

## 可证归属与处理

只有缺少初始 row 时才临存待匹配预览，不向服务器补查询。首 row 消费时必须同时满足：完整 session/customer/conversationType/serviceType 可用；发送者UID与row.customerUid匹配；消息room JID与row嵌入消息的room JID匹配；thread相符，缺失thread只接受row空thread；消息时间严格晚于row.lastUpdateTime及row列表消息时间；订单卡还须对应row订单。不能用gid单独认领消息。

首 row 前的self或系统消息若不能证明客户归属，则不将其临存预览借给新row；缺客户、room、thread、snapshot fence或session证据也保持原row预览。原有独立消息显示通道继续处理这些消息，本块不删除、修改或伪造消息正文，也不声称这些不确定消息已建立会话身份。

首row消费后，预览保护绑定完整gid/session/customer/conversationType/serviceType/thread/conversationKey/worksheet/order/self身份签名。相同gid的身份边界变化会丢弃旧预览保护；不因旧预览时间更大而把旧客户或服务的文本继承给新行。首个不匹配row会消费证据，后续字段恢复不能使旧待匹配预览复活。

## 资源与生命周期界限

每个page session最多保留256个房间，每房最新一条最多200字符预览，TTL为60秒。只保留显示尺寸的预览、时间及受限身份字段，不临存完整消息正文；room、sender及thread字符串上限512。达到容量上限淘汰最早保留房间；过期在缓存读写时清理；session.stop清空待匹配预览。完整快照排除的gid亦清理。缓存不落盘、不记录日志。

## 重复gid边界

同一列表批若出现重复gid，ConversationStore.update先保留末row。新增合成反例证明，若逐raw合并时借首row旧fence和末row新session身份组合，可误接早消息到新服务。该反例真实红后，修复要求消费时raw必须与store持有的最终row为同一对象；否则不合并待匹配预览。后续独立评审还复现无需SDK的第二条路径：前raw客户A的embedded较新preview被赋予末raw客户B的context签名，随后盖过B的旧时间。修复将整个display列表流程规范为仅最终raw投影，每gid最多一次；同批重复gid直接撤销其待匹配证据，不能用早raw的display字段组合末raw身份。新增断言确保A私有preview从未通过conversation display通道发出。两个重复gid反例均真实红→绿，保留原断言，未放宽判据。

## 验证与适用范围

证据目录：%TEMP%/vbk-windows-20261031。

- r7-pending-preview-functional-red.log / functional-green.log：原评审脚本第二测试的基线红→绿，失败值1700000000500与期望1700000009000。
- r7-pending-preview-duplicate-red.log：pending fence与身份混合的真实失败。
- r7-pending-preview-embedded-duplicate-red.log：embedded A/B的真实失败；独立评审原脚本未改断言在r7-pending-preview-embedded-review-green.log通过。
- r7-pending-preview-special-final.log：23项专项通过，覆盖SDK/补偿、身份不符、thread、TTL/容量/截断、stop/restart、字段恢复、完整身份变化及重复gid。
- r7-pending-preview-all-ts-final.log：完整TS631项通过，0失败、0skip、0cancelled；typecheck与bundle各退出0。

命令均在独立864c54f快照运行：node --experimental-strip-types --test ui/packages/web-adapter/src/pending-preview.test.ts；npm test；npm run typecheck；npm run bundle:ui。本块未改Rust，未运行cargo，未操作浏览器或桌面，未读取真实登录态或网络。测试仅合成fixture。本修复不增加HTTP请求、SDK发送或已读操作；专项验证首次SDK到达不会新增HTTP调用。真实忙账号与长期运行验收由主代理独立完成，自动化通过不等同于实机验收。
