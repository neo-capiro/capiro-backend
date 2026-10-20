import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(__dirname, '../../../..');
const entry = 'apps/api/src/auth/application-authority.module.ts';
function assertDependency(path: string) {
  if (/^(apps\/(meriv2-orchestrator|clio-sandbox)\/|packages\/meriv2-core\/)/.test(path)
    || /apps\/api\/src\/engagement\//.test(path)
    || path.startsWith('apps/api/src/meri/')
    || /\/(?:context|business-development)\.module\.ts$/.test(path)) {
    throw new Error(`Retired/heavy runtime dependency: ${path}`);
  }
}
function graph(overrides: Record<string, string> = {}) {
  const seen = new Set<string>(); const external = new Set<string>();
  function visit(path: string) {
    assertDependency(path); // Refuse before reading a forbidden/protected body.
    if (seen.has(path)) return;
    seen.add(path);
    const source = overrides[path] ?? (existsSync(resolve(root, path)) ? readFileSync(resolve(root, path), 'utf8')
      : execFileSync('git', ['show', `HEAD:${path}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 }).toString());
    const js = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true,
    }, reportDiagnostics: true });
    expect(js.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error)).toEqual([]);
    const file = ts.createSourceFile(path + '.js', js.outputText, ts.ScriptTarget.Latest, true);
    function walk(node: ts.Node) {
      if (ts.isCallExpression(node) && (node.expression.getText(file) === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
        const value = node.arguments[0];
        if (!value || !ts.isStringLiteral(value)) throw new Error('Unbounded runtime import');
        if (value.text.startsWith('.')) {
          const target = posix.normalize(posix.join(posix.dirname(path), value.text)).replace(/\.js$/, '.ts');
          visit(target);
        } else {
          if (/^@capiro\/meriv[23]/.test(value.text)) throw new Error('Legacy runtime package');
          external.add(value.text);
        }
      }
      ts.forEachChild(node, walk);
    }
    walk(file);
  }
  visit(entry);
  return { paths: [...seen].sort(), external: [...external].sort() };
}

describe('authority runtime import boundary and current reexports', () => {
  it('follows emitted runtime imports through the actual auth/domain closure without legacy owner', () => {
    const closure = graph();
    expect(closure.paths).toContain('apps/api/src/auth/application-authority.controller.ts');
    expect(closure.paths).toContain('apps/api/src/business-development/bizdev-meri-scope.authorization.ts');
    expect(closure.paths.some((path) => path.startsWith('apps/api/src/meri/'))).toBe(false);
    expect(closure.paths).toContain('apps/api/src/research-portfolios/research-portfolio-artifact-authority.ts');
    expect(closure.paths).toContain('apps/api/src/tenant/tenant-context.middleware.ts');
    expect(closure.paths).toContain('apps/api/src/context/context-security-scope.service.ts');
    expect(closure.external).not.toContain('@capiro/meriv2-core');
  });

  it.each(['../meri/meri-prospect-scope.helpers.js', '../meri/meri.module.js', '../meri/meri.service.js', '../engagement/engagement.service.js', '../context/context.module.js'])
  ('refuses an introduced runtime dependency before reading it: %s', (dependency) => {
    const source = readFileSync(resolve(root, entry), 'utf8');
    expect(() => graph({ [entry]: `import '${dependency}';\n${source}` })).toThrow('Retired/heavy runtime dependency');
  });

  it('refuses nonliteral runtime imports and legacy package introduction', () => {
    const source = readFileSync(resolve(root, entry), 'utf8');
    expect(() => graph({ [entry]: `require(process.env.RUNTIME_MODULE);\n${source}` })).toThrow('Unbounded runtime import');
    expect(() => graph({ [entry]: `import '@capiro/meriv2-core';\n${source}` })).toThrow('Legacy runtime package');
  });

  it('reexports the same thin provider owners from both former modules and mounts the routes once', () => {
    const context = readFileSync(resolve(root, 'apps/api/src/context/context.module.ts'), 'utf8');
    const business = readFileSync(resolve(root, 'apps/api/src/business-development/business-development.module.ts'), 'utf8');
    for (const [source, name] of [[context, 'ContextSecurityScope'], [business, 'BizDevMeriScope']]) {
      expect(source).toContain(`${name}Module,`);
      expect(source).not.toContain(`${name}Service,`);
    }
    const app = readFileSync(resolve(root, 'apps/api/src/app.module.ts'), 'utf8');
    expect(app.match(/^    ApplicationAuthorityModule,$/gm)).toHaveLength(1);
    expect(readFileSync(resolve(root, 'apps/api/src/meri/meri.controller.ts'), 'utf8')).not.toContain("@Post('application-authority/");
  });
});
