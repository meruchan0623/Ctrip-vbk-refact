import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockIpc } from './mock.ts';
import { UiCommands, UiEvents, type UiAccountSnapshot, type UiConversation, type UiOrderPackageSummary, type UiPackageDetail, type UiTsimStatus } from './client.ts';
import { AccountCommands, Events } from './commands.ts';

test('order query exposes every plan, unknown quota and only matching opaque detail handles', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  try {
    const accounts = await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT), account = accounts.accounts[0]!.context;
    const rows = await ipc.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account }); const conv = rows.find(c => c.order)!;
    const identity = await ipc.invoke<UiTsimStatus>(UiCommands.ASSIST_TSIM_STATUS);
    const args = { account, gid: conv.gid, order_id: conv.order!.order_id, context_revision: conv.assistant_context_revision, session_epoch: identity.session_epoch };
    const query = await ipc.invoke<UiOrderPackageSummary>(UiCommands.ASSIST_ORDER_SUMMARY, args);
    assert.equal(query.order_id, args.order_id); assert.equal(query.total, 2); assert.equal(query.plans.length, 2); assert.ok(query.plans.every(p => p.remain_pct === null));
    await assert.rejects(ipc.invoke(UiCommands.ASSIST_ORDER_SUMMARY, { ...args, order_id: '0000000001' }));
    await assert.rejects(ipc.invoke(UiCommands.ASSIST_ORDER_SUMMARY, { ...args, context_revision: 'wrong-source' }));
    await assert.rejects(ipc.invoke(UiCommands.ASSIST_PACKAGE_DETAIL_OPEN, { account, gid: 'wrong-gid', query_handle: query.query_handle, detail_handle: query.plans[1]!.detail_handle }));
    await assert.rejects(ipc.invoke(UiCommands.ASSIST_PACKAGE_DETAIL_OPEN, { account, gid: conv.gid, query_handle: query.query_handle, detail_handle: '/arbitrary/path-or-card' }));
    await ipc.invoke(UiCommands.ASSIST_PACKAGE_DETAIL_OPEN, { account, gid: conv.gid, query_handle: query.query_handle, detail_handle: query.plans[1]!.detail_handle });
    const detail = await ipc.invoke<UiPackageDetail>(UiCommands.ASSIST_PACKAGE_DETAIL, {});
    assert.equal(detail.plan.iccid, query.plans[1]!.iccid); assert.ok(detail.detail_fields.length && detail.live_fields.length && detail.cdrs.length);
    let invalidated = 0;
    ipc.listen(UiEvents.PACKAGE_DETAIL_INVALIDATED, () => invalidated++);
    await ipc.invoke(UiCommands.ACCOUNT_SET_REMARK, { account, remark: 'synthetic changed label' });
    ipc.emit(Events.ACCOUNT_CHANGED, { ...accounts, accounts: accounts.accounts.map(a => ({ ...a, unread: 99, nick: 'updated profile label' })) });
    assert.equal(invalidated, 0, 'ordinary remark/unread/profile broadcasts keep a current binding');
    await ipc.invoke(UiCommands.ASSIST_PACKAGE_DETAIL, {});
    const other = accounts.accounts.find(a => a.context.account_id !== account.account_id)!;
    await ipc.invoke(AccountCommands.SWITCH, { account: other.context });
    assert.equal(invalidated, 1, 'real active-owner change emits the directed invalidation');
    await assert.rejects(ipc.invoke(UiCommands.ASSIST_PACKAGE_DETAIL, {}));
    await ipc.invoke(UiCommands.ASSIST_TSIM_LOGOUT, {});
    await assert.rejects(ipc.invoke(UiCommands.ASSIST_PACKAGE_DETAIL, {}));
    await assert.rejects(ipc.invoke(UiCommands.ASSIST_ORDER_SUMMARY, args));
  } finally { ipc.dispose(); }
});
