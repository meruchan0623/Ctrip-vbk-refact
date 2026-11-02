// AST-level facts for TS/JS sources (I-02). Comments are not nodes and string
// literals are only reported as such, so neither can hit an identifier rule.
import ts from 'typescript';

const PLUS = ts.SyntaxKind.PlusToken;
const isPlus = (n) => ts.isBinaryExpression(n) && n.operatorToken.kind === PLUS;
const isComma = (n) => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.CommaToken;

/**
 * Constant-fold string literals joined with `+`, templates whose every
 * substitution folds, and parenthesised forms; `null` when not constant.
 */
export function foldString(node) {
  if (!node) return null;
  if (ts.isParenthesizedExpression(node)) return foldString(node.expression);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node) || ts.isNonNullExpression(node)) return foldString(node.expression);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const v = foldString(span.expression);
      if (v === null) return null;
      out += v + span.literal.text;
    }
    return out;
  }
  if (isPlus(node)) {
    const l = foldString(node.left);
    const r = foldString(node.right);
    return l !== null && r !== null ? l + r : null;
  }
  return null;
}

/**
 * The constant prefix of a string-valued expression: the full fold when it
 * is constant, otherwise the template head / left-most literal run. `''`
 * when nothing is known. Lets a rule see `--remote-debugging-port=${p}`
 * and `'javascript:' + x` for what they are.
 */
export function foldPrefix(node) {
  if (!node) return '';
  const full = foldString(node);
  if (full !== null) return full;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return foldPrefix(node.expression);
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const v = foldString(span.expression);
      if (v === null) return out;
      out += v + span.literal.text;
    }
    return out;
  }
  if (isPlus(node)) {
    const l = foldString(node.left);
    return l !== null ? l + foldPrefix(node.right) : foldPrefix(node.left);
  }
  return '';
}

/** True for a node that is itself a string-building expression (template with holes or a `+` chain). */
function isStringExpr(node) {
  return ts.isTemplateExpression(node) || isPlus(node);
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
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return accessedName(node.expression);
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
  if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr) || ts.isAsExpression(expr)) return calleeText(expr.expression);
  // `(0, eval)(x)` is the classic indirect eval: the callee is the comma's right side
  if (isComma(expr)) return calleeText(expr.right);
  return null;
}

const ASSIGN_OPS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/** What a string-valued node feeds: an object property, an assignment target, a call argument, or a type position. */
function feedsOf(node) {
  const p = node.parent;
  if (!p) return null;
  if (ts.isPropertyAssignment(p) && p.initializer === node) return { kind: 'prop', name: nameOfProp(p.name) };
  if (ts.isBinaryExpression(p) && p.right === node && ASSIGN_OPS.has(p.operatorToken.kind)) {
    return { kind: 'assign', name: accessedName(p.left) ?? (ts.isIdentifier(p.left) ? p.left.text : null) };
  }
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    const args = p.arguments ?? [];
    return { kind: 'arg', callee: calleeText(p.expression), index: args.indexOf(node), first: foldString(args[0]) };
  }
  if (ts.isLiteralTypeNode(p) || ts.isEnumMember(p)) return { kind: 'type' };
  return null;
}

/**
 * Returns facts: `ident` (every Identifier node), `string` (every string-like literal
 * and every string-building expression, with `value` = full fold or `null`, `prefix` = constant
 * prefix, and the property/attribute it feeds), `prop` (object-literal key / class member /
 * interface member / element-access name), `assign` (assignment target name and base text),
 * `delete` (deleted property name), `call`, `new`.
 */
export function tsFacts(text, fileName = 'file.ts') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, /\.(?:tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : undefined);
  const facts = [];
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (node) => {
    if (ts.isIdentifier(node)) facts.push({ type: 'ident', name: node.text, line: line(node) });
    if (ts.isStringLiteralLike(node)) {
      facts.push({ type: 'string', value: node.text, prefix: node.text, line: line(node), feeds: feedsOf(node) });
    } else if (isStringExpr(node) && !(node.parent && isPlus(node.parent))) {
      // one fact per outermost `+` chain / template, so `'a' + 'b'` is seen as `ab`
      facts.push({ type: 'string', value: foldString(node), prefix: foldPrefix(node), line: line(node), feeds: feedsOf(node), composite: true });
    }
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) {
      const n = nameOfProp(node.name);
      if (n !== null) facts.push({ type: 'prop', name: n, line: line(node), value: ts.isPropertyAssignment(node) ? node.initializer.getText(sf) : null });
    }
    if (ts.isPropertySignature(node) || ts.isMethodSignature(node) || ts.isEnumMember(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
      // declared shape members (interfaces, type literals, enums, parameters); `value: undefined` marks "no runtime write"
      const n = ts.isParameter(node) || ts.isBindingElement(node) ? (ts.isIdentifier(node.name) ? node.name.text : null) : nameOfProp(node.name);
      if (n !== null) facts.push({ type: 'prop', name: n, line: line(node), value: undefined, declared: true });
    }
    if (ts.isElementAccessExpression(node)) {
      const n = foldString(node.argumentExpression);
      if (n !== null) facts.push({ type: 'prop', name: n, line: line(node), value: null });
    }
    if (ts.isBinaryExpression(node) && ASSIGN_OPS.has(node.operatorToken.kind)) {
      const n = accessedName(node.left) ?? (ts.isIdentifier(node.left) ? node.left.text : null);
      facts.push({ type: 'assign', name: n, base: calleeText(node.left), line: line(node) });
    }
    if (ts.isDeleteExpression(node)) {
      facts.push({ type: 'delete', name: accessedName(node.expression), line: line(node) });
    }
    if (ts.isCallExpression(node)) {
      facts.push({
        type: 'call',
        callee: calleeText(node.expression),
        args: node.arguments.map((a) => foldString(a)),
        argPrefixes: node.arguments.map((a) => foldPrefix(a)),
        argNodes: node.arguments.map((a) => a),
        line: line(node),
        sf,
      });
    }
    if (ts.isNewExpression(node)) {
      facts.push({ type: 'new', callee: calleeText(node.expression), args: (node.arguments ?? []).map((a) => foldString(a)), line: line(node) });
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

/** True when a call argument node is a string value built in place (literal, template, `+` chain). */
export function isStringValued(node) {
  if (!node) return false;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return isStringValued(node.expression);
  return ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || isPlus(node);
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
