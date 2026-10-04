import { resolveCase12SetupRecipe } from "./case12-memory-setup.mjs";
import { createCase12MemoryEligibilityOwner } from "./case12-memory-eligibility-owner.mjs";
import { expectedMemoryCandidatePayload } from "./memory-candidate-owner.mjs";
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from "./contract.mjs";
import { sha256Stable, stableJson } from "../lib/stable.mjs";

const SLOT = "case12MemorySetup";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const VERSION = /^[0-9]{1,10}$/u;
const fail = (code) => {
  throw new Error(`CASE12_CURRENT_${code}`);
};
const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isUuid = (v) => typeof v === "string" && UUID.test(v);
const isHash = (v) => typeof v === "string" && HASH.test(v);
const isVersion = (v) =>
  typeof v === "string" && VERSION.test(v) && Number(v) <= 0xffffffff;
const timestamp = (value) => {
  if (!(value instanceof Date) && typeof value !== "string")
    fail("CURRENT_TIMESTAMP_INVALID");
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("CURRENT_TIMESTAMP_INVALID");
  return date.toISOString();
};
const hasExactKeys = (v, keys) =>
  isObject(v) && Object.keys(v).sort().join("|") === [...keys].sort().join("|");

function requireComposition(deps) {
  if (
    typeof deps?.assertSyntheticApprovedMemoryInTx !== "function" ||
    typeof deps?.memoryAuthorization?.loadItemInTx !== "function" ||
    typeof deps?.memoryAuthorization?.evaluateInTx !== "function" ||
    typeof deps?.readCase12CanonicalEligibilityInTx !== "function" ||
    typeof deps?.clientMemoryAllowed !== "function"
  )
    fail("NATIVE_SOURCE_COMPOSITION_REQUIRED");
}

function validateClaim(operation, spec) {
  const definitions = spec.definitions;
  const definitionHash = sha256Stable(definitions.map((d) => d.candidate));
  if (
    !isObject(operation) ||
    operation.kind !== "meri-case12-memory-setup-claim" ||
    operation.schemaVersion !== 1 ||
    operation.status !== "SETUP_COMPLETE" ||
    operation.liveAcceptance !== "NOT_RUN" ||
    operation.fixtureInstanceId !== spec.input.fixtureInstanceId ||
    !hasExactKeys(operation.locator, Object.keys(spec.input)) ||
    sha256Stable(operation.locator) !== sha256Stable(spec.input) ||
    operation.recipeSha256 !== sha256Stable(spec.input) ||
    operation.manifestContentSha256 !== spec.manifest.contentSha256 ||
    operation.orderedDefinitionSha256 !== definitionHash ||
    !isHash(operation.planSha256) ||
    !isObject(operation.plan)
  )
    fail("CLAIM_IDENTITY_INVALID");

  const { planSha256, ...planBody } = operation.plan;
  if (
    typeof planSha256 !== "string" ||
    planSha256 !== operation.planSha256 ||
    sha256Stable(planBody) !== planSha256 ||
    planBody.recipeSha256 !== operation.recipeSha256 ||
    planBody.manifestContentSha256 !== operation.manifestContentSha256 ||
    planBody.orderedDefinitionSha256 !== definitionHash ||
    planBody.exactCanonicalDefinitionCount !== 510 ||
    planBody.firstLogicalId !== "MA510" ||
    planBody.fixtureNamespace !== FIXTURE_NAMESPACE ||
    planBody.fixtureInstanceId !== spec.input.fixtureInstanceId ||
    planBody.tenantId !== spec.input.ctx.tenantId ||
    !isHash(planBody.priorSettingsSha256) ||
    !isVersion(planBody.tenantRowVersion) ||
    !isObject(planBody.actorScope) ||
    planBody.actorScope.proposerUserId !== spec.input.ctx.userId ||
    planBody.actorScope.proposerRole !== "standard_user" ||
    planBody.actorScope.clerkUserId !== spec.input.clerkUserId ||
    planBody.actorScope.reviewerUserId !== spec.input.reviewerUserId ||
    planBody.actorScope.reviewerRole !== "user_admin" ||
    planBody.actorScope.clientId !== spec.manifest.clients.ASTER.physicalId
  )
    fail("PLAN_BINDING_INVALID");

  const claimIdentity = sha256Stable({
    planSha256: operation.planSha256,
    recipeSha256: operation.recipeSha256,
  });
  if (
    !isHash(operation.claimIdentitySha256) ||
    operation.claimIdentitySha256 !== claimIdentity ||
    !Array.isArray(operation.progress) ||
    operation.progress.length !== 510 ||
    !isHash(operation.progressSha256) ||
    operation.progressSha256 !== sha256Stable(operation.progress)
  )
    fail("CLAIM_PROGRESS_INVALID");

  const bindings = [];
  for (let index = 0; index < 510; index++) {
    const step = operation.progress[index];
    const definition = definitions[index];
    const candidate = definition?.candidate;
    const logicalId =
      index === 0
        ? "MA510"
        : `MA510-DISTRACTOR-${String(index).padStart(4, "0")}`;
    const b = step?.binding;
    if (
      !isObject(step) ||
      step.index !== index ||
      step.logicalId !== logicalId ||
      step.phase !== "VERIFIED" ||
      step.candidateId !== candidate?.physicalId ||
      !isObject(b) ||
      !isHash(step.bindingSha256) ||
      step.bindingSha256 !== sha256Stable(b) ||
      b.logicalId !== logicalId ||
      b.supporting !== definition.supporting ||
      b.owner !== "memory_item" ||
      b.tenantId !== candidate.tenantId ||
      b.clientId !== candidate.clientPhysicalId ||
      !isUuid(b.physicalId) ||
      b.proposedItemId !== definition.proposedItemId ||
      b.candidateId !== candidate.physicalId ||
      b.ownershipMarkerSha256 !== candidate.ownership.markerSha256 ||
      b.candidatePayloadSha256 !== candidate.payloadSha256 ||
      b.lifecycle !== "approved"
    )
      fail("CLAIM_SAVED_BINDING_INVALID");
    bindings.push({ definition, savedPhysicalId: b.physicalId });
  }
  return { claimIdentitySha256: claimIdentity, bindings };
}

async function readCurrentScope(tx, deps, spec, tenant) {
  const { input, manifest } = spec;
  const fixture = tenant.settings.meriFoundationFixture;

  const users = await tx.$queryRawUnsafe(
    `SELECT u.id::text,u.clerk_user_id,u.email,u.first_name,u.last_name,tm.role
     FROM users u JOIN tenant_memberships tm ON tm.user_id=u.id
     WHERE tm.tenant_id=$1::uuid AND tm.user_id=ANY($2::uuid[]) AND tm.status='active'
     ORDER BY u.id FOR SHARE OF u,tm`,
    input.ctx.tenantId,
    [input.ctx.userId, input.reviewerUserId],
  );
  const pat = users.find((row) => row.id === input.ctx.userId);
  const priya = users.find((row) => row.id === input.reviewerUserId);
  const syntheticIdentity = (row) =>
    typeof row?.email === "string" &&
    row.email.toLowerCase().includes(FIXTURE_NAMESPACE) &&
    row.email.toLowerCase().endsWith("@example.com") &&
    /synthetic/iu.test(`${row.first_name ?? ""} ${row.last_name ?? ""}`);
  if (
    users.length !== 2 ||
    !pat ||
    !priya ||
    pat.role !== "standard_user" ||
    priya.role !== "user_admin" ||
    pat.clerk_user_id !== input.clerkUserId ||
    typeof pat.clerk_user_id !== "string" ||
    !/^user_[A-Za-z0-9_-]+$/u.test(pat.clerk_user_id) ||
    typeof priya.clerk_user_id !== "string" ||
    !/^user_[A-Za-z0-9_-]+$/u.test(priya.clerk_user_id) ||
    !syntheticIdentity(pat) ||
    !syntheticIdentity(priya) ||
    (manifest.actors.PRIYA.clerkUserId !== undefined &&
      priya.clerk_user_id !== manifest.actors.PRIYA.clerkUserId)
  )
    fail("ACTOR_MEMBERSHIP_INVALID");

  const clientId = manifest.clients.ASTER.physicalId;
  const clients = await tx.$queryRawUnsafe(
    "SELECT id::text,status,memory_wall FROM clients WHERE id=$1::uuid AND tenant_id=$2::uuid FOR SHARE",
    clientId,
    input.ctx.tenantId,
  );
  if (
    clients.length !== 1 ||
    clients[0].status === "archived" ||
    !(await deps.clientMemoryAllowed(
      tx,
      input.ctx.tenantId,
      input.ctx.userId,
      clientId,
    ))
  )
    fail("CURRENT_CLIENT_WALL_DENIED");
  return { tenant, fixture, clientId };
}

export function createCase12CurrentMemoryOwner(suppliedDeps) {
  // Hard prerequisite fence: these function checks run before any tx/DB access.
  requireComposition(suppliedDeps);
  // Capture exact native methods once; mutable dependency objects do not swap authority mid-read.
  const setGuard = suppliedDeps.assertSyntheticApprovedMemorySetInTx;
  const setAuth = suppliedDeps.memoryAuthorization.readCase12ItemsWithDecisionsInTx;
  if ((typeof setGuard === 'function') !== (typeof setAuth === 'function')) fail("NATIVE_SET_PORTS_INCOMPLETE");
  const deps = Object.freeze({
    assertSyntheticApprovedMemorySetInTx: typeof setGuard === 'function' ? setGuard.bind(suppliedDeps) : undefined,
    assertSyntheticApprovedMemoryInTx:
      suppliedDeps.assertSyntheticApprovedMemoryInTx.bind(suppliedDeps),
    readCase12CanonicalEligibilityInTx:
      suppliedDeps.readCase12CanonicalEligibilityInTx.bind(suppliedDeps),
    clientMemoryAllowed: suppliedDeps.clientMemoryAllowed.bind(suppliedDeps),
    memoryAuthorization: Object.freeze({
      readCase12ItemsWithDecisionsInTx: typeof setAuth === 'function' ? setAuth.bind(suppliedDeps.memoryAuthorization) : undefined,
      loadItemInTx: suppliedDeps.memoryAuthorization.loadItemInTx.bind(
        suppliedDeps.memoryAuthorization,
      ),
      evaluateInTx: suppliedDeps.memoryAuthorization.evaluateInTx.bind(
        suppliedDeps.memoryAuthorization,
      ),
    }),
  });

  return Object.freeze({
    async inspectInTx(tx, suppliedCtx, suppliedScope) {
      const ctx = structuredClone(suppliedCtx),
        scope = structuredClone(suppliedScope);
      if (!tx || typeof tx.$queryRawUnsafe !== "function")
        fail("TRANSACTION_REQUIRED");
      if (
        !hasExactKeys(scope, ["caseId", "clientId"]) ||
        scope.caseId !== "12" ||
        !isUuid(scope.clientId)
      )
        fail("SCOPE_INVALID");
      if (
        !isObject(ctx) ||
        !isUuid(ctx.tenantId) ||
        !isUuid(ctx.userId) ||
        ctx.role !== "standard_user" ||
        ctx.tenantId !== AUTHORIZED_TENANTS.T1.id ||
        ctx.tenantSlug !== AUTHORIZED_TENANTS.T1.slug
      )
        fail("ORDINARY_ACTOR_SCOPE_INVALID");

      const tenants = await tx.$queryRawUnsafe(
        "SELECT id::text,slug,settings_jsonb AS settings,xmin::text AS version FROM tenants WHERE id=$1::uuid FOR UPDATE",
        ctx.tenantId,
      );
      const tenant = tenants[0],
        fixture = tenant?.settings?.meriFoundationFixture;
      if (
        tenants.length !== 1 ||
        tenant.id !== ctx.tenantId ||
        tenant.slug !== ctx.tenantSlug ||
        fixture?.fixtureNamespace !== FIXTURE_NAMESPACE ||
        !isObject(fixture[SLOT])
      )
        fail("TENANT_OR_CLAIM_LOCATOR_INVALID");
      const recipeLocator = structuredClone(fixture[SLOT].locator);
      if (
        !isObject(recipeLocator) ||
        !isUuid(recipeLocator.fixtureInstanceId) ||
        !isUuid(recipeLocator.ctx?.userId) ||
        !isUuid(recipeLocator.reviewerUserId) ||
        ![
          recipeLocator.clients?.ASTER?.physicalId,
          recipeLocator.clients?.BLUEHAVEN?.physicalId,
        ].every(isUuid)
      )
        fail("SETUP_RECIPE_LOCATOR_INVALID");
      const spec = await resolveCase12SetupRecipe(recipeLocator);
      if (
        ctx.tenantId !== spec.input.ctx.tenantId ||
        ctx.userId !== spec.input.ctx.userId ||
        ctx.role !== spec.input.ctx.role ||
        scope.clientId !== spec.manifest.clients.ASTER.physicalId
      )
        fail("CALLER_RECIPE_SCOPE_MISMATCH");
      const current = await readCurrentScope(tx, deps, spec, tenant);
      const claim = current.fixture[SLOT];
      const { claimIdentitySha256, bindings: claimBindings } = validateClaim(
        claim,
        spec,
      );

      const currentBindings = [];
      const candidateIds = new Set();
      const itemIds = new Set();
      let bulkCanonical = null;
      if (deps.assertSyntheticApprovedMemorySetInTx) {
        const rows = await tx.$queryRawUnsafe(`SELECT c.id::text AS candidate_id,c.source_id,c.payload_jsonb->>'key' AS candidate_key,
                  c.proposed_by::text AS proposer,c.client_id::text AS candidate_client,c.status,
                  c.approved_by_user_id::text AS reviewer,c.committed_memory_item_id::text AS item_id,
                  c.xmin::text AS candidate_version,m.id::text AS actual_item_id,
                  m.tenant_id::text AS tenant_id,m.client_id::text AS item_client_id,
                  m.xmin::text AS item_version,m.status AS item_status,m.source_version,m.source_content_hash,
                  c.approved_at AS candidate_approved_at,m.approved_at,m.as_of,m.effective_from,m.valid_until,m.expires_at
           FROM memory_candidate c JOIN memory_items m
             ON m.tenant_id=c.tenant_id AND m.id=c.committed_memory_item_id
           WHERE c.tenant_id=$1::uuid AND c.id=ANY($2::uuid[]) FOR UPDATE OF c,m`,
          spec.input.ctx.tenantId,claimBindings.map(x=>x.definition.candidate.physicalId));
        bulkCanonical = new Map(rows.map(row=>[row.candidate_id,row]));
        if (rows.length !== 510 || bulkCanonical.size !== 510 ||
            claimBindings.some(x=>!bulkCanonical.has(x.definition.candidate.physicalId))) fail("CURRENT_CANONICAL_JOIN_MISSING");
      }
      for (const { definition, savedPhysicalId } of claimBindings) {
        const candidate = definition.candidate;
        const rows = bulkCanonical ? [bulkCanonical.get(candidate.physicalId)] : await tx.$queryRawUnsafe(
          `SELECT c.id::text AS candidate_id,c.source_id,c.payload_jsonb->>'key' AS candidate_key,
                  c.proposed_by::text AS proposer,c.client_id::text AS candidate_client,c.status,
                  c.approved_by_user_id::text AS reviewer,c.committed_memory_item_id::text AS item_id,
                  c.xmin::text AS candidate_version,m.id::text AS actual_item_id,
                  m.tenant_id::text AS tenant_id,m.client_id::text AS item_client_id,
                  m.xmin::text AS item_version,m.status AS item_status,m.source_version,m.source_content_hash,
                  c.approved_at AS candidate_approved_at,m.approved_at,m.as_of,m.effective_from,m.valid_until,m.expires_at
           FROM memory_candidate c JOIN memory_items m
             ON m.tenant_id=c.tenant_id AND m.id=c.committed_memory_item_id
           WHERE c.tenant_id=$1::uuid AND c.id=$2::uuid FOR UPDATE OF c,m`,
          spec.input.ctx.tenantId,
          candidate.physicalId,
        );
        if (rows.length !== 1) fail("CURRENT_CANONICAL_JOIN_MISSING");
        const row = rows[0];
        const payload = expectedMemoryCandidatePayload(
          candidate,
          spec.input.ctx.userId,
          stableJson({
            ownership: candidate.ownership,
            payload: candidate.payload,
          }),
        );
        if (
          row.candidate_id !== candidate.physicalId ||
          row.source_id !== candidate.ownership.markerSha256 ||
          row.candidate_key !== payload.key ||
          row.proposer !== spec.input.ctx.userId ||
          row.candidate_client !== scope.clientId ||
          row.status !== "approved" ||
          row.reviewer !== spec.input.reviewerUserId ||
          row.item_id !== savedPhysicalId ||
          row.actual_item_id !== savedPhysicalId ||
          row.tenant_id !== spec.input.ctx.tenantId ||
          row.item_client_id !== scope.clientId ||
          row.item_status !== "active" ||
          row.source_version !== `candidate:${candidate.physicalId}` ||
          !isHash(row.source_content_hash) ||
          !isVersion(row.candidate_version) ||
          !isVersion(row.item_version)
        )
          fail("CURRENT_CANONICAL_BINDING_CHANGED");
        if (
          candidateIds.has(row.candidate_id) ||
          itemIds.has(row.actual_item_id)
        )
          fail("DUPLICATE_CURRENT_BINDING");
        candidateIds.add(row.candidate_id);
        itemIds.add(row.actual_item_id);
        const candidateApprovedAt = timestamp(row.candidate_approved_at);
        const approvedAt = timestamp(row.approved_at),
          asOf = timestamp(row.as_of),
          effectiveFrom = timestamp(row.effective_from);
        // Observe native times; this module never writes or rewinds them.
        if (
          Date.parse(candidateApprovedAt) < Date.parse(approvedAt) ||
          asOf !== approvedAt ||
          effectiveFrom !== approvedAt
        )
          fail("NATIVE_APPROVAL_TIMES_DIVERGED");
        currentBindings.push({
          logicalId: definition.logicalId,
          supporting: definition.supporting,
          owner: "memory_item",
          tenantId: row.tenant_id,
          clientId: row.item_client_id,
          physicalId: row.actual_item_id,
          proposedItemId: definition.proposedItemId,
          candidateId: row.candidate_id,
          ownershipMarkerSha256: candidate.ownership.markerSha256,
          candidatePayloadSha256: candidate.payloadSha256,
          candidateRowVersion: row.candidate_version,
          itemRowVersion: row.item_version,
          sourceVersion: row.source_version,
          contentSha256: row.source_content_hash,
          lifecycle: "approved",
          candidateApprovedAt,
          approvedAt,
          asOf,
          effectiveFrom,
          validUntil:
            row.valid_until === null ? null : timestamp(row.valid_until),
          expiresAt: row.expires_at === null ? null : timestamp(row.expires_at),
        });
      }
      if (
        currentBindings.length !== 510 ||
        currentBindings[0].logicalId !== "MA510"
      )
        fail("CURRENT_510_BINDINGS_REQUIRED");

      // These are locally rebuilt from current rows. Versions are current guard inputs only.
      const seedInventory = {
        kind: "meri-approved-memory-local-bindings",
        fixtureMapSha256: spec.manifest.contentSha256,
        bindings: currentBindings.map(
          ({
            sourceVersion,
            contentSha256,
            candidateApprovedAt,
            approvedAt,
            asOf,
            effectiveFrom,
            validUntil,
            expiresAt,
            ...binding
          }) => binding,
        ),
        bindingsSha256: sha256Stable(
          currentBindings.map(
            ({
              sourceVersion,
              contentSha256,
              candidateApprovedAt,
              approvedAt,
              asOf,
              effectiveFrom,
              validUntil,
              expiresAt,
              ...binding
            }) => binding,
          ),
        ),
        liveAcceptance: "NOT_RUN",
      };
      const eligibilityOwner = createCase12MemoryEligibilityOwner({
        manifest: spec.manifest,
        seedInventory,
        proposerForTenant: (tenantId) =>
          tenantId === spec.input.ctx.tenantId
            ? spec.input.ctx.userId
            : fail("FOREIGN_TENANT"),
        assertSyntheticApprovedMemoryInTx:
          deps.assertSyntheticApprovedMemoryInTx,
        assertSyntheticApprovedMemorySetInTx: deps.assertSyntheticApprovedMemorySetInTx,
        memoryAuthorization: deps.memoryAuthorization,
        readCase12CanonicalEligibilityInTx:
          deps.readCase12CanonicalEligibilityInTx,
      });
      const inventory = await eligibilityOwner.inspectInTx(tx, ctx, {
        caseId: "12",
        clientId: scope.clientId,
      });
      if (
        inventory?.inventoryVerified !== true ||
        !Array.isArray(inventory.observations) ||
        inventory.observations.length !== 510 ||
        inventory.observations[0]?.logicalId !== "MA510" ||
        inventory.olderThan500CurrentEligibleRowsVerified !== true ||
        !Number.isInteger(inventory.newerCurrentEligibleRecordCount) ||
        inventory.newerCurrentEligibleRecordCount < 500 ||
        inventory.currentEligibility?.semanticClockQualified !== false ||
        !Array.isArray(inventory.currentEligibility?.observations)
      )
        fail("CURRENT_ELIGIBILITY_NOT_QUALIFIED");

      const inventoryById = new Map(
        inventory.observations.map((row) => [row.physicalId, row]),
      );
      if (inventoryById.size !== 510) fail("CURRENT_INVENTORY_DUPLICATE");
      const eligible = [...inventory.currentEligibility.observations].sort(
        (a, b) => a.physicalId.localeCompare(b.physicalId),
      );
      const eligibleById = new Map(
        eligible.map((row) => [row.physicalId, row]),
      );
      const target = currentBindings[0];
      if (
        !eligibleById.has(target.physicalId) ||
        eligible.some((row) => !inventoryById.has(row.physicalId)) ||
        eligible.filter((row) => row.newerThanTarget === true).length < 500
      )
        fail("CURRENT_ELIGIBLE_MEMBERSHIP_INVALID");

      const canonicalBindings = currentBindings.map((binding) => {
        const observed = inventoryById.get(binding.physicalId);
        const eligibleObservation =
          eligibleById.get(binding.physicalId) ?? null;
        return {
          logicalId: binding.logicalId,
          physicalId: binding.physicalId,
          candidateId: binding.candidateId,
          tenantId: binding.tenantId,
          clientId: binding.clientId,
          candidateRowVersion: binding.candidateRowVersion,
          itemRowVersion: binding.itemRowVersion,
          sourceVersion: binding.sourceVersion,
          contentSha256: binding.contentSha256,
          sectionsSha256: observed.sectionsSha256,
          candidateApprovedAt: binding.candidateApprovedAt,
          approvedAt: binding.approvedAt,
          asOf: binding.asOf,
          effectiveFrom: binding.effectiveFrom,
          validUntil: binding.validUntil,
          expiresAt: binding.expiresAt,
          ownershipMarkerSha256: binding.ownershipMarkerSha256,
          currentlyEligible: eligibleObservation !== null,
          newerThanTarget: eligibleObservation?.newerThanTarget === true,
        };
      });
      const currentVerify = {
        kind: "case12-current-memory-canonical-verification",
        fixtureNamespace: FIXTURE_NAMESPACE,
        fixtureVersion: spec.manifest.fixtureVersion,
        fixtureInstanceId: spec.input.fixtureInstanceId,
        caseId: "12",
        tenantId: spec.input.ctx.tenantId,
        actorUserId: spec.input.ctx.userId,
        clientId: scope.clientId,
        claimIdentitySha256,
        setupClaimSha256: sha256Stable(claim),
        setupPlanSha256: claim.planSha256,
        manifestContentSha256: spec.manifest.contentSha256,
        orderedDefinitionSha256: sha256Stable(
          spec.definitions.map((d) => d.candidate),
        ),
        target: {
          logicalId: "MA510",
          physicalId: target.physicalId,
          candidateId: target.candidateId,
          itemRowVersion: target.itemRowVersion,
          sourceVersion: target.sourceVersion,
          contentSha256: target.contentSha256,
        },
        inventoryCount: canonicalBindings.length,
        eligibleMemberIds: eligible.map((row) => row.physicalId),
        eligibleMemberCount: eligible.length,
        newerEligibleCount: inventory.newerCurrentEligibleRecordCount,
        observations: canonicalBindings,
      };
      const currentVerifySha256 = sha256Stable(currentVerify);
      const currentEligibilityObservation =
        inventory.currentEligibility.observation;
      const observedAt = Date.parse(
        currentEligibilityObservation.databaseObservedAt,
      );
      if (
        canonicalBindings
          .filter((row) => row.currentlyEligible)
          .some(
            (row) =>
              Date.parse(row.candidateApprovedAt) > observedAt ||
              Date.parse(row.approvedAt) > observedAt ||
              Date.parse(row.effectiveFrom) > observedAt ||
              (row.validUntil !== null &&
                Date.parse(row.validUntil) <= observedAt) ||
              (row.expiresAt !== null &&
                Date.parse(row.expiresAt) <= observedAt),
          )
      )
        fail("CURRENT_ELIGIBLE_TIMESTAMP_JOIN_INVALID");
      const currentInventorySourceSha256 = sha256Stable(inventory);
      const sourceMap = {
        MA510: {
          frozenFixtureId: "MA510",
          kind: "memory",
          physicalId: target.physicalId,
          tenantPhysicalId: target.tenantId,
          clientPhysicalId: target.clientId,
          version: target.sourceVersion,
          contentSha256: target.contentSha256,
        },
      };
      return {
        kind: "case12-current-memory-owner-evidence",
        fixtureNamespace: FIXTURE_NAMESPACE,
        fixtureVersion: spec.manifest.fixtureVersion,
        fixtureInstanceId: spec.input.fixtureInstanceId,
        caseId: "12",
        tenantId: spec.input.ctx.tenantId,
        actorUserId: spec.input.ctx.userId,
        clientId: scope.clientId,
        sourceMap,
        physicalMapSha256: sha256Stable(sourceMap),
        setupClaimSha256: sha256Stable(claim),
        setupPlanSha256: claim.planSha256,
        currentVerify,
        currentVerifySha256,
        currentEligibilityObservation,
        currentInventorySourceSha256,
        corpusQualified: true,
        semanticClockQualified: false,
        fixtureReady: false,
        captureAuthority: false,
        liveAcceptance: "NOT_RUN",
        missing: [
          "NATIVE_CASE12_CAPTURE_ADMISSION",
          "CASE12_SEMANTIC_CLOCK_SOURCE",
          "CASE12_CAPTURE_SEED_RESET_RECEIPT_JOINS",
        ],
      };
    },
  });
}
