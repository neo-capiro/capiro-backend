set -euo pipefail
test "$CODEBUILD_RESOLVED_SOURCE_VERSION" = "786e4d4940bcddc6c48d31f112c69d82275529ae"
test "$(git rev-parse HEAD)" = "786e4d4940bcddc6c48d31f112c69d82275529ae"
test "$(uname -m)" = aarch64
test "$(aws sts get-caller-identity --query Account --output text)" = 967807252336
test "$(aws ecr list-images --region us-east-1 --repository-name capiro/dev/engagement-api --filter tagStatus=TAGGED --query "length(imageIds[?imageTag=='786e4d4940bcddc6c48d31f112c69d82275529ae'])" --output json)" = 0
python3 scripts/validate-meri-build-isolation.py
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 967807252336.dkr.ecr.us-east-1.amazonaws.com
docker pull public.ecr.aws/docker/library/node@sha256:b20fe038d9592822dd534600a1ddf467e985178aa3fed60ec441a056c2cc45bd
docker tag public.ecr.aws/docker/library/node@sha256:b20fe038d9592822dd534600a1ddf467e985178aa3fed60ec441a056c2cc45bd node:22.23.3-bookworm-slim
docker build --platform linux/arm64 --build-arg NODE_VERSION=22.23.3  --label org.opencontainers.image.revision=786e4d4940bcddc6c48d31f112c69d82275529ae -f apps/engagement-api/Dockerfile -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/engagement-api:786e4d4940bcddc6c48d31f112c69d82275529ae .
test "$(docker image inspect 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/engagement-api:786e4d4940bcddc6c48d31f112c69d82275529ae --format '{{.Architecture}}')" = arm64
test "$(docker image inspect 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/engagement-api:786e4d4940bcddc6c48d31f112c69d82275529ae --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = 786e4d4940bcddc6c48d31f112c69d82275529ae
docker run --rm --network none --entrypoint node 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/engagement-api:786e4d4940bcddc6c48d31f112c69d82275529ae -e 'const a=require("node:assert/strict");a.equal(process.version,"v22.23.3");require("./dist/engagement/krisp/krisp-notetaker.service.js");require("./dist/engagement-workers/krisp-notetaker-worker.service.js");require("./dist/meri/meri-managed-mcp.service.js");require("./dist/engagement-workers/engagement-workers.module.js");const p=require("@prisma/client");a.ok(p.Prisma.ModelName.KrispMeetingImport);const flags=require("./dist/common/krisp-notetaker-flags.js");a.equal(flags.krispNotetakerEnabled({clioFeatureFlags:{"notetaker.krisp.enabled":true}},"other-firm"),true);a.equal(flags.krispNotetakerEnabled({clioFeatureFlags:{"notetaker.krisp.enabled":false}}),false);a.equal(flags.krispNotetakerEnabled({}),false);const fs=require("node:fs");a.ok(fs.readFileSync("./dist/engagement/krisp/krisp-notetaker.service.js","utf8").includes("generateMeetingDebriefDraft"));a.equal(flags.krispImportMode("c2-strategies"),"direct_notes");a.equal(flags.krispImportMode("capiro-internal"),"generated");a.equal(flags.krispImportMode("other-firm"),"generated");const h=require("./dist/engagement/krisp/krisp.helpers.js");a.equal(h.krispNotes({results:[{id:"a".repeat(32),document:{notes:"  Exact notes\n"}}]},"a".repeat(32)),"  Exact notes\n");console.log("KRISP_PACKAGED_RUNTIME_PASS")'
docker run --rm --network none --entrypoint node 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/engagement-api:786e4d4940bcddc6c48d31f112c69d82275529ae -e 'const fs=require("node:fs"),c=require("node:crypto");const r="./prisma/migrations";console.log(JSON.stringify(fs.readdirSync(r).filter(n=>fs.existsSync(r+"/"+n+"/migration.sql")).sort().map(n=>({name:n,sha256:c.createHash("sha256").update(fs.readFileSync(r+"/"+n+"/migration.sql")).digest("hex")}))))' > image-migrations.json
python3 - <<'PY'
import json, pathlib, hashlib
expected=[{'name':p.parent.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(pathlib.Path('apps/api/prisma/migrations').glob('*/migration.sql'))]
assert json.load(open('image-migrations.json'))==expected
assert len(expected)>450
print('EXACT_PACKAGED_MIGRATIONS_PASS')
PY
docker push 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/engagement-api:786e4d4940bcddc6c48d31f112c69d82275529ae
digest=$(aws ecr describe-images --region us-east-1 --repository-name capiro/dev/engagement-api --image-ids imageTag=786e4d4940bcddc6c48d31f112c69d82275529ae --query 'imageDetails[0].imageDigest' --output text)
echo "QUALIFIED_BUILD_IMAGE=967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/engagement-api@$digest"
