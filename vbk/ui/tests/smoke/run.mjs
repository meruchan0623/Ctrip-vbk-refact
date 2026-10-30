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
  check((await text(page, '.conv[data-gid="g-demo-2"] .badge')) === '1', 'unread badge on another conversation');
  check((await page.$('.conv .cmark')) !== null, 'colour mark bar rendered');
  check((await text(page, '.conv.on .cname')) === '客户A', 'first active conversation is 客户A');

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
  await page.mouse.click(5, 5);
  await shot(page, 'main-messages.png');

  // notifications
  await page.click('[data-nav="notifications"]');
  await page.waitForSelector('.nitem', { timeout: 5000 });
  const cats = await page.$$eval('.ncat-i', (els) => els.map((e) => e.textContent?.replace(/\d+$/, '').trim()));
  check(cats.join(',') === '订单通知,产品通知,财务通知,系统公告', `notification categories (${cats.join(',')})`);
  check(!cats.includes('特别关注'), 'no 特别关注 category');
  check((await page.$$('.nitem.unread')).length >= 1, 'unread notifications');
  check((await text(page, '.nitem .link'))?.includes('打开官方页面'), 'notification link opens official page');
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
  await shot(page, 'main-order-contact.png');
  const multi = await expectState('0000000002', 'multiple');
  check(multi?.includes('多个匹配'), 'multiple results state');
  check((await expectState('0000000003', 'forbidden'))?.includes('无权'), 'forbidden state');
  check((await expectState('0000000008', 'none'))?.includes('未找到'), 'none state');
  check((await expectState('0000000009', 'unknown'))?.includes('不会自动重试'), 'timeout → unknown, no auto retry');
  await page.fill('[data-fid="order-query"]', '123');
  await page.click('[data-action="order-query"]');
  await page.waitForSelector('.toast', { timeout: 3000 });
  check((await text(page, '.toast'))?.includes('完整订单号'), 'invalid order id rejected');
  await expectState('0000000001', 'one');
  await page.click('[data-order-state="one"] [data-action="im"]');
  await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-view') === 'messages' && document.querySelector('.conv.on .cname')?.textContent === '客户A', null, { timeout: 8000 });
  check(true, 'IM 联系 opens the customer conversation (existing one reused)');

  // logout dialog with three modes
  await page.click('.tab .tab-x');
  await page.waitForSelector('.dlg', { timeout: 3000 });
  const modes = await page.$$eval('.dlg [data-logout]', (els) => els.map((e) => e.getAttribute('data-logout')));
  check(modes.join(',') === 'suspend,logout,forget', `logout dialog modes (${modes.join(',')})`);
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
  await shot(page, 'alarm.png');

  // tick advances
  const before = waits[0];
  await page.waitForFunction((b) => Number(document.querySelector('.arow [data-waited]')?.getAttribute('data-waited')) > b, before, { timeout: 5000 });
  check(true, 'snapshot ticks every second');

  // snooze
  await page.click('.arow:nth-child(2) [data-act="snooze"]');
  await page.click('.arow:nth-child(2) [data-snooze="10"]');
  await page.waitForSelector('[data-snoozed]', { timeout: 5000 });
  check((await text(page, '[data-snoozed]'))?.startsWith('稍后提醒至'), 'snoozed indicator');
  check(/^2 个回复超时提醒$/.test((await text(page, '[data-alarm-title]')) ?? ''), 'snoozed entry not counted in header');

  // version mismatch → notice + refresh
  await page.evaluate(() => {
    const st = window.__vbkStore;
    const snap = st.get().snapshot;
    st.patch({ snapshot: { ...snap, entries: snap.entries.map((e, i) => (i === 0 ? { ...e, version: e.version + 10 } : e)) } });
  });
  await page.click('.arow:first-child [data-act="hide"]');
  await page.waitForSelector('[data-alarm-notice]', { timeout: 5000 });
  check((await text(page, '[data-alarm-notice]')) === '提醒已更新，已刷新列表', 'version mismatch notice');
  check((await page.$$('.arow')).length === 3, 'stale hide did not remove the entry');

  // hide → removed
  await page.click('.arow:first-child [data-act="hide"]');
  await page.waitForFunction(() => document.querySelectorAll('.arow').length === 2, null, { timeout: 5000 });
  check(true, '清除 hides the round');
  await page.click('[data-act="hide-all"]');
  await page.waitForSelector('.empty', { timeout: 5000 });
  check((await text(page, '.empty'))?.includes('没有回复超时'), '全部清除 empties the list');

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
  await page.selectOption('[data-setting="reminder.t1_seconds"]', '90');
  await page.waitForSelector('.toast', { timeout: 5000 });
  const t1 = await page.evaluate(() => window.__vbkMock.invoke('prefs_snapshot').then((p) => p.reminder.t1_seconds));
  check(t1 === 90, `T1 persisted via notify_set_threshold (${t1})`);
  await page.click('[data-setting="reminder.enabled"]');
  await page.waitForFunction(() => document.querySelector('[data-setting="reminder.enabled"]')?.getAttribute('aria-checked') === 'false', null, { timeout: 5000 });
  check(true, 'reminder toggle off');
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
  for (const sec of ['general', 'display', 'keys', 'network', 'storage', 'privacy']) {
    await page.click(`[data-section="${sec}"]`);
    await page.waitForSelector('.set-h', { timeout: 3000 });
    check(!((await text(page, '.setbody'))?.includes('即将上线')), `section ${sec} has no 即将上线 placeholder`);
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
  await shot(page, 'login.png');
  for (const e of errors) check(false, `login: ${e}`);
  await page.close();
}

async function main() {
  build();
  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  try {
    await testMain(browser, base);
    await testAlarm(browser, base);
    await testSetting(browser, base);
    await testLogin(browser, base);
  } catch (e) {
    failures += 1;
    console.error(`  FAIL (exception): ${e?.stack ?? e}`);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`[smoke] ${passes} checks passed, ${failures} failed`);
  for (const s of screenshots) console.log(`[smoke] screenshot ${s}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
