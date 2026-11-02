// AST-level facts for TS/JS sources (I-02). Comments are not nodes and string
// literals are only reported as such, so neither can hit an identifier rule.
import ts from 'typescript';

/** Constant-fold string literals joined with `+` / substitution-free templates; `null` when not constant. */
export function foldString(node) {
  if (!node) return null;
  if (ts.isParenthesizedExpression(node)) return foldString(node.expression);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = foldString(node.left);
    const r = foldString(node.right);
    return l !== null && r !== null ? l + r : null;
  }
  return null;
}

function nameOfProp(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return foldString(name.expression);
  return null;
}

/** Name accessed by `a.b` or `a["b" + "c"]`; `null` when dynamic. */
function accessedName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return foldString(node.argumentExpression);
  return null;
}

function calleeText(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const base = calleeText(expr.expression);
    return base ? `${base}.${expr.name.text}` : expr.name.text;
  }
  if (ts.isElementAccessExpression(expr)) {
    const n = foldString(expr.argumentExpression);
    const base = calleeText(expr.expression);
    return n !== null && base ? `${base}.${n}` : base ? `${base}.<dynamic>` : null;
  }
  if (ts.isParenthesizedExpression(expr)) return calleeText(expr.expression);
  return null;
}

const ASSIGN_OPS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * Returns facts: `ident` (every Identifier node), `string` (every string-like literal,
 * with the property/attribute it feeds), `prop` (object-literal key / element-access name),
 * `assign` (assignment target name and base text), `call`, `new`.
 */
export function tsFacts(text, fileName = 'file.ts') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, /\.(?:tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : undefined);
  const facts = [];
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (node) => {
    if (ts.isIdentifier(node)) facts.push({ type: 'ident', name: node.text, line: line(node) });
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const p = node.parent;
      let feeds = null;
      if (p && ts.isPropertyAssignment(p) && p.initializer === node) feeds = { kind: 'prop', name: nameOfProp(p.name) };
      else if (p && ts.isBinaryExpression(p) && p.right === node && ASSIGN_OPS.has(p.operatorToken.kind)) feeds = { kind: 'assign', name: accessedName(p.left) ?? (ts.isIdentifier(p.left) ? p.left.text : null) };
      else if (p && ts.isCallExpression(p)) feeds = { kind: 'arg', callee: calleeText(p.expression), index: p.arguments.indexOf(node), first: foldString(p.arguments[0]) };
      facts.push({ type: 'string', value: node.text, line: line(node), feeds });
    }
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) {
      const n = nameOfProp(node.name);
      if (n !== null) facts.push({ type: 'prop', name: n, line: line(node), value: ts.isPropertyAssignment(node) ? node.initializer.getText(sf) : null });
    }
    if (ts.isElementAccessExpression(node)) {
      const n = foldString(node.argumentExpression);
      if (n !== null) facts.push({ type: 'prop', name: n, line: line(node), value: null });
    }
    if (ts.isBinaryExpression(node) && ASSIGN_OPS.has(node.operatorToken.kind)) {
      const n = accessedName(node.left) ?? (ts.isIdentifier(node.left) ? node.left.text : null);
      facts.push({ type: 'assign', name: n, base: calleeText(node.left), line: line(node) });
    }
    if (ts.isCallExpression(node)) {
      facts.push({ type: 'call', callee: calleeText(node.expression), args: node.arguments.map((a) => foldString(a)), argNodes: node.arguments.map((a) => a), line: line(node), sf });
    }
    if (ts.isNewExpression(node)) {
      facts.push({ type: 'new', callee: calleeText(node.expression), line: line(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

/** Keys of an object-literal node (folded), used for `Object.defineProperties`. */
export function objectKeys(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) return [];
  return node.properties.map((p) => nameOfProp(p.name)).filter((n) => n !== null);
}

/** Names of exported `const XxxCommands = { A: 'a', ... }` maps, value strings only. */
export function commandMaps(text, fileName = 'commands.ts') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out = {};
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /Commands$/.test(node.name.text)) {
      let init = node.initializer;
      while (init && (ts.isAsExpression(init) || ts.isParenthesizedExpression(init) || ts.isSatisfiesExpression?.(init))) init = init.expression;
      if (init && ts.isObjectLiteralExpression(init)) {
        out[node.name.text] = init.properties.filter(ts.isPropertyAssignment).map((p) => foldString(p.initializer)).filter((v) => v !== null);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
