import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

const modules = [
  'client-identity-v1.ts',
  'client-identity-v1-lda.ts',
  'client-identity-v1-filings.ts',
  'client-identity-v1-catalog.ts',
  'client-identity-v1.types.ts',
  'client-mapping-v1.ts',
  'client-mapping-v1-catalog.ts',
  'client-mapping-v1-review.ts',
  'client-mapping-v1-setup.ts',
  'client-context-v1-graph.ts',
  'client-context-v1-graph-labels.ts',
  'client-context-v1-graph-presentation.ts',
  'client-context-v1-health.ts',
  'client-context-v1-outreach.ts',
  'client-intelligence-values.ts',
];
const ownership: Record<string, string[]> = {
  identityProfile: ['getClientProfile'],
  identityLda: [
    'pickLdaClientIds',
    'resolveLdaClientIds',
    'confirmedLdaIds',
    'issueCodesForLdaIds',
    'fetchLdaByIds',
    'fuzzyMatchLda',
    'findCompetitors',
  ],
  identityFilings: ['getClientLdaFilings'],
  identityCatalog: [
    'isUuid',
    'fetchContractorById',
    'fetchLobbyIntelById',
    'fuzzyMatchContractor',
    'fuzzyMatchLobbyIntel',
  ],
  mapping: ['getMappings', 'resolveMapping', 'getAllMappingsForTenant'],
  mappingCatalog: [
    'searchLdaClients',
    'searchFecEmployers',
    'searchFecCommittees',
    'searchContractors',
    'searchAssistanceRecipients',
  ],
  mappingReview: ['createManualMapping', 'rejectMappingCandidate', 'confirmMapping'],
  mappingSetup: ['getSetupCompleteness'],
  graph: ['walkClientGraph', 'getKnowledgeGraph'],
  outreach: ['getOutreachContext'],
  health: ['computeEngagementHealth'],
};
function source(name: string) {
  const text = readFileSync(join(__dirname, name), 'utf8');
  const { diagnostics } = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  expect(diagnostics ?? []).toHaveLength(0);
  return { text, ast: ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true) };
}
it('keeps all fifteen client source modules and complete functions within Cleanup ownership limits', () => {
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
it('routes all thirty client facade methods through concrete owners and bounds actual composition', () => {
  const { ast } = source('intelligence.service.ts');
  const facade = ast.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'IntelligenceService',
  );
  if (!facade) throw new Error('Actual Intelligence facade is required');
  const ctor = facade.members.find(ts.isConstructorDeclaration);
  const factory = facade.members.find(
    (node): node is ts.MethodDeclaration =>
      ts.isMethodDeclaration(node) && node.name.getText(ast) === 'createClientSources',
  );
  expect(ctor?.getText(ast).split('\n').length).toBeLessThanOrEqual(80);
  expect(factory?.getText(ast).split('\n').length).toBeLessThanOrEqual(80);
  let delegates = 0;
  for (const [owner, names] of Object.entries(ownership)) {
    for (const name of names) {
      const method = facade.members.find(
        (node): node is ts.MethodDeclaration =>
          ts.isMethodDeclaration(node) && node.name.getText(ast) === name,
      );
      expect(method?.body?.statements).toHaveLength(1);
      const statement = method?.body?.statements[0];
      if (
        !statement ||
        !ts.isReturnStatement(statement) ||
        !statement.expression ||
        !ts.isCallExpression(statement.expression)
      )
        throw new Error(`Missing real delegate for ${name}`);
      expect(statement.expression.expression.getText(ast)).toBe(
        `this.clientSources.${owner}.${name}`,
      );
      delegates += 1;
    }
  }
  expect(delegates).toBe(30);
});
it('publishes the exact six-family source handover and retains all three outside families unchanged', () => {
  const inventoryText = readFileSync(
    join(
      __dirname,
      '../../../../docs/backend-cleanup/20261013/INTELLIGENCE-REMAINING-4970927F.json',
    ),
    'utf8',
  );
  expect(createHash('sha256').update(inventoryText).digest('hex')).toBe(
    '2c0a20d4c2d9742d53896b2e5f5b825a4cfebafabb47f3a6724de9f11d188b04',
  );
  const inventory = JSON.parse(inventoryText) as {
    remainingCompleteFamilies: Array<{
      family: string;
      methods: Array<{ name: string; sha256: string }>;
    }>;
  };
  expect(inventory.remainingCompleteFamilies).toHaveLength(6);
  expect(inventory.remainingCompleteFamilies.flatMap((family) => family.methods)).toHaveLength(57);
  const { ast } = source('intelligence.service.ts');
  const names = new Map<string, ts.MethodDeclaration | ts.FunctionDeclaration>();
  const visit = (node: ts.Node) => {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name)
      names.set(node.name.getText(ast), node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const family of inventory.remainingCompleteFamilies.filter((row) =>
    /^(I4|I8|I12) /.test(row.family),
  )) {
    for (const method of family.methods) {
      const current = names.get(method.name);
      if (!current) throw new Error(`Missing retained source ${method.name}`);
      expect(createHash('sha256').update(current.getText(ast)).digest('hex')).toBe(method.sha256);
    }
  }
});
