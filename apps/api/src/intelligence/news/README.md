# Dashboard News & Narrative MVP

This module powers the Dashboard **News & Narrative** card. It intentionally uses NewsCatcher as a client-relevant signal input, not as a generic news feed.

## Relevance model

For Capiro's typical smaller client, being named in the press is not the main relevance test. The MVP therefore treats **issues and capabilities as primary signals** and direct company coverage as a high-confidence bonus/fallback.

Capiro builds each active client's monitoring profile from data it already owns:

- capability names;
- capability tags and explicit match keywords;
- client-level issue codes;
- capability-level issue codes;
- issue codes derived from confirmed LDA mappings;
- Program Element codes attached to capabilities;
- appropriation-account / target-subcommittee metadata where present;
- legal name, stripped legal-name variant, and DBA aliases.

A story may therefore be relevant even when the company is never named. For example, an Army autonomous-ground-vehicle procurement story can map to a small autonomy client through its capability profile.

Broad signals such as `Defense`, `Army`, or another service branch are **supporting context only**. They cannot qualify an article on their own; this prevents every broad defense story from being assigned to every defense client.

## MVP behavior

- One grouped `/search` request per tenant/cache window — never one provider request per client.
- Capiro fairly packs client capability/issue/program/company signals into one bounded Boolean query so one client with many tags cannot consume the whole query envelope.
- The portfolio signal query is intersected with a government-affairs policy query.
- The request is limited to the last 48 hours, sorted by date, NLP-enriched, ranked-source-only, robots-compliant, and duplicate-suppressed.
- Capiro re-scores every returned article against the full client monitoring profiles before surfacing it.
- Strong capability, specific issue, tracked program/PE, or direct-company matches can qualify a story.
- Broad issue/service terms can increase confidence but cannot qualify a story by themselves.
- Results are ranked by Capiro relevance before recency, with light client diversification so one portfolio company does not consume the whole dashboard.
- The API returns only headline/source/time/link plus Capiro-derived client/topic relevance. It does not return or persist full article text.
- If NewsCatcher returns article content, Capiro may use it ephemerally for matching; it is not stored or sent to the browser.
- Up to eight items are shown on the dashboard.
- A 30-minute process cache and in-flight request coalescing keep provider call volume bounded.
- Provider failure can serve a stale successful cache result. A missing key returns `available:false` and never breaks the rest of the dashboard.

## Configuration

The API serve process reads these environment variables directly:

```bash
NEWSCATCHER_API_KEY=
# Optional overrides:
NEWSCATCHER_BASE_URL=https://v3-api.newscatcherapi.com/api
NEWSCATCHER_DASHBOARD_CACHE_MS=1800000
NEWSCATCHER_TIMEOUT_MS=8000
```

`NEWSCATCHER_API_KEY` should be supplied from the environment's secret manager to the long-lived API serve task. Do not put the credential in source control.

The current live `dev` Compute stack is intentionally frozen/drifted (see `infra/cdk/lib/compute-stack.ts`), so this branch does not invent or hard-code an AWS secret ARN. When promoting the feature, add the secret to the governed task-definition rollout used for the live API and then verify the endpoint below before enabling the dashboard for production users.

## Endpoint

```text
GET /api/intelligence/news/dashboard
```

Expected configured response:

```json
{
  "available": true,
  "provider": "newscatcher",
  "items": [],
  "generatedAt": "...",
  "cached": false,
  "monitoredClientCount": 12,
  "activeClientCount": 12,
  "coverageLimited": false
}
```

Each returned item contains `clientMatches` plus a human-readable `relevanceReason`, for example:

```text
Relevant to Overland AI · Autonomous Ground Vehicles / ground robotics
```

That explanation is derived from Capiro's deterministic issue/capability matching; the MVP does not ask an LLM to invent relevance.

Without a configured key:

```json
{
  "available": false,
  "provider": "newscatcher",
  "items": [],
  "reason": "not_configured"
}
```

## Promotion checks

1. Set `NEWSCATCHER_API_KEY` only on the API serve task.
2. Call `/api/intelligence/news/dashboard` as a tenant with active clients that have realistic issues/capabilities.
3. Confirm at least some relevant stories map through a capability or issue even when the client name is absent.
4. Confirm direct company coverage still maps correctly when it exists.
5. Confirm broad terms alone (`Defense`, `Army`, etc.) do not create noisy client assignments.
6. Manually review a meaningful sample and target >=85% clearly relevant dashboard stories; tighten matching rather than filling the feed with weak results.
7. Refresh twice inside 30 minutes and confirm provider usage does not grow one-for-one with dashboard refreshes.
8. Remove/deny the provider key in a non-production environment and confirm the dashboard renders the explicit unavailable state while all other dashboard modules continue to load.
9. Confirm the NewsCatcher Services Agreement permits the intended client-facing headline/source/link and derived-insight display before production rollout.

## Not in this MVP

- full article ingestion/archive;
- embeddings or semantic search;
- CatchAll;
- X/Twitter or social feeds;
- sentiment dashboards;
- long-running per-client polling jobs;
- risk scores;
- proactive email/Slack alerts.

Those can build on a normalized signal store after the dashboard relevance/usage data proves the value of the initial issue/capability monitoring workflow.
