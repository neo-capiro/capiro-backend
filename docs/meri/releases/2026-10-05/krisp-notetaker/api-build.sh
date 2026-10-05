set -euo pipefail
test "$CODEBUILD_RESOLVED_SOURCE_VERSION" = "be4d886ffa774f72e0ed5c5268995109cbd11220"
test "$(git rev-parse HEAD)" = "be4d886ffa774f72e0ed5c5268995109cbd11220"
test "$(uname -m)" = aarch64
test "$(aws sts get-caller-identity --query Account --output text)" = 967807252336
test "$(aws ecr list-images --region us-east-1 --repository-name capiro/dev/api --filter tagStatus=TAGGED --query "length(imageIds[?imageTag=='be4d886ffa774f72e0ed5c5268995109cbd11220'])" --output json)" = 0
python3 scripts/validate-meri-build-isolation.py
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 967807252336.dkr.ecr.us-east-1.amazonaws.com
docker build --platform linux/arm64 --build-arg NODE_VERSION=22.23.3  --label org.opencontainers.image.revision=be4d886ffa774f72e0ed5c5268995109cbd11220 -f apps/api/Dockerfile -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api:be4d886ffa774f72e0ed5c5268995109cbd11220 .
test "$(docker image inspect 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api:be4d886ffa774f72e0ed5c5268995109cbd11220 --format '{{.Architecture}}')" = arm64
test "$(docker image inspect 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api:be4d886ffa774f72e0ed5c5268995109cbd11220 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = be4d886ffa774f72e0ed5c5268995109cbd11220
docker run --rm --network none --entrypoint node 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api:be4d886ffa774f72e0ed5c5268995109cbd11220 -e 'const a=require("node:assert/strict");a.equal(process.version,"v22.23.3");require("./dist/engagement/krisp/krisp-notetaker.service.js");require("./dist/engagement-workers/krisp-notetaker-worker.service.js");require("./dist/meri/meri-managed-mcp.service.js");require("./dist/engagement-workers/engagement-workers.module.js");const p=require("@prisma/client");a.ok(p.Prisma.ModelName.KrispMeetingImport);console.log("KRISP_PACKAGED_RUNTIME_PASS")'
docker run --rm --network none --entrypoint node 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api:be4d886ffa774f72e0ed5c5268995109cbd11220 -e 'const fs=require("node:fs"),c=require("node:crypto");const r="./prisma/migrations";console.log(JSON.stringify(fs.readdirSync(r).filter(n=>fs.existsSync(r+"/"+n+"/migration.sql")).sort().map(n=>({name:n,sha256:c.createHash("sha256").update(fs.readFileSync(r+"/"+n+"/migration.sql")).digest("hex")}))))' > image-migrations.json
python3 - <<'PY'
import json, pathlib, hashlib
expected=[{'name':p.parent.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(pathlib.Path('apps/api/prisma/migrations').glob('*/migration.sql'))]
assert json.load(open('image-migrations.json'))==expected
assert len(expected)==454
print('EXACT_454_PACKAGED_MIGRATIONS_PASS')
PY
docker push 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api:be4d886ffa774f72e0ed5c5268995109cbd11220
digest=$(aws ecr describe-images --region us-east-1 --repository-name capiro/dev/api --image-ids imageTag=be4d886ffa774f72e0ed5c5268995109cbd11220 --query 'imageDetails[0].imageDigest' --output text)
echo "QUALIFIED_BUILD_IMAGE=967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@$digest"
