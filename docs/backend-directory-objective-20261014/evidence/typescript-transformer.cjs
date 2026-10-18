const ts = require(require.resolve('typescript', { paths: [require('node:path').resolve(__dirname, '../../../apps/api')] }));
module.exports = { process(source, filename) {
  return { code: ts.transpileModule(source, { fileName: filename, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true, useDefineForClassFields: false,
  } }).outputText };
} };
