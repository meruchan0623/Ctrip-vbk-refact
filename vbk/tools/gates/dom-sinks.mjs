import ts from 'typescript';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { isAssignment, memberName, propertyName, productionFiles, read, relativeFile, root, scanTypescript, stringValue, unwrap, formatHits } from './source.mjs';

const html = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
const urlProperties = new Set(['href', 'src', 'location']);
const javascript = (node) => /^\s*javascript\s*:/i.test(stringValue(node) ?? '');
export function scanDom(source, file = 'fixture.ts') {
  return scanTypescript(source, file, (node, report) => {
    if (isAssignment(node)) {
      const name = memberName(node.left);
      if (html.has(name)) report(node, name);
      if (urlProperties.has(name) && javascript(node.right)) report(node, 'javascript:');
    }
    if (ts.isPropertyAssignment(node) || ts.isJsxAttribute(node)) {
      const name = propertyName(node.name);
      if (html.has(name)) report(node, name);
      if (urlProperties.has(name) && javascript(node.initializer)) report(node, 'javascript:');
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      let callee = unwrap(node.expression);
      // Indirect eval: (0, eval)(source).
      if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken) callee = unwrap(callee.right);
      const name = memberName(callee), args = node.arguments ?? [];
      if (name === 'eval' || name === 'Function' || name === 'insertAdjacentHTML') report(node, name);
      if ((name === 'write' || name === 'writeln') && memberName(callee.expression) === 'document') report(node, 'document.write');
      if (name === 'setAttribute') {
        const attr = stringValue(args[0])?.toLowerCase();
        if (attr === 'srcdoc') report(node, 'srcdoc');
        if ((attr === 'href' || attr === 'src') && javascript(args[1])) report(node, 'javascript:');
      }
      if (name === 'defineProperty' && memberName(callee.expression) === 'Object' && html.has(stringValue(args[1]))) report(node, stringValue(args[1]));
    }
  });
}
export function checkDom(base = root) {
  const hits = productionFiles(base).filter((f) => !f.endsWith('.rs')).flatMap((f) => scanDom(read(f), relativeFile(f, base)));
  const allow = JSON.parse(read(join(base, 'tools/gates/dom-sinks.allowlist.json')));
  if (!Array.isArray(allow)) throw new Error('DOM allowlist must be an array');
  const key = (h) => `${h.file}:${h.line}:${h.sink}`;
  const keys = new Set();
  for (const entry of allow) {
    if (entry.file !== 'ui/apps/main/companion-card.ts' || entry.sink !== 'innerHTML'
      || !Number.isInteger(entry.line) || entry.expires !== 'B1/I-29' || keys.has(key(entry))) throw new Error('Invalid or duplicate DOM allowlist entry');
    keys.add(key(entry));
    if (!hits.some((hit) => key(hit) === key(entry))) throw new Error(`Stale DOM allowlist entry: ${key(entry)}`);
  }
  if (allow.length > 1) throw new Error('DOM allowlist may contain at most the single B0 SVG sink');
  return hits.filter((hit) => !keys.has(key(hit)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hits = checkDom();
  if (hits.length) { console.error(formatHits(hits)); process.exitCode = 1; }
  else console.log('DOM sinks: passed (allowlist is checked for stale entries)');
}
