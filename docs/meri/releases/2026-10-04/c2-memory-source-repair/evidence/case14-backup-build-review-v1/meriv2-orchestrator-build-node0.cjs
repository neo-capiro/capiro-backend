const assert = require("node:assert/strict");
const { ApiToolExecutorRepo } = require("./dist/meri/api-tool-executor.repo.js");
const { RequestCredentialsStore } = require("./dist/request/request-credentials.store.js");
const config = { MERIV2_API_BASE_URL: "https://offline.invalid", INTERNAL_SERVICE_SECRET: "synthetic-offline-secret" };
const repo = new ApiToolExecutorRepo({ get: key => config[key] });
let called = 0;
global.fetch = async (url, init) => {
  called++; assert.equal(url, "https://offline.invalid/api/clio/tools/list_emails");
  assert.equal(init.headers.authorization, "Bearer synthetic-offline-bearer");
  assert.equal(init.headers["x-internal-service-secret"], config.INTERNAL_SERVICE_SECRET);
  assert.deepEqual(JSON.parse(init.body), { limit: 1, folder: "all", offset: 0 });
  return new Response(JSON.stringify({ totalMatches: 0, returned: 0, hasMore: false, messages: [], searchedMailboxes: [{mailCoverage:{sourceStatus:"healthy"}}] }), {status:200});
};
RequestCredentialsStore.run({bearerToken:"synthetic-offline-bearer"}, () => repo.execute({}, "list_emails", Object.freeze({limit:1})))
  .then(result => { assert.equal(result.totalMatches,0); assert.equal(called,1); console.log("OFFLINE_PACKAGED_MAIL_DEFAULTS_PASS"); })
  .catch(error => { console.error(error); process.exitCode=1; });
