const ts = require('/workspace/capirov2/node_modules/typescript');
const cp = require('node:child_process');
const fs = require('node:fs');

const base = '6074d8a59d1fb5bc10bf9ccfbcb338bff68932e8';
const donorParent = '4970927fe1951636ab002522a20a35310d3dc7c4';
const donor = 'e19ec92e1c40e92d6fe48803df57ec3b51ec8e8c';
const frozen = 'cd827868794a3197aa557070a8ae162949e6209f';
const servicePath = 'apps/api/src/intelligence/intelligence.service.ts';
const git = (...args) => cp.execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
if (git('rev-parse', 'HEAD') !== frozen) throw new Error('Wrong receiving source HEAD');

const paths = git('diff', '--name-only', donorParent, donor).split('\n');
for (const path of paths) {
  if (!path.startsWith('apps/api/src/intelligence/') &&
      !path.startsWith('apps/api/test/fixtures/intelligence-') && !path.startsWith('docs/backend-cleanup/20261013/'))
    throw new Error(`Out-of-scope donor path: ${path}`);
}
const entry = (rev, path) => git('ls-tree', rev, '--', path).split('\t')[0];
const exactDonor = paths.filter((path) => entry(donor, path) === entry(frozen, path));

const oldSource = git('show', `${base}:${servicePath}`);
const newSource = fs.readFileSync(servicePath, 'utf8');
const changedProductionPaths = git('diff', '--name-only', base, frozen, '--',
  'apps/api/src/intelligence').split('\n').filter((path) =>
    path.endsWith('.ts') && !path.endsWith('.spec.ts'));

function parse(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const cls = file.statements.find((node) =>
    ts.isClassDeclaration(node) && node.name?.text === 'IntelligenceService');
  const methods = new Map();
  if (cls) for (const node of cls.members) if (ts.isMethodDeclaration(node)) {
    const name = node.name.getText(file);
    methods.set(name, {
      header: source.slice(node.getStart(file), node.body?.getStart(file) ?? node.end),
      body: node.body?.getText(file),
    });
  }
  const ctor = cls?.members.find(ts.isConstructorDeclaration);
  const ctorParams = ctor?.parameters.map((node) => node.getText(file)) ?? [];
  const exports = file.statements.filter((node) => ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)).map((node) => {
      if (ts.isVariableStatement(node)) return node.declarationList.declarations.map((d) => d.name.getText(file)).join(',');
      return node.name?.getText(file) ?? node.kind;
    });
  const tags = [], unsafe = [];
  function visit(node) {
    if (ts.isTaggedTemplateExpression(node)) tags.push(node.template.getText(file));
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === '$queryRawUnsafe')
      unsafe.push(node.arguments.map((arg) => arg.getText(file)).join('\u241F'));
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { methods, ctorParams, exports, tags, unsafe };
}
const before = parse(servicePath, oldSource);
const after = parse(servicePath, newSource);
const moved = changedProductionPaths.map((path) => parse(path, fs.readFileSync(path, 'utf8')));
const multiset = (values) => {
  const map = new Map();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return [...map].sort(([a], [b]) => a.localeCompare(b));
};
const preservedHeaders = [...before.methods].filter(([name, value]) =>
  after.methods.get(name)?.header === value.header);
const preservedBodies = [...before.methods].filter(([name, value]) =>
  after.methods.get(name)?.body === value.body);
const allNewTags = moved.flatMap((item) => item.tags);
const allNewUnsafe = moved.flatMap((item) => item.unsafe);
const result = {
  base, donor, frozen,
  exactDonorPathCount: exactDonor.length,
  donorPathCount: paths.length,
  originalMethodCount: before.methods.size,
  receivingMethodCount: after.methods.size,
  exactExistingHeaders: preservedHeaders.length,
  exactExistingWholeBodies: preservedBodies.length,
  changedExistingBodies: before.methods.size - preservedBodies.length,
  newMethodNames: [...after.methods.keys()].filter((name) => !before.methods.has(name)),
  constructorParametersExact: JSON.stringify(before.ctorParams) === JSON.stringify(after.ctorParams),
  constructorParameterCount: before.ctorParams.length,
  exportDeclarationsExact: JSON.stringify(before.exports) === JSON.stringify(after.exports),
  exportDeclarationCount: before.exports.length,
  taggedSqlOrTemplateCountBefore: before.tags.length,
  taggedSqlOrTemplateCountAfter: allNewTags.length,
  taggedTemplateTextAndInterpolationMultisetExact: JSON.stringify(multiset(before.tags)) === JSON.stringify(multiset(allNewTags)),
  rawUnsafeCallCountBefore: before.unsafe.length,
  rawUnsafeCallCountAfter: allNewUnsafe.length,
  rawUnsafeArgumentVectorMultisetExact: JSON.stringify(multiset(before.unsafe)) === JSON.stringify(multiset(allNewUnsafe)),
  productionPathsCompared: changedProductionPaths.length,
};
if (result.exactDonorPathCount !== result.donorPathCount ||
    result.exactExistingHeaders !== result.originalMethodCount ||
    !result.constructorParametersExact || !result.exportDeclarationsExact ||
    !result.taggedTemplateTextAndInterpolationMultisetExact ||
    !result.rawUnsafeArgumentVectorMultisetExact)
  throw new Error(JSON.stringify(result));
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
