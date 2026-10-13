'use strict';
// Root approves the exact invocation and stable fixture slot before execution.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const SOURCE='bbb38185058fdc64c204da723943aee055b3dad3';
const AUTHOR='/tmp/capiro-meri-http-harness-20261013/docs/meri-application-authority-http-qualification-20261013';
async function main(output,bindingPath) {
  assert.equal(process.env.OWNED_HTTP_REVIEW_ACK,SOURCE,'Exact parent-approved invocation required');
  assert.ok(output && !fs.existsSync(output),'Exclusive new review receipt required');
  const binding=JSON.parse(fs.readFileSync(bindingPath,'utf8'));
  assert.equal(binding.source,SOURCE);
  for(const [name,expected] of Object.entries(binding.files)) {
    assert.ok(['http-driver.cjs','critical-loader.cjs','critical-source-sha256.json','containment-preload.cjs'].includes(name));
    assert.equal(sha(fs.readFileSync(path.join(AUTHOR,name))),expected,`Frozen host operand differs: ${name}`);
  }
  assert.deepEqual(Object.keys(binding.files).sort(),['containment-preload.cjs','critical-loader.cjs','critical-source-sha256.json','http-driver.cjs']);
  const config=JSON.parse(fs.readFileSync('/tmp/capiro-authority-http-runtime.json','utf8'));
  assert.equal(config.sourceHead,SOURCE);
  assert.equal(config.approvedOwnedDatabase,true);
  assert.equal(config.databaseName,'capiro_auth_http_20261013_4966f869fa');
  assert.equal(config.databaseOid,16917);
  // A transient copy changes only the test-harness selection. It is outside
  // the repository packet, exclusive, mode0600, and removed on every exit.
  const privatePath=`/tmp/capiro-owned-supplementary-http-20261013-${process.pid}.json`;
  fs.writeFileSync(privatePath,JSON.stringify({...config,runAuthorCases:false}),{flag:'wx',mode:0o600});
  try {
    const {supplementary}=require('./supplementary-http.cjs');
    const driver=require(path.join(AUTHOR,'http-driver.cjs'));
    await driver.main(privatePath,output,{supplementary});
    for(const [name,expected] of Object.entries(binding.files)) {
      assert.equal(sha(fs.readFileSync(path.join(AUTHOR,name))),expected,`Host operand moved during qualification: ${name}`);
    }
    const receipt=JSON.parse(fs.readFileSync(output,'utf8'));
    assert.equal(receipt.total,24);
    assert.equal(receipt.failed,0);
    console.log(JSON.stringify({independentHTTP:'PASS',cases:receipt.total,source:SOURCE}));
  } finally {
    fs.unlinkSync(privatePath);
  }
}
if(require.main===module) main(process.argv[2],process.argv[3]).catch(error=>{
  console.error(JSON.stringify({independentHTTP:'FAIL',name:error.name,code:error.code??null,
    message:error instanceof assert.AssertionError?error.message:'controlled HTTP qualification failed; inspect owned receipt'}));
  process.exitCode=1;
});
module.exports={main};
