import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

const modules = [
  'intelligence-bill-discovery.shared.ts',
  'intelligence-bill-relevance-inputs.ts',
  'intelligence-relevant-bill-discovery.ts',
  'intelligence-tracked-bill-discovery.ts',
  'intelligence-manual-bill-tracking.ts',
  'intelligence-bill-enrichment.ts',
];
const ownership: Record<string, string[]> = {
  billRelevanceInputs: ['capabilityFallbackTerms', 'getIssueCodeSignal', 'getClientRelevanceTerms'],
  relevantBillDiscovery: [
    'findRelevantBills',
    'findRelevantBillsByEmbeddings',
    'findRelevantBillsByKeyword',
    'getClientBills',
  ],
  trackedBillDiscovery: [
    'getTrackedBills',
    'findTrackedBillsByEmbeddings',
    'findTrackedBillsByKeyword',
  ],
  manualBillTracking: [
    'getManualTrackedBillIds',
    'fetchBillsByIds',
    'listTrackedBills',
    'addTrackedBill',
    'removeTrackedBill',
  ],
  billEnrichment: ['getBillRegulationLinks', 'getBillResearchAttachments'],
};

function source(name: string) {
  const text = readFileSync(join(__dirname, name), 'utf8');
  const { diagnostics } = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  expect(diagnostics ?? []).toHaveLength(0);
  const ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  return { text, ast };
}

it('keeps all six concrete bill modules and every complete function within ownership limits', () => {
  for (const name of modules) {
    const { text, ast } = source(name);
    expect(text.split('\n').filter((line) => line.trim()).length).toBeLessThan(400);
    const visit = (node: ts.Node) => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isConstructorDeclaration(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node)) &&
        node.body
      ) {
        expect(node.getText(ast).split('\n').length).toBeLessThanOrEqual(80);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});

it('uses the real named owners for all seventeen facade methods and bounds their constructor wiring', () => {
  const { ast } = source('intelligence.service.ts');
  const facade = ast.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'IntelligenceService',
  );
  expect(facade).toBeDefined();
  if (!facade) throw new Error('Actual Intelligence facade is required');
  const ctor = facade.members.find(ts.isConstructorDeclaration);
  expect(ctor?.getText(ast).split('\n').length).toBeLessThanOrEqual(80);
  let delegates = 0;
  for (const [owner, names] of Object.entries(ownership)) {
    for (const name of names) {
      const method = facade.members.find(
        (node): node is ts.MethodDeclaration =>
          ts.isMethodDeclaration(node) && node.name.getText(ast) === name,
      );
      expect(method?.body?.statements).toHaveLength(1);
      const statement = method?.body?.statements[0];
      expect(statement && ts.isReturnStatement(statement)).toBe(true);
      if (!statement || !ts.isReturnStatement(statement) || !statement.expression)
        throw new Error(`Missing real delegate for ${name}`);
      const call = statement.expression;
      expect(ts.isCallExpression(call)).toBe(true);
      if (!ts.isCallExpression(call)) throw new Error(`Missing real owner call for ${name}`);
      expect(call.expression.getText(ast)).toBe(`this.${owner}.${name}`);
      delegates += 1;
    }
  }
  expect(delegates).toBe(17);
});
