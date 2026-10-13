import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import * as facadeExports from './intelligence.service.js';
import * as policy from './intelligence-facade-policy-values.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientPrepopulationService } from './client-prepopulation.service.js';
import { OfficeRecommenderService } from './office-recommender.service.js';

const compositionFiles = [
  'intelligence-facade-profile-composition.ts',
  'intelligence-facade-supporting-composition.ts',
  'intelligence-facade-client-composition.ts',
  'intelligence-facade-final-composition.ts',
];
const helperFiles = [
  ...compositionFiles,
  'intelligence-facade-contracts.ts',
  'intelligence-facade-owners.ts',
  'intelligence-facade-policy-values.ts',
  'intelligence-profile-source-budget.ts',
];
// Original Core production declarations; the three cleanup-only factories are retired.
const coreNames = `
  asFinite asFiniteOrNull asIsoOrNull normalizeProfileV1Sections getClientProfile
  withSourceBudget getClientRegulatoryProfile buildRegulatoryLifecycle getClientProfileV1
  getClientProfileV1WithinBillDeadline pickLdaClientIds resolveLdaClientIds confirmedLdaIds
  issueCodesForLdaIds fetchLdaByIds getClientLdaFilings isUuid fetchContractorById
  fetchLobbyIntelById fuzzyMatchLda fuzzyMatchContractor fuzzyMatchLobbyIntel
  capabilityFallbackTerms findRelevantBills findRelevantBillsByEmbeddings
  findRelevantBillsByKeyword findActiveRegulations findCompetitors getChanges getMappings
  searchLdaClients searchFecEmployers searchFecCommittees searchContractors
  searchAssistanceRecipients createManualMapping rejectMappingCandidate resolveMapping
  confirmMapping markChangeConsumed getUnreadChangesCount getLobbyingRoi getPacGiving
  getFecMoneyFlow getCompetitorBoard getExStaffers getClientBills getSetupCompleteness
  getIssueCodeSignal computeOfficeRecommendations getClientRelevanceTerms getTrackedBills
  getManualTrackedBillIds fetchBillsByIds listTrackedBills addTrackedBill removeTrackedBill
  findTrackedBillsByEmbeddings findTrackedBillsByKeyword getIssueLeaderboard
  computeEngagementHealth getCommentPeriodAlerts alertCountdownLabel getClientIssueCodes
  getHearingAlerts getOverdueCommentAlerts getCompetitorLdaAlerts getContractAwardAlerts
  resolveContractorUeisForAlerts setAlertState clearAlertState listClientBriefs addClientBrief
  deleteClientBrief walkClientGraph getKnowledgeGraph getOutreachContext
  getAllMappingsForTenant getDistrictNexus getDistrictNexusSpend getBillRegulationLinks
  getClientRelevantRegulations getBillResearchAttachments getTodayTimeline getLiveTicker
  getComingUp getPortfolioSummary emptyPortfolioAlerts withPortfolioAlertsRequestBudget
  getPortfolioAlerts computePortfolioAlerts getPortfolioRollup getPortfolioPeSummary
  getPortfolioEngagementTrend buildRoiQuarterSeries
`
  .trim()
  .split(/\s+/);
const construction = [
  ['profileV1', 'createProfileV1', compositionFiles[0]!],
  ['billRelevanceInputs', 'createBillRelevanceInputs', compositionFiles[0]!],
  ['relevantBillDiscovery', 'createRelevantBillDiscovery', compositionFiles[0]!],
  ['trackedBillDiscovery', 'createTrackedBillDiscovery', compositionFiles[0]!],
  ['manualBillTracking', 'createManualBillTracking', compositionFiles[0]!],
  ['billEnrichment', 'createBillEnrichment', compositionFiles[0]!],
  ['supportingSources', 'createSupportingSources', compositionFiles[1]!],
  ['clientSources', 'createClientSources', compositionFiles[2]!],
  ['finalSources', 'createFinalSources', compositionFiles[3]!],
] as const;
const utilityRoutes: Record<string, string> = {
  asFinite: 'profileV1Finite',
  asFiniteOrNull: 'profileV1FiniteOrNull',
  asIsoOrNull: 'profileV1IsoOrNull',
  normalizeProfileV1Sections: 'normalizeProfileV1Sections',
  withSourceBudget: 'withIntelligenceSourceBudget',
  buildRegulatoryLifecycle: 'buildProfileV1RegulatoryLifecycle',
  getClientProfileV1: 'withBillKeywordProfileDeadline',
};

function parsed(name: string) {
  const text = readFileSync(join(__dirname, name), 'utf8');
  const ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const emitted = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  expect(emitted.diagnostics ?? []).toHaveLength(0);
  return { text, ast };
}
function root() {
  const result = parsed('intelligence.service.ts');
  const cls = result.ast.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'IntelligenceService',
  );
  if (!cls) throw new Error('Actual exported facade class is required');
  return { ...result, cls };
}
function returnCall(method: ts.MethodDeclaration) {
  expect(method.body?.statements).toHaveLength(1);
  const statement = method.body?.statements[0];
  if (
    !statement ||
    !ts.isReturnStatement(statement) ||
    !statement.expression ||
    !ts.isCallExpression(statement.expression)
  )
    throw new Error('Expected a real named delegate');
  return statement.expression;
}

it('closes the facade and all eight new source modules within complete Cleanup budgets', () => {
  expect(helperFiles).toHaveLength(8);
  for (const file of ['intelligence.service.ts', ...helperFiles]) {
    const { text, ast } = parsed(file);
    expect(text.split('\n').filter((line) => line.trim()).length).toBeLessThan(400);
    const visit = (node: ts.Node) => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isConstructorDeclaration(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node)) &&
        node.body
      )
        expect(node.getText(ast).split('\n').length).toBeLessThanOrEqual(80);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});

it('keeps exactly the original ninety-five own declarations as concrete or canonical delegates', () => {
  const { ast, cls } = root();
  const methods = cls.members.filter(ts.isMethodDeclaration);
  expect(coreNames).toHaveLength(95);
  expect(methods.map((method) => method.name.getText(ast))).toEqual(coreNames);
  let ownerDelegates = 0;
  for (const method of methods) {
    const name = method.name.getText(ast);
    const call = returnCall(method);
    const utility = utilityRoutes[name];
    if (utility) expect(call.expression.getText(ast)).toBe(utility);
    else {
      if (!ts.isPropertyAccessExpression(call.expression)) throw new Error('Named owner required');
      expect(call.expression.name.text).toBe(name);
      expect(
        construction.some(([field]) => call.expression.getText(ast).startsWith(`this.${field}.`)),
      ).toBe(true);
      ownerDelegates++;
    }
  }
  expect(ownerDelegates).toBe(88);
  expect(methods.some((method) => /^create.*Sources$/.test(method.name.getText(ast)))).toBe(false);
  const visit = (node: ts.Node) => {
    expect(
      ts.isTaggedTemplateExpression(node) ||
        ts.isForStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node) ||
        ts.isTryStatement(node),
    ).toBe(false);
    if (ts.isPropertyAccessExpression(node))
      expect(node.getText(ast).startsWith('this.prisma.')).toBe(false);
    ts.forEachChild(node, visit);
  };
  visit(cls);
});

it('constructs all nine actual owner fields through exported concrete factories with the same host', () => {
  const { ast, cls } = root();
  const ctor = cls.members.find(ts.isConstructorDeclaration);
  if (!ctor?.body) throw new Error('Actual constructor required');
  expect(ctor.body.statements).toHaveLength(9);
  for (const [index, [field, factoryName, file]] of construction.entries()) {
    const statement = ctor.body.statements[index]!;
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression))
      throw new Error('Actual owner field assignment required');
    const assignment = statement.expression;
    expect(assignment.left.getText(ast)).toBe(`this.${field}`);
    expect(assignment.operatorToken.kind).toBe(ts.SyntaxKind.EqualsToken);
    if (!ts.isCallExpression(assignment.right))
      throw new Error('Actual factory invocation required');
    expect(assignment.right.expression.getText(ast)).toBe(factoryName);
    expect(assignment.right.arguments[0]?.kind).toBe(ts.SyntaxKind.ThisKeyword);
    const declaration = ast.statements
      .filter(ts.isImportDeclaration)
      .find(
        (node) =>
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === './' + file.replace(/\.ts$/, '.js'),
      );
    expect(declaration?.importClause?.isTypeOnly).toBe(false);
    const bindings = declaration?.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) throw new Error('Named factory import required');
    expect(bindings.elements.some((binding) => binding.name.text === factoryName)).toBe(true);
    const composition = parsed(file);
    const factory = composition.ast.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === factoryName,
    );
    expect(
      factory?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
    ).toBe(true);
    expect(factory?.parameters[0]?.name.getText(composition.ast)).toBe('host');
    expect(factory?.body?.statements).toHaveLength(1);
    expect(factory?.body?.statements[0]?.kind).toBe(ts.SyntaxKind.ReturnStatement);
  }
});

it('instantiates the thirty-six canonical source owners and keeps runtime host imports acyclic', () => {
  const expectedOwners = `IntelligenceClientProfileV1 IntelligenceBillRelevanceInputs
    IntelligenceRelevantBillDiscovery IntelligenceTrackedBillDiscovery IntelligenceManualBillTracking
    IntelligenceBillEnrichment ClientFinancialV1Lobbying ClientFinancialV1Pac ClientFinancialV1MoneyFlow
    ClientFinancialV1Quarters ClientRelationshipsV1 ClientChangesV1 ClientBriefsV1 ClientDistrictV1
    ClientDistrictV1Spend ClientIdentityV1Profile ClientIdentityV1Lda ClientIdentityV1Filings
    ClientIdentityV1Catalog ClientMappingV1 ClientMappingV1Catalog ClientMappingV1Review ClientMappingV1Setup
    ClientContextV1Graph ClientContextV1Health ClientContextV1Outreach ClientRegulatoryV1
    ClientCommentDeadlineAlertsV1 ClientAlertsV1 ClientAwardAlertsV1 IntelligencePortfolioTimeline
    IntelligencePortfolioComingUp IntelligencePortfolioSummary IntelligencePortfolioAlerts
    IntelligencePortfolioRollup IntelligencePortfolioTrend`.split(/\s+/);
  const actualOwners: string[] = [];
  for (const file of compositionFiles) {
    const { ast } = parsed(file);
    for (const declaration of ast.statements.filter(ts.isImportDeclaration))
      if (
        ts.isStringLiteral(declaration.moduleSpecifier) &&
        declaration.moduleSpecifier.text === './intelligence.service.js'
      )
        expect(declaration.importClause?.isTypeOnly).toBe(true);
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node)) {
        actualOwners.push(node.expression.getText(ast));
        expect(node.arguments?.[0]?.getText(ast)).toBe("host['prisma']");
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  expect(actualOwners).toEqual(expectedOwners);
  expect(actualOwners).toHaveLength(36);
  for (const file of ['intelligence-facade-owners.ts', 'intelligence-facade-contracts.ts']) {
    const { ast } = parsed(file);
    expect(
      ast.statements.filter(ts.isImportDeclaration).every((node) => node.importClause?.isTypeOnly),
    ).toBe(true);
    expect(
      ast.statements.some(
        (node) =>
          ts.isFunctionDeclaration(node) ||
          ts.isVariableStatement(node) ||
          ts.isClassDeclaration(node),
      ),
    ).toBe(false);
  }
});

it('retains lazy method, optional collaborator, logger and mutable portfolio state ports', () => {
  let currentMethodPorts = 0;
  for (const file of compositionFiles) {
    const { ast } = parsed(file);
    const visit = (node: ts.Node) => {
      if (
        ts.isArrowFunction(node) &&
        ts.isCallExpression(node.body) &&
        ts.isElementAccessExpression(node.body.expression) &&
        node.body.expression.expression.getText(ast) === 'host'
      ) {
        const key = node.body.expression.argumentExpression;
        if (!key || !ts.isStringLiteral(key)) throw new Error('Literal current Root port required');
        expect(coreNames).toContain(key.text);
        if (node.parent && ts.isPropertyAssignment(node.parent))
          expect(node.parent.name.getText(ast)).toBe(key.text);
        currentMethodPorts++;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  expect(currentMethodPorts).toBe(72);
  const { text: profile } = parsed(compositionFiles[0]!);
  expect(profile).toContain("officeRecommender: () => host['officeRecommender']");
  expect(profile).toContain("warn: (message) => host['logger'].warn(message)");
  const { text: client } = parsed(compositionFiles[2]!);
  expect(client).toContain("prepopulation: () => host['prepopulation']");
  const { text: final } = parsed(compositionFiles[3]!);
  for (const [port, field] of [
    ['cache', 'portfolioAlertsCache'],
    ['inflight', 'portfolioAlertsInflight'],
    ['gate', 'portfolioAlertsGate'],
    ['logger', 'logger'],
  ])
    expect(final).toContain(`${port}: () => host['${field}']`);
  expect(final).toContain("host['portfolioAlertsGate'] = value");
  expect(final).toContain('ttlMs: () => policies.ttlMs()');
  expect(final).toContain('requestBudgetMs: () => policies.requestBudgetMs()');
});

it('reads current static policies and logger through the canonical bounded source budget', () => {
  const { ast, cls, text } = root();
  const method = cls.members.find(
    (node): node is ts.MethodDeclaration =>
      ts.isMethodDeclaration(node) && node.name.getText(ast) === 'withSourceBudget',
  );
  if (!method) throw new Error('Original source budget declaration required');
  expect(returnCall(method).expression.getText(ast)).toBe('withIntelligenceSourceBudget');
  expect(method.body?.getText(ast)).toContain(
    'budgetMs: () => IntelligenceService.PROFILE_V1_SOURCE_BUDGET_MS',
  );
  expect(method.body?.getText(ast)).toContain(
    'slowMs: () => IntelligenceService.PROFILE_V1_SLOW_SOURCE_MS',
  );
  expect(method.body?.getText(ast)).toContain('logger: () => this.logger');
  expect(text).toContain('ttlMs: () => IntelligenceService.PORTFOLIO_ALERTS_TTL_MS');
  expect(text).toContain(
    'requestBudgetMs: () => IntelligenceService.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS',
  );
  const budget = parsed('intelligence-profile-source-budget.ts');
  expect(budget.text).toContain('Promise.race([work, budget]).finally(');
  expect(budget.text).toContain('ports.logger().warn(');
  expect(budget.text).toContain('ports.slowMs()');
  expect(budget.text.match(/ports\.budgetMs\(\)/g)).toHaveLength(2);
  expect(
    budget.ast.statements.filter(ts.isFunctionDeclaration).map((node) => node.name?.text),
  ).toEqual(['withIntelligenceSourceBudget']);
});

it('preserves the actual public export identities and three canonical Nest injection dependencies', () => {
  const { ast, cls } = root();
  const ctor = cls.members.find(ts.isConstructorDeclaration);
  expect(ctor?.parameters.map((parameter) => parameter.type?.getText(ast))).toEqual([
    'PrismaService',
    'ClientPrepopulationService',
    'OfficeRecommenderService',
  ]);
  const imports = ast.statements.filter(ts.isImportDeclaration);
  for (const [token, file] of [
    ['PrismaService', '../prisma/prisma.service.js'],
    ['ClientPrepopulationService', './client-prepopulation.service.js'],
    ['OfficeRecommenderService', './office-recommender.service.js'],
  ]) {
    const declaration = imports.find(
      (node) =>
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === file &&
        node.importClause?.isTypeOnly === false,
    );
    const bindings = declaration?.importClause?.namedBindings;
    expect(
      bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some((binding) => binding.name.text === token),
    ).toBe(true);
  }
  expect(Reflect.getMetadata('__injectable__', facadeExports.IntelligenceService)).toBe(true);
  expect(Reflect.getMetadata('design:paramtypes', facadeExports.IntelligenceService)).toEqual([
    PrismaService,
    ClientPrepopulationService,
    OfficeRecommenderService,
  ]);
  expect(Object.keys(facadeExports).sort()).toEqual([
    'AWARD_BEARING_MAPPING_SOURCES',
    'IntelligenceService',
    'THIN_SIGNAL_SIMILARITY_FLOOR',
    'TRACKED_BILL_SIMILARITY_FLOOR',
    'buildQuarterWindows',
    'embeddingSimilarityFloor',
    'foldEngagementTrend',
  ]);
  expect(facadeExports.AWARD_BEARING_MAPPING_SOURCES).toBe(policy.AWARD_BEARING_MAPPING_SOURCES);
  expect(facadeExports.TRACKED_BILL_SIMILARITY_FLOOR).toBe(policy.TRACKED_BILL_SIMILARITY_FLOOR);
  expect(facadeExports.THIN_SIGNAL_SIMILARITY_FLOOR).toBe(policy.THIN_SIGNAL_SIMILARITY_FLOOR);
  expect(parsed('intelligence.module.ts').text).toMatch(
    /providers:\s*\[[\s\S]*?IntelligenceService/,
  );
  expect(parsed('intelligence.module.ts').text).toMatch(/exports:\s*\[[\s\S]*?IntelligenceService/);
});
