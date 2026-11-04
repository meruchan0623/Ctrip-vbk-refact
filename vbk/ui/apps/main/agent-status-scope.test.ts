import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { isUiAgentStatusEvent } from '../_shared/guards.ts';
import { mergeAgentStatus, agentView, sameAccount } from './viewmodel.ts';

const source = readFileSync(process.env['VBK_STATUS_SCOPE_SOURCE'] ?? new URL('./main.ts', import.meta.url), 'utf8');
const owner = { account_id: 'a', environment: 'production', session_generation: 2 };
const other = { ...owner, account_id: 'b' };
function fixture() {
  let active: typeof owner | null = owner;
  const state: any = { agent: { status: 'online', confirmed: true } };
  const env = { isUiAgentStatusEvent, mergeAgentStatus, S: () => state,
    stillActive: (account: typeof owner) => !!active && sameAccount(account, active) && account.session_generation === active.session_generation,
    store: { patch: (patch: object) => Object.assign(state, patch) } };
  const start = source.indexOf('function receiveAgentStatus(');
  const end = source.indexOf('\nipc.listen<unknown>(UiEvents.AGENT_STATUS', start);
  assert.ok(start >= 0 && end > start);
  const receive = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(start, end)) + ';return receiveAgentStatus;')(...Object.values(env));
  assert.match(source, /ipc.listen<unknown>\(UiEvents.AGENT_STATUS, receiveAgentStatus\)/);
  return { state, receive, switchTo: (account: typeof owner | null) => { active = account; state.agent = { status: 'online', confirmed: false }; } };
}

test('background confirmed getoff and watchdog expiry cannot alternate the foreground status', () => {
  const f = fixture();
  for (let cycle = 0; cycle < 20; cycle++) {
    const before = f.state.agent;
    f.receive({ account: other, status: 'getoff', confirmed: true });
    assert.equal(f.state.agent, before);
    f.receive({ account: other, status: 'getoff', confirmed: false });
    assert.equal(f.state.agent, before);
    assert.equal(agentView(f.state.agent).label, '在线');
    f.receive({ account: owner, status: 'online', confirmed: true });
  }
  f.receive({ account: owner, status: 'getoff', confirmed: true });
  assert.equal(agentView(f.state.agent).label, '下班');
});

test('reject missing/malformed owners, foreign environment and old login generation', () => {
  const f = fixture(), before = f.state.agent;
  for (const account of [undefined, null, {}, { ...owner, environment: 'test' }, { ...owner, session_generation: 1 }, { ...owner, session_generation: NaN }]) {
    f.receive({ account, status: 'getoff', confirmed: true });
    assert.equal(f.state.agent, before);
  }
  f.receive({ account: owner, status: 'bogus', confirmed: true });
  assert.equal(f.state.agent, before);
});

test('switches and relogin accept only the current owner; no active account accepts nothing', () => {
  const f = fixture(); f.switchTo(other);
  f.receive({ account: owner, status: 'hangup', confirmed: true });
  assert.equal(agentView(f.state.agent).known, false);
  f.receive({ account: other, status: 'leaving', confirmed: true });
  assert.equal(agentView(f.state.agent).label, '离开');
  f.switchTo({ ...other, session_generation: 3 });
  f.receive({ account: other, status: 'getoff', confirmed: true });
  assert.equal(agentView(f.state.agent).known, false);
  f.switchTo(null);
  f.receive({ account: owner, status: 'getoff', confirmed: true });
  assert.equal(agentView(f.state.agent).known, false);
});
