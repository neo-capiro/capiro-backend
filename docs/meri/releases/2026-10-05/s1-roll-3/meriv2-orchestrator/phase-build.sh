set -euo pipefail
image="967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/meriv2-orchestrator:${EXPECTED_SHA}"
docker build --platform linux/arm64 --no-cache \
  --label "org.opencontainers.image.revision=$EXPECTED_SHA" \
  --label 'org.opencontainers.image.source=https://github.com/neo-capiro/capirov2' \
  -f apps/meriv2-orchestrator/Dockerfile -t "$image" .
test "$(docker image inspect "$image" --format '{{.Architecture}}')" = arm64
test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_SHA"
docker run --rm --network none --entrypoint node "$image" -e "
const assert=require('node:assert/strict');
const access=require('/app/apps/meriv2-orchestrator/dist/meri/meriv3/meriv3-access.service.js');
assert.equal(access.meriV3EnvironmentEnabled({}),true);
assert.equal(access.tenantFlagEnabled({clioFeatureFlags:{'meriv3.fullChat':false}}),false);
const client=require('/app/apps/meriv2-orchestrator/dist/meri/meriv3/openai-responses.client.js');
assert.equal(client.parseRetryAfterMs(new Headers({'retry-after':'2'})),2000);
const shared=require('@capiro/shared');
assert.equal(shared.extractCitationsFromToolResult('get_bill_status',{found:true,billId:'119-hr-8800',title:'T'},1)[0].url,'https://www.congress.gov/bill/119th-congress/house-bill/8800');
const core=require('/app/packages/meriv2-core/dist/index.js');
assert.ok(!core.inferClaimCategories('How did this PE change from FY26 enacted to FY27 requested?').includes('member_vote'));
console.log('IMAGE_SMOKE_PASS');
"
