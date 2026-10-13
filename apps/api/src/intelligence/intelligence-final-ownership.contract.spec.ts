import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
const modules = [
  'client-alerts-v1-awards.ts',
  'client-alerts-v1-comment-deadlines.ts',
  'client-alerts-v1.shared.ts',
  'client-alerts-v1.ts',
  'client-regulatory-v1.ts',
  'intelligence-portfolio-alerts.ts',
  'intelligence-portfolio-coming-up.ts',
  'intelligence-portfolio-quarters.ts',
  'intelligence-portfolio-rollup.ts',
  'intelligence-portfolio-summary.ts',
  'intelligence-portfolio-timeline.ts',
  'intelligence-portfolio-trend.ts',
];
const ownership: Record<string, string[]> = {
  regulatory: [
    'getClientRegulatoryProfile',
    'findActiveRegulations',
    'getClientRelevantRegulations',
  ],
  commentDeadlines: ['getCommentPeriodAlerts'],
  alerts: [
    'alertCountdownLabel',
    'getClientIssueCodes',
    'getHearingAlerts',
    'getOverdueCommentAlerts',
    'getCompetitorLdaAlerts',
    'setAlertState',
    'clearAlertState',
  ],
  awardAlerts: ['getContractAwardAlerts', 'resolveContractorUeisForAlerts'],
  timeline: ['getTodayTimeline', 'getLiveTicker'],
  comingUp: ['getComingUp'],
  summary: ['getPortfolioSummary'],
  portfolioAlerts: [
    'emptyPortfolioAlerts',
    'withPortfolioAlertsRequestBudget',
    'getPortfolioAlerts',
    'computePortfolioAlerts',
  ],
  rollup: ['getPortfolioRollup', 'getPortfolioPeSummary'],
  trend: ['getPortfolioEngagementTrend'],
};
function parsed(name: string) {
  const text = readFileSync(join(__dirname, name), 'utf8');
  const ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  return { text, ast };
}
function facade() {
  const result = parsed('intelligence.service.ts');
  const cls = result.ast.statements.find(
    (n): n is ts.ClassDeclaration =>
      ts.isClassDeclaration(n) && n.name?.text === 'IntelligenceService',
  );
  if (!cls) throw new Error('Actual facade required');
  return { ...result, cls };
}
it('bounds all final family modules and complete functions without waiving the facade file budget', () => {
  for (const file of modules) {
    const { text, ast } = parsed(file);
    expect(text.split('\n').filter((x) => x.trim()).length).toBeLessThan(400);
    const visit = (n: ts.Node) => {
      if (
        (ts.isFunctionDeclaration(n) ||
          ts.isMethodDeclaration(n) ||
          ts.isConstructorDeclaration(n) ||
          ts.isArrowFunction(n) ||
          ts.isFunctionExpression(n)) &&
        n.body
      )
        expect(n.getText(ast).split('\n').length).toBeLessThanOrEqual(80);
      ts.forEachChild(n, visit);
    };
    visit(ast);
  }
  const { text, ast } = facade();
  expect(text.split('\n').filter((x) => x.trim()).length).toBeLessThan(400);
  const visit = (n: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(n) ||
        ts.isMethodDeclaration(n) ||
        ts.isConstructorDeclaration(n) ||
        ts.isArrowFunction(n) ||
        ts.isFunctionExpression(n)) &&
      n.body
    )
      expect(n.getText(ast).split('\n').length).toBeLessThanOrEqual(80);
    ts.forEachChild(n, visit);
  };
  visit(ast);
});
it('routes all twenty-four final family methods to concrete owners with bounded actual construction', () => {
  const { ast, cls } = facade();
  let count = 0;
  for (const [owner, names] of Object.entries(ownership))
    for (const name of names) {
      const m = cls.members.find(
        (n): n is ts.MethodDeclaration => ts.isMethodDeclaration(n) && n.name.getText(ast) === name,
      );
      expect(m?.body?.statements).toHaveLength(1);
      const statement = m?.body?.statements[0];
      if (
        !statement ||
        !ts.isReturnStatement(statement) ||
        !statement.expression ||
        !ts.isCallExpression(statement.expression)
      )
        throw new Error('Missing actual delegate');
      expect(statement.expression.expression.getText(ast)).toBe(
        'this.finalSources.' + owner + '.' + name,
      );
      count++;
    }
  expect(count).toBe(24);
  expect(
    cls.members.find(ts.isConstructorDeclaration)?.getText(ast).split('\n').length,
  ).toBeLessThanOrEqual(80);
  const composition = parsed('intelligence-facade-final-composition.ts');
  const factory = composition.ast.statements.find(
    (n): n is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(n) && n.name?.text === 'createFinalSources',
  );
  expect(factory?.body?.statements).toHaveLength(1);
  expect(factory?.getText(composition.ast).split('\n').length).toBeLessThanOrEqual(80);
  expect(cls.members.find(ts.isConstructorDeclaration)?.body?.getText(ast)).toContain(
    'this.finalSources = createFinalSources(this,',
  );
  expect(
    ast.statements
      .filter(ts.isImportDeclaration)
      .some(
        (n) => n.moduleSpecifier.getText(ast) === "'./intelligence-facade-final-composition.js'",
      ),
  ).toBe(true);
});
it('keeps canonical quarter helpers and original public module paths without an unused private shim', () => {
  const { ast } = facade();
  const routes = [
    ['buildQuarterWindows', 'portfolioBuildQuarterWindows'],
    ['foldEngagementTrend', 'portfolioFoldEngagementTrend'],
  ];
  for (const [name, alias] of routes) {
    const fn = ast.statements.find(
      (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name,
    );
    expect(fn?.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)).toBe(true);
    expect(fn?.body?.statements).toHaveLength(1);
    const statement = fn?.body?.statements[0];
    if (
      !statement ||
      !ts.isReturnStatement(statement) ||
      !statement.expression ||
      !ts.isCallExpression(statement.expression)
    )
      throw new Error('Missing real public helper');
    expect(statement.expression.expression.getText(ast)).toBe(alias);
  }
  expect(
    ast.statements.some((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'startOfQuarter'),
  ).toBe(false);
  const quarters = parsed('intelligence-portfolio-quarters.ts').ast;
  for (const name of ['startOfQuarter', 'buildQuarterWindows', 'foldEngagementTrend'])
    expect(
      quarters.statements.some((n) => ts.isFunctionDeclaration(n) && n.name?.text === name),
    ).toBe(true);
  for (const file of modules) {
    const { ast } = parsed(file);
    for (const n of ast.statements.filter(ts.isImportDeclaration))
      if (n.moduleSpecifier.getText(ast).includes('intelligence.service'))
        expect(n.importClause?.isTypeOnly).toBe(true);
  }
});
