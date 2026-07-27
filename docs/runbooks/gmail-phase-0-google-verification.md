# Gmail Integration — Phase 0 Runbook: GCP Setup, OAuth Verification, CASA

**Status:** Ready to execute once GCP org access is granted (see §0 Blocker). No code required for
this phase.
**Source:** `docs/plans/2026-07-10-gmail-integration-blueprint.md`. Every policy claim below was
independently researched AND adversarially cross-checked (2 independent verifiers per topic against
primary Google/App Defense Alliance sources) on 2026-07-10. Citations are inline; treat anything
marked UNCERTAIN as genuinely unresolved in Google's own documentation, not a gap in this research.

---

## 0. BLOCKER — no legitimate Capiro GCP identity exists yet

Checked directly in this environment: `gcloud auth list` shows only two identities — a personal
`neo.martinez30@gmail.com` account and a service account tied to an unrelated project,
`big-query-ai-hackathon-469622` ("Big Query AI Hackathon"). **Neither is a legitimate Capiro, Inc.
corporate identity.** Creating an OAuth app that will read real customers' Gmail data under a
founder's personal Google account or an unrelated hackathon project is a real compliance problem for
a company with a stated SOC 2 Type II posture — not just an architectural inconvenience — so this
runbook does not proceed past planning until it's resolved.

**What's needed to unblock, precisely:**
1. A Google Cloud project owned by a proper Capiro corporate identity — either an existing Capiro
   Google Workspace organization, or a new GCP project created under a company-controlled Google
   Account (not a personal `@gmail.com`), with billing attached to a Capiro-controlled billing account.
2. Who administers that project day to day (receives Google's OAuth-review and annual-CASA-recertification
   emails — see §5 below on why keeping this contact current matters).

Nothing else in this runbook is blocked. Once §0 is resolved, every step below is mechanical.

---

## 1. Corrected phase sequencing (read this before executing anything)

The original blueprint scoped "Phase 0" as: GCP setup → submit OAuth verification → CASA, with
Phase 1 (build the connect/sync flow) starting only after. **Verified research shows this ordering is
impossible under Google's own rules:**

> "Apps in development, testing or staging are not applicable for verification." Submission requires
> first clicking **Publish App** to flip status from Testing to Production, and the mandatory demo
> video must show "the end-to-end flow of your app including the OAuth grant process" and "the app
> functionalities that utilize the requested OAuth scopes" **for the actual app being submitted** —
> not a mockup.
> — [support.google.com/cloud/answer/13461325](https://support.google.com/cloud/answer/13461325), [support.google.com/cloud/answer/13464321](https://support.google.com/cloud/answer/13464321)

Both independent verifiers confirmed this verbatim against the live pages. So Phase 0 splits into two
parts with Phase 1 (the actual connect+sync build) sandwiched between them:

| Sub-phase | What | Blocked on | Requires code? |
|---|---|---|---|
| **0a** | GCP project, APIs, OAuth consent screen (stays in **Testing** status), OAuth client, domain verification | §0 GCP identity | No |
| **Phase 1** | Build + deploy the connect/sync flow, running against the 0a OAuth client in **Testing** mode | 0a complete | Yes |
| **0b** | Flip to **Production**, record the demo video of the *real* flow, submit for verification, complete CASA | Phase 1 stable & scope-final | No |

This is explicitly the Google-sanctioned pattern, not a workaround: *"if your app is in the
development, testing, or staging phases, verification isn't required"* — [developers.google.com sensitive-scope-verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).
Testing-mode apps are capped at 100 allow-listed test users with tokens/consent expiring after 7 days
— [support.google.com/cloud/answer/15549945](https://support.google.com/cloud/answer/15549945) — which is exactly the ceiling Phase 1 development and internal dogfooding needs to live under until 0b clears.

**One-way door once you flip to Production and submit:** any subsequent change to requested scopes,
app name, logo, redirect URI, homepage, or privacy-policy link "will be required to complete brand
verification again" and can restart the review clock —
[support.google.com/cloud/answer/13464018](https://support.google.com/cloud/answer/13464018). A real
developer account documented five separate review rounds (domain/hosting issue → scope-justification
rewrite → scope reduction to dodge a costlier CASA tier → demo-video redo → approval), each adding
days —
[medium.com/@info.brightconstruct](https://medium.com/@info.brightconstruct/the-real-oauth-journey-getting-a-google-workspace-add-on-verified-fc31bc4c9858).
**Do not flip to Production / click Submit for Verification until Phase 1's exact scope list and
consent-screen fields are final.**

---

## 2. Phase 0a — GCP setup (execute once §0 is resolved; no code)

### 2.1 Create the project & enable APIs
- New GCP project under the resolved Capiro identity (§0).
- Enable: **Gmail API**, **Google Calendar API**. (Cloud Pub/Sub API is Phase 3, not needed yet.)

### 2.2 OAuth consent screen — exact values to use
Capiro already has everything Google's consent-screen/verification form requires, live today
(confirmed by direct repo read, not assumed):

| Field | Value | Verified from |
|---|---|---|
| App name | Capiro | — |
| Homepage URL | `https://capiro.ai` | must be public, describe the app, link to privacy policy — [developers.google.com/.../brand-verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification) |
| Privacy Policy URL | `https://capiro.ai/privacy` | live page, same domain as homepage as required — [marketing/privacy.html](../../marketing/privacy.html) |
| Terms of Service URL | `https://capiro.ai/terms` | Google's own pages disagree on whether this is strictly required or "recommended" for the link slot — supply it regardless, it costs nothing and it's live |
| Developer/support contact email | `support@capiro.ai` | live, used throughout onboarding email templates |
| Legal entity / registrant | Capiro, Inc., 2791 Centerboro Drive, Suite 186, Vienna, VA 22181 | [marketing/privacy.html:78](../../marketing/privacy.html) |
| Authorized domains | `capiro.ai` | top-private domain behind homepage/privacy/ToS/redirect URIs — [support.google.com/cloud/answer/15549049](https://support.google.com/cloud/answer/15549049) |
| App logo | Capiro logo asset (marketing/assets) | optional field, but omitting it means only the domain (not the name/logo) renders to users until brand verification passes — plausible per one verifier, unconfirmed by the other; supply the logo to avoid the question entirely |

Leave publishing status as **Testing** for all of Phase 0a and Phase 1.

### 2.3 Domain verification (the one domain-verification step that's actually required)
Verified research (topic: domain scope) found **three separate, non-overlapping** Google
verification concerns — do not confuse them:

1. **OAuth consent-screen "Authorized domains"** — DOES require verifying ownership of `capiro.ai`
   via **Google Search Console, DNS-level "Domain Property"** (not URL-prefix), max 10 domains per
   project — [support.google.com/cloud/answer/13804266](https://support.google.com/cloud/answer/13804266). **This is the only domain-verification step in the entire integration.**
2. **Gmail API push** (`users.watch`, Phase 3) — no domain verification at all. Only an IAM grant to
   `gmail-api-push@system.gserviceaccount.com` on a Pub/Sub topic; Pub/Sub's own docs state
   *"Pub/Sub doesn't require proof of ownership for push subscription URL domains"* —
   [docs.cloud.google.com/pubsub/docs/create-push-subscription](https://docs.cloud.google.com/pubsub/docs/create-push-subscription).
3. **Calendar API push** (`events.watch`, Phase 3) — no domain verification either; only a valid,
   non-self-signed, hostname-matching HTTPS certificate on the callback address —
   [developers.google.com/.../calendar/api/guides/push](https://developers.google.com/workspace/calendar/api/guides/push).

**Correction to the original blueprint:** §8 of the blueprint said domain verification was "required
for push." That's wrong per this research — push needs neither Search Console verification nor any
GCP-console domain-verification step (there was a legacy push-domain-verification mechanism; Google
has since explicitly retired it — [support.google.com/googleapi/answer/7072069](https://support.google.com/googleapi/answer/7072069)). Only the OAuth consent screen needs it, and only once.

**Mechanics, using Capiro's existing infra (confirmed via [infra/cdk/lib/dns-stack.ts](../../infra/cdk/lib/dns-stack.ts)):** the `capiro.ai` Route53 hosted zone already exists and is CDK-managed
(`HostedZone.fromLookup`). Add the Search-Console-issued TXT record **out-of-band directly in
Route53** (same pattern already used for other low-risk record changes — see
[infra/cdk/DRIFT-FINDINGS.md](../../infra/cdk/DRIFT-FINDINGS.md)), not via a `cdk deploy` of the DNS
stack, to avoid any risk of an unrelated diff touching the live cert/ALB config. This environment has
live AWS credentials for the real Capiro account (967807252336) — I can execute this step once a
Search Console owner account and the TXT value exist, subject to your explicit go-ahead before any
production DNS write.

### 2.4 Create the OAuth 2.0 client
- Type: **Web application**.
- Redirect URIs (mirror the Microsoft integration's pattern —
  [microsoft-oauth.controller.ts](../../apps/api/src/engagement/microsoft/microsoft-oauth.controller.ts)):
  `https://app.capiro.ai/api/engagement/integrations/google/callback` (prod),
  `https://app.staging.capiro.ai/api/engagement/integrations/google/callback` (staging),
  `http://localhost:4000/api/engagement/integrations/google/callback` (dev).
- Also register the **onboarding IT-admin test-connect** callback (added 2026-07-14;
  see docs/runbooks/onboarding-operations.md "IT-admin Google option"):
  `https://app.capiro.ai/onboard-api/it/google/callback` (prod).
- Unlike Microsoft (certificate-only, since the capiro.ai Azure AD tenant blocks client secrets),
  **Google's Web-application OAuth client uses a standard client secret** — there is no certificate
  option for this flow. Store it in AWS Secrets Manager as `capiro/dev/GOOGLE_CLIENT_SECRET` (no
  leading slash — required for the ECS exec role's `capiro/dev/*` grant, per
  [infra/cdk/DRIFT-FINDINGS.md:179](../../infra/cdk/DRIFT-FINDINGS.md)). Wire it into the task
  definition **out-of-band**, the same way `MICROSOFT_CERT_PRIVATE_KEY` is wired — never via
  `cdk deploy Compute`, which is known to drop out-of-band secrets (see
  [infra/cdk/DRIFT-FINDINGS.md](../../infra/cdk/DRIFT-FINDINGS.md) and the CDK↔task-def drift memory).

### 2.5 Draft (but do not submit) the scope-justification text
Google requires a written justification per sensitive/restricted scope — *"an explanation why
narrower scopes would not work, including specifics on what functionality would not work as
intended"* — [support.google.com/cloud/answer/13464321](https://support.google.com/cloud/answer/13464321). Draft this now so 0b isn't blocked on writing it later. Suggested basis (edit once
Phase 1's actual UX is real, since the video must match):

- **`gmail.readonly`** (RESTRICTED — [confirmed on the official scopes table](https://developers.google.com/workspace/gmail/api/auth/scopes)): "Capiro is a client-engagement platform for government-affairs professionals. Connected users' email threads with their own clients are read and associated with the relevant client record inside Capiro, mirroring the same read-only mailbox sync Capiro already performs for Microsoft 365/Outlook. The message body is passed to the user's own AI assistant for meeting-prep summaries and follow-up drafting that reference the substance of prior correspondence. A narrower scope (`gmail.metadata`) would not work, on three independent grounds: (1) it exposes headers only, with no message body, so there would be nothing to summarize or draft from; (2) [Google's own `users.messages.list` reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) states the `q` search parameter — which the sync depends on to bound the backfill window and exclude spam/trash/drafts — 'cannot be used when accessing the api using the gmail.metadata scope'; (3) `gmail.metadata` is itself classified RESTRICTED, so narrowing to it would not reduce the security-assessment burden while removing the functionality. `gmail.readonly` is therefore the narrowest workable scope."
  **Status (2026-07-27):** full-body retrieval (`format=full` + `extractGmailBodyText`, matching the claim above) is code-complete — see the completion plan's Phase G / Branch G-A — but **NOT YET DEPLOYED**. Until it is deployed and verified live (completion plan §0.1 / K5), the running code still stores only Gmail's short snippet as `bodyText`, and no correspondence with Google should describe full-body access as already live.
- **`gmail.send`** (SENSITIVE): "Capiro lets the connected user send outreach emails and AI-drafted follow-ups from within the platform, which are delivered from the user's own Gmail account (mirroring the existing Outlook send capability) so recipients see mail from the user's real address, not a third-party relay."
- **`calendar.events.readonly`** (SENSITIVE): "Capiro reads events from the connected user's primary Google Calendar and automatically matches meetings to the correct client record by attendee email address, surfacing upcoming and past client meetings alongside email in the same client-engagement view — identical to the existing Microsoft 365 Calendar-equivalent behavior. A narrower scope, `calendar.events.owned.readonly`, would not work: it is limited to events the user owns, but the meetings this feature exists to track are, in the majority of cases, organized by the client or a third party, with the user as an invitee rather than the owner — exactly the events that scope would hide. Capiro does not request the broader `calendar.readonly`, and never reads calendar list metadata or calendar settings; `calendar.events.readonly` is the narrowest scope that returns the event data the feature depends on."
  **Note:** this bullet previously named the scope `calendar.readonly`, which does not match the code (`calendar.events.readonly` — `packages/shared/src/index.ts:76-83`) or the Cloud Console configuration. That exact mismatch triggered a real Google verification rejection; see commit `9f685e2b` and completion plan Phase J.

---

## 3. Phase 1 happens here (see the main blueprint, §4–§10) — not repeated in this runbook

Build the `google/` OAuth adapter + sync engine against the Phase 0a Testing-mode client. Internal
users and pilot design partners can use it immediately under the 100-test-user / 7-day-token ceiling.
**Do not** touch the consent-screen scopes/branding fields again once 0b begins.

---

## 4. Phase 0b — Verification submission (only after Phase 1 is live and scope-stable)

### 4.1 Submission sequence (verified, exact order)
Per [support.google.com/cloud/answer/13461325](https://support.google.com/cloud/answer/13461325):
**Publish App** (Testing → Production) → **Prepare for Verification** → scope justification → demo
video → **Submit for Verification**.

### 4.2 Demo video — hard requirements
- Must show, in English: the real app's OAuth consent screen with **the exact scopes requested**,
  the browser address bar showing **the real OAuth client ID**, the full end-to-end grant flow, and
  the actual functionality each scope enables (message read → client timeline; send → outreach;
  calendar read → meeting association) —
  [developers.google.com/.../restricted-scope-verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [support.google.com/cloud/answer/13464321](https://support.google.com/cloud/answer/13464321).
- Host on **YouTube Studio, set to Unlisted** — this is the current developers.google.com
  requirement; an older support.google.com page is looser (YouTube/Drive/"any accessible link," no
  visibility mandate) but the stricter, more current instruction should be followed to avoid a
  rejection round.
- Must be the **real, deployed production app** — not a mockup, not staging pretending to be prod.

### 4.3 Expected timeline (verified, with the honest caveats)
Google's own FAQ gives explicit estimates, **explicitly caveated as "not guaranteed"**:
Brand Verification 2–3 business days; Sensitive Scope Verification ~10 business days (one official
Google blog post says 3–5 days instead — Google's own materials disagree); **Restricted Scope
Verification ~6 weeks**, which is layered *before* CASA, described as *"the final step of the
restricted scopes review process"* —
[support.google.com/cloud/answer/13463817](https://support.google.com/cloud/answer/13463817), [support.google.com/cloud/answer/13465431](https://support.google.com/cloud/answer/13465431).
A real documented account took 5 review rounds. **Budget realistically for 2–4 months end to end**
from "Phase 1 stable" to "fully verified, In Production" — this is a range, not a guarantee in either
direction; it could clear faster if the first submission is clean, or slower if a review round or
CASA remediation is needed.

### 4.4 CASA — what's actually required, with real numbers (not the placeholder guess in the original blueprint)

**Why it's unavoidable:** `gmail.readonly` is RESTRICTED (confirmed on
[Google's own Gmail scopes table](https://developers.google.com/workspace/gmail/api/auth/scopes)),
and *"every app that requests access to Google users' restricted data and has the ability to access
data from or through a third-party server must go through a security assessment"* —
[developers.google.com/.../restricted-scope-verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification). Capiro's backend is exactly that third-party server. `calendar.events.readonly` and `gmail.send` are SENSITIVE, not restricted, and would not by
themselves trigger CASA — but the locked-in decision to use `gmail.readonly` for full-body parity
means CASA applies regardless.

**Which tier:** Google assigns the tier itself, by risk calculation (data sensitivity + user count +
internal signals), communicated by email **after** you submit for verification — there is no
published numeric threshold and no tier picker. **Do not self-initiate CASA before Google's tiering
email** — self-initiated assessments are automatically routed to the more expensive Tier 3 —
[appdefensealliance.dev/casa/casa-self-start](https://appdefensealliance.dev/casa/casa-self-start).
The closest real-world comparable found: **Truto**, a B2B unified-API company requesting
`gmail.readonly` plus several other restricted read scopes, was assigned **Tier 2**, not Tier 3 —
[truto.one blog](https://truto.one/blog/our-google-oauth-app-is-live-and-casa-tier-2-certified/).
This is a plausible outcome for Capiro's profile (moderate B2B SaaS, not a consumer app with millions
of users) but is **not guaranteed** — treat Tier 3 as a real possibility to budget for, not the
expected case.

**What each tier involves:**
- **Tier 2 (AL1):** a Dynamic Application Security Testing (DAST) scan of externally-facing
  interfaces + a Self-Assessment Questionnaire (~50 questions covering architecture, data flow,
  token/secret handling, access control, incident response), reviewed by an authorized lab, ending in
  a **Letter of Validation (LOV)**. No source code is submitted.
- **Tier 3 (AL2):** the same control set but tested manually/hands-on by the lab, including real
  penetration testing. Once assessed at Tier 3, **all future annual re-assessments stay at Tier 3** —
  there's no dropping back down.

**How to engage:** there is no Google-run portal — contact an ADA-listed **CASA Authorized Assessor**
directly (Google is not a party to this contract and charges nothing itself). Current directory (~9
labs, onboarding of new labs paused during the App Defense Alliance's move under the Linux
Foundation) —
[appdefensealliance.dev/casa/casa-assessors](https://appdefensealliance.dev/casa/casa-assessors):
TAC Security, Bishop Fox, KPMG, Leviathan Security, NCC Group, NetSentries Technologies, Orange
Cyberdefense South Africa, Prescient Security, DEKRA. **Get quotes from more than one** — Google's own
FAQ recommends this, and real prices vary substantially by lab.

**Realistic cost (corroborated across multiple independent sources, not a guess):**

| Tier | Low end | High end | Real example |
|---|---|---|---|
| Tier 2 | ~$500 (TAC Security) | ~$1,500–1,800 (Bishop Fox/NCC Group) | Orbis paid $540 total via TAC Security, DAST + 54-question SAQ, ~2 days turnaround after the scan report |
| Tier 3 | ~$4,500 (TAC Security) | ~$7,000–8,000+ (NCC Group/Bishop Fox) | — |

An older $15,000–$75,000 figure circulates in some blog posts; multiple 2025–2026 sources describe
today's self-serve lab path as having superseded that — treat the high figure as legacy/edge-case, not
the expected cost.

**This is a recurring cost, not a one-time cost.** Recertification is **annual**, timed from the prior
Letter of Validation's effective date, and Google emails the Cloud Console Project Owner/Editor —
**keeping that contact current is Capiro's responsibility, not Google's** —
[support.google.com/cloud/answer/13463816](https://support.google.com/cloud/answer/13463816). Google's
own language on non-renewal is non-committal on exact timing ("use of the API **may be** suspended")
with no published grace period — a real developer account described abandoning apps over the ~$500/yr
recurring cost rather than treating it as trivial. **Budget Tier-2 CASA (~$500–$1,800) as a recurring
annual line item going forward, not a one-time Phase-0 expense**, and assign a specific owner for the
annual renewal now so it isn't missed a year from now.

**Realistic timeline:** lab assessment itself ~1–3 weeks once testing begins (Tier 2); Tier 3 runs
longer, order-of-weeks higher, though sources don't agree on an exact range — budget conservatively.
Combined with Google's own review stages, **budget the full 0b phase at 2–4 months**, not weeks.

### 4.5 What Ninja needs to decide/own for 0b (not needed for 0a)
- Who administers the ADA assessor relationship and pays the invoice (this is a real vendor
  engagement, procurement territory).
- Confirm the ~$500–$1,800/yr (Tier 2 case) or ~$4,500–$8,000+/yr (Tier 3 case) recurring CASA cost is
  acceptable as an ongoing line item — this is now a real number, not the vague "low-thousands" guess
  in the original blueprint.
- Who's the named Cloud Console Project Owner/Editor contact that will receive Google's annual
  recertification email indefinitely.

---

## 5. Citation index

All claims above were independently verified by 2 adversarial reviewers against live official pages
on 2026-07-10. Primary sources used throughout:
- Scope classification: [developers.google.com/workspace/gmail/api/auth/scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [support.google.com/cloud/answer/13464325](https://support.google.com/cloud/answer/13464325)
- OAuth verification FAQ: [support.google.com/cloud/answer/13463817](https://support.google.com/cloud/answer/13463817)
- Restricted/sensitive scope verification requirements: [developers.google.com/.../restricted-scope-verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [developers.google.com/.../sensitive-scope-verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- Brand verification & app branding: [developers.google.com/.../brand-verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification), [support.google.com/cloud/answer/15549049](https://support.google.com/cloud/answer/15549049)
- App audience / Testing status limits: [support.google.com/cloud/answer/15549945](https://support.google.com/cloud/answer/15549945)
- Unverified app screen: [support.google.com/cloud/answer/7454865](https://support.google.com/cloud/answer/7454865)
- Domain verification: [support.google.com/cloud/answer/13804266](https://support.google.com/cloud/answer/13804266), [support.google.com/cloud/answer/13464321](https://support.google.com/cloud/answer/13464321)
- Submission workflow & dev/testing/staging exemption: [support.google.com/cloud/answer/13461325](https://support.google.com/cloud/answer/13461325)
- Security assessment / CASA overview: [support.google.com/cloud/answer/13465431](https://support.google.com/cloud/answer/13465431)
- Annual recertification: [support.google.com/cloud/answer/13463816](https://support.google.com/cloud/answer/13463816)
- Changes-to-approved-app re-verification triggers: [support.google.com/cloud/answer/13464018](https://support.google.com/cloud/answer/13464018)
- CASA program (App Defense Alliance): [appdefensealliance.dev/casa](https://appdefensealliance.dev/casa), [.../casa-tiering](https://appdefensealliance.dev/casa/casa-tiering), [.../casa-assessors](https://appdefensealliance.dev/casa/casa-assessors), [.../casa-self-start](https://appdefensealliance.dev/casa/casa-self-start)
- Real-world cost/tier precedents: [Orbis](https://meetorbis.com/blog/how-we-passed-google-casa-tier-2-with-claude), [Truto](https://truto.one/blog/our-google-oauth-app-is-live-and-casa-tier-2-certified/), [switchlabs pricing comparison](https://www.switchlabs.dev/post/casa-tier-2-tier-3-security-review-providers-pricing-and-the-cheapest-option)
- Gmail/Calendar push, no domain verification: [developers.google.com/.../gmail/api/guides/push](https://developers.google.com/workspace/gmail/api/guides/push), [developers.google.com/.../calendar/api/guides/push](https://developers.google.com/workspace/calendar/api/guides/push), [docs.cloud.google.com/pubsub/docs/create-push-subscription](https://docs.cloud.google.com/pubsub/docs/create-push-subscription)

Two genuine unresolved ambiguities in Google's own documentation (flagged, not resolved, by design):
(1) whether the app logo/name renders only after brand verification or whether unverified apps simply
show the domain instead — one verifier confirmed this, the other could not find a primary-source
statement; (2) the exact CASA Tier 3 audit boundary — one ADA page says infrastructure is excluded,
another ADA page and third-party sources say Tier 3 tests deployment infrastructure too. If Capiro
ends up in Tier 3, get the exact scope boundary from the assigned assessor in writing rather than
relying on either ADA page.

---

## 6. Verified status

**Human task, no code — see completion plan (`2026-07-27-google-integration-completion-plan.md`)
Phase I. Neo only. Do not mark any item below "done" without actually checking the Cloud Console —
this section exists specifically to stop stale assumptions from silently becoming the operating
"truth," which is exactly what happened to the `calendar.readonly` bullets in §2.5/§4.4 above before
this pass corrected them.**

| # | Question | Answer | Verified on |
|---|---|---|---|
| 1 | Publishing status — Testing or Production? (Testing = 100-user cap + 7-day refresh-token expiry) | _unanswered_ | |
| 2 | Brand verification — approved? | _unanswered_ | |
| 3 | Scope approval — does the Console's approved set match `packages/shared/src/index.ts:76-83` exactly (`openid`, `email`, `profile`, `gmail.readonly`, `gmail.send`, `calendar.events.readonly`)? | _unanswered_ | |
| 4 | CASA — Letter of Validation issued? Which tier? Recertification date and owner? | _unanswered_ | |
| 5 | Authorized redirect URIs registered — all four? (`.../api/engagement/integrations/google/callback` prod; `.../onboard-api/it/google/callback`; staging, if staging is still live; `localhost:4000/...` dev) | _unanswered_ | |
| 6 | Authorized domain — `capiro.ai` verified in Search Console as a DNS Domain Property? | _unanswered_ | |

Until items 1–4 are confirmed, the honest product statement is that Google Workspace is
**conditionally functional** — that framing should not be softened in customer-facing material.
