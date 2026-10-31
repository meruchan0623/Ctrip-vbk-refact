# 主界面账号列表加载与广播竞态

基线：`864c54f8661c40fa5e1861a06b84cee3d0d4fcdf`。在独立 TEMP 快照内修改、验证；没有修改主工作树或共享暂存区，没有浏览器、原生窗口、真实账号请求或消息发送。

## 已证实的条件性缺陷

真实 `loadForActiveAccount` 以 `Promise.all` 等待 conversations、agent、net、notice categories。conversations 先返回旧 A，agent 尚未完成时，真实 `upsertConversation` 已收到新 A 与新增 B；最后 agent 完成，旧快照整表覆盖，A 的标题/时间回退且 B 消失。另有同 scope 并行请求及 A→B→A 切换，旧请求只检查当前账号时仍可能覆盖最新列表。

## 变更

- 账号加载使用递增请求 ticket，最终写入同时核验 ticket 与完整 account/environment/session generation。
- 只为当前加载观察实际 store 列表变更，按 gid 记录更新与删除墓碑；迟到快照使用这些更新覆盖旧行、追加新行、拒绝复活已删行。收到的 finished 状态同样保留，不以消息时间推断新旧。
- 快照行必须属于请求的完整账号 scope；未被事件触碰而在权威快照中缺失的旧行仍删除，避免盲目 union。
- 新请求先释放旧观察器，完成/退出也释放；没有账号的新调用同样使旧 ticket 失效。背景加载仍不自动打开会话或确认未读。
- 两个既有测试夹具改为加载请求 helper；startup fixture 使用真实 store。原选择保护、媒体附件 readback 删除释放判据保留。

## 验证

日志目录：`%TEMP%\vbk-windows-20261031`。命令在独立快照 `r7-account-load-race-864c54f\vbk` 执行。

- `node --test ui/apps/main/account-load-race.test.ts`：新增前四项真实入口回归在原代码全部失败，exit 1；`r7-account-load-race-before.log`。
- `node --test ui/apps/main/account-load-race.test.ts ui/apps/main/startup-selection.test.ts`：最终 8/8、exit 0，见 `r7-account-load-race-after.log`，含原两项不自动打开会话判据；新增六项含权威快照删除及观察器清理。
- 临时故障文件仅移除 ticket 比对，通过 `VBK_ACCOUNT_LOAD_SOURCE` 注入实际函数；`node --test --test-name-pattern latest-request-wins ui/apps/main/account-load-race.test.ts` 再次失败，旧 A 覆盖最新行，exit 1；`r7-account-load-race-fault.log`。原生产文件没有被故障替换。
- `npm test`：614/614、exit 0，无 skip/todo，见 `r7-account-load-race-all-ui.log`。`npm run typecheck`：exit 0，见 `r7-account-load-race-typecheck.log`。

## 局限

这只修主界面已经收到列表更新/删除时与在途 readback 的竞态，不证明用户忙账号现场的所有异常均由此引起。若宿主删除会话却未发删除通知，主界面在下一次权威快照前无法凭空得知；本补丁不新增删除事件协议。也不修改 adapter 首次列表尚无行时的消息摘要投影、宿主 clock RPC、其它独立读回流程。无真实忙/闲账号持续验收或真实出站验证。
