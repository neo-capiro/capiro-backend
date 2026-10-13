import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';

const root = resolve(__dirname, '../../..');
const directory = 'apps/intel-api/src/bill-dossier';
// Pinned from immutable3d76ab21 original AST; business bodies are validated by retained runtime cases and phase reconstruction receipts.
const modules = [
  'bill-dossier.service.ts',
  'bill-dossier-federal.ts',
  'bill-dossier-state.ts',
  'bill-dossier-actions.ts',
  'bill-dossier-vote-status.ts',
  'bill-dossier-funding.ts',
  'bill-dossier-funding-empty.ts',
  'bill-dossier-funding-format.ts',
  'bill-dossier-funding-projections.ts',
  'bill-dossier-funding-comparisons.ts',
  'bill-dossier-funding.constants.ts',
  'bill-dossier-presentation.ts',
  'bill-dossier-client-context.ts',
  'bill-dossier-kpis.ts',
];
const methodHeaders: Record<string, string> = {
  getGlobalDossier: '4fb3c0d9e39773bbf91c8ce1ef4bffebaa5a51879c3f6df39b5b1de1f36bf4e7',
  getSourceRecords: '739d0f6e8da17e19333b40e353f3766fc301f0c9c964d122d9815513825ceb8a',
  getStateVoteMembers: '27f65da17ad8ce6292fd81aa917193a1c77d220a8f8dd83d9b3ecc331dff3933',
  getClientDossier: 'fa3fab7957ad7b0bb43b37fb6c5b48363477054b6c01d31dbdf544c012c344d6',
  buildFederalCore: '09d70fa22a852edae0811f5dbbfc6ae274cdf89ecdccacf1a759cfc6af540cb9',
  buildFederalMilestones: 'b743bb81bdd5c441bc95e99acbbeb031cec8393678eec7b68dd02a009897790c',
  ruleVoteToBillVote: 'ad094f5afeb3e8f79dfccccbb6093d1e94e20fc4964f6259f393f1330313047c',
  passageVoteToBillVote: '673e3cb006ff9eab49eac676862758cf44f1e38ef7af376a1ffce8349a806ccb',
  buildStateCore: 'ad666c68d2b125860923516072f1dd82704f0d2fecdeaff1d83dd0848b260c3c',
  loadFunding: '1d57d6df7775ae8f3f4bf4b7cb9961baa2339106e68abdb0143fa3b277a2ca42',
  loadTracking: 'fe703218655db20f23292653fa22710fbfdb0222a7ea801114c30b371365090f',
  loadClientAlerts: '258429ebc9515bd87114f7629d7c9676067f3c250912082e7efaa26d25d592f4',
  loadMatchedTopics: '579dbf917cce1e1c3da5bf0c42dffe6578a30863d9fc2df0273ee32fc30d78f5',
  loadClientHearings: '20e4d1ccacd22cb07f08ac0f549f48db7331475d83d68559cac564cede69011b',
  mergeAnalystOverview: '410f892a1bd45d7288251003c176131a63e6c37a52afaa15c2b11e4047407b9f',
  buildKpis: '4fb6d54653b2c11c2258da20cf72a81775d1d113db6308b795720dbe1ef4efb1',
};
const publicBodies: Record<string, string> = {
  getGlobalDossier: '31606ab65ed388be9b77b29428e5269b8052b7bee7ba4f20e8c032e35d03c4a5',
  getSourceRecords: '2dab1d892822de7b4c5fbb162088b4c8a9ce1669b06e1cf3f8cc8fdad5d446c2',
  getStateVoteMembers: '17a90de6efacb19dd4ebd709db99faa536439c59bbb8cadb3cab756219798d08',
  getClientDossier: '3e4714febb0125b9b831f56d35affda2db12c61e82b7c1ae01508de1392c6322',
};
const constants: Record<string, string> = {
  UUID_RE: 'e7aa3a6a24f38c0faeb69564bb799a24c6e71496db2a388e6be10baa06a7427f',
  DAY_MS: 'cbae3187b38d15d390d80f4e951cc702a6682490723b0587278ff204a7fe65d3',
  MAX_ACTIONS: '95752348ab77f0217617aaa606bb06e717f0e6a93a2a257b40036db819ec4f1e',
  MAX_VOTES: 'de78e40d8af3dc060c342ff34350f5786e3f49810d74a9b0396d7fdef76af228',
  MAX_ALERTS: '95752348ab77f0217617aaa606bb06e717f0e6a93a2a257b40036db819ec4f1e',
  MAX_HEARINGS: 'dff8eef9f5afe734fd383a3913c31db3967effe53d6eff2fb371478811220ba0',
  MAX_MENTIONS_PER_HEARING: '7b6b77855f8ed4592ac55a5f553d9b43d32548579ff3ff79474acaf315b84c11',
  MAX_RECOMMENDED_ACTIONS: '7b6b77855f8ed4592ac55a5f553d9b43d32548579ff3ff79474acaf315b84c11',
  MAX_FISCAL_NOTES: '7b6b77855f8ed4592ac55a5f553d9b43d32548579ff3ff79474acaf315b84c11',
  MAX_FUNDING_POSITIONS: '95752348ab77f0217617aaa606bb06e717f0e6a93a2a257b40036db819ec4f1e',
  MAX_PE_IMPACTS: '8068bec40630fba169f725273bb7f43329c174ef75be43fa2f55e6bb2636efbb',
  MAX_RELATED_VEHICLES: 'de78e40d8af3dc060c342ff34350f5786e3f49810d74a9b0396d7fdef76af228',
  MAX_PROVISIONS: '95752348ab77f0217617aaa606bb06e717f0e6a93a2a257b40036db819ec4f1e',
  NO_TARGET_VOTE: 'de5882bb52618b7577b1d3f46b0e4365cb0ae846cb16cf413138ea63a9ae7e07',
  FUNDING_UNAVAILABLE: 'fcb9880c016e6b1b57af159d578b7d01f392687e6b247f03bf3aa9fda5fc9ef4',
  FUNDING_NO_DATA: '897609b1da6a948ee7fb7ad1987fc63edaa08505114f3f63cffde244e3c4eaba',
  STATE_FUNDING_UNSUPPORTED: '89d3b072ecd71f6ba33391a5698cc70078fa5d769fb69b01468bbc64b9b87762',
  FUNDING_NO_PRIMARY_POSITION: 'eafd92583c0c511b925284d5d325333d5351356273690295bc243725841ec9a2',
  FUNDING_TABLES_PENDING: 'ad67729475d9c0b0bf19e16405cbb1475c9393e79bd6148ce5b86f6bb3a96a9b',
  OVERRIDE_RECONCILIATION_GUARDRAIL:
    'e8bbd95e5460789dfcba4b8543add3753d8ad60b08473bc9aaacf7fa38ba149b',
  OVERRIDE_RECONCILIATION_MARKER:
    '438d6eca714b4a495d06198fb50d301cd8cace91442433e1b0cc57fd2f662f03',
  NO_REQUEST_COMPARISON: 'e459f87e25bb13e0b09f67c66a85537572b3ca7a1f8a6a04d42099c8ffab00aa',
  NO_OFFICIAL_ACTION: 'ea21d77869ee96b48362dcf5f74b9818cc8e9a096e9cbc76c3b8474fe32abb16',
  NO_EXPECTED_MILESTONE: 'c0e347ebcb8e2181e749855012a9f0633cc1cdb6fb8724dc9c5a5cf33105e0e6',
  SCOPE_GUARDRAIL: '343d35994798360102a953cc0e7a475210f5c7ebfab35c1d226cf74b65ff4a41',
  STAGE_ORDER: 'abebf0bdeae2995caf2d94c2e96302f007c702113da54432bac8fcaa9e8faf23',
};
const sharedLabels: Record<string, string> = {
  EXPECTED_MILESTONE_TYPE_LABELS:
    'da98bb9bf56bedf0b92c0a5eff261ca34d461ed04244384920308c9368f3b375',
  billStatusLabel: 'ff2f4c58ee4021d2d3ff2f9c8112b1f4e9940c08b124c6842d270a2f270e80dd',
  classifyVoteResult: '43e108ce19ed564b0449fadd21b5d82f5db8850fdce6b0bafb186d83f4793f7f',
  humanizeBillId: 'f48fc98d88e3bdf137c4f4547ba95aeb4c814a4e7fea57e1a4122a43e3e58622',
  humanizeStateBillKey: 'f74e8ec2c18341b3c0eb7d2b4c1ab5dcd505e1b9faaea766c7ba01b4af3511e5',
  stateBillStatusLabel: 'bff011c61a5ef1dc401235bd8f4eefbb0f5cacd1af3eeb4c1c9ea4fd4a58a29f',
  stateBillReplacement: 'b780a4ff0b9da38b6b8a285a5bcec1ffb0291fc15f52e7bea838d0bfe3bfc305',
  isStateBillKey: '31c16d801ee30e633fdde97175fb64ae06652b8e9a0700ebf35830503beefb96',
};
const fixedAssets = [
  {
    path: 'apps/intel-api/src/bill-dossier/bill-dossier.types.ts',
    sha256: '1ceb52a27f48c5d3ea0bf99912914bc7f1325b0a2ba2fdc64f9bdb9b3689f045',
  },
  {
    path: 'apps/intel-api/src/bill-dossier/bill-dossier.controller.ts',
    sha256: 'ea2fe17be011556047c4e338ceed430e3f84e8c973da70ce4e7449e7155a88a0',
  },
  {
    path: 'apps/intel-api/src/bill-dossier/bill-dossier.module.ts',
    sha256: '4ce6a1c32dc0fca55e05427359a6278c9fa41a43cd01663300ba96dbb188272f',
  },
  {
    path: 'apps/intel-api/test/bill-dossier.spec.ts',
    sha256: 'de5b31a9e1f06571f69510cf81edbdb970f12a3be1c9cb70c0eb3a34fcf9495b',
  },
  {
    path: 'apps/intel-api/test/bill-dossier.truth.spec.ts',
    sha256: '764a8ad7e039b0f1617d842c3029b9bd4298013b7736cd37df3cbd4da25c04e0',
  },
  {
    path: 'apps/intel-api/test/bill-dossier-auth.spec.ts',
    sha256: '4643860b24347ba5f9b5f06550600958fab07560c7c9fc2381f9ee513af54d90',
  },
  {
    path: 'apps/intel-api/test/bill-dossier-state.spec.ts',
    sha256: 'ee5a9e677356e6971a2448f114edf7e2c4756df12346b24e0899a47cc0123850',
  },
  {
    path: 'apps/intel-api/test/bill-dossier-funding.spec.ts',
    sha256: '26c54cef90b4750d2b6f7f4a766969730fe276481a1fdf885f30153a69db6db3',
  },
  {
    path: 'apps/intel-api/test/verify-bill-dossier-sources.spec.ts',
    sha256: '28f7e34c9b62cbd7918028c26a3f338e4d4cc075bc160aabcdd788d4aef01b78',
  },
];
const delegates: Record<string, string> = {
  buildFederalCore: 'this.federal.buildFederalCore',
  buildFederalMilestones: 'this.federal.buildFederalMilestones',
  ruleVoteToBillVote: 'this.federal.ruleVoteToBillVote',
  passageVoteToBillVote: 'this.federal.passageVoteToBillVote',
  buildStateCore: 'this.state.buildStateCore',
  loadFunding: 'this.funding.loadFunding',
  loadTracking: 'this.clientContext.loadTracking',
  loadClientAlerts: 'this.clientContext.loadClientAlerts',
  loadMatchedTopics: 'this.clientContext.loadMatchedTopics',
  loadClientHearings: 'this.clientContext.loadClientHearings',
  mergeAnalystOverview: 'this.clientContext.mergeAnalystOverview',
  buildKpis: 'buildDossierKpis',
};
function hash(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function shape(node: ts.Node | undefined): unknown {
  if (!node) return null;
  const children: unknown[] = [];
  ts.forEachChild(node, (child) => {
    children.push(shape(child));
  });
  return {
    kind: ts.SyntaxKind[node.kind],
    value: ts.isIdentifier(node) || ts.isLiteralExpression(node) ? node.text : undefined,
    children,
  };
}
function digest(value: unknown): string {
  return hash(JSON.stringify(value));
}
function signature(node: ts.MethodDeclaration): string {
  return digest({
    name: node.name.getText(),
    modifiers: node.modifiers?.map((mod) => ts.SyntaxKind[mod.kind]) ?? [],
    parameters: node.parameters.map(shape),
    returnType: shape(node.type),
    typeParameters: node.typeParameters?.map(shape) ?? [],
    optional: !!node.questionToken,
  });
}
function source(name: string) {
  const text = readFileSync(join(root, directory, name), 'utf8');
  const ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const emitted = ts.transpileModule(text, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
    },
    reportDiagnostics: true,
  });
  expect(emitted.diagnostics ?? []).toHaveLength(0);
  return { text, ast };
}
function facade() {
  const { ast } = source('bill-dossier.service.ts');
  const owner = ast.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'BillDossierService',
  );
  if (!owner) throw new Error('Missing actual BillDossierService');
  return { ast, owner };
}
function declarations(ast: ts.SourceFile): ts.NamedDeclaration[] {
  return ast.statements.flatMap((node) =>
    ts.isVariableStatement(node)
      ? [...node.declarationList.declarations]
      : 'name' in node
        ? [node as unknown as ts.NamedDeclaration]
        : [],
  );
}

it('bounds the actual Root and all thirteen child modules and every complete nested function', () => {
  expect(modules).toHaveLength(14);
  for (const name of modules) {
    const { text, ast } = source(name);
    expect(text.split('\n').filter((line) => line.trim()).length).toBeLessThan(400);
    const visit = (node: ts.Node) => {
      if (ts.isFunctionLike(node) && 'body' in node && node.body) {
        const start = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line;
        const end = ast.getLineAndCharacterOfPosition(node.end).line;
        expect(end - start + 1).toBeLessThanOrEqual(80);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});

it('preserves all sixteen original method signatures, three DI parameters and four canonical public bodies', () => {
  const { owner, ast } = facade();
  const methods = owner.members.filter(ts.isMethodDeclaration);
  expect(methods).toHaveLength(16);
  expect(Object.keys(methodHeaders)).toHaveLength(16);
  for (const method of methods) {
    const name = method.name.getText(ast);
    expect(signature(method)).toBe(methodHeaders[name]);
    if (publicBodies[name]) expect(digest(shape(method.body))).toBe(publicBodies[name]);
  }
  expect(Object.keys(publicBodies)).toHaveLength(4);
  const ctor = owner.members.find(ts.isConstructorDeclaration);
  expect(ctor?.parameters).toHaveLength(3);
  expect(digest(ctor?.parameters.map(shape))).toBe(
    '1278d0d31427aff68b4fd4550c726db785e4fc9ce4c2a398366cdd1876f1c5c7',
  );
  expect(ts.getDecorators(owner)?.map((node) => node.expression.getText(ast))).toEqual([
    'Injectable()',
  ]);
  const options = ast.statements.find(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === 'DossierOptions',
  );
  expect(digest(shape(options))).toBe(
    '719c1ab17bfc01d61d400073b22168e57a64409d2d01ff583a171d69ade7e566',
  );
  expect(
    ast.statements
      .filter(
        (node) =>
          ts.canHaveModifiers(node) &&
          ts.getModifiers(node)?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword),
      )
      .map((node) =>
        'name' in node ? (node as unknown as ts.NamedDeclaration).name?.getText(ast) : null,
      ),
  ).toEqual(['DossierOptions', 'BillDossierService']);
});

it('routes twelve private methods through real owners and preserves actual Root KPI lookup and receiver ports', () => {
  const { owner, ast } = facade();
  for (const [name, callee] of Object.entries(delegates)) {
    const method = owner.members.find(
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
      throw new Error('Missing concrete delegate ' + name);
    expect(statement.expression.expression.getText(ast)).toBe(callee);
  }
  const ctor = owner.members.find(ts.isConstructorDeclaration);
  const owners: string[] = [];
  let getters = 0;
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node)) owners.push(node.expression.getText(ast));
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'kpiOwner') {
      expect(ts.isArrowFunction(node.initializer)).toBe(true);
      if (!ts.isArrowFunction(node.initializer))
        throw new Error('KPI host must be the actual Root');
      expect(node.initializer.body.kind).toBe(ts.SyntaxKind.ThisKeyword);
      getters += 1;
    }
    ts.forEachChild(node, visit);
  };
  if (!ctor) throw new Error('Missing constructor');
  visit(ctor);
  expect(owners).toEqual([
    'BillDossierFunding',
    'BillDossierClientContext',
    'BillDossierFederal',
    'BillDossierState',
  ]);
  expect(getters).toBe(2);
  for (const name of ['bill-dossier-federal.ts', 'bill-dossier-state.ts']) {
    const { ast: rail } = source(name);
    let calls = 0;
    const inspect = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isElementAccessExpression(node.expression) &&
        ts.isStringLiteral(node.expression.argumentExpression) &&
        node.expression.argumentExpression.text === 'buildKpis'
      ) {
        const host = node.expression.expression;
        if (!ts.isCallExpression(host))
          throw new Error('KPI method must resolve on actual Root host');
        expect(host.expression.getText(rail).replace(/\s+/g, '')).toBe('this.ports.kpiOwner');
        calls += 1;
      }
      ts.forEachChild(node, inspect);
    };
    inspect(rail);
    expect(calls).toBe(1);
  }
});

it('keeps forty-nine original helpers in single canonical owners and records the one reviewed unpublished retirement', () => {
  const archive = readFileSync(
    join(root, 'docs/backend-cleanup/20261013/BILL-DOSSIER-NEXT-INVENTORY.json'),
    'utf8',
  );
  expect(hash(archive)).toBe('6877fc39cdc1999d14e87ef6e6ccc99a913621bf1362426e28490375b6c6c32b');
  const inventory = JSON.parse(archive) as {
    recommendedWholeCapability: {
      sha256: string;
      spans: Array<{ name: string; category: string; sha256: string }>;
    };
  };
  expect(inventory.recommendedWholeCapability.sha256).toBe(
    '3644620513ba0fd4bfe87d69c4d094d8f4519ff1c3350e43edcd0e769c397175',
  );
  const helpers = inventory.recommendedWholeCapability.spans.filter(
    (row) => row.category === 'standalone-function',
  );
  expect(helpers).toHaveLength(50);
  const actual = modules.flatMap((name) =>
    source(name).ast.statements.filter(ts.isFunctionDeclaration),
  );
  let moved = 0;
  for (const helper of helpers) {
    const declarations = actual.filter((node) => node.name?.text === helper.name);
    if (helper.name === 'prettifyStatus') {
      expect(helper.sha256).toBe(
        'c4c6dac8aec658a1699e4faf0db7d887a76a90db2237cba250e58d499a6b12a4',
      );
      expect(declarations).toHaveLength(0);
    } else {
      expect(declarations).toHaveLength(1);
      expect(declarations[0]?.body?.statements.length).toBeGreaterThan(0);
      moved += 1;
    }
  }
  expect(moved).toBe(49);
});

it('preserves canonical cap and message declarations, shared labels, public contracts and all six original suites', () => {
  const actual = modules.flatMap((name) => declarations(source(name).ast));
  for (const [name, expected] of Object.entries(constants)) {
    const matches = actual.filter(
      (node) => ts.isVariableDeclaration(node) && node.name.getText() === name,
    );
    expect(matches).toHaveLength(1);
    const variable = matches[0];
    if (!variable || !ts.isVariableDeclaration(variable))
      throw new Error('Missing canonical constant ' + name);
    expect(digest(shape(variable.initializer))).toBe(expected);
  }
  const shared = ts.createSourceFile(
    'shared.ts',
    readFileSync(join(root, 'packages/shared/src/index.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = modules
    .flatMap((name) => source(name).ast.statements.filter(ts.isImportDeclaration))
    .filter(
      (node) =>
        ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@capiro/shared',
    )
    .flatMap((node) =>
      node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        ? node.importClause.namedBindings.elements.map(
            (item) => (item.propertyName ?? item.name).text,
          )
        : [],
    );
  for (const [name, expected] of Object.entries(sharedLabels)) {
    expect(imports).toContain(name);
    const node = declarations(shared).find((node) => node.name?.getText(shared) === name);
    expect(digest(shape(node))).toBe(expected);
  }
  for (const asset of fixedAssets)
    expect(hash(readFileSync(join(root, asset.path), 'utf8'))).toBe(asset.sha256);
});
