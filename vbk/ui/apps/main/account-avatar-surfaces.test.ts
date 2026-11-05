import { t as translateUi } from '../../packages/ui-kit/src/i18n.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { renderMessageAvatar } from './message-profile.ts';
import { accountTabTitle } from './account-tab-info.ts';
import { initialOf } from '../../packages/ui-kit/src/format.ts';
import { AGENT_STATUS_ORDER, accountInitial, accountLabel, sameAccount } from './viewmodel.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
function actualFunction(name: string, next: string): string {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\nfunction ${next}(`, start);
  assert.ok(start >= 0 && end > start);
  return stripTypeScriptTypes(source.slice(start, end));
}
interface Node { tag: string; props?: Record<string, unknown>; children?: unknown[]; src?: string; alt?: string }
function nodes(tree: unknown): Node[] {
  return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree as Node, ...nodes((tree as Node).children ?? [])] : [];
}
const selfA = 'https://dimg04.c-ctrip.com/synthetic-self-a.png';
const selfB = 'https://dimg04.c-ctrip.com/synthetic-self-b.png';
const customer = 'https://dimg04.c-ctrip.com/synthetic-customer.png';
function account(id: string, name: string, avatar: string | null) {
  return { context: { account_id: id, environment: 'synthetic', session_generation: 1 }, nick: `Platform ${id}`, remark: null, party: 'Synthetic Company', state: 'online', color: '#aaa', unread: 0, self_profile: { uid: `synthetic-im-${id}`, name, avatar } };
}
function fixture() {
  const a = account('synthetic-a', 'Alice', selfA);
  const b = account('synthetic-b', 'Bob', selfB);
  const conv = { gid: 'synthetic-room', title: 'Customer', color: '#bbb', customer_avatar: customer, lang: 'zh', customer_tags: [], order: null };
  const state = { accounts: { accounts: [a, b], active_account_id: a.context.account_id, max_accounts: 16 }, conversations: [conv], noticeCats: [], view: 'messages', agent: { status: 'online', confirmed: false }, agentBusy: false, meMenu: false, alarmCount: 0, webTabs: [] as unknown[], activeWeb: null, editingTab: null, banners: [] as unknown[] };
  return { a, b, conv, state };
}
function render(name: string, next: string, state: unknown, conv?: unknown): Node {
  const doc = { querySelector: () => null, createElement: (tag: string) => ({ tag, replaceWith() {} }), createTextNode: (text: string) => ({ tag: '#text', text }) };
  const accountName = new Function('accountLabel', actualFunction('accountAvatarName', 'activeConv') + '\nreturn accountAvatarName;')(accountLabel);
  const env = {
    document: doc, renderMessageAvatar, accountTabTitle, accountAvatarName: accountName, accountInitial, accountLabel, initialOf, sameAccount, cx,
    h: (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), icon: () => null, IC: {}, t: translateUi,
    activeAccount: (s: ReturnType<typeof fixture>['state']) => s.accounts.accounts.find((a) => a.context.account_id === s.accounts.active_account_id),
    onTitleMouseDown: () => undefined, onTabsWheel: () => undefined, revealActiveTab: () => () => undefined, windowControls: () => null, agentView: () => ({ label: 'online', colorVar: '--c-ok' }), browserTabs: { activate() {}, close() {} }, webTabView: () => null, switchAccount() {}, startLogin() {}, saveRemark() {}, cancelLogin() {}, store: { patch() {} }, invokeSafe() {}, unreadTotal: () => 0, AGENT_STATUS_ORDER, agentStatusColorVar: () => '', agentStatusLabel: () => '', agentStatusDesc: () => '',
    memberPillsFor: () => ({ count: null, isMaster: false }), activeConv: () => conv, historyScopeKey: () => '', isDone: () => true, customerLanguage: () => 'zh', netView: () => ({ offline: false }), messagePane: () => null, composer: () => null, emojiPicker: () => null, part: (_name: string, build: () => unknown) => build(), featureRuntime: { renderSlot: () => [] }, EMPTY_MESSAGES: [],
    splitCategories: (cats: unknown[]) => ({ visible: cats, hidden: [] }), ignoredNoticeCats: () => [],
    packageCard: () => null, BANNER_VISIBLE: 3, formatClock: () => '', badgeText: () => '',
  };
  const run = new Function(...Object.keys(env), actualFunction(name, next) + `\nreturn ${name};`)(...Object.values(env));
  return run(state, conv) as Node;
}

for (const [name, next] of [['titleBar', 'navBar'], ['navBar', 'welcomeView']] as const) {
  test(`${name} uses its account's verified IM profile and never a customer's or another account's avatar`, () => {
    const { a, b, conv, state } = fixture();
    const images = nodes(render(name, next, state, conv)).filter((node) => node.tag === 'img');
    assert.deepEqual(images.map((image) => [image.src, image.alt]), name === 'titleBar' ? [[selfA, 'Alice'], [selfB, 'Bob']] : []);
    if (name === 'navBar') return; // the nav rail has no account avatar
    a.self_profile.avatar = null;
    b.self_profile.avatar = null;
    assert.deepEqual(nodes(render(name, next, state, conv)).filter((node) => node.tag === 'img'), []);
    // Missing verified data must also be a placeholder, never a guessed platform image.
    const absent = { ...state, accounts: { ...state.accounts, accounts: state.accounts.accounts.map(({ self_profile, ...rest }) => rest) } };
    assert.deepEqual(nodes(render(name, next, absent, conv)).filter((node) => node.tag === 'img'), []);
  });
}

test('customer chat header uses only the selected conversation avatar', () => {
  const { conv, state } = fixture();
  assert.deepEqual(nodes(render('chatPane', 'messagesView', { ...state, messages: {} }, conv)).filter((node) => node.tag === 'img').map((image) => [image.src, image.alt]), [[customer, 'Customer']]);
  assert.deepEqual(nodes(render('chatPane', 'messagesView', { ...state, messages: {} }, { ...conv, customer_avatar: null })).filter((node) => node.tag === 'img'), []);
});

test('banner avatar requires both owning account and gid; absent customer context is neutral', () => {
  const { a, b, conv, state } = fixture();
  const banner = { id: 1, account: a.context, gid: conv.gid, system: false, count: 1, at: 0 };
  assert.deepEqual(nodes(render('bannerStack', 'statusBar', { ...state, banners: [banner] })).filter((node) => node.tag === 'img').map((image) => image.src), [customer]);
  for (const changed of [{ ...banner, account: b.context }, { ...banner, gid: 'synthetic-other-room' }, { ...banner, account: { ...a.context, session_generation: 0 } }]) {
    assert.deepEqual(nodes(render('bannerStack', 'statusBar', { ...state, banners: [changed] })).filter((node) => node.tag === 'img'), []);
  }
});

test('titleBar has no account dropdown; status lives in the list header and logout on the account tab', () => {
  const { conv, state } = fixture();
  const bar = nodes(render('titleBar', 'navBar', state, conv));
  assert.equal(bar.some((n) => (n.props?.['dataset'] as Record<string, string> | undefined)?.['nav'] === 'me'), false);
  assert.equal(bar.some((n) => n.props?.['aria-haspopup'] === 'menu'), false);
  assert.equal(bar.filter((n) => n.props?.['class'] === 'tab-x').length, state.accounts.accounts.length);
});
