import ts from 'typescript';

// Check the boolean gate rather than its spelling or the order of && terms.
export function previewGateProblems(source) {
  const file = ts.createSourceFile(
    'router.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const problems = [];
  if (file.parseDiagnostics.length) return ['router parse error'];
  let gate;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'v3Enabled'
    ) {
      if (gate) problems.push('duplicate V3 gate');
      gate = node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!gate) return ['missing V3 gate'];
  function termName(node) {
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isIdentifier(node.operand)
    ) {
      return `!${node.operand.text}`;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'isEngagementPreviewActive' &&
      node.arguments.length === 0
    ) {
      return 'isEngagementPreviewActive()';
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === 'previewMode' &&
      ts.isStringLiteral(node.right) &&
      node.right.text === 'v3'
    ) {
      return "previewMode==='v3'";
    }
    return `unsupported:${node.getText(file)}`;
  }
  const terms = [];
  function flatten(node) {
    if (ts.isParenthesizedExpression(node)) return flatten(node.expression);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      flatten(node.left);
      flatten(node.right);
    } else terms.push(termName(node));
  }
  flatten(gate);
  for (const required of [
    "previewMode==='v3'",
    'isEngagementPreviewActive()',
    '!hasClassicDraft',
  ]) {
    if (!terms.includes(required)) problems.push(`missing required V3 guard ${required}`);
  }
  // Later owner-approved Classic fallback adds this stricter guard.
  if (/\bforceClassic\b/.test(source) && !terms.includes('!forceClassic'))
    problems.push('missing Classic fallback guard');
  for (const term of terms) {
    if (
      ![
        "previewMode==='v3'",
        'isEngagementPreviewActive()',
        '!hasClassicDraft',
        '!forceClassic',
      ].includes(term)
    ) {
      problems.push(`unexpected V3 gate term ${term}`);
    }
  }
  return problems;
}
