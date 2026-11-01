import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';

/** Execute exact owner methods without loading unrelated asset/provider modules. */
export function clientsServiceFragment(names: readonly string[], bindings: Record<string, unknown>) {
  const source = ts.createSourceFile('clients.service.ts',
    readFileSync(join(__dirname, 'clients.service.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const owner = source.statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'ClientsService');
  const methods = names.map(name => {
    const found = owner?.members.filter(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
    if (found?.length !== 1) throw Error('Expected one canonical ClientsService method');
    return found[0]!.getText(source);
  });
  const sandbox = { ...bindings, module: { exports: {} } };
  runInNewContext(ts.transpileModule(`class Fragment {
    constructor(prisma) { this.prisma = prisma; } ${methods.join('\n')}
    } module.exports = Fragment;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, sandbox);
  return sandbox.module.exports;
}
