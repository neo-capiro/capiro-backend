set -euo pipefail
test "${CODEBUILD_BUILD_SUCCEEDING:-0}" = 1
image="967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/meriv2-orchestrator:${EXPECTED_SHA}"
docker push "$image"
docker image inspect "$image" --format '{{json .RepoDigests}}' > pushed-repo-digests.json
digest="$(aws ecr describe-images --region us-east-1 --repository-name capiro/dev/meriv2-orchestrator --image-ids "imageTag=${EXPECTED_SHA}" --query 'imageDetails[0].imageDigest' --output text)"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
python3 - "$digest" <<'PY'
import json,sys
target='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/meriv2-orchestrator@'+sys.argv[1]
assert target in json.load(open('pushed-repo-digests.json'))
print('LOCAL_REPODIGEST_ECR_MATCH_PASS')
PY
echo "CANDIDATE_IMAGE=967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/meriv2-orchestrator@$digest"
