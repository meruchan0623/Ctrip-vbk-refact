// Shared helpers for the source gates (I-02). Node built-ins plus `typescript` only.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const gatesDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const vbkRoot = join(gatesDir, '..', '..');
export const repoRoot = join(vbkRoot, '..');

/** Production source roots scanned by the TLS / debug / DOM gates (relative to `vbk/`). */
export const PRODUCTION_ROOTS = ['crates', 'src-tauri/src', 'ui/packages', 'ui/apps'];

const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'bundle', 'gen', 'docs', '.git', 'tests', 'fixtures']);
const TS_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

/**
 * Production-source predicate. Test files, test directories and the gates
 * themselves are out of scope (plan I-02 item 1); `#[cfg(test)]` blocks inside
 * Rust files are skipped by the lexer.
 */
export function isProductionFile(rel) {
  const p = rel.split(sep).join('/');
  if (p.startsWith('tools/gates/')) return false;
  if (/\.test\.[cm]?[tj]sx?$/.test(p) || /\.d\.ts$/.test(p)) return false;
  if (/(?:^|\/)(?:tests?|fixtures|node_modules|target|dist|bundle|gen)\//.test(p)) return false;
  if (p.endsWith('.rs')) return !/(?:_tests|^tests)\.rs$/.test(p.split('/').pop() ?? '') && !/(?:^|\/)tests\.rs$/.test(p);
  return TS_EXT.test(p);
}

export function listFiles(root, rel = '') {
  const out = [];
  const dir = join(root, rel);
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = statSync(join(root, r));
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...listFiles(root, r));
    } else {
      out.push(r);
    }
  }
  return out;
}

export function productionFiles(root = vbkRoot, roots = PRODUCTION_ROOTS) {
  return roots.flatMap((r) => listFiles(root, r)).filter(isProductionFile);
}

export const readText = (path) => readFileSync(path, 'utf8');
export const relFromVbk = (path) => relative(vbkRoot, path).split(sep).join('/');

/** A violation is a plain, printable record. */
export function violation(gate, file, line, message) {
  return { gate, file, line, message };
}

export function formatViolation(v) {
  return `[${v.gate}] ${v.file}${v.line ? `:${v.line}` : ''}  ${v.message}`;
}

/** RFC 7386 JSON merge patch (null deletes), used by the structured fixtures. */
export function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}
