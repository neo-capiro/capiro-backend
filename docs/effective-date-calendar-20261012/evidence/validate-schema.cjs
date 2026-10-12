const fs = require('node:fs');
const path = require('node:path');
const toolsRoot = process.argv[2];
if (!toolsRoot) throw new Error('Provide the installed pinned official Prisma internals package directory');
const version = JSON.parse(fs.readFileSync(path.join(toolsRoot, 'package.json'), 'utf8')).version;
if (version !== '5.22.0') throw new Error('Prisma 5.22.0 is required');
const { getDMMF } = require(toolsRoot);
getDMMF({ datamodel: fs.readFileSync('apps/api/prisma/schema.prisma', 'utf8') }).then(dmmf => {
  const model = dmmf.datamodel.models.find(model => model.name === 'FederalRegisterDocument');
  console.log(JSON.stringify({ evidenceKind: 'official_prisma_wasm_dmmf_source_only', version,
    model: model.name, fields: model.fields.filter(field => field.name.startsWith('effectiveDate')).map(field => ({ name: field.name, type: field.type, isRequired: field.isRequired })) }, null, 2));
}).catch(error => { console.error(error); process.exitCode = 1; });
