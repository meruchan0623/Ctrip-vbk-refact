import ts from 'typescript';
import { pathToFileURL } from 'node:url';
import { isAssignment, memberName, propertyName, productionFiles, read, relativeFile, root, rustProduction, scanTypescript, stringValue, formatHits } from './source.mjs';

const forbidden = new Set(['danger_accept_invalid_certs', 'ignore-certificate-errors', 'rejectUnauthorized', 'remote-debugging-port', 'NODE_TLS_REJECT_UNAUTHORIZED', 'disable-web-security', 'disable-site-isolation-trials']);
const spoofed = new Set(['isTrusted', 'webdriver']);
export function scanSecurity(source, file = 'fixture.ts') {
  if (file.endsWith('.rs')) {
    const code = rustProduction(source), hits = [];
    for (const match of code.matchAll(/\b(?:danger_accept_invalid_certs|rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED)\b/g)) {
      const prefix = code.slice(0, match.index).split('\n');
      hits.push({ file, line: prefix.length, column: prefix.at(-1).length + 1, sink: match[0] });
    }
    return hits;
  }
  return scanTypescript(source, file, (node, report) => {
    if (isAssignment(node)) {
      const name = memberName(node.left);
      if (forbidden.has(name) || spoofed.has(name)) report(node, name);
    }
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)) {
      const name = propertyName(node.name);
      if (forbidden.has(name) || spoofed.has(name)) report(node, name);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = memberName(node.expression), args = node.arguments ?? [];
      if (forbidden.has(name)) report(node, name);
      if (name === 'defineProperty' && ['Object', 'Reflect'].includes(memberName(node.expression.expression))) {
        const target = stringValue(args[1]);
        if (spoofed.has(target) || forbidden.has(target)) report(node, target);
      }
      // Literal strings are harmless except when supplied as executable switches.
      if (['appendSwitch', 'setSwitch', 'push', 'spawn', 'exec', 'execFile', 'command', 'args', 'arg'].includes(name)) {
        const inspect = (arg) => {
          if (ts.isArrayLiteralExpression(arg)) return arg.elements.forEach(inspect);
          const value = stringValue(arg);
          if (value !== undefined) for (const flag of forbidden) if (value === flag || value.includes(`--${flag}`)) report(node, flag);
        };
        args.forEach(inspect);
      }
    }
  });
}
export const checkSecurity = (base = root) => productionFiles(base).flatMap((file) => scanSecurity(read(file), relativeFile(file, base)));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hits = checkSecurity();
  if (hits.length) { console.error(formatHits(hits)); process.exitCode = 1; }
  else console.log('TLS, debug switches and anti-automation mutations: passed');
}
