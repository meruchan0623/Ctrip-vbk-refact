// I-29: identify untranslated UI literals using the TypeScript parser.
// Enforced by run.mjs; exact upstream field contexts are reviewed in cjk-protocols.mjs.
import assert from 'node:assert/strict';
import ts from 'typescript';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { productionFiles, readText, violation, formatViolation, vbkRoot } from './lib/common.mjs';
import { protocolLiteralPolicy } from './cjk-protocols.mjs';

export const GATE = 'cjk-literals';
// Real-tree enforcement is deferred (see run.mjs). Tests that scan production files call
// `expectNoCjkLiterals`, which only fails when VBK_CJK_GATE=1 or `npm run gates:cjk` enforce it.
export const CJK_ENFORCED = process.env.VBK_CJK_GATE === '1';
export function expectNoCjkLiterals(violations, message) {
  if (CJK_ENFORCED) assert.deepEqual(violations.map(formatViolation), [], message);
}
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;

// JSX numeric entities are decoded once by the JSX compiler. Do not apply this
// to ordinary strings or recursively decode an escaped ampersand.
function jsxText(value) {
  return value.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, code) => {
    const point = code[0].toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : '\ufffd';
  });
}

export function scanFile(file, text) {
  if (['i18n.ts', 'strings.ts'].includes(basename(file)) || /\.test\.[cm]?[tj]sx?$/.test(file)
    || /(?:^|\/)(?:tests?|fixtures)\//.test(file)) return [];
  // This exact fixture is stripped by the release bundler and release scanner;
  // neighboring files, including any production mock loader, remain checked.
  if (file === 'ui/packages/ipc/src/mock.ts') return [];
  const source = ts.createSourceFile('/' + file.replace(/^\/+/, ''), text, ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const isProtocolLiteral = protocolLiteralPolicy(file, source);
  const out = [];
  let stringShadowed = false;
  const findBinding = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
      || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isImportClause(node)
      || ts.isImportSpecifier(node) || ts.isImportEqualsDeclaration(node)
      || ts.isNamespaceImport(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node))
      && node.name && ts.isIdentifier(node.name) && node.name.text === 'String') stringShadowed = true;
    ts.forEachChild(node, findBinding);
  };
  findBinding(source);
  const literalText = (node) => {
    if (ts.isJsxText(node) || (ts.isStringLiteral(node) && ts.isJsxAttribute(node.parent))) return jsxText(node.text);
    if (!stringShadowed && ts.isTemplateLiteralToken(node)) {
      let parent = node.parent;
      while (parent && (ts.isTemplateSpan(parent) || ts.isTemplateExpression(parent))) parent = parent.parent;
      if (parent && ts.isTaggedTemplateExpression(parent) && ts.isPropertyAccessExpression(parent.tag)
        && ts.isIdentifier(parent.tag.expression) && parent.tag.expression.text === 'String'
        && parent.tag.name.text === 'raw') return node.rawText ?? node.text;
    }
    return node.text;
  };
  const visit = (node) => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node) || ts.isJsxText(node)) && CJK.test(literalText(node)) && !isProtocolLiteral(node)) {
      out.push(violation(GATE, file, source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        'CJK literal outside an approved string catalog'));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

export function run(root = vbkRoot) {
  return productionFiles(root, ['ui/apps', 'ui/packages'])
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .flatMap((file) => scanFile(file, readText(join(root, file))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = run();
  for (const finding of findings) console.error(formatViolation(finding));
  console.log(`[${GATE}] ${findings.length} literal(s) remaining`);
  process.exitCode = findings.length ? 1 : 0;
}
