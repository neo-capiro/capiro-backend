# Meeting Notetaker — Phase 0 Infra & Secret Wiring Runbook

**Status:** Recall workspace now LIVE (2026-07-07): **"Capiro", region us-west-2 (US West / Oregon)**. Dashboard config partly done — BYO-Deepgram ✅, Recall API key generated ✅, webhook deferred to Phase 1. Remaining operator work: store the two secrets in AWS Secrets Manager, CDK wiring, and the Recall DPA/subprocessor listing. (Secret ARNs still don't exist in code — committing placeholder ARNs would break `cdk deploy`, so the CDK edits below stay as a to-apply recipe.)
**Related:** [meeting-notetaker-bot-plan.md](meeting-notetaker-bot-plan.md). Code side (config schema keys, provider, flag) is already committed in this branch.

---

## What the code already declares (committed)
- `apps/api/src/config/config.schema.ts` — `RECALL_API_KEY`, `RECALL_WEBHOOK_SECRET` (optional; unset = feature inert), `RECALL_API_BASE_URL` (default `https://us-west-2.recall.ai` — Capiro's Recall region), `NOTETAKER_ENABLED`.
- The provider reads these via `ConfigService`. **Nothing works until the two secrets are created and wired to the running task, and the Recall dashboard is configured.**

## Which task needs which secret (corrected — do NOT blindly copy the migrate-family pattern)
- **`RECALL_API_KEY`** → **serve task only** (`capiro-dev-api`). All outbound Recall calls (dispatch bot, create/pull transcript, leave, delete_media) run in the serve API — in Phase 1 they're user-initiated, and the webhook-driven async steps also run in the serve task.
- **`RECALL_WEBHOOK_SECRET`** → **serve task only**. Only the inbound `/webhooks/recall` receiver (serve task) verifies signatures.
- **Migrate family** (`capiro-dev-api-migrate` / the out-of-band `capiro-dev-api-admin-migrate`) → **does NOT need either secret for Phase 0/1** (migrations + sync scripts never create bots). ⚠️ **Phase 2 exception:** the EventBridge auto-dispatch scheduler *does* create bots, so whatever family runs it will need `RECALL_API_KEY`. Wire it then, on that family.

## Drift caveats (from the codebase recon — verify against the LIVE account, don't trust CDK alone)
1. `scripts/deploy-dev.sh` does **not** run `cdk deploy`; it only runs the migrate task then `force-new-deployment`. Applying `compute-stack.ts` secret changes requires a **manual `cdk deploy` of the Compute stack**, then a service roll.
2. The operational migrate family the deploy script uses is `capiro-dev-api-admin-migrate`, which is **registered out-of-band and is NOT the CDK `capiro-dev-api-migrate`**. (Not relevant to Phase 0 since migrate needs no Recall secret, but know it.)
3. Some secrets (e.g. `INTERNAL_SERVICE_SECRET`) were wired **out-of-band** onto the running task, never through CDK. So the live `capiro-dev-api` task def may have drifted from CDK. After `cdk deploy`, **diff the running task def** and, if needed, re-register the Recall secrets out-of-band the same way — otherwise a future `cdk deploy` could revert a hand-wired secret.

---

## Step 1 — Recall.ai account + dashboard  (mostly done 2026-07-07)
Workspace **"Capiro"** is live in **us-west-2 (US West / Oregon)** — matches `RECALL_API_BASE_URL`, US data-residency ✓.
1. ✅ Workspace live in **us-west-2**. ⏳ Still to do: sign the Recall **DPA** + add Recall to the subprocessor list / Trust Center (compliance).
2. ✅ **BYO-Deepgram configured** — Transcription → Deepgram credential `capiro-notetaker-deepgram` saved as **Default**, US endpoint (Host blank). Transcribes on Deepgram key `capiro-dev-recall-notetaker` in the **same project intel-api uses** (`a213623f-607b-4756-aa7a-1fe779cbaf62`). Project Id left blank — that field is Desktop-SDK-only, not needed for meeting-bot async.
3. ⏳ **Webhook endpoint DEFERRED to Phase 1** — the `/webhooks/recall` receiver doesn't exist yet and Recall's Svix portal is a cross-origin iframe (couldn't automate). Add `https://app.capiro.ai/webhooks/recall` (subscribe to all events) when the receiver ships; the Svix signing secret is viewable on the endpoint page anytime (not a one-time reveal).
4. ✅ **Recall API key generated** (`ec28b…`). Store it in AWS Secrets Manager as `capiro/dev/recall-api-key` (Step 2). ⚠️ Account is on the **$5 trial credit** — upgrade to pay-as-you-go before production meeting volume.
5. Retention: leave per-bot (`RecallProvider` sets `retention: { type: 'timed', hours: 24 }`). Do **not** rely on literal zero-retention with async BYO-Deepgram — see plan §4 (async needs retained media; we `delete_media` after pulling).

## Step 2 — AWS secrets (account 967807252336, us-east-1)
- ✅ **`capiro/dev/recall-api-key` CREATED 2026-07-07** — ARN `arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/recall-api-key-WDNzEP`, holding a PLACEHOLDER. Neo sets the real value (console: Retrieve → Edit; or CLI):
  ```sh
  aws secretsmanager put-secret-value --secret-id capiro/dev/recall-api-key \
    --secret-string '<RECALL_API_KEY>' --region us-east-1
  ```
- ⏳ **`capiro/dev/recall-webhook-secret`** — NOT created (webhook deferred to Phase 1; create it with the endpoint's signing secret when the receiver ships):
  ```sh
  aws secretsmanager create-secret --name capiro/dev/recall-webhook-secret \
    --secret-string '<whsec_...>' --region us-east-1
  ```

## Step 3 — CDK edits (mirror the anthropic / sam-gov pattern; SERVE task only)

> ✅ **COMMITTED 2026-07-08** (Phase 1 build): `recallApiKey` is wired exactly as below; `RECALL_WEBHOOK_SECRET` wiring is **gated** — it attaches automatically once the `recallWebhookSecret` ARN is added to `externalSecretArns` in `config.ts` (do that in go-live item E, after creating the secret). The recipe below is kept for reference.
**`infra/cdk/lib/config.ts`**
- Extend the `externalSecretArns` type (~lines 47-59): `recallApiKey?: string;` `recallWebhookSecret?: string;`
- Add the resolved complete ARNs to the **dev** `externalSecretArns` object (~lines 188-200):
  ```ts
  recallApiKey:        'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/recall-api-key-WDNzEP',
  recallWebhookSecret: 'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/recall-webhook-secret-XXXXXX',
  ```

**`infra/cdk/lib/compute-stack.ts`** (4 edits — serve only)
1. After the anthropic import (~line 209):
   ```ts
   const recallApiKeySecret = importExternalSecret(
     this, 'ImportedRecallApiKey',
     `capiro/${cfg.envName}/recall-api-key`, cfg.externalSecretArns?.recallApiKey);
   const recallWebhookSecret = importExternalSecret(
     this, 'ImportedRecallWebhookSecret',
     `capiro/${cfg.envName}/recall-webhook-secret`, cfg.externalSecretArns?.recallWebhookSecret);
   ```
2. In the **api task role** `addToPolicy` resources array (~after line 317):
   ```ts
   `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/recall-api-key*`,
   `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/recall-webhook-secret*`,
   ```
3. In **`apiServeSecrets`** (~before line 378):
   ```ts
   RECALL_API_KEY: ecs.Secret.fromSecretsManager(recallApiKeySecret),
   RECALL_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(recallWebhookSecret),
   ```
4. In **`externalRuntimeSecretArnPatterns`** (serve exec role, ~after line 477):
   ```ts
   `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/recall-api-key*`,
   `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/recall-webhook-secret*`,
   ```
> Do **not** add to `apiMigrateSecrets` / the migrate exec-role grant for Phase 0/1 (see "which task needs which secret").

## Step 4 — Deploy + verify
1. `cdk deploy` the Compute stack (registers a new `capiro-dev-api` task revision).
2. `RECALL_API_BASE_URL` / `NOTETAKER_ENABLED` are plain env (non-secret) — if you want them non-default, add to `apiSharedEnv`. Defaults are fine for Phase 0 (feature stays dormant; `NOTETAKER_ENABLED` unset ⇒ off).
3. Roll the serve service (`aws ecs update-service … --force-new-deployment`).
4. **Verify the LIVE task def** actually carries `RECALL_API_KEY` + `RECALL_WEBHOOK_SECRET` (drift caveat #3):
   ```sh
   aws ecs describe-task-definition --task-definition capiro-dev-api \
     --query 'taskDefinition.containerDefinitions[0].secrets[?starts_with(name,`RECALL`)]'
   ```
   If absent (out-of-band drift), register a new revision out-of-band with the two secrets and update the service.

## Phase 0 exit criteria (infra half)
- [ ] Recall DPA signed; US region; zero-/short-retention posture set; subprocessor listed in Trust Center; SOC 2 report filed.
- [ ] Our Deepgram key configured in Recall dashboard; **BYO-Deepgram verified end-to-end** — a test bot on a throwaway meeting produces a transcript that shows up in **our** Deepgram usage dashboard.
- [ ] `capiro/dev/recall-api-key` + `capiro/dev/recall-webhook-secret` exist; both present on the **live** `capiro-dev-api` task def.
- [ ] `/webhooks/recall` endpoint registered in the Recall dashboard (receiver itself lands Phase 1).
- [ ] `NOTETAKER_ENABLED` stays unset (feature dormant) until Phase 1 canary.
