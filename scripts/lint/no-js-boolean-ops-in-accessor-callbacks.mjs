// The zamda accessor-callback rule.
//
// zamda pipelines are declarative expressions, not JavaScript logic. Inside a
// callback given to a zamda pipeline operator (`filter`, `select`,
// `withColumns`, `sort`, `groupBy`, `agg`), writing `a && b` produces the JS
// logical operator, not a zamda `and`. The JS operator evaluates the left side
// as a plain boolean (a BoolExpr is always truthy), so the expression typechecks
// and silently means something else. The same holds for `!` and for `===` against
// a value of the DSL's own comparison builders. Use the DSL spellings:
// `.and()`, `.or()`, `.not()`, `.eq()`, `.neq()`.
//
// The rule uses type information (the nearest tsconfig, via ESLintUtils.getParserServices)
// to recognise the zamda operators: an accessor callback is an argument of a call
// to a `Pipeline` or `Grouped` method, whatever it is named locally. A call to
// `Array.prototype.filter` is never flagged. If type information is not available
// the rule stays silent, because flagging evaluated JavaScript nobody asked about
// would be worse than missing a bug the DSL itself usually catches at compile time.

import { ESLintUtils } from '@typescript-eslint/utils';
import { SyntaxKind } from 'typescript';

const ACCESSOR_METHODS = new Set(['filter', 'select', 'withColumns', 'sort', 'groupBy', 'agg']);
const CLASS_NAMES = new Set(['Pipeline', 'Grouped']);
// The zamda expression classes whose values the JS operators evaluate incorrectly.
const EXPR_CLASSES = new Set(['Expr', 'BoolExpr', 'OrdExpr', 'NumExpr', 'StrExpr', 'TimeExpr', 'AggExpr', 'SortKey']);
const OPERATOR = new Map([
  ['&&', '.and()'],
  ['||', '.or()'],
  ['!', '.not()'],
  ['===', '.eq()'],
  ['!==', '.neq()'],
  ['==', '.eq()'],
  ['!=', '.neq()'],
]);

// The operands an operator evaluates as a JavaScript boolean: `!x` has the argument, `x == y` the two sides.
function operandsOf(node) {
  switch (node.type) {
    case 'UnaryExpression':
      return [node.argument];
    case 'BinaryExpression':
    case 'LogicalExpression':
      return [node.left, node.right];
    default:
      return [];
  }
}

// Whether any of these nodes has a type that comes from a zamda expression class.
function anyExpressionType(services, nodes) {
  // Purpose: check each node's type symbol against the expression classes
  const checker = services.program.getTypeChecker();
  const toTsNode = node => services.esTreeNodeToTSNodeMap.get(node);
  return nodes.some(node => {
    const tsNode = toTsNode(node);
    if (!tsNode) return false;
    const symbol = checker.getTypeAtLocation(tsNode)?.getSymbol();
    return symbol !== undefined && EXPR_CLASSES.has(symbol.getName());
  });
}

function accessorInfo(context, node) {
  const parent = node.parent;
  if (parent?.type !== 'CallExpression' || !parent.arguments.includes(node)) return false;
  const callee = parent.callee;
  if (callee?.type !== 'MemberExpression' || callee.computed) return false;
  if (callee.property?.type !== 'Identifier') return false;
  const name = callee.property.name;
  if (!ACCESSOR_METHODS.has(name)) return null;
  let services;
  try {
    services = ESLintUtils.getParserServices(context);
  } catch {
    return null;
  }
  const program = services.program;
  if (!program || typeof services.esTreeNodeToTSNodeMap?.get !== 'function') return null;
  const checker = program.getTypeChecker();
  const tsProperty = services.esTreeNodeToTSNodeMap.get(callee.property);
  const symbol = checker.getSymbolAtLocation(tsProperty);
  for (const declaration of symbol?.getDeclarations() ?? []) {
    const cls = declaration.parent;
    if (!cls) continue;
    const isClass = cls.kind === SyntaxKind.ClassDeclaration || cls.kind === SyntaxKind.ClassExpression;
    if (isClass && CLASS_NAMES.has(cls.name.text)) return { services };
  }
  return null;
}

// Whether this node sits inside an accessor callback; a function defined inside one is in the callback's region.
function accessorContextOf(context, node) {
  // Purpose: walk up the ancestor chain looking for an accessor callback; returns its checker, if any
  let current = node;
  while (current) {
    if (current.type === 'ArrowFunctionExpression' || current.type === 'FunctionExpression') {
      const info = accessorInfo(context, current);
      if (info) return info;
    }
    current = current.parent;
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow JavaScript logical and equality operators inside zamda accessor callbacks; use the zamda DSL spellings.',
      recommended: true,
    },
    schema: [],
    messages: {
      noJsOperator: 'In an accessor callback, `{{ operator }}` is JavaScript, not a zamda expression; use `{{ hint }}` instead. See docs/API.md, "Pitfalls".',
    },
  },
  create(context) {
    // Purpose: report only when an operand is a zamda expression; a plain JS boolean is ordinary code
    const check = (node, operator) => {
      // Purpose: report only when an operand is a zamda expression; a plain JS boolean is ordinary code
      const info = accessorContextOf(context, node);
      if (info === null) return;
      if (!anyExpressionType(info.services, operandsOf(node))) return;
      context.report({ node, messageId: 'noJsOperator', data: { operator, hint: OPERATOR.get(operator) } });
    };
    return {
      LogicalExpression(node) {
        if (node.operator === '&&' || node.operator === '||') check(node, node.operator);
      },
      UnaryExpression(node) {
        if (node.operator === '!') check(node, node.operator);
      },
      BinaryExpression(node) {
        if (OPERATOR.has(node.operator)) check(node, node.operator);
      },
    };
  },
};
