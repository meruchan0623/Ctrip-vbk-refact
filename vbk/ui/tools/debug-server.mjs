#!/usr/bin/env node
/**
 * 浏览器调试服务：把 `ui/` 下所有窗口（apps/*）挂在一个本地 HTTP 服务里，
 * 每个窗口都使用确定性的 mock IPC（见 packages/ipc/src/mock.ts），
 * 便于在浏览器中直接查看整个界面。仅用于开发调试，不进入发布包。
 *
 *   node ui/tools/debug-server.mjs              (from vbk/)
 *   node ui/tools/debug-server.mjs --no-build   跳过 tsc 编译，直接用已有 ui/dist
 *   PORT=5180 HOST=127.0.0.1                    可通过环境变量覆盖
 *
 * 打开 http://127.0.0.1:5180/ 可看到窗口索引；每个窗口可加 ?scenario=
 * 切换 mock 场景：default | empty | offline | clock-untrusted | reconciling | no-accounts | media-draft。
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vbkRoot = resolve(uiRoot, '..');
const PORT = Number(process.env.PORT ?? 5180);
const HOST = process.env.HOST ?? '127.0.0.1';
const SCENARIOS = ['default', 'empty', 'offline', 'clock-untrusted', 'reconciling', 'no-accounts', 'media-draft'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function build() {
  let localTsc = null;
  try {
    localTsc = createRequire(join(vbkRoot, 'package.json')).resolve('typescript/bin/tsc');
  } catch {
    localTsc = null;
  }
  const args = ['-p', 'tsconfig.build.json'];
  const r = localTsc
    ? spawnSync(process.execPath, [localTsc, ...args], { cwd: vbkRoot, encoding: 'utf8' })
    : spawnSync('tsc', args, { cwd: vbkRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (out) console.log(out);
  if (r.status !== 0) console.warn(`[debug] tsc 退出码 ${r.status}，仍尝试使用已产出的 ui/dist（若缺失会 404）`);
  else console.log('[debug] 编译完成');
}

/** 发现含 index.html 的窗口目录，例如 apps/main、apps/alarm。 */
function discoverApps() {
  const appsDir = join(uiRoot, 'apps');
  return readdirSync(appsDir)
    .filter((name) => !name.startsWith('_') && existsSync(join(appsDir, name, 'index.html')))
    .sort();
}

function indexPage(apps) {
  const rows = apps
    .map((app) => {
      const links = SCENARIOS.map((s) => `<a href="/apps/${app}/index.html?scenario=${s}">${s}</a>`).join(' · ');
      return `<li><strong>${app}</strong><br>${links}</li>`;
    })
    .join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>VBK UI 调试索引</title>
<style>body{font:14px/1.6 system-ui,sans-serif;margin:24px;max-width:900px}li{margin:10px 0}a{margin-right:2px}</style>
</head><body><h1>VBK UI 调试索引</h1><p>所有窗口使用 mock IPC。点击场景名切换数据状态。</p><ul>${rows}</ul></body></html>`;
}

const noBuild = process.argv.includes('--no-build');
if (!noBuild) build();

const apps = discoverApps();
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(indexPage(apps));
    return;
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(uiRoot, rel);
  if (!file.startsWith(uiRoot) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found: ' + url.pathname);
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`[debug] UI 调试服务已启动: http://${HOST}:${PORT}/`);
  console.log(`[debug] 窗口: ${apps.join(', ')}`);
  console.log(`[debug] 场景: ${SCENARIOS.join(' | ')}（用 ?scenario=<名称> 指定）`);
});
