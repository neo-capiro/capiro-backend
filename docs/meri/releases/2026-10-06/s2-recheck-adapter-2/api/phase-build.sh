set -euo pipefail
image="967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api:${EXPECTED_SHA}"
docker build --platform linux/arm64 \
  --label "org.opencontainers.image.revision=$EXPECTED_SHA" \
  --label 'org.opencontainers.image.source=https://github.com/neo-capiro/capirov2' \
  -f apps/api/Dockerfile -t "$image" .
test "$(docker image inspect "$image" --format '{{.Architecture}}')" = arm64
test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_SHA"
docker run --rm --network none --entrypoint node "$image" -e "
const assert=require('node:assert/strict');
assert.equal(typeof require('@prisma/client').PrismaClient,'function');
require('./dist/meri/meri-tools.service.js');
const flags=require('./dist/common/meriv3-flags.js');
assert.equal(flags.meriV3ChatActive({}, {}),true);
assert.equal(flags.meriV3ChatActive({clioFeatureFlags:{'meriv3.fullChat':false}}, {}),false);
assert.equal(flags.meriV3ChatActive({}, {MERIV3_ENABLED:'false'}),false);
const proxy=require('./dist/meri/meriv3-proxy.service.js');
assert.equal(typeof proxy.MeriV3ProxyService.prototype.streamUnavailable,'function');
const fs=require('node:fs');
const names=fs.readdirSync('./prisma/migrations');
assert.ok(names.includes('20281007020000_clio_attachments_xlsx_kind'));
assert.ok(names.includes('20261005160000_krisp_notetaker'));
assert.ok(names.includes('20281008010000_clio_research_sessions_jobs'));
const job=require('./dist/meri/meri-job.js');
assert.equal(job.projectMeriJobStatus({status:'complete',metadata:{}}),'completed');
const sweeper=require('./dist/meri/meri-job-lease-sweeper.js');
assert.equal(sweeper.meriJobSweeperEnabled({}),false);
const inputs=require('./dist/meri/meri-research-producer-inputs.js');
assert.ok(inputs.PUBLIC_DATA_RESEARCH_TOOLS.has('search_public_web'));
assert.ok(!inputs.PUBLIC_DATA_RESEARCH_TOOLS.has('get_representation'));
assert.equal(typeof require('@capiro/meriv2-core').governedSteeringRowDecision,'function');
const shared=require('@capiro/shared');
assert.equal(shared.congressGovBillUrl('119-hr-8800'),'https://www.congress.gov/bill/119th-congress/house-bill/8800');
console.log('IMAGE_SMOKE_PASS');
"
