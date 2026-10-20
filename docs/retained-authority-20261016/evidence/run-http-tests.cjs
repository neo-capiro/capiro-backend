const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = 'C:/Users/neoma/Documents/Codex/2026-10-15/task-3/backend-retained-authority/packages/shared/src';
const ts = require('C:/Users/neoma/Documents/Codex/2026-10-15/task-3/implementation-runtime/workspace/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/typescript.js');
const canonicalPath = 'C:/Users/neoma/Documents/Codex/2026-10-15/task-4/meri-greenfield/node_modules/canonicalize/lib/canonicalize.js';
const resolve = Module._resolveFilename;
Module._resolveFilename = function(specifier, parent, ...rest) {
  if (specifier === 'canonicalize') return canonicalPath;
  if (specifier.startsWith('./') && specifier.endsWith('.js') && parent?.filename.replaceAll('\\', '/').startsWith(root)) {
    const candidate = path.resolve(path.dirname(parent.filename), specifier.slice(0, -3) + '.ts');
    if (fs.existsSync(candidate)) return candidate;
  }
  return resolve.call(this, specifier, parent, ...rest);
};
require.extensions['.ts'] = (module, filename) => {
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {fileName:filename, reportDiagnostics:true, compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true,strict:true}});
  const errors = result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) || [];
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors,{getCurrentDirectory:()=>root,getCanonicalFileName:v=>v,getNewLine:()=> '\n'}));
  module._compile(result.outputText, filename);
};
require(path.join(root, 'core-retained-authority-http.spec.ts'));
process.on('exit', (code) => process.stdout.write(JSON.stringify({kind:'process-evidence',pid:process.pid,exitCode:code,maxRssBytes:process.resourceUsage().maxRSS*1024,heapLimitBytes:require('node:v8').getHeapStatistics().heap_size_limit})+'\n'));
