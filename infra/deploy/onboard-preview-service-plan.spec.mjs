import assert from "node:assert/strict";
import test from "node:test";
import { renderOnboardPreviewPlan } from "./onboard-preview-service-plan.mjs";

const bindings = {
  image: "967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-onboard-api",
  imageDigest: "sha256:1a66f9699168cb098bca2f74e94d7557854f5b1417fee7733cc4ccbe3e668ebd",
  source: "129156c8a71cae411d012eb5500c8fc587af1ea0",
  cloneDbHost: "capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com",
  subnets: ["subnet-0a1b2c3d4e5f60718", "subnet-1a2b3c4d5e6f70819"],
  securityGroups: ["sg-0e742fb6a11314392"],
  executionRoleArn:
    "arn:aws:iam::967807252336:role/Capiro-dev-Compute-ApiTaskDefExecutionRoleE6ABB053-YlEDKuUPHjLg",
  taskRoleArn: "arn:aws:iam::967807252336:role/Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ",
  targetGroupArn:
    "arn:aws:elasticloadbalancing:us-east-1:967807252336:targetgroup/capiro-preview-onboard-api/e1ffa6a1394ba2ca",
  env: {
    ONBOARD_PORT: "4400",
    ONBOARD_BIND_HOST: "0.0.0.0",
    CAPIRO_ENV: "preview",
    DB_NAME: "capiro",
    APP_ENV: "capiro-preview",
    ONBOARD_APP_BASE_URL: "https://app.capiro.ai",
    ONBOARD_APPS_API_BASE: "https://first-chat-preview.app-dev.capiro.ai",
    ONBOARD_API_PUBLIC_BASE_URL: "https://first-chat-preview.app-dev.capiro.ai",
    ONBOARD_PUBLIC_BASE_URL: "https://app.capiro.ai",
    BILLING_RETURN_URL: "https://app.capiro.ai",
    ONBOARD_FUNNEL_ENABLED: "false",
    ONBOARD_EMAIL_ENABLED: "false",
    ONBOARD_EMAIL_FROM: "onboarding@capiro.ai",
    ONBOARD_CS_NOTIFY_EMAIL: "sales@capiro.ai",
    ONBOARD_WIRE_DUE_DAYS: "14",
    CLERK_JWT_ISSUER: "https://clerk.app.capiro.ai",
    CLERK_PUBLISHABLE_KEY: "pk_test_synthetic",
    STRIPE_PRICE_SLOTS: "price_synthetic_slots",
    STRIPE_PRICE_OVERAGE: "price_synthetic_overage",
    STRIPE_OVERAGE_METER_EVENT: "llm_overage_cents",
    STRIPE_PUBLISHABLE_KEY: "pk_test_synthetic_billing",
  },
  secrets: {
    DB_USER: "arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/preview/aurora/app-user",
    DB_PASSWORD: "arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/preview/aurora/app-password",
    CLERK_SECRET_KEY: "arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/clerk/secret-key-FT67tM",
    OAUTH_STATE_SECRET: "arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/oauth-state",
    INTERNAL_SERVICE_SECRET:
      "arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/internal-service-secret-6cEZG4",
    STRIPE_SECRET_KEY: "arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/stripe-secret",
    STRIPE_WEBHOOK_SECRET: "arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/stripe-webhook",
    MICROSOFT_CLIENT_ID: "arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/microsoft-client-id",
    GOOGLE_CLIENT_ID: "arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/google-client-id",
    GOOGLE_CLIENT_SECRET: "arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/google-client-secret",
  },
};

const withEnv = (patch) => ({ ...bindings, env: { ...bindings.env, ...patch } });
const withSecrets = (patch) => ({ ...bindings, secrets: { ...bindings.secrets, ...patch } });

test("renders the existing preview identity with the literal clone database", () => {
  const plan = renderOnboardPreviewPlan(bindings);
  const container = plan.taskDefinition.containerDefinitions[0];
  assert.equal(plan.taskDefinition.family, "capiro-preview-onboard-api");
  assert.equal(plan.taskDefinition.cpu, "512");
  assert.equal(plan.taskDefinition.memory, "1024");
  assert.equal(plan.taskDefinition.runtimePlatform.cpuArchitecture, "ARM64");
  assert.deepEqual(container.command, ["serve"]);
  assert.equal(container.portMappings[0].containerPort, 4400);
  assert.equal(container.image.endsWith(`@${bindings.imageDigest}`), true);
  const host = container.environment.find((item) => item.name === "DB_HOST");
  assert.equal(host.value, bindings.cloneDbHost);
  assert.equal(container.environment.some((item) => item.name === "DATABASE_URL"), false);
  assert.equal(container.secrets.some((item) => item.name === "DB_HOST"), false);
  assert.equal(container.environment.find((item) => item.name === "ONBOARD_FUNNEL_ENABLED").value, "false");
  assert.equal(container.environment.find((item) => item.name === "ONBOARD_EMAIL_ENABLED").value, "false");
  assert.equal(plan.service.cluster, "capiro-dev");
  assert.equal(plan.service.serviceName, "capiro-preview-onboard-api");
  assert.equal(plan.service.networkConfiguration.awsvpcConfiguration.assignPublicIp, "DISABLED");
  assert.deepEqual(plan.service.loadBalancers, [
    {
      targetGroupArn: bindings.targetGroupArn,
      containerName: "onboard-api",
      containerPort: 4400,
    },
  ]);
  assert.equal(plan.service.desiredCount, 1);
});

test("output is deterministic and never carries a secret value", () => {
  const first = JSON.stringify(renderOnboardPreviewPlan(bindings));
  const second = JSON.stringify(renderOnboardPreviewPlan({ ...bindings }));
  assert.equal(first, second);
  const container = JSON.parse(first).taskDefinition.containerDefinitions[0];
  for (const item of container.secrets)
    assert.match(item.valueFrom, /^arn:aws:secretsmanager:us-east-1:967807252336:secret:[A-Za-z0-9/_-]+$/);
  assert.doesNotMatch(first, /SecretString|GetSecretValue|password=/);
});

test("rejects a non-clone or secret-referenced database owner", () => {
  for (const cloneDbHost of [
    "capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv.cluster-csryw28ai752.us-east-1.rds.amazonaws.com",
    "arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/aurora/master-P4z1Vo",
    "localhost",
  ])
    assert.throws(() => renderOnboardPreviewPlan({ ...bindings, cloneDbHost }), /ONBOARD_PREVIEW_PLAN_INVALID:clone-db-host/);
});

test("rejects any command other than serve and any delivery or provider activation", () => {
  for (const patch of [
    { ONBOARD_FUNNEL_ENABLED: "true" },
    { ONBOARD_EMAIL_ENABLED: "true" },
  ])
    assert.throws(() => renderOnboardPreviewPlan(withEnv(patch)), /ONBOARD_PREVIEW_PLAN_INVALID:(funnel|email)-hold/);
  assert.throws(
    () => renderOnboardPreviewPlan({ ...bindings, command: ["migrate"] }),
    /ONBOARD_PREVIEW_PLAN_INVALID/,
  );
  assert.throws(
    () => renderOnboardPreviewPlan(withSecrets({ DB_HOST: bindings.secrets.DB_USER })),
    /ONBOARD_PREVIEW_PLAN_INVALID:secret-key:DB_HOST/,
  );
  assert.throws(
    () => renderOnboardPreviewPlan(withEnv({ DATABASE_URL: "postgres://legacy" })),
    /ONBOARD_PREVIEW_PLAN_INVALID:env-key:DATABASE_URL/,
  );
});

test("rejects a foreign image, wrong target group and open networking", () => {
  assert.throws(
    () => renderOnboardPreviewPlan({ ...bindings, image: bindings.image.replace("preview-onboard-api", "preview-core") }),
    /ONBOARD_PREVIEW_PLAN_INVALID:image-repository/,
  );
  assert.throws(
    () => renderOnboardPreviewPlan({ ...bindings, imageDigest: "sha256:abc" }),
    /ONBOARD_PREVIEW_PLAN_INVALID:image-digest/,
  );
  assert.throws(
    () => renderOnboardPreviewPlan({ ...bindings, targetGroupArn: bindings.targetGroupArn.replace("capiro-preview-onboard-api", "other") }),
    /ONBOARD_PREVIEW_PLAN_INVALID:target-group/,
  );
  assert.throws(
    () => renderOnboardPreviewPlan({ ...bindings, subnets: [bindings.subnets[0]] }),
    /ONBOARD_PREVIEW_PLAN_INVALID:subnets/,
  );
});
