// Reviewed upstream field keys, not translated UI copy. No file-wide exemption.
import ts from 'typescript';
import { createHash } from 'node:crypto';

const SET_KEYS = {
  DETAIL_LABELS: ['业务流水号', '渠道套餐', '来源套餐', '供应商', '渠道', '套餐状态', '查询状态', '支持地区', '有效期', 'eSIM状态', 'eSIM更新时间', '设备型号', '累计用量（MB）', '当日用量（MB）', '套餐规格'],
  LIVE_LABELS: ['实时状态', '累计用量（MB）', '当日用量（MB）', '容量（MB）', '套餐规格', 'eSIM状态', '设备型号', '原始累计用量（MB）'],
  CDR_LABELS: ['更新时间', '更新时间戳', '日期', '开始时间', '结束时间', '时间', '时长（秒）', '国家/地区', '地区', '运营商', '网络', '上行（MB）', '下行（MB）', '总用量（MB）', '总用量（KB）'],
};
const HELPER_KEYS = {
  field: ['eSIM状态', '业务流水号', '设备型号', '渠道套餐', '来源套餐', '原始累计用量（MB）', '累计用量（MB）', '当日用量（MB）'],
  cdrField: ['更新时间戳', '更新时间', '时间', '开始时间', '结束时间', '日期', '总用量（MB）', '总用量（KB）', '国家/地区', '地区', '运营商', '网络'],
};
// Normalized initializer ASTs: if the lookup helpers change, review their new
// semantics before updating these hashes. A same-named UI function is not allowed.
const HELPER_HASHES = {
  field: '735b25fba50f51580158a654e2da4423acffd4d78e23f38e0565f5c1c144a45a',
  cdrField: 'db77df9eecfdfd4eddd434b2f95f5cf2d871cbf8ab4bca53d80ef6c6aa5e1b7c',
};
const printer = ts.createPrinter({ removeComments: true });

export function protocolLiteralPolicy(file, source) {
  if (!['ui/apps/main/package-preview.ts', 'ui/apps/main/companion-card.ts'].includes(file)) return () => false;
  const options = { noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === source.fileName ? source : undefined;
  host.fileExists = (name) => name === source.fileName;
  host.readFile = (name) => name === source.fileName ? source.text : undefined;
  const checker = ts.createProgram([source.fileName], options, host).getTypeChecker();
  const declarationOf = (identifier) => checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  const isConst = (decl) => ts.isVariableDeclarationList(decl.parent) && !!(decl.parent.flags & ts.NodeFlags.Const);
  const approvedHelper = (decl) => {
    if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !isConst(decl) || !decl.initializer) return null;
    const name = decl.name.text;
    if (!Object.hasOwn(HELPER_HASHES, name)) return null;
    const block = decl.parent.parent.parent;
    if (!ts.isBlock(block) || !ts.isFunctionDeclaration(block.parent) || block.parent.name?.text !== 'companionPackageCard') return null;
    const normalized = printer.printNode(ts.EmitHint.Unspecified, decl.initializer, source);
    return createHash('sha256').update(normalized).digest('hex') === HELPER_HASHES[name] ? name : null;
  };
  // Freeze the small validation path as well as the literals. Reusing a key set
  // as rendered/exported copy revokes its exemption, even with no new literal.
  const functionHash = (node) => createHash('sha256').update(printer.printNode(ts.EmitHint.Unspecified, node, source)).digest('hex');
  const safeFields = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'safeFields' && n.body);
  const packageInfo = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'packageInfo' && n.body);
  const validationIntact = !!safeFields && !!packageInfo
    && functionHash(safeFields) === '1a49d066e4ee0e5bb0c888bdc940d1ae9134481ccce420a53fbc2037d2a6951e'
    && functionHash(packageInfo) === '75ab5c05968163f852b0006dda7b752c91f1cf2d82cda6a952c26b6c192b4ccc';
  const unsafeSetNames = new Set();
  const checkSetUse = (node) => {
    if (ts.isIdentifier(node) && Object.hasOwn(SET_KEYS, node.text)) {
      const declarationName = ts.isVariableDeclaration(node.parent) && node.parent.name === node;
      const call = node.parent;
      const validationCall = validationIntact && ts.isCallExpression(call)
        && call.arguments.length === 2 && call.arguments[1] === node
        && ts.isIdentifier(call.expression) && declarationOf(call.expression) === safeFields
        && node.pos >= packageInfo.pos && node.end <= packageInfo.end;
      if (!declarationName && !validationCall) unsafeSetNames.add(node.text);
    }
    ts.forEachChild(node, checkSetUse);
  };
  if (file === 'ui/apps/main/package-preview.ts') checkSetUse(source);
  return (node) => {
    if (!ts.isStringLiteral(node)) return false;
    if (file === 'ui/apps/main/package-preview.ts') {
      const array = node.parent, construct = array.parent, decl = construct?.parent;
      return ts.isArrayLiteralExpression(array) && ts.isNewExpression(construct)
        && ts.isIdentifier(construct.expression) && construct.expression.text === 'Set'
        && !checker.getSymbolAtLocation(construct.expression)
        && construct.arguments?.length === 1 && construct.arguments[0] === array
        && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && isConst(decl)
        && decl.parent.parent.parent === source
        && !decl.parent.parent.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
        && validationIntact && !unsafeSetNames.has(decl.name.text)
        && Object.hasOwn(SET_KEYS, decl.name.text) && SET_KEYS[decl.name.text].includes(node.text);
    }
    const call = node.parent;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.arguments.indexOf(node) < 1) return false;
    let decl = declarationOf(call.expression);
    // The only approved alias is the const local get = cdrField in records.
    if (call.expression.text === 'get' && decl && ts.isVariableDeclaration(decl) && isConst(decl)
      && decl.initializer && ts.isIdentifier(decl.initializer) && decl.initializer.text === 'cdrField') {
      const block = decl.parent.parent.parent;
      if (!ts.isBlock(block) || !ts.isArrowFunction(block.parent)
        || !ts.isVariableDeclaration(block.parent.parent) || block.parent.parent.name.getText(source) !== 'records'
        || !isConst(block.parent.parent)) return false;
      const recordsBlock = block.parent.parent.parent.parent.parent;
      const helper = declarationOf(decl.initializer);
      if (!ts.isBlock(recordsBlock) || !helper || helper.parent.parent.parent !== recordsBlock) return false;
      decl = declarationOf(decl.initializer);
    }
    const name = approvedHelper(decl);
    return !!name && HELPER_KEYS[name].includes(node.text) && (name !== 'field' || call.arguments.indexOf(node) === 1);
  };
}
