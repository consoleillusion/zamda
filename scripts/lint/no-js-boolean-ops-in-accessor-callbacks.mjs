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
// The rule uses type information (the nearest tsconfig) to recognise the zamda
// operators: an accessor callback is an argument of a call to a `Pipeline` or
// `Grouped` method, whatever it is named locally. A call to `Array.prototype.filter`
// is never flagged. If type information is not available the rule stays silent,
// because flagging evaluated JavaScript nobody asked about would be worse than
// missing a bug the DSL itself usually catches at compile time.

const ACCESSOR_METHODS = new Set(['filter', 'select', 'withColumns', 'sort', 'groupBy', 'agg']);
const CLASS_NAMES = new Set(['Pipeline', 'Grouped']);
const OPERATOR = new Map([
  ['&&', '.and()'],
  ['||', '.or()'],
  ['!', '.not()'],
  ['===', '.eq()'],
  ['!==', '.neq()'],
  ['==', '.eq()'],
  ['!=', '.neq()'],
]);

function accessorInfo(context, node) {
  const parent = node.parent;
  if (parent?.type !== 'CallExpression' || !parent.arguments.includes(node)) return false;
  const callee = parent.callee;
  if (callee?.type !== 'MemberExpression' || callee.computed) return false;
  if (callee.property?.type !== 'Identifier') return false;
  const name = callee.property.name;
  if (!ACCESSOR_METHODS.has(name)) return false;
  const services = context.sourceCode.parserServices;
  const program = services?.program;
  if (!program || typeof services.esTreeNodeToTSNodeMap?.get !== 'function') return false;
  const checker = program.getTypeChecker();
  const tsProperty = services.esTreeNodeToTSNodeMap.get(callee.property);
  const symbol = checker.getSymbolAtLocation(tsProperty);
  for (const declaration of symbol?.getDeclarations() ?? []) {
    const cls = declaration.parent;
    if (cls?.kind === 'ClassDeclaration' && CLASS_NAMES.has(cls.name.text)) return true;
  }
  return false;
}

// Whether this node sits inside an accessor callback; a function defined inside one is in the callback's region.
function insideAccessorCallback(context, node) {
  // Purpose: walk up the ancestor chain looking for an accessor callback
  let current = node;
  while (current) {
    if ((current.type === 'ArrowFunctionExpression' || current.type === 'FunctionExpression') && accessorInfo(context, current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
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
    // Purpose: report every type-recognised JavaScript operator inside an accessor callback
    const report = (node, operator) => {
      context.report({ node, messageId: 'noJsOperator', data: { operator, hint: OPERATOR.get(operator) } });
    };
    return {
      LogicalExpression(node) {
        if (!insideAccessorCallback(context, node)) return;
        if (node.operator === '&&' || node.operator === '||') report(node, node.operator);
      },
      UnaryExpression(node) {
        if (!insideAccessorCallback(context, node)) return;
        if (node.operator === '!') report(node, node.operator);
      },
      BinaryExpression(node) {
        if (!insideAccessorCallback(context, node)) return;
        if (OPERATOR.has(node.operator)) report(node, node.operator);
      },
    };
  },
};
