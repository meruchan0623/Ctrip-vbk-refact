#!/usr/bin/env node
/**
 * Browser smoke test for the UI windows (no third-party deps besides the
 * pre-installed Playwright/Chromium).
 *
 *   node ui/tests/smoke/run.mjs            (from vbk/)
 *
 * 1. `tsc -p tsconfig.build.json` → ui/dist (ES modules, .ts imports rewritten)
 * 2. static `node:http` server rooted at ui/ (html from apps/, js from dist/)
 * 3. open each app with the mock IPC, assert key elements/texts, screenshot
 *
 * Exits non-zero on any failed assertion, page error or console error.
 */

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const vbkRoot = resolve(here, '../../..'); // vbk/
const uiRoot = resolve(vbkRoot, 'ui');
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

const OWN_PATHS = ['ui/apps/', 'ui/packages/ui-kit/', 'ui/packages/ipc/src/client.ts', 'ui/packages/ipc/src/mock.ts'];

// ------------------------------------------------------------------ 1. build
function build() {
  const r = spawnSync('tsc', ['-p', 'tsconfig.build.json'], { cwd: vbkRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) {
    const own = out.split('\n').filter((l) => /error TS/.test(l) && OWN_PATHS.some((p) => l.startsWith(p)));
    if (own.length > 0) {
      console.error(out);
      throw new Error(`tsc reported ${own.length} error(s) in UI-owned files`);
    }
    console.warn(`[smoke] tsc exited ${r.status} with errors outside UI-owned files (emit still produced):\n${out.trim()}`);
  }
  for (const app of ['main', 'alarm', 'setting', 'login']) {
    const f = join(uiRoot, 'dist', 'apps', app, 'main.js');
    if (!existsSync(f)) throw new Error(`missing build output ${f}`);
  }
  console.log('[smoke] build ok');
}

// ----------------------------------------------------------------- 2. server
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(uiRoot, rel);
    if (!file.startsWith(uiRoot) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => resolveP({ server, port: server.address().port }));
  });
}

// ------------------------------------------------------------------ 3. tests
let failures = 0;
let passes = 0;
const screenshots = [];

function check(cond, what) {
  if (cond) {
    passes += 1;
  } else {
    failures += 1;
    console.error(`  FAIL: ${what}`);
  }
}

async function text(page, selector) {
  const el = await page.$(selector);
  return el ? (await el.textContent())?.trim() ?? '' : null;
}

function document_view(v) {
  return v ?? '';
}

async function shot(page, name) {
  const file = join(outDir, name);
  await page.screenshot({ path: file, fullPage: false });
  screenshots.push(file);
}

function watch(page, errors) {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`);
  });
}

/** Wrap the mock's `invoke` so command payloads can be asserted; `window.open` is stubbed and counted. */
async function recordInvokes(page) {
  await page.evaluate(() => {
    const m = window.__vbkMock;
    window.__calls = [];
    window.__windowOpen = 0;
    const orig = m.invoke;
    m.invoke = (cmd, payload) => {
      window.__calls.push({ cmd, payload: JSON.parse(JSON.stringify(payload ?? null)) });
      return orig.call(m, cmd, payload);
    };
    window.open = () => {
      window.__windowOpen += 1;
      return null;
    };
  });
  return {
    calls: (cmd) => page.evaluate((c) => window.__calls.filter((x) => !c || x.cmd === c), cmd ?? null),
    reset: () => page.evaluate(() => void (window.__calls = [])),
    windowOpen: () => page.evaluate(() => window.__windowOpen),
  };
}

/** Pruning §8 / CSP checks shared by every window: no inline script or handler, no link to a deleted module. */
const DELETED_MODULES = /首页|工作台|事件|公告|商服|产品管理|数据|BI|点评|退款|核销|导出|特别关注|星标/;
// For free-text button labels, 「数据」/「导出」 are matched as whole labels only: 「数据目录」 (storage) and the local
// diagnostics 「导出」 (08-update-telemetry) are not business modules, and the logout dialog mentions 「WebView 数据」.
const DELETED_MODULES_SUBSTR = /首页|工作台|事件|公告|商服|产品管理|BI|点评|退款|核销|特别关注|星标/;
const DELETED_MODULES_EXACT = /^(数据|BI|导出|数据报表|经营数据)$/;
async function hygiene(page, name) {
  const r = await page.evaluate(() => {
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
    let inlineHandlers = 0;
    for (const el of document.querySelectorAll('*')) for (const a of el.attributes) if (/^on/i.test(a.name)) inlineHandlers += 1;
    const inlineScripts = document.querySelectorAll('script:not([src])').length;
    const jsLinks = Array.from(document.querySelectorAll('[href]')).filter((e) => /^\s*javascript:/i.test(e.getAttribute('href') ?? '')).length;
    const navText = Array.from(document.querySelectorAll('nav, [role="tab"], [role="menuitem"], [role="tablist"], .setnav, .tab-add, .nav-i')).map((e) => e.textContent?.trim() ?? '');
    const buttons = Array.from(document.querySelectorAll('button, a, .link, .chipbtn')).map((e) => e.textContent?.trim() ?? '');
    return { csp, inlineHandlers, inlineScripts, jsLinks, navText, buttons };
  });
  check(/script-src 'self'/.test(r.csp) && /object-src 'none'/.test(r.csp) && !/unsafe-eval/.test(r.csp), `${name}: CSP meta restricts script-src to self (${r.csp.slice(0, 40)}…)`);
  check(r.inlineHandlers === 0, `${name}: no inline on* handler attributes (${r.inlineHandlers})`);
  check(r.inlineScripts === 0 && r.jsLinks === 0, `${name}: no inline <script> / javascript: links`);
  const badNav = r.navText.filter((s) => DELETED_MODULES.test(s));
  check(badNav.length === 0, `${name}: no nav/tab/menu label points at a deleted module (${badNav.join('|')})`);
  const badBtn = r.buttons.filter((s) => DELETED_MODULES_SUBSTR.test(s) || (DELETED_MODULES_EXACT.test(s) && !(s === '导出' && name.startsWith('setting/privacy'))));
  check(badBtn.length === 0, `${name}: no button/link label points at a deleted module (${badBtn.join('|')})`);
}

const GARBAGE_PAYLOADS = [null, undefined, 0, '', 'garbage', true, [], {}, { entries: null }, { entries: [{}] }, { accounts: 'x' }, { gid: 1 }, { quality: 'x' }, { text: 7 }];

async function testMain(browser, base) {
  console.log('[smoke] main');
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  watch(page, errors);
  await page.goto(`${base}/apps/main/index.html?scenario=default`);
  await page.waitForSelector('.conv', { timeout: 10000 });
  await page.waitForSelector('.msg', { timeout: 10000 });

  // title bar / nav
  check((await page.$$('.tab')).length === 2, 'two account tabs');
  check((await text(page, '.tab.on .tab-name'))?.includes('示例商家A'), 'active tab is 示例商家A');
  check((await text(page, '[data-nav="messages"]')) === '消息' + (await text(page, '[data-nav="messages"] .nav-badge') ?? ''), 'nav 消息 present');
  check((await page.$('[data-nav="notifications"]')) !== null && (await page.$('[data-nav="order"]')) !== null, 'nav 通知 / 订单联系 present');
  check((await page.$('[data-nav="settings"]')) !== null && (await page.$('[data-nav="me"]')) !== null, 'nav bottom 设置 / 账号');
  const navLabels = await page.$$eval('.nav .nav-i span:not(.nav-badge)', (els) => els.map((e) => e.textContent?.trim()));
  check(navLabels.join(',') === '消息,通知,订单联系,设置', `left nav only 消息/通知/订单联系/设置 (got ${navLabels.join(',')})`);

  // conversation list
  const doing = await text(page, '[data-tab="doing"]');
  const done = await text(page, '[data-tab="done"]');
  check(/^处理中 \d+$/.test(doing ?? ''), `处理中 N tab (${doing})`);
  check(/^已完成 \d+$/.test(done ?? ''), `已完成 N tab (${done})`);
  const firstConv = await page.$('.conv');
  check((await firstConv?.getAttribute('class'))?.includes('top'), 'pinned conversation sorts first');
  await page.waitForFunction(() => document.querySelector('.conv[data-gid="g-demo-1"] .badge') === null, null, { timeout: 5000 });
  check(true, 'auto-opened conversation was marked read (badge gone)');
  check(/等待 \d+秒/.test((await text(page, '.conv[data-gid="g-demo-1"] .wait')) ?? ''), 'opening + marking read leaves the waiting chip untouched (host data only)');
  check((await text(page, '.conv[data-gid="g-demo-2"] .badge')) === '1', 'unread badge on another conversation');
  check((await page.$('.conv .cmark')) !== null, 'colour mark bar rendered');
  check((await text(page, '.conv.on .cname')) === '客户A', 'first active conversation is 客户A');
  const rec = await recordInvokes(page);

  // clicking the already-active account tab is a no-op: conversation and draft survive
  await page.fill('textarea.ta', '未发送草稿');
  await page.click('.tab.on .tab-name');
  await page.waitForTimeout(400);
  check((await text(page, '.conv.on .cname')) === '客户A' && (await page.inputValue('textarea.ta')) === '未发送草稿', 'clicking the active tab keeps the open conversation and draft');
  check((await rec.calls('account_switch')).length === 0, 'no account_switch command for the active tab');
  await page.fill('textarea.ta', '');

  // malformed event payloads are dropped, never rendered, never crash the window
  const convCount = (await page.$$('.conv')).length;
  const msgCount = (await page.$$('.msg')).length;
  await page.evaluate((garbage) => {
    const m = window.__vbkMock;
    for (const ev of ['account://changed', 'im://conversation-changed', 'im://message-new', 'prefs://changed', 'net://clock', 'notify://alarm-snapshot', 'net://status', 'account://agent-status', 'shell://toast']) {
      for (const g of garbage) m.emit(ev, g);
    }
  }, GARBAGE_PAYLOADS);
  await page.waitForTimeout(100);
  check((await page.$$('.conv')).length === convCount && (await page.$$('.msg')).length === msgCount && (await page.$$('.tab')).length === 2, 'garbage payloads on every event leave the main window intact');
  check(errors.length === 0, `no page error after garbage payloads (${errors.join('; ')})`);

  // chat pane: roles + send states
  check((await page.$$('.msg')).length >= 5, 'messages rendered');
  check((await text(page, '[data-send-state="unk"]'))?.includes('结果未知（请核对，不自动重发）'), 'unknown send state copy');
  check((await text(page, '[data-send-state="rej"]'))?.includes('发送失败'), 'rejected send state copy');
  check((await page.$('[data-send-state="rej"] .act')) !== null, 'rejected offers 重新发送');
  check((await page.$('[data-send-state="unk"] .act')) === null, 'unknown does NOT offer resend');
  check((await text(page, '.btr .trtag')) === '译', 'inbound platform translation shown under original');
  check((await page.$('.side .ucard')) !== null && (await text(page, '.side .info-grid .mono'))?.includes('0000000001'), 'right panel order summary');
  check((await text(page, '.side .pkg-h b')) === '套餐速览', 'package quick-view slot');
  check((await page.$('[data-sb="agent"]')) !== null && (await text(page, '[data-sb="agent"]'))?.includes('在线'), 'status bar agent status read-back');
  check((await text(page, '[data-sb="net"]'))?.includes('已连接'), 'status bar network');
  await page.waitForSelector('[data-sb="alarm"]', { timeout: 5000 });
  check((await text(page, '[data-sb="alarm"]'))?.includes('超时提醒 3'), 'status bar alarm count from snapshot event');

  // translation bar in replace-draft mode
  await page.waitForSelector('.trbar', { timeout: 5000 });
  check((await text(page, '.trbar'))?.includes('替换草稿'), 'translation bar shows ReplaceDraft mode');
  await page.fill('textarea.ta', '你好，示例草稿');
  await page.waitForSelector('[data-tr-state="done"]', { timeout: 8000 });
  await page.click('[data-tr="replace"]');
  const draft = await page.inputValue('textarea.ta');
  check(draft.startsWith('[示例译文'), `替换 puts translation into draft (${draft})`);
  // translation failure prompt
  await page.fill('textarea.ta', '这句会失败');
  await page.waitForSelector('[data-tr-state="error"]', { timeout: 8000 });
  check((await page.$('[data-tr="send-original"]')) !== null && (await page.$('[data-tr="retry"]')) !== null, 'failure prompt 发送原文 / 重试');
  // send → confirmed
  await page.fill('textarea.ta', '示例回复');
  await page.click('[data-action="send"]');
  await page.waitForSelector('[data-send-state="ok"]', { timeout: 8000 });
  check((await text(page, '[data-send-state="ok"]')) === '已确认', 'sent message confirmed');

  // context menu: pin + colour
  await page.click('.conv[data-gid="g-demo-2"]', { button: 'right' });
  await page.waitForSelector('.ctx-menu', { timeout: 3000 });
  check((await page.$$('.ctx-menu .mk')).length === 5, 'five colour marks in context menu');
  check((await text(page, '.ctx-menu [data-ctx="top"]')) === '置顶', 'context menu 置顶');
  check((await page.$('.ctx-menu [data-ctx="clear"]')) !== null, '取消标记 shown for marked conversation');
  await page.click('.ctx-menu [data-mark="4"]');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.conv[data-gid="g-demo-2"] .cmark');
      return !!el && getComputedStyle(el).backgroundColor === 'rgb(138, 92, 214)';
    },
    null,
    { timeout: 5000 },
  );
  check(true, 'colour mark updated to 紫');
  await page.click('.conv[data-gid="g-demo-2"]', { button: 'right' });
  await page.click('.ctx-menu [data-ctx="top"]');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.conv')).slice(0, 2).map((e) => e.getAttribute('data-gid')).join(',') === 'g-demo-1,g-demo-2', null, { timeout: 5000 });
  check((await page.$('.conv[data-gid="g-demo-2"].top')) !== null, 'pinned conversation moves into the pinned group (after the newer pinned 客户A)');
  await hygiene(page, 'main/messages+ctx');
  const markCalls = await rec.calls('im_set_mark');
  check(markCalls.length === 1 && markCalls[0].payload.action === 4 && markCalls[0].payload.account?.account_id === 'acc-demo-a', 'im_set_mark payload {account, gid, action 4}');
  await page.mouse.click(5, 5);
  await page.click('[data-nav="me"]');
  await page.waitForSelector('.me-menu', { timeout: 3000 });
  await hygiene(page, 'main/me-menu');
  await page.mouse.click(5, 5);
  await shot(page, 'main-messages.png');

  // notifications
  await page.click('[data-nav="notifications"]');
  await page.waitForSelector('.nitem', { timeout: 5000 });
  const cats = await page.$$eval('.ncat-i', (els) => els.map((e) => e.textContent?.replace(/\d+$/, '').trim()));
  check(cats.join(',') === '订单通知,产品通知,财务通知,系统通知', `notification categories (${cats.join(',')})`);
  check(!cats.includes('特别关注'), 'no 特别关注 category');
  check((await page.$$('.nitem.unread')).length >= 1, 'unread notifications');
  check((await text(page, '.nitem .link'))?.includes('打开官方页面'), 'notification link opens official page');
  await hygiene(page, 'main/notifications');
  await shot(page, 'main-notifications.png');
  await page.click('[data-action="mark-all"]');
  await page.waitForFunction(() => document.querySelectorAll('.nitem.unread').length === 0, null, { timeout: 5000 });
  check(true, '全部标为已读 clears unread');

  // order contact
  await page.click('[data-nav="order"]');
  await page.waitForSelector('[data-action="order-query"]', { timeout: 5000 });
  const expectState = async (id, state) => {
    await page.click(`[data-sample="${id}"]`);
    await page.waitForSelector(`[data-order-state="${state}"]`, { timeout: 8000 });
    return text(page, `[data-order-state="${state}"]`);
  };
  const one = await expectState('0000000001', 'one');
  check(one?.includes('IM 联系') && one.includes('网页高级操作'), 'single result has 「IM 联系」 and 「网页高级操作」');
  await hygiene(page, 'main/order');
  await shot(page, 'main-order-contact.png');
  // 网页高级操作 → host webview command with the official detail URL, never window.open
  await rec.reset();
  await page.click('[data-order-state="one"] [data-action="web"]');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent?.includes('已在内置网页打开'), null, { timeout: 3000 });
  const webCalls = await rec.calls('shell_open_webview');
  check(webCalls.length === 1 && webCalls[0].payload.url === 'https://vbooking.ctrip.com/ticket_order/order/detail?orderId=0000000001' && webCalls[0].payload.account?.account_id === 'acc-demo-a', `网页高级操作 uses shell_open_webview with the detail URL (${JSON.stringify(webCalls[0]?.payload)})`);
  check((await rec.windowOpen()) === 0 && (await rec.calls('shell_open_external')).length === 0, '网页高级操作 never calls window.open / shell_open_external');
  const multi = await expectState('0000000002', 'multiple');
  check(multi?.includes('多个匹配'), 'multiple results state');
  check((await page.$('[data-order-state="multiple"] [data-action="im"]')) === null && (await page.$('[data-order-state="multiple"] [data-action="web"]')) === null, 'multiple results offer no 「IM 联系」/「网页高级操作」');
  check((await page.$$('[data-order-state="multiple"] [data-action="select"]')).length === 2, 'each row of a multiple result offers 选择此订单');
  await page.click('[data-order="0000000005"] [data-action="select"]');
  await page.waitForSelector('[data-order-state="one"]', { timeout: 3000 });
  check((await page.$$('[data-order-state="one"] [data-order]')).length === 1 && (await page.$('[data-order-state="one"] [data-order="0000000005"] [data-action="im"]')) !== null, 'picking a row narrows to one verified order with 「IM 联系」');
  check((await expectState('0000000003', 'forbidden'))?.includes('无权'), 'forbidden state');
  check((await expectState('0000000008', 'none'))?.includes('未找到'), 'none state');
  await rec.reset();
  check((await expectState('0000000009', 'unknown'))?.includes('不会自动重试'), 'timeout → unknown, no auto retry');
  await page.waitForTimeout(500);
  check((await rec.calls('order_search')).length === 1, 'a timed-out order query is issued exactly once (no automatic replay)');
  await page.fill('[data-fid="order-query"]', '123');
  await page.click('[data-action="order-query"]');
  await page.waitForSelector('.toast', { timeout: 3000 });
  check((await text(page, '.toast'))?.includes('完整订单号'), 'invalid order id rejected');
  await expectState('0000000001', 'one');
  await rec.reset();
  // two synchronous clicks on 「IM 联系」 (double-click before re-render) fire createimchat once
  await page.$eval('[data-order-state="one"] [data-action="im"]', (el) => {
    el.click();
    el.click();
  });
  await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-view') === 'messages' && document.querySelector('.conv.on .cname')?.textContent === '客户A', null, { timeout: 8000 });
  check(true, 'IM 联系 opens the customer conversation (existing one reused)');
  const imCalls = await rec.calls('order_create_im_chat');
  check(imCalls.length === 1 && imCalls[0].payload.order_id === '0000000001' && imCalls[0].payload.account?.account_id === 'acc-demo-a', `createimchat fired exactly once per click (${imCalls.length})`);

  // an in-flight 「IM 联系」 keeps its account: switching tabs meanwhile must not show A's result under B
  await page.click('[data-nav="order"]');
  await expectState('0000000001', 'one');
  await rec.reset();
  await page.$eval('[data-order-state="one"] [data-action="im"]', (el) => el.click());
  await page.click('.tab[data-account="acc-demo-b"]');
  await page.waitForSelector('.tab.on[data-account="acc-demo-b"]', { timeout: 5000 });
  await page.waitForTimeout(900);
  const lateIm = await rec.calls('order_create_im_chat');
  const lateConvs = await rec.calls('im_conversations');
  check(lateIm.length === 1 && lateIm[0].payload.account?.account_id === 'acc-demo-a', 'in-flight createimchat still carries account A');
  check(lateConvs.some((c) => c.payload.account?.account_id === 'acc-demo-a') && lateConvs.some((c) => c.payload.account?.account_id === 'acc-demo-b'), 'conversation reloads are issued per account');
  check(document_view(await page.getAttribute('.app', 'data-view')) === 'order' && (await page.$('[data-order-state]')) === null, 'switching accounts keeps the navigation view but drops the other account\'s order result');
  await page.click('[data-nav="messages"]');
  await page.waitForTimeout(100);
  check((await page.$$('.conv')).length === 0 && (await page.$('.conv.on')) === null, 'account B shows none of A\'s conversations after the in-flight action settled');
  check(errors.length === 0, `no page error around the account switch (${errors.join('; ')})`);
  await page.click('.tab[data-account="acc-demo-a"]');
  await page.waitForSelector('.conv', { timeout: 5000 });
  check((await page.$$('.conv')).length === 5, 'switching back to A restores its 处理中 conversations');

  // logout dialog with three modes
  await page.click('.tab[data-account="acc-demo-a"] .tab-x');
  await page.waitForSelector('.dlg', { timeout: 3000 });
  const modes = await page.$$eval('.dlg [data-logout]', (els) => els.map((e) => e.getAttribute('data-logout')));
  check(modes.join(',') === 'suspend,logout,forget', `logout dialog modes (${modes.join(',')})`);
  await hygiene(page, 'main/logout-dialog');
  await page.keyboard.press('Escape');

  // clock-untrusted scenario
  await page.goto(`${base}/apps/main/index.html?scenario=clock-untrusted`);
  await page.waitForSelector('[data-sb="clock-untrusted"]', { timeout: 8000 });
  check((await text(page, '[data-sb="clock-untrusted"]')) === '待核对', 'clock-untrusted indicator in status bar');

  for (const e of errors) check(false, `main: ${e}`);
  await page.close();
}

async function testAlarm(browser, base) {
  console.log('[smoke] alarm');
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 520 } });
  watch(page, errors);
  await page.goto(`${base}/apps/alarm/index.html?scenario=default`);
  await page.waitForSelector('.arow', { timeout: 8000 });
  check(/^3 个回复超时提醒$/.test((await text(page, '[data-alarm-title]')) ?? ''), 'alarm header count');
  check((await text(page, '[data-alarm-threshold]')) === '阈值 30 秒', 'alarm threshold text');
  const waits = await page.$$eval('.arow [data-waited]', (els) => els.map((e) => Number(e.getAttribute('data-waited'))));
  check(waits.length === 3 && waits[0] >= waits[1] && waits[1] >= waits[2], `sorted by waited desc (${waits.join(',')})`);
  check((await page.$('.arow:first-child .alarm-wait.red')) !== null, 'first entry (> 90 s) is red');
  check((await page.$('.arow:nth-child(2) .alarm-wait.red')) === null, '45 s entry is not red');
  check((await text(page, '[data-pending]')) === '待核对', '待核对 badge for unconfirmed start');
  check(/\d+分\d+秒/.test((await text(page, '.arow:first-child .alarm-wait')) ?? ''), 'waited time formatted 分秒');
  const bodyText = await text(page, 'body');
  check(!/示例消息|Is breakfast/.test(bodyText ?? ''), 'no customer message text in alarm window');
  // stronger: none of the demo conversations' message texts / previews may appear anywhere in the alarm DOM
  const leaked = await page.evaluate(async () => {
    const m = window.__vbkMock;
    const acc = (await m.invoke('account_snapshot')).accounts[0].context;
    const convs = await m.invoke('im_conversations', { account: acc });
    const texts = [];
    for (const c of convs) {
      if (c.preview) texts.push(c.preview);
      for (const msg of await m.invoke('im_messages', { account: acc, gid: c.gid })) if (msg.text.length > 3) texts.push(msg.text);
    }
    const html = document.body.innerHTML;
    return texts.filter((t) => html.includes(t));
  });
  check(leaked.length === 0, `no conversation text leaks into the alarm DOM (${leaked.join('|')})`);
  await hygiene(page, 'alarm');
  await shot(page, 'alarm.png');
  const rec = await recordInvokes(page);

  // red threshold is inclusive at 90 s (store injection; the next tick restores the mock data)
  const redFlags = await page.evaluate(() => {
    const st = window.__vbkStore;
    const snap = st.get().snapshot;
    st.patch({ snapshot: { ...snap, entries: snap.entries.map((e, i) => ({ ...e, waited_seconds: i === 0 ? 90 : 89 })) } });
    return new Promise((r) => queueMicrotask(() => r(Array.from(document.querySelectorAll('.arow')).map((row) => [row.querySelector('[data-waited]')?.getAttribute('data-waited'), row.classList.contains('red')]))));
  });
  check(JSON.stringify(redFlags) === JSON.stringify([['90', true], ['89', false], ['89', false]]), `red exactly at waited_seconds >= 90 (${JSON.stringify(redFlags)})`);

  // malformed `notify://alarm-snapshot` payloads must be dropped, not rendered and not crash
  const garbageResult = await page.evaluate((garbage) => {
    const m = window.__vbkMock;
    const before = document.querySelectorAll('.arow').length;
    const counts = [];
    for (const g of garbage) {
      m.emit('notify://alarm-snapshot', g);
      counts.push(document.querySelectorAll('.arow').length);
    }
    return { before, counts, title: document.querySelector('[data-alarm-title]')?.textContent };
  }, GARBAGE_PAYLOADS);
  check(garbageResult.counts.every((n) => n === garbageResult.before) && /^3 个/.test(garbageResult.title ?? ''), `garbage alarm payloads are dropped (${garbageResult.counts.join(',')})`);
  await page.waitForTimeout(50);
  check(errors.length === 0, `no page error after garbage alarm payloads (${errors.join('; ')})`);
  check((await page.$$('.arow')).length === 3, 'alarm list intact after garbage payloads');

  // tick advances
  const before = waits[0];
  await page.waitForFunction((b) => Number(document.querySelector('.arow [data-waited]')?.getAttribute('data-waited')) > b, before, { timeout: 5000 });
  check(true, 'snapshot ticks every second');

  // snooze: the menu offers exactly 5/10/30 and the command echoes the row's identity + version
  const row2 = await page.$eval('.arow:nth-child(2)', (el) => ({ gid: el.dataset.gid, round_id: el.dataset.round, version: Number(el.dataset.version) }));
  await page.click('.arow:nth-child(2) [data-act="snooze"]');
  await page.waitForSelector('[data-snooze]', { timeout: 3000 });
  const snoozeOpts = await page.$$eval('[data-snooze]', (els) => els.map((e) => e.getAttribute('data-snooze')));
  check(snoozeOpts.join(',') === '5,10,30', `snooze menu offers exactly 5/10/30 (${snoozeOpts.join(',')})`);
  await page.click('.arow:nth-child(2) [data-snooze="10"]');
  await page.waitForSelector('[data-snoozed]', { timeout: 5000 });
  check((await text(page, '[data-snoozed]'))?.startsWith('稍后提醒至'), 'snoozed indicator');
  check(/^2 个回复超时提醒$/.test((await text(page, '[data-alarm-title]')) ?? ''), 'snoozed entry not counted in header');
  const snoozeCalls = await rec.calls('notify_snooze');
  check(
    snoozeCalls.length === 1 && JSON.stringify(Object.keys(snoozeCalls[0].payload).sort()) === '["account","gid","minutes","round_id","version"]' && snoozeCalls[0].payload.gid === row2.gid && snoozeCalls[0].payload.round_id === row2.round_id && snoozeCalls[0].payload.version === row2.version && snoozeCalls[0].payload.minutes === 10 && snoozeCalls[0].payload.account.account_id === 'acc-demo-a',
    `notify_snooze echoes {account,gid,round_id,version} of the displayed row + minutes (${JSON.stringify(snoozeCalls[0]?.payload)})`,
  );

  // version mismatch → notice + refresh, no retry with the old version
  await rec.reset();
  const staleVersion = await page.evaluate(() => {
    const st = window.__vbkStore;
    const snap = st.get().snapshot;
    st.patch({ snapshot: { ...snap, entries: snap.entries.map((e, i) => (i === 0 ? { ...e, version: e.version + 10 } : e)) } });
    return snap.entries[0].version + 10;
  });
  await page.click('.arow:first-child [data-act="hide"]');
  await page.waitForSelector('[data-alarm-notice]', { timeout: 5000 });
  check((await text(page, '[data-alarm-notice]')) === '提醒已更新，已刷新列表', 'version mismatch notice');
  check((await page.$$('.arow')).length === 3, 'stale hide did not remove the entry');
  const hideCalls = await rec.calls('notify_hide_round');
  check(hideCalls.length === 1 && hideCalls[0].payload.version === staleVersion && JSON.stringify(Object.keys(hideCalls[0].payload).sort()) === '["account","gid","round_id","version"]', 'hide echoed the displayed (stale) version exactly once; no retry');
  check((await rec.calls('notify_snapshot')).length >= 1, 'version mismatch triggers a notify_snapshot refresh');
  await page.waitForFunction((v) => Number(document.querySelector('.arow:first-child')?.getAttribute('data-version')) === v, staleVersion - 10, { timeout: 5000 });
  check(true, 'refreshed row carries the host version again');

  // hide → removed, with the identity echoed from the refreshed snapshot
  await rec.reset();
  const row1 = await page.$eval('.arow:first-child', (el) => ({ gid: el.dataset.gid, round_id: el.dataset.round, version: Number(el.dataset.version) }));
  await page.click('.arow:first-child [data-act="hide"]');
  await page.waitForFunction(() => document.querySelectorAll('.arow').length === 2, null, { timeout: 5000 });
  check(true, '清除 hides the round');
  const hide2 = await rec.calls('notify_hide_round');
  check(hide2.length === 1 && hide2[0].payload.gid === row1.gid && hide2[0].payload.round_id === row1.round_id && hide2[0].payload.version === row1.version, 'notify_hide_round echoes the displayed row');
  const shown = await page.$$eval('.arow', (els) => els.map((el) => ({ gid: el.dataset.gid, round_id: el.dataset.round, version: Number(el.dataset.version) })));
  await rec.reset();
  await page.click('[data-act="hide-all"]');
  await page.waitForSelector('.empty', { timeout: 5000 });
  check((await text(page, '.empty'))?.includes('没有回复超时'), '全部清除 empties the list');
  const hideAll = await rec.calls('notify_hide_all');
  const sortRef = (a) => [...a].sort((x, y) => x.gid.localeCompare(y.gid));
  check(hideAll.length === 1 && JSON.stringify(sortRef(hideAll[0].payload.seen)) === JSON.stringify(sortRef(shown)), `notify_hide_all sends exactly the displayed versions (${JSON.stringify(hideAll[0]?.payload.seen)})`);

  await page.goto(`${base}/apps/alarm/index.html?scenario=reconciling`);
  await page.waitForSelector('[data-alarm-banner="reconciling"]', { timeout: 8000 });
  check((await text(page, '[data-alarm-banner="reconciling"]')) === '正在对账，暂停新提醒', 'reconciling banner');
  await page.goto(`${base}/apps/alarm/index.html?scenario=clock-untrusted`);
  await page.waitForSelector('[data-alarm-banner="clock"]', { timeout: 8000 });
  check((await text(page, '[data-alarm-banner="clock"]'))?.includes('时间为估计'), 'clock-untrusted hint');
  await shot(page, 'alarm-clock-untrusted.png');

  for (const e of errors) check(false, `alarm: ${e}`);
  await page.close();
}

async function testSetting(browser, base) {
  console.log('[smoke] setting');
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 880, height: 640 } });
  watch(page, errors);
  await page.goto(`${base}/apps/setting/index.html`);
  await page.waitForSelector('[data-setting="reminder.enabled"]', { timeout: 8000 });
  const sections = await page.$$eval('.setnav [data-section]', (els) => els.map((e) => e.textContent?.trim()));
  check(sections.join('/') === '通用/显示/通知与提醒/快捷键/商家助手/网络/存储/隐私', `sections (${sections.join('/')})`);
  const t1Options = await page.$$eval('[data-setting="reminder.t1_seconds"] option', (els) => els.map((e) => e.value));
  check(t1Options.join(',') === '30,60,90,120,180', `T1 options (${t1Options.join(',')})`);
  check((await page.getAttribute('[data-setting="reminder.continuous_l4"]', 'aria-checked')) === 'false', 'L4 default off');
  check((await text(page, 'body'))?.includes('默认关闭。开启后进入强提醒再过 60 秒'), 'L4 explanation');
  for (const key of ['reminder.timeout_sound', 'reminder.position', 'reminder.alert_during_dnd', 'reminder.alert_during_fullscreen', 'reminder.tray_flash', 'reminder.taskbar_badge', 'dnd.schedule_enabled']) {
    check((await page.$(`[data-setting="${key}"]`)) !== null, `setting ${key} present`);
  }
  const rec = await recordInvokes(page);
  await page.selectOption('[data-setting="reminder.t1_seconds"]', '90');
  await page.waitForSelector('.toast', { timeout: 5000 });
  const t1 = await page.evaluate(() => window.__vbkMock.invoke('prefs_snapshot').then((p) => p.reminder.t1_seconds));
  check(t1 === 90, `T1 persisted via notify_set_threshold (${t1})`);
  check((await rec.calls('notify_set_threshold')).length === 1 && (await rec.calls('prefs_set')).length === 0, 'T1 goes through notify_set_threshold, not prefs_set');
  // an invalid value injected into the select cannot be submitted (UI validation before the command)
  await rec.reset();
  await page.evaluate(() => {
    const sel = document.querySelector('[data-setting="reminder.t1_seconds"]');
    const o = document.createElement('option');
    o.value = '45';
    o.textContent = '45 秒';
    sel.appendChild(o);
  });
  await page.selectOption('[data-setting="reminder.t1_seconds"]', '45');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent?.includes('保存失败'), null, { timeout: 5000 });
  check((await rec.calls('notify_set_threshold')).length === 0, 'invalid T1 (45) is rejected before any command is sent');
  check((await page.evaluate(() => window.__vbkMock.invoke('prefs_snapshot').then((p) => p.reminder.t1_seconds))) === 90, 'T1 unchanged after invalid submit');
  await page.waitForFunction(() => document.querySelector('[data-setting="reminder.t1_seconds"]')?.value === '90', null, { timeout: 3000 });
  check(true, 'select reverts to the persisted value');
  // every other reminder toggle persists (prefs_set section reminder) and reaches the alarm snapshot
  for (const key of ['continuous_l4', 'alert_during_dnd', 'tray_flash']) {
    const was = await page.getAttribute(`[data-setting="reminder.${key}"]`, 'aria-checked');
    await page.click(`[data-setting="reminder.${key}"]`);
    await page.waitForFunction((k, w) => document.querySelector(`[data-setting="reminder.${k}"]`)?.getAttribute('aria-checked') === (w === 'true' ? 'false' : 'true'), null, { timeout: 5000 }, key, was).catch(() => undefined);
    await page.waitForTimeout(350);
    const persisted = await page.evaluate((k) => window.__vbkMock.invoke('prefs_snapshot').then((p) => p.reminder[k]), key);
    const shown = await page.getAttribute(`[data-setting="reminder.${key}"]`, 'aria-checked');
    check(String(persisted) === (was === 'true' ? 'false' : 'true') && shown === String(persisted), `reminder.${key} toggle persisted via prefs_set (was ${was}, now ${persisted}, shown ${shown})`);
  }
  const alarmSettings = await page.evaluate(() => window.__vbkMock.invoke('notify_snapshot').then((s) => s.settings));
  check(alarmSettings.continuous_l4 === true && alarmSettings.t1_seconds === 90, 'alarm snapshot reflects L4 + threshold changes');
  await page.click('[data-setting="reminder.enabled"]');
  await page.waitForFunction(() => document.querySelector('[data-setting="reminder.enabled"]')?.getAttribute('aria-checked') === 'false', null, { timeout: 5000 });
  check(true, 'reminder toggle off');
  await hygiene(page, 'setting/notify');
  await shot(page, 'setting-notify.png');

  await page.click('[data-section="assistant"]');
  await page.waitForSelector('[data-send-mode="replace_draft"]', { timeout: 5000 });
  check((await page.getAttribute('[data-send-mode="replace_draft"]', 'aria-checked')) === 'true', 'replace-draft is default');
  check((await text(page, '[data-send-mode="send_direct"]'))?.includes('客户只收到译文'), 'direct-send explanation');
  check((await text(page, '[data-send-mode="replace_draft"]'))?.includes('点「替换」'), 'replace-draft explanation');
  await page.click('[data-send-mode="send_direct"]');
  await page.waitForFunction(() => document.querySelector('[data-send-mode="send_direct"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 5000 });
  check(true, 'send mode switched');
  check((await page.getAttribute('[data-tsim-status]', 'data-tsim-status')) === 'in', 'TSim initially logged in (demo)');
  await page.click('[data-action="tsim-logout"]');
  await page.waitForSelector('[data-fid="tsim-user"]', { timeout: 5000 });
  await page.fill('[data-fid="tsim-user"]', 'tsim-demo-user');
  await page.fill('[data-fid="tsim-pass"]', 'wrong');
  await page.click('[data-action="tsim-login"]');
  await page.waitForSelector('[role="alert"]', { timeout: 5000 });
  check((await page.inputValue('[data-fid="tsim-pass"]')) === '', 'password cleared after failed login');
  await page.fill('[data-fid="tsim-pass"]', 'secret');
  await page.click('[data-action="tsim-login"]');
  await page.waitForSelector('[data-tsim-status="in"]', { timeout: 5000 });
  check((await text(page, '[data-tsim-status="in"]'))?.includes('tsim-demo-user'), 'TSim login succeeded');
  const stateDump = await page.evaluate(() => JSON.stringify(window.__vbkStore.get()));
  check(!stateDump.includes('secret'), 'no password kept in UI state');
  check((await page.$('[data-setting="assistant.package_quick_view"]')) !== null, '套餐速览 toggle');
  await shot(page, 'setting-assistant.png');
  await hygiene(page, 'setting/assistant');
  for (const sec of ['general', 'display', 'keys', 'network', 'storage', 'privacy']) {
    await page.click(`[data-section="${sec}"]`);
    await page.waitForSelector('.set-h', { timeout: 3000 });
    check(!((await text(page, '.setbody'))?.includes('即将上线')), `section ${sec} has no 即将上线 placeholder`);
    await hygiene(page, `setting/${sec}`);
  }

  for (const e of errors) check(false, `setting: ${e}`);
  await page.close();
}

async function testLogin(browser, base) {
  console.log('[smoke] login');
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 460 } });
  watch(page, errors);
  await page.goto(`${base}/apps/login/index.html`);
  await page.waitForSelector('[data-action="cancel"]', { timeout: 8000 });
  check((await text(page, 'body'))?.includes('官方登录页在该账号独立的 WebView'), 'login shell explanation');
  check((await text(page, '.url')) === 'https://vbooking.ctrip.com/ivbk/accountV2/login', 'official login URL');
  check((await page.$('input[type="password"]')) === null, 'no password form in login shell');
  await hygiene(page, 'login');
  await page.evaluate((garbage) => {
    for (const g of garbage) window.__vbkMock.emit('account://changed', g);
  }, GARBAGE_PAYLOADS);
  await page.waitForTimeout(50);
  check((await page.$('[data-action="cancel"]')) !== null && errors.length === 0, 'login shell survives garbage account events');
  await shot(page, 'login.png');
  for (const e of errors) check(false, `login: ${e}`);
  await page.close();
}

const BUDGET_MS = 120_000;

async function main() {
  const started = Date.now();
  build();
  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  // Never leave Chromium or the server behind: hard budget and signal handlers both tear down.
  const teardown = async () => {
    await browser.close().catch(() => undefined);
    server.close();
    server.closeAllConnections?.();
  };
  const budget = setTimeout(() => {
    console.error(`  FAIL: smoke exceeded the ${BUDGET_MS / 1000}s budget`);
    void teardown().finally(() => process.exit(1));
  }, BUDGET_MS);
  budget.unref();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      console.error(`[smoke] ${sig}: tearing down`);
      void teardown().finally(() => process.exit(130));
    });
  }
  try {
    await testMain(browser, base);
    await testAlarm(browser, base);
    await testSetting(browser, base);
    await testLogin(browser, base);
  } catch (e) {
    failures += 1;
    console.error(`  FAIL (exception): ${e?.stack ?? e}`);
  } finally {
    clearTimeout(budget);
    await teardown();
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  check(Date.now() - started < BUDGET_MS, `smoke finished within budget (${elapsed}s)`);
  console.log(`[smoke] ${passes} checks passed, ${failures} failed in ${elapsed}s`);
  for (const s of screenshots) console.log(`[smoke] screenshot ${s}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
