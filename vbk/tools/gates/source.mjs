import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export function filesBelow(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? filesBelow(join(dir, e.name)) : [join(dir, e.name)]);
}
export function productionFiles(base = root) {
  return ['crates', 'src-tauri/src', 'ui/packages', 'ui/apps'].flatMap((dir) => filesBelow(join(base, dir)))
    .filter((f) => /\.(?:[cm]?[jt]sx?|rs)$/.test(f) && !/(?:\.test\.[cm]?[jt]sx?|_tests\.rs)$/.test(f));
}
export const read = (file) => readFileSync(file, 'utf8');
export const relativeFile = (file, base = root) => relative(base, file).replaceAll('\\', '/');

export function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
}
// Resolve syntax-local constants only. No code is executed by the scanner.
export function stringValue(node) {
  node = unwrap(node);
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringValue(node.left), right = stringValue(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;
    for (const span of node.templateSpans) {
      const value = stringValue(span.expression);
      if (value === undefined) return undefined;
      result += value + span.literal.text;
    }
    return result;
  }
  return undefined;
}
export function memberName(node) {
  node = unwrap(node);
  if (!node) return undefined;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return stringValue(node.argumentExpression);
  if (ts.isIdentifier(node)) return node.text;
  return undefined;
}
export function propertyName(node) {
  if (!node) return undefined;
  return ts.isComputedPropertyName(node) ? stringValue(node.expression)
    : ts.isIdentifier(node) ? node.text : stringValue(node);
}
export function isAssignment(node) {
  return ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
}
export function scanTypescript(source, file, inspect) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const hits = [];
  function report(node, sink) {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    if (!hits.some((h) => h.line === line + 1 && h.column === character + 1 && h.sink === sink))
      hits.push({ file, line: line + 1, column: character + 1, sink });
  }
  function visit(node) { inspect(node, report); ts.forEachChild(node, visit); }
  visit(sf);
  if (sf.parseDiagnostics.length) hits.push({ file, line: 1, column: 1, sink: 'unparseable-source' });
  return hits;
}

// Keep offsets/newlines stable, remove nested comments, escaped/byte/char/raw
// strings, then skip the complete item guarded by #[cfg(test)]. Lifetimes are
// not character literals. No third-party Rust parser is needed.
export function rustProduction(source, preserveStrings = false, skipTests = true) {
  const chars = source.split('');
  const blank = (start, end) => { for (let k = start; k < end; k++) if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' '; };
  for (let i = 0; i < source.length;) {
    const start = i;
    let comment = false;
    if (source.startsWith('//', i)) {
      comment = true;
      i = source.indexOf('\n', i); if (i < 0) i = source.length;
    } else if (source.startsWith('/*', i)) {
      comment = true;
      let depth = 1; i += 2;
      while (i < source.length && depth) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; } else i++;
      }
    } else {
      const raw = /^(?:br|cr|r)(#*)"/.exec(source.slice(i));
      if (raw && (i === 0 || !/[\w]/.test(source[i - 1]))) {
        const end = source.indexOf('"' + raw[1], i + raw[0].length);
        i = end < 0 ? source.length : end + 1 + raw[1].length;
      } else if (source[i] === '"') {
        i++; while (i < source.length) { if (source[i] === '\\') i += 2; else if (source[i++] === '"') break; }
      } else if (source[i] === "'" && /^'(?:\\(?:u\{[\da-fA-F_]+\}|x[\da-fA-F]{2}|[^\r\n])|[^'\\\r\n])'/u.test(source.slice(i))) {
        const char = /^'(?:\\(?:u\{[\da-fA-F_]+\}|x[\da-fA-F]{2}|[^\r\n])|[^'\\\r\n])'/u.exec(source.slice(i));
        i += char[0].length;
      } else { i++; continue; }
    }
    if (comment || !preserveStrings) blank(start, i);
  }
  if (!skipTests) return chars.join('');
  const code = preserveStrings ? rustProduction(source, false, false) : chars.join('');
  for (const match of code.matchAll(/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/g)) {
    let i = match.index + match[0].length;
    // Attributes may themselves contain brace tokens; skip them first.
    while (/\s/.test(code[i] ?? '') || code[i] === '#') {
      if (code[i] === '#') {
        const open = code.indexOf('[', i); if (open < 0) break;
        let depth = 1; i = open + 1;
        while (i < code.length && depth) { if (code[i] === '[') depth++; if (code[i] === ']') depth--; i++; }
      } else i++;
    }
    while (i < code.length && code[i] !== '{' && code[i] !== ';') i++;
    if (code[i] === '{') {
      let depth = 1; i++;
      while (i < code.length && depth) { if (code[i] === '{') depth++; if (code[i] === '}') depth--; i++; }
    } else i++;
    blank(match.index, i);
  }
  return chars.join('');
}
export function formatHits(hits) { return hits.map((h) => `${h.file}:${h.line}:${h.column}: ${h.sink}`).join('\n'); }
