# Meri Notetaker — Signed-In Bots + branded avatar (scoped follow-up)

**Status:** SCOPED, not built (2026-07-08). Companion to [meeting-notetaker-bot-plan.md](meeting-notetaker-bot-plan.md).
**Why this exists:** on a live Teams canary, Meri shows as **"Meri Notetaker (recording) (Unverified)"** with no profile photo. Ninja asked to (1) remove the "Unverified" label and (2) show the Meri logo as the bot's photo. This doc is the grounded scope for both, from a 5-dimension research pass over Recall's docs + our codebase + the consent design.

---

## TL;DR / recommendation

There are **two independent fixes**, with very different cost and reliability:

| | **Fix A — logo on the camera tile** | **Fix B — signed-in bot** |
| --- | --- | --- |
| Solves | Logo visible as the bot's **video tile** | True **profile avatar** next to the name + label `(Unverified)` → `(External)` |
| Ships today? | **Yes** — small code change, no account | No — needs a dedicated M365 account + Recall dashboard config + SOC 2 sign-off |
| Code | ~10 lines in `recall.provider.ts` (`automatic_video_output`) | ~0–minimal (credentials live in Recall's dashboard, not our API) |
| Reliability on external Teams | Always shows (it's the camera feed) | ⚠️ avatar + `(External)` may **not render** unless the *host* org (the agency) trusts our bot domain — see below |
| Effort | **S** | **M** (Teams) — plus per-platform repeats for Meet/Zoom (**L** total) |

**Recommendation:** the "photo ID" Ninja actually wants — a real avatar by the name — is **Fix B**, but on the *external* Teams meetings this product is built for, Fix B's avatar/label change is **not guaranteed to appear** (it depends on the counterparty's tenant settings, which we can't control). So:

1. **Quick win, if wanted now:** ship **Fix A** (logo as camera tile). It reliably puts the Meri mark in the meeting on Zoom/Meet/Teams regardless of tenant trust. It is a video tile, not the circular avatar — set expectations accordingly.
2. **Real fix, gated:** pursue **Fix B (Teams)** only after a **SOC 2 review** of the service-account posture (below) and a **counsel note** (folded into the already-pending consent review, §F). Treat Meet/Zoom signed-in as separate later efforts — nothing carries over between platforms.

> **Correction to an earlier claim in this thread:** I previously implied the logo was "saved" and that signing in cleanly removes the Unverified label. Both need qualifying: (a) I cannot extract the attached image to the repo myself — a human must commit the Meri mark as a JPEG (Fix A) and/or upload it as the bot account's profile photo (Fix B); (b) signing in only downgrades `(Unverified)` → `(External)`, and even that requires host-tenant trust for external meetings.

---

## The "Unverified" label — what it actually is

Microsoft Teams appends `(Unverified)` to **any participant not signed into a Microsoft identity with a trusted relationship to the host tenant** — it is Microsoft's own anti-bot / anonymous-guest security indicator, not anything about email. It is **universal to notetaker bots**: Otter's bot gets the identical label for the identical reason ([Otter help](https://help.otter.ai/hc/en-us/articles/29548257993879-Otter-Notetaker-is-showing-as-unverified)), and from **mid-May 2026** Teams actively flags suspected external bots under "Suspected threats." So it is not a Capiro bug and not fixable by config alone.

Signing the bot in (Fix B) changes `(Unverified)` → `(External)` **only when the meeting is hosted by a different tenant** (i.e. every Hill/agency meeting). Getting to *no* label would require the **host organization** to whitelist our bot's domain in their Teams External Access settings — outside our control, per-counterparty, and something we should **not** pursue for external meetings (see consent note).

---

## Fix A — logo on the camera tile (`automatic_video_output`)

- **Mechanism:** add `automatic_video_output` to the Create Bot payload with a base64 JPEG for the `in_call_recording` and `in_call_not_recording` states. Recall renders it as the bot's **camera video feed** on Zoom/Meet/Teams/Webex (not Slack).
- **Works anonymously — no account, ships now.**
- **Image spec:** JPEG only, 16:9, recommended **1280×720**, max **~1.3 MB**, quality ~90 (design at 2560×1440, downscale; bold text ≥50px).
- **Code:** entirely inside `RecallProvider.dispatchBot()` ([recall.provider.ts](../../apps/api/src/engagement/notetaker/recall.provider.ts) — the sole builder of the create-bot `body`). Load the JPEG once (module constant), append `body.automatic_video_output = { in_call_recording: { kind: 'jpeg', b64_data: LOGO_B64 }, in_call_not_recording: { kind: 'jpeg', b64_data: LOGO_B64 } }`. No new config/secret. `MeetingBotProvider`/`DispatchBotInput` interface unchanged (keep it a fixed Meri asset; only add an optional field if the image must become per-tenant later). Update `recall.provider.spec.ts` to assert the new branch.
- **Asset gap:** there is **no server-side Meri JPEG** in `apps/api` today — the only Meri marks are PNGs in the web app (`apps/web/public/logo.png`, `apps/web/src/assets/chat/meri-bubble.png`) and marketing. A human must produce a 1280×720 letterboxed JPEG of the mark Ninja attached (blue field, white "meri" wordmark) and commit it under `apps/api` (e.g. `apps/api/src/engagement/notetaker/assets/meri-camera.jpg`).

## Fix B — signed-in bot (Teams first)

- **What it buys:** a real profile avatar next to the name, and `(Unverified)` → `(External)`. On Google Meet it additionally removes a "may not be who they claim to be" warning and unlocks sign-in-restricted meetings. On Zoom the only documented gain is the avatar (no "unverified" indicator is documented there).
- **Mechanism (Teams):** **not** an Entra app registration / OAuth flow. Recall logs in as a **real user with a stored email + password**. Requires:
  1. A **dedicated, standalone M365 tenant** (Recall explicitly says *not* to use our production org — sign-in needs org-level permission changes) with **one Microsoft 365 Business Basic license** (~$6/mo) for a "Meri Notetaker" user.
  2. In that tenant: **Security Defaults OFF**, "keep user signed in" off, Self-Service Password Reset = None.
  3. Upload the **Meri logo as that account's profile photo** (Azure portal → Users → bot → camera icon) and set its display name — these become the in-meeting name+avatar and **override** our `bot_name`/`DEFAULT_BOT_NAME`.
  4. Enter the account **email + password in the Recall dashboard** (Meeting Bot Setup → Microsoft Teams, per-region), **not** via our API. Set "Login mandatory" → Enabled to show the identity on every join.
- **Codebase impact is minimal** — credentials are dashboard-managed, so `config.schema.ts` needs no new secret and `dispatchBot()` needs little/no change. The one code follow-through: stop relying on `bot_name` for Teams (it's ignored once signed in) and reconcile the consent-disclosure copy, which references the bot name.
- **⚠️ SOC 2 blocker to clear first:** this trades an anonymous bot for a **plaintext-credential, MFA-disabled service account** whose password Recall stores and replays. That deviates from Capiro's MFA-everywhere baseline and must be explicitly accepted or rejected in a security review. Recall's docs are **silent** on token/session lifetime, credential rotation, and account-lockout behavior — assume **manual** rotation (re-enter in dashboard) and add join-failure alerting for a locked account.
- **Multi-platform:** Meet and Zoom are **separate** setups (Meet = dedicated Google Workspace + SAML SSO + login groups; Zoom = account + a ZAK-token HTTP endpoint). Nothing from Teams carries over. Do **Teams-only first** (matches the canary + agency-on-Teams reality); scope Meet/Zoom later if avatar parity there is wanted.

---

## Consent / compliance verdict

Signed-in + a **logo** avatar is **neutral-to-positive** for the strict informed-consent posture, *provided the load-bearing disclosures stay intact* — the `(recording)` name suffix and the on-join chat disclosure, neither of which signing in touches. Reasoning:

- The posture never relied on Microsoft's `(Unverified)` tag as a consent signal (the consent copy itself says a bot merely appearing in the roster is **not** sufficient notice). Removing that tag forfeits no protection.
- The `(External)` tag is actually a **consent plus** — it affirmatively tells the staffer's org that an outside party is present.
- **The one real risk is habituation:** a polished, verified-looking participant is less likely to make a Hill staffer stop and ask "what is that?". Mitigated by hard rules below.

**Hard rules if Fix B proceeds (to add to consent-copy §6):**
- The signed-in account's display name **MUST** retain the `(recording)` suffix — signing in must not drop or prettify it.
- The avatar is the **Meri/firm logo only** — never a human face/headshot, never a name that reads as a plausible human. "Obviously-a-tool" identity is a constraint.
- The on-join chat disclosure must still post identically and still name the **third-party firm** ({{firmName}}) — a more official-looking bot raises the bar on the text making clear it is not the host's own tool.

**New legal surface (non-consent):** authenticating a bot into Microsoft/Google/Zoom accounts implicates those platforms' automated-use / bot-account terms of service — a distinct review item for counsel.

---

## Recommended sequencing

1. **(optional, now)** Fix A camera-tile logo — S, reversible, reliable. Needs the JPEG asset from a human.
2. **SOC 2 review** of the Fix B service-account posture (plaintext creds in Recall + MFA-disabled account). Gate.
3. **Counsel note** folded into the pending consent review (§F) — the 3 questions added to consent-copy §7.
4. **Fix B (Teams):** provision the dedicated M365 account, set profile photo, dashboard config, verify live that it reads `(External)` + shows the avatar. Accept that external-meeting rendering depends on host-tenant trust.
5. **Meet/Zoom signed-in** — separate later efforts only if wanted.

**Sources:** Recall docs — signed-in-bots, signed-in-teams-bots-overview, setting-up-signed-in-bots-for-microsoft-teams, microsoft-teams-bots-faq, personal-vs-business-ms-teams, output-video-in-meetings, zoom-signed-in-bots, google-meet-login-getting-started, bot-login-credentials, bot_create reference. Codebase: `recall.provider.ts`, `meeting-bot.provider.ts`, `notetaker.service.ts`, `config.schema.ts`, `branding.service.ts`. Consent: `meeting-notetaker-consent-copy.md`, plan §5.
