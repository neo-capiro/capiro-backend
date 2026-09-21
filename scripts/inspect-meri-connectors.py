"""Read-only inspection of an MCP-consuming API; never reads or prints secret values."""
import argparse
import json
import subprocess
from datetime import datetime, timezone

def aws(*args):
    result = subprocess.run(["aws", *args, "--output", "json"], capture_output=True, text=True)
    if result.returncode:
        # Error messages can echo arguments. Keep only a fixed diagnostic.
        raise RuntimeError("AWS read failed: " + args[0] + ":" + args[1])
    return json.loads(result.stdout)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--service", choices=["capiro-dev-api", "capiro-dev-engagement-api"], default="capiro-dev-api")
parser.add_argument("--output-file", default="meri-connector-deployment.json")
args = parser.parse_args()

service = aws("ecs", "describe-services", "--cluster", "capiro-dev", "--services", args.service)["services"][0]
definition = aws("ecs", "describe-task-definition", "--task-definition", service["taskDefinition"])["taskDefinition"]
safe_values = {
    "CLIO_MCP_ENABLED", "CLIO_MCP_OAUTH_REDIRECT_URI", "CLIO_MCP_OAUTH_SUCCESS_REDIRECT",
    "MERI_MCP_HUBSPOT_ENABLED", "MERI_MCP_AIRTABLE_ENABLED",
    "MERI_MCP_MONDAY_ENABLED", "MERI_MCP_GOOGLE_DRIVE_ENABLED",
}
tracked = safe_values | {
    "MERI_MCP_MONDAY_ALLOWED_USER_IDS", "MERI_MCP_MONDAY_ALLOWED_TENANT_IDS",
    "OAUTH_TOKEN_ENCRYPTION_KEY", "OAUTH_TOKEN_ENCRYPTION_KEY_VERSION", "OAUTH_STATE_SECRET",
    "MERI_MCP_HUBSPOT_CLIENT_ID", "MERI_MCP_HUBSPOT_CLIENT_SECRET",
    "MERI_MCP_GOOGLE_DRIVE_CLIENT_ID", "MERI_MCP_GOOGLE_DRIVE_CLIENT_SECRET",
}
containers = []
for container in definition["containerDefinitions"]:
    env = {item["name"]: item["value"] for item in container.get("environment", [])}
    refs = {item["name"]: item["valueFrom"] for item in container.get("secrets", [])}
    config = {}
    for name in sorted(tracked):
        config[name] = {"present": bool(env.get(name) or refs.get(name))}
        if name in safe_values and name in env:
            config[name]["value"] = env[name]
        if name in refs:
            config[name]["secretReference"] = refs[name]
    oauth_gaps = [name for name in ["CLIO_MCP_OAUTH_REDIRECT_URI", "OAUTH_STATE_SECRET", "OAUTH_TOKEN_ENCRYPTION_KEY"]
                  if not config[name]["present"]]
    containers.append({"name": container["name"], "image": container["image"], "configuration": config,
                       "missingManagedOAuthConfiguration": oauth_gaps})

role = definition.get("executionRoleArn", "")
permissions = {"executionRole": role, "status": "unverified"}
try:
    role_name = role.rsplit("/", 1)[-1]
    permissions["inlinePolicyNames"] = aws("iam", "list-role-policies", "--role-name", role_name)["PolicyNames"]
    permissions["attachedPolicyArns"] = [p["PolicyArn"] for p in aws("iam", "list-attached-role-policies", "--role-name", role_name)["AttachedPolicies"]]
    permissions["status"] = "policy references inspected; effective GetSecretValue and KMS permissions still require verification"
except RuntimeError:
    permissions["status"] = "blocked: read-only inspection role cannot inspect IAM policies"

report = {
    "checkedAt": datetime.now(timezone.utc).isoformat(),
    "cluster": "capiro-dev", "service": service["serviceName"],
    "taskDefinition": definition["taskDefinitionArn"],
    "runningCount": service["runningCount"], "desiredCount": service["desiredCount"],
    "deployments": [{"status": d["status"], "taskDefinition": d["taskDefinition"], "runningCount": d["runningCount"]} for d in service["deployments"]],
    "containers": containers, "secretLoadingPermissions": permissions,
    "liveAuthorization": {p: "NOT TESTED: authenticated Meri fixture required" for p in ["hubspot", "airtable", "monday", "google-drive"]},
}
print(json.dumps(report, indent=2))
with open(args.output_file, "w", encoding="utf-8") as handle:
    json.dump(report, handle, indent=2)
