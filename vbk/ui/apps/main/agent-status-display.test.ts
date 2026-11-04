import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentView, mergeAgentStatus, type AgentDisplayStatus } from './viewmodel.ts';
import { createPresence } from '../../packages/web-adapter/src/presence.ts';
import { makeDeps, jsonResponse } from '../../packages/web-adapter/src/testing.ts';

test('15-second expiry and delayed refresh keep the observed work status without confirming stale data', async () => {
  const deps = makeDeps(() => jsonResponse({}));
  let state: AgentDisplayStatus = { status: 'online', confirmed: false };
  const presence = createPresence(deps, (status, confirmed) => { state = mergeAgentStatus(state, { status, confirmed }); });
  presence.start();
  assert.equal(agentView(state).known, false);
  presence.captureRead().commit('hangup');
  for (let round = 0; round < 3; round++) {
    await deps.clock.advance(15_000);
    assert.equal(state.confirmed, false);
    assert.equal(agentView(state).label, '挂起');
    await deps.clock.advance(1_000);
    presence.captureRead().commit('hangup');
    assert.equal(state.confirmed, true);
  }
  presence.captureRead().commit('getoff');
  assert.equal(agentView(state).label, '下班');
  presence.stop();
  state = { status: 'online', confirmed: false }; // account/session reset
  assert.equal(agentView(state).known, false);
  assert.equal(agentView(mergeAgentStatus(state, { status: 'getoff', confirmed: false })).known, false);
});
