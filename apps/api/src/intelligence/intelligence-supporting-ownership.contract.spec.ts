import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

const modules = [
  'client-financial-v1.ts',
  'client-financial-v1-pac.ts',
  'client-financial-v1-flow.ts',
  'client-financial-v1-quarters.ts',
  'client-financial-v1.types.ts',
  'client-relationships-v1.ts',
  'client-changes-v1.ts',
  'client-briefs-v1.ts',
  'client-district-v1.ts',
  'client-district-v1-spend.ts',
];
const ownership: Record<string, string[]> = {
  financial: ['getLobbyingRoi'],
  pac: ['getPacGiving'],
  flow: ['getFecMoneyFlow'],
  quarters: ['buildRoiQuarterSeries'],
  relationships: [
    'getCompetitorBoard',
    'getExStaffers',
    'getIssueLeaderboard',
    'computeOfficeRecommendations',
  ],
  changes: ['getChanges', 'markChangeConsumed', 'getUnreadChangesCount'],
  briefs: ['listClientBriefs', 'addClientBrief', 'deleteClientBrief'],
  district: ['getDistrictNexus'],
  districtSpend: ['getDistrictNexusSpend'],
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

it('keeps all ten supporting source modules and complete functions within Cleanup ownership limits', () => {
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

it('routes all sixteen facade methods through concrete owners and bounds actual composition', () => {
  const { ast } = source('intelligence.service.ts');
  const facade = ast.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'IntelligenceService',
  );
  if (!facade) throw new Error('Actual Intelligence facade is required');
  const ctor = facade.members.find(ts.isConstructorDeclaration);
  const composition = source('intelligence-facade-supporting-composition.ts');
  const factory = composition.ast.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'createSupportingSources',
  );
  expect(factory?.body?.statements).toHaveLength(1);
  expect(ctor?.body?.getText(ast)).toContain(
    'this.supportingSources = createSupportingSources(this',
  );
  expect(
    ast.statements
      .filter(ts.isImportDeclaration)
      .some(
        (node) =>
          node.moduleSpecifier.getText(ast) === "'./intelligence-facade-supporting-composition.js'",
      ),
  ).toBe(true);
  expect(ctor?.getText(ast).split('\n').length).toBeLessThanOrEqual(80);
  expect(factory?.getText(composition.ast).split('\n').length).toBeLessThanOrEqual(80);
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
        `this.supportingSources.${owner}.${name}`,
      );
      delegates += 1;
    }
  }
  expect(delegates).toBe(16);
});
