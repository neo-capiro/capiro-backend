import assert from "node:assert/strict";
import test from "node:test";
import { renderOnboardPreviewPlan, renderServiceRequest } from "./onboard-preview-service-plan.mjs";

const PINNED_VERSION = "3f9c1d2e8a7b46c95d0e1f2a3b4c5d6e";

const bindings = {
  image: "967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-onboard-api",
  imageDigest: "sha256:1a66f9699168cb098bca2f74e94d7557854f5b1417fee7733cc4ccbe3e668ebd",
  source: "129156c8a71cae411d012eb5500c8fc587af1ea0",
  cloneDbHost: "capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com",
  dbName: "capiro",
  subnets: ["subnet-0a1b2c3d4e5f60718", "subnet-1a2b3c4d5e6f70819"],
  securityGroups: ["sg-0e742fb6a11314392"],
  executionRoleArn:
    "arn:aws:iam::967807252336:role/Capiro-dev-Compute-ApiTaskDefExecutionRoleE6ABB053-YlEDKuUPHjLg",
  taskRoleArn: "arn:aws:iam::967807252336:role/Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ",
  targetGroupArn:
    "arn:aws:elasticloadbalancing:us-east-1:967807252336:targetgroup/capiro-preview-onboard-api/e1ffa6a1394ba2ca",
  env: {
    AWS_REGION_DEFAULT: "us-east-1",
    BILLING_RETURN_URL: "https://app.capiro.ai",
    CAPIRO_ENV: "preview",
    CLERK_JWT_ISSUER: "https://clerk.app.capiro.ai",
    CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsuYXBwLmNhcGlyby5haSQ",
    ONBOARD_APP_BASE_URL: "https://app.capiro.ai",
    ONBOARD_APPS_API_BASE: "https://first-chat-preview.app-dev.capiro.ai",
    ONBOARD_API_PUBLIC_BASE_URL: "https://first-chat-preview.app-dev.capiro.ai",
    ONBOARD_BIND_HOST: "0.0.0.0",
    ONBOARD_CS_NOTIFY_EMAIL: "sales@capiro.ai",
    ONBOARD_EMAIL_ENABLED: "false",
    ONBOARD_EMAIL_FROM: "onboarding@capiro.ai",
    ONBOARD_FUNNEL_ENABLED: "false",
    ONBOARD_PORT: "4400",
    ONBOARD_PUBLIC_BASE_URL: "https://onboarding.capiro.ai",
    ONBOARD_WIRE_DUE_DAYS: "14",
  },
  secrets: {
    CLERK_SECRET_KEY: "arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/clerk/secret-key-FT67tM",
    DB_PASSWORD:
      "arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/aurora/app-zNPtsU:password::",
    DB_USER: "arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/aurora/app-zNPtsU:username::",
    INTERNAL_SERVICE_SECRET: `arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/internal-service-secret-6cEZG4:::${PINNED_VERSION}`,
  },
};

const taskDefinitionArn =
  "arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-preview-onboard-api:1";

const withEnv = (patch) => ({ ...bindings, env: { ...bindings.env, ...patch } });
const envWithout = (key) => {
  const env = { ...bindings.env };
  delete env[key];
  return { ...bindings, env };
};
const withSecrets = (patch) => ({ ...bindings, secrets: { ...bindings.secrets, ...patch } });

test("renders every field the serve entrypoint requires", () => {
  const request = renderOnboardPreviewPlan(bindings).registerTaskDefinition.request;
  const container = request.containerDefinitions[0];
  const env = Object.fromEntries(container.environment.map((item) => [item.name, item.value]));

  assert.equal(env.DB_HOST, bindings.cloneDbHost);
  assert.equal(env.DB_PORT, "5432");
  assert.equal(env.DB_NAME, "capiro");
  assert.equal(env.RELEASE_SHA, bindings.source);
  assert.equal(env.AWS_REGION_DEFAULT, "us-east-1");
  assert.equal(env.ONBOARD_PORT, "4400");
  // DATABASE_URL is composed by the entrypoint from the DB_* fields.
  assert.equal("DATABASE_URL" in env, false);
  assert.deepEqual(container.command, ["serve"]);
  assert.equal(container.portMappings[0].containerPort, 4400);
  assert.equal(container.environment.filter((item) => item.name.startsWith("DB_")).length, 3);
  // The entrypoint's requirement is the DB_* set plus DB_NAME, all four present exactly once.
  for (const name of ["DB_HOST", "DB_PORT", "DB_NAME", "RELEASE_SHA"])
    assert.equal(container.environment.filter((item) => item.name === name).length, 1, name);
});

test("preserves the real reference syntax including selectors and the pinned version", () => {
  const request = renderOnboardPreviewPlan(bindings).registerTaskDefinition.request;
  const secrets = Object.fromEntries(
    request.containerDefinitions[0].secrets.map((item) => [item.name, item.valueFrom]),
  );
  assert.equal(secrets.DB_USER, bindings.secrets.DB_USER);
  assert.match(secrets.DB_USER, /:username::$/);
  assert.equal(secrets.DB_PASSWORD, bindings.secrets.DB_PASSWORD);
  assert.match(secrets.DB_PASSWORD, /:password::$/);
  assert.equal(secrets.INTERNAL_SERVICE_SECRET, bindings.secrets.INTERNAL_SERVICE_SECRET);
  assert.ok(secrets.INTERNAL_SERVICE_SECRET.endsWith(`:::${PINNED_VERSION}`));
  assert.deepEqual(Object.keys(secrets).sort(), [
    "CLERK_SECRET_KEY",
    "DB_PASSWORD",
    "DB_USER",
    "INTERNAL_SERVICE_SECRET",
  ]);

  // A stripped selector, an unpinned internal secret and the admin credential are refused.
  for (const patch of [
    {
      DB_USER:
        "arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/aurora/app-zNPtsU",
    },
    {
      DB_PASSWORD:
        "arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/aurora/app-zNPtsU:username::",
    },
    {
      INTERNAL_SERVICE_SECRET:
        "arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/internal-service-secret-6cEZG4",
    },
    {
      DB_PASSWORD:
        "arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/aurora/master-P4z1Vo:password::",
    },
  ])
    assert.throws(
      () => renderOnboardPreviewPlan(withSecrets(patch)),
      /ONBOARD_PREVIEW_PLAN_INVALID:(db-user-selector|db-password-selector|internal-version-pin|admin-credential:DB_PASSWORD)/,
    );
});

test("omits held provider credentials instead of requiring them", () => {
  const request = renderOnboardPreviewPlan(bindings).registerTaskDefinition.request;
  const names = request.containerDefinitions[0].secrets.map((item) => item.name);
  const envNames = request.containerDefinitions[0].environment.map((item) => item.name);
  for (const held of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "OAUTH_STATE_SECRET", "MICROSOFT_CLIENT_ID", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
    assert.equal(names.includes(held), false, held);
    assert.throws(
      () =>
        renderOnboardPreviewPlan(
          withSecrets({ [held]: "arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/held" }),
        ),
      /ONBOARD_PREVIEW_PLAN_INVALID:provider-credential-held:/,
    );
  }
  for (const held of ["STRIPE_PRICE_SLOTS", "STRIPE_PRICE_OVERAGE", "STRIPE_OVERAGE_METER_EVENT", "STRIPE_PUBLISHABLE_KEY"]) {
    assert.equal(envNames.includes(held), false, held);
    assert.throws(
      () => renderOnboardPreviewPlan(withEnv({ [held]: "price_x" })),
      /ONBOARD_PREVIEW_PLAN_INVALID:provider-config-held:/,
    );
  }
  // The identity keys stay required, must be a real publishable-key shape and never a secret key.
  assert.throws(
    () => renderOnboardPreviewPlan(withEnv({ CLERK_PUBLISHABLE_KEY: "sk_live_not_a_publishable_key" })),
    /ONBOARD_PREVIEW_PLAN_INVALID:clerk-publishable-key/,
  );
  assert.throws(
    () => renderOnboardPreviewPlan(withEnv({ CLERK_PUBLISHABLE_KEY: "pk_test" })),
    /ONBOARD_PREVIEW_PLAN_INVALID:clerk-publishable-key/,
  );
  assert.throws(
    () => renderOnboardPreviewPlan(envWithout("CLERK_PUBLISHABLE_KEY")),
    /ONBOARD_PREVIEW_PLAN_INVALID:env-missing:CLERK_PUBLISHABLE_KEY/,
  );
});

test("keeps the canonical operational shape", () => {
  const plan = renderOnboardPreviewPlan(bindings);
  const request = plan.registerTaskDefinition.request;
  const container = request.containerDefinitions[0];

  assert.equal(container.logConfiguration.options["awslogs-group"], "/capiro/dev/onboard-api");
  assert.equal(container.logConfiguration.options["awslogs-stream-prefix"], "onboard-api");
  assert.deepEqual(container.healthCheck, {
    command: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:4400/health || exit 1"],
    interval: 30,
    timeout: 5,
    retries: 3,
    startPeriod: 30,
  });
  assert.equal(request.runtimePlatform.cpuArchitecture, "ARM64");
  assert.equal(request.networkMode, "awsvpc");
  assert.equal(request.executionRoleArn, bindings.executionRoleArn);
  assert.equal(request.taskRoleArn, bindings.taskRoleArn);
  assert.equal(plan.registration.executable, false);

  const update = renderServiceRequest(bindings, { taskDefinitionArn, mode: "update" }).request;
  assert.equal(update.deploymentConfiguration.minimumHealthyPercent, 100);
  assert.deepEqual(update.deploymentConfiguration.deploymentCircuitBreaker, { enable: true, rollback: true });
  assert.equal(update.networkConfiguration.awsvpcConfiguration.assignPublicIp, "DISABLED");
  assert.deepEqual(update.networkConfiguration.awsvpcConfiguration.securityGroups, bindings.securityGroups);
  assert.equal(update.healthCheckGracePeriodSeconds, 60);
});

test("stages registration, create and update separately", () => {
  const plan = renderOnboardPreviewPlan(bindings);
  assert.deepEqual(plan.registration.blockedOn, "taskDefinitionArn");
  assert.equal(plan.createService.executable, false);
  assert.equal(plan.updateService.executable, false);
  // The pending field sets are visible but carry no fabricated task-definition ARN.
  assert.equal(plan.createService.request.taskDefinition, null);
  assert.equal(plan.updateService.request.taskDefinition, null);
  assert.equal("serviceName" in plan.createService.request, true);
  assert.equal("service" in plan.createService.request, false);
  assert.equal("service" in plan.updateService.request, true);
  assert.equal("serviceName" in plan.updateService.request, false);

  const create = renderServiceRequest(bindings, { taskDefinitionArn, mode: "create" });
  const update = renderServiceRequest(bindings, { taskDefinitionArn, mode: "update" });
  assert.equal(create.executable, true);
  assert.equal(update.executable, true);
  // CreateService identifies the new service by serviceName and takes no `service`.
  assert.equal(create.request.serviceName, "capiro-preview-onboard-api");
  assert.equal("service" in create.request, false);
  for (const field of ["serviceName", "launchType", "platformVersion", "schedulingStrategy", "propagateTags"])
    assert.ok(field in create.request, field);
  // UpdateService identifies the existing service by `service` and takes no create-only field.
  assert.equal(update.request.service, "capiro-preview-onboard-api");
  for (const field of ["serviceName", "launchType", "schedulingStrategy"])
    assert.equal(field in update.request, false, field);
  // UpdateService does accept platformVersion/propagateTags/enableExecuteCommand, but this
  // request deliberately omits them so an apply cannot change them as a side effect.
  for (const field of ["platformVersion", "propagateTags", "enableExecuteCommand", "tags"])
    assert.equal(field in update.request, false, field);
  assert.equal(create.request.taskDefinition, taskDefinitionArn);
  assert.equal(update.request.taskDefinition, taskDefinitionArn);

  // A placeholder, a zero revision or an unfilled mode is never rendered into a request.
  assert.throws(
    () =>
      renderServiceRequest(bindings, {
        taskDefinitionArn: "arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-preview-onboard-api:<registered-revision>",
        mode: "create",
      }),
    /ONBOARD_PREVIEW_PLAN_INVALID:task-definition-arn:create/,
  );
  assert.throws(
    () =>
      renderServiceRequest(bindings, {
        taskDefinitionArn: "arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-preview-onboard-api:0",
        mode: "update",
      }),
    /ONBOARD_PREVIEW_PLAN_INVALID:task-definition-arn:update/,
  );
  assert.throws(() => renderServiceRequest(bindings, { taskDefinitionArn }), /ONBOARD_PREVIEW_PLAN_INVALID:service-mode/);
});

test("output is deterministic and carries no secret value", () => {
  const first = JSON.stringify(renderOnboardPreviewPlan(bindings));
  const second = JSON.stringify(renderOnboardPreviewPlan({ ...bindings }));
  assert.equal(first, second);
  assert.doesNotMatch(first, /SecretString|GetSecretValue|password=/);
});

test("rejects a non-clone or secret-referenced database owner", () => {
  for (const cloneDbHost of [
    "capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv.cluster-csryw28ai752.us-east-1.rds.amazonaws.com",
    "arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/aurora/master-P4z1Vo:host::",
    "localhost",
  ])
    assert.throws(
      () => renderOnboardPreviewPlan({ ...bindings, cloneDbHost }),
      /ONBOARD_PREVIEW_PLAN_INVALID:clone-db-host/,
    );
});

test("rejects any command, DATABASE_URL or delivery activation", () => {
  for (const patch of [{ ONBOARD_FUNNEL_ENABLED: "true" }, { ONBOARD_EMAIL_ENABLED: "true" }])
    assert.throws(
      () => renderOnboardPreviewPlan(withEnv(patch)),
      /ONBOARD_PREVIEW_PLAN_INVALID:(funnel|email)-hold/,
    );
  assert.throws(
    () => renderOnboardPreviewPlan({ ...bindings, command: ["migrate"] }),
    /ONBOARD_PREVIEW_PLAN_INVALID:binding-key:command/,
  );
  assert.throws(
    () => renderOnboardPreviewPlan(withSecrets({ DB_HOST: bindings.secrets.DB_USER })),
    /ONBOARD_PREVIEW_PLAN_INVALID:secret-key:DB_HOST/,
  );
  assert.throws(
    () => renderOnboardPreviewPlan(withEnv({ DATABASE_URL: "postgres://legacy" })),
    /ONBOARD_PREVIEW_PLAN_INVALID:env-key:DATABASE_URL/,
  );
  assert.throws(
    () => renderOnboardPreviewPlan(envWithout("ONBOARD_PORT")),
    /ONBOARD_PREVIEW_PLAN_INVALID:env-missing:ONBOARD_PORT/,
  );
});

test("rejects a foreign image, wrong target group and open networking", () => {
  assert.throws(
    () =>
      renderOnboardPreviewPlan({
        ...bindings,
        image: bindings.image.replace("preview-onboard-api", "preview-core"),
      }),
    /ONBOARD_PREVIEW_PLAN_INVALID:image-repository/,
  );
  assert.throws(
    () => renderOnboardPreviewPlan({ ...bindings, imageDigest: "sha256:abc" }),
    /ONBOARD_PREVIEW_PLAN_INVALID:image-digest/,
  );
  assert.throws(
    () =>
      renderOnboardPreviewPlan({
        ...bindings,
        targetGroupArn: bindings.targetGroupArn.replace("capiro-preview-onboard-api", "other"),
      }),
    /ONBOARD_PREVIEW_PLAN_INVALID:target-group/,
  );
  assert.throws(
    () => renderOnboardPreviewPlan({ ...bindings, subnets: [bindings.subnets[0]] }),
    /ONBOARD_PREVIEW_PLAN_INVALID:subnets/,
  );
  assert.throws(
    () => renderOnboardPreviewPlan({ ...bindings, executionRoleArn: bindings.taskRoleArn.replace(":role/", ":user/") }),
    /ONBOARD_PREVIEW_PLAN_INVALID:executionRoleArn/,
  );
});
