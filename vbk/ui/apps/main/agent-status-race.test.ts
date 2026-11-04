import { mergeAgentStatus } from './viewmodel.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { t as translateUi } from '../../packages/ui-kit/src/i18n.ts';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
function fixture() {
  const account = { account_id: 'a', environment: 'test', session_generation: 1 };
  const state: any = { agent: { status: 'online', confirmed: true }, agentBusy: false, conversations: [], noticeCats: [], activeGid: null };
  let active = true;
  let resolve!: (value: unknown) => void;
  const response = new Promise(r => { resolve = r; });
  const commands = { ACCOUNT_SET_AGENT_STATUS: 'set', ACCOUNT_AGENT_STATUS: 'get', IM_CONVERSATIONS: 'convs', NET_STATUS: 'net', NOTICE_CATEGORIES: 'cats' };
  const invoke = (cmd: string) => cmd === 'set' || cmd === 'get' ? response : Promise.resolve([]);
  const env = { mergeAgentStatus, S: () => state, activeAccount: () => ({ context: account }), stillActive: () => active,
    store: { patch: (p: object) => Object.assign(state, p), subscribe: () => () => {} }, ipc: { invoke }, invokeQuiet: invoke,
    UiCommands: commands, isUiAgentStatus: (v: any) => v && typeof v.confirmed === 'boolean',
    isUiConversation: () => true, isUiNetStatus: () => false, sameAccount: () => true,
    t: translateUi, toast: () => {}, agentStatusLabel: (s: string) => s, errorMessage: String,
    releaseAttachment: async () => {}, noticeQuery: { categories: async () => {} } };
  function extract(start: string, end: string, name: string, prefix = '') {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    return new Function(...Object.keys(env), prefix + stripTypeScriptTypes(source.slice(a, b)) + `\nreturn ${name};`)(...Object.values(env));
  }
  const set = extract('async function setAgentStatus(', '// --------------------------------------------------------------- messages', 'setAgentStatus');
  const load = extract('async function loadForActiveAccount(', '\nasync function loadPrefs(', 'loadForActiveAccount', 'let accountLoadTicket = 0; let stopAccountLoadObservation = null;');
  return { state, resolve, set, load, switchAccount() { active = false; state.agentBusy = true; } };
}
test('status write read-back cannot overwrite a newer remote getoff push', async () => {
  const f = fixture(); const pending = f.set('online');
  f.state.agent = { status: 'getoff', confirmed: true };
  f.resolve({ status: 'online', confirmed: true }); await pending;
  assert.deepEqual(f.state.agent, { status: 'getoff', confirmed: true });
});
test('account load cannot overwrite a pushed unknown status with old confirmed online', async () => {
  const f = fixture(); const pending = f.load();
  f.state.agent = { status: 'online', confirmed: false };
  f.resolve({ status: 'online', confirmed: true }); await pending;
  assert.equal(f.state.agent.confirmed, false);
});
test('old account write completion does not unlock the new account operation', async () => {
  const f = fixture(); const pending = f.set('getoff'); f.switchAccount();
  f.resolve({ status: 'getoff', confirmed: true }); await pending;
  assert.equal(f.state.agentBusy, true);
  assert.equal(f.state.agent.status, 'online');
});
test('same-account ABA completion cannot unlock or overwrite a later operation', async () => {
  const f = fixture(); const pending = f.set('getoff');
  // Account reset and a later operation have replaced the first operation token.
  f.state.agentOperation = {};
  f.state.agent = { status: 'hangup', confirmed: true };
  f.resolve({ status: 'getoff', confirmed: true }); await pending;
  assert.equal(f.state.agentBusy, true);
  assert.equal(f.state.agent.status, 'hangup');
});
test('account reset releases only the previous account status-operation state', () => {
  const reset = source.slice(source.indexOf('const ACCOUNT_SCOPED_RESET ='), source.indexOf('let toastTimer:'));
  assert.match(reset, /agentBusy: false/);
  assert.match(reset, /agentOperation: null/);
});
