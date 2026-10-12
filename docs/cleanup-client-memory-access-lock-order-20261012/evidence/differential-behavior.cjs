require('./strict-source-read-refusal.cjs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('/workspace/capirov2/apps/api/node_modules/typescript');
const root = path.resolve(__dirname, '../../..');
class NotFoundException extends Error { status = 404; }
class BadRequestException extends Error { status = 400; }
function compile(text) {
  const file = ts.createSourceFile('clients.service.ts', text, ts.ScriptTarget.Latest, true);
  const owner = file.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'ClientsService');
  const methods = owner?.members.filter(n => ts.isMethodDeclaration(n) && n.name.getText(file) === 'setMemoryAccess');
  if (methods?.length !== 1) throw new Error('Unique method required');
  const sandbox = { module: { exports: {} }, NotFoundException, BadRequestException };
  vm.runInNewContext(ts.transpileModule(`class Fragment { constructor(prisma) { this.prisma = prisma; } ${methods[0].getText(file)} } module.exports=Fragment;`, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, sandbox);
  return sandbox.module.exports;
}
const Before = compile(fs.readFileSync(path.join(__dirname, 'clients.service.before.ts.txt'), 'utf8'));
const After = compile(fs.readFileSync(path.join(root, 'apps/api/src/clients/clients.service.ts'), 'utf8'));
async function run(Owner, scenario) {
  const events = [];
  const ctx = {tenantId: 'tenant-current', userId: 'actor-current', role: 'user_admin'};
  const input = {memoryWall: scenario.nextWall ?? true, userIds: scenario.requested ?? ['u2','u1','u2']};
  const originalInput = JSON.stringify(input);
  const operation = (name, result) => async args => {
    events.push({name,args});
    if (scenario.error === name) throw new Error('synthetic '+name);
    return result;
  };
  const tx = {
    $queryRaw: async () => {events.push({name:'lock'});return [{id:'client-current'}];},
    client: {findFirst: operation('client', scenario.absent ? null : {id:'client-current',memoryWall:scenario.oldWall ?? false}), update: operation('update',{})},
    tenantMembership: {findMany: operation('members', (scenario.members ?? ['u1','u2','actor-current']).map(userId=>({userId})))},
    clientMemoryAccess: {findMany: operation('roster',(scenario.roster ?? ['old','u1']).map(userId=>({userId}))),createMany:operation('add',{}),deleteMany:operation('remove',{})},
    auditLog: {create: operation('audit',{})},
  };
  const instance = new Owner({withTenant:async(tenant,callback)=>{events.push({name:'tenant',args:tenant});return callback(tx);}});
  let outcome;
  try {outcome={result:await instance.setMemoryAccess(ctx,'client-current',input)};}
  catch(error) {outcome={error:{message:error.message,status:error.status ?? null}};}
  return JSON.parse(JSON.stringify({events:events.filter(row=>row.name!=='lock'),outcome,inputUnchanged:JSON.stringify(input)===originalInput}));
}
(async()=>{
 const scenarios = [
  {name:'replace-deduplicate-sorted-audit'},
  {name:'no-op-roster-and-wall',oldWall:true,roster:['u2','u1']},
  {name:'clear-all-self-grant',requested:[],roster:['actor-current','old']},
  {name:'empty-wall-only',requested:[],roster:[]},
  {name:'add-only',roster:['u1']},
  {name:'remove-only',requested:['u1']},
  {name:'self-grant',requested:['actor-current']},
  {name:'preserve-first-request-order',requested:['u1','u2','u1']},
  {name:'toggle-wall-off',oldWall:true,nextWall:false},
  {name:'foreign-member-reject',members:['u1']},
  {name:'client-missing',absent:true},
  ...['client','members','roster','add','remove','update','audit'].map(error=>({name:error+'-error',error})),
 ];
 const rows=[];
 for(const scenario of scenarios) {
  const before=await run(Before,scenario),after=await run(After,scenario);
  rows.push({name:scenario.name,equal:JSON.stringify(before)===JSON.stringify(after),before,after});
 }
 const result={sourceHead:'926b269ad6e3b5ed789b5d18f55306df310d046c',baseline:'277053c8196dc1be4789c42ea304b0de0553fe00',typescriptVersion:ts.version,compared:rows.length,passed:rows.filter(x=>x.equal).length,rows,nativePrisma:false,databaseOperations:false};
 fs.writeFileSync(path.join(__dirname,'06-differential-behavior.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({compared:result.compared,passed:result.passed,nativePrisma:false}));
 if(rows.some(x=>!x.equal || !x.before.inputUnchanged || !x.after.inputUnchanged)) process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
