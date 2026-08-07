# engagement-api Observability Fields — v1

**Micro-session:** 2.8 — UI-aware observability
**Construct:** `infra/cdk/lib/engagement-api/engagement-api-alarms.ts`
**Spec:** `infra/cdk/test/engagement-api-observability.spec.ts`

---

## The problem this solves

`engagement-api` serves real tenant data on safe reads. Operators still need to
answer "which prototype-relevant route family is failing" without any log line,
metric dimension, or dashboard widget ever containing campaign content.

The split: **route family and status class are observable; content is not.**

---

## Allowed structured log fields

Emitted only when the application's existing middleware already produces them.
Micro-session 2.8 adds no application logging.

| Field | Meaning |
|---|---|
| `service` | always `engagement-api`, distinguishes shadow from main |
| `release_sha` | 40-hex release provenance |
| `route_family` | one of the families below |
| `http_method` | GET, POST, … |
| `status_class` | `2xx`, `4xx`, `5xx` — not the body |
| `latency_bucket` | bucketed, not a per-request timing tied to a record |
| `shadow_denial_action` | the Phase 1 runtime action that was refused |
| `ui_contract_sha` | which UI contract this release was built against |

### Route families

```text
meetings · reports · integrations · outreach_records · targets
profiles · context · drafts · preflight · delivery_history · health
```

These are exactly the families used by the
[UI/API capability matrix](outreach-v3-ui-api-capability-matrix-v1.md), and a
test asserts every `observabilityFamily` in the capability manifest is one of
them. If 2.2 adds a family, this list must grow with it or the spec fails.

---

## Never logged

```text
goal text · message body · subject · recipient email · recipient
target name · client name · context text · source excerpt · note body
OAuth state · bearer token · campaign prompt
```

Enforced, not merely documented: the spec lowercases the entire synthesized
template and asserts none of these strings appear in any alarm, metric filter,
event rule, or dashboard widget.

Metric dimensions are separately restricted to an allowlist —
`LoadBalancer`, `TargetGroup`, `ClusterName`, `ServiceName`,
`DBClusterIdentifier`. A dimension carrying a recipient or client value cannot
pass. The template is also asserted to contain no email-shaped string anywhere.

---

## Alarms

All eight notify the configured SNS topic.

| Alarm | Condition | Missing data |
|---|---|---|
| `HealthyHosts` | `HealthyHostCount < 1`, 3 of 3 one-minute periods | not breaching |
| `Target5xx` | `HTTPCode_Target_5XX_Count >= 5` in 5 minutes | not breaching |
| `LatencyP95` | `TargetResponseTime` p95 > 3s, 3 of 5 periods | not breaching |
| `Cpu` | ECS `CPUUtilization` > 80%, 3 of 5 periods | not breaching |
| `Memory` | ECS `MemoryUtilization` > 80%, 3 of 5 periods | not breaching |
| `FatalBootstrap` | one log event | not breaching |
| `InvalidShadowPosture` | one log event | not breaching |
| `DatabaseConnections` | above the reviewed budget threshold, 2 periods | **missing** |

`treatMissingData: notBreaching` on the ALB and ECS alarms is deliberate: the
target group is created empty and the service arrives later, so a breach on "no
data yet" would page before there is anything to page about.

`DatabaseConnections` is the exception. It uses `MISSING`, because absent RDS
data means the shared-database signal is gone — and that alarm protects the
**main product**, not the preview. Silence there is not reassurance.

The two log-derived alarms fire on a **single** event. A fatal bootstrap or a
runtime that came up armed is never acceptable, so they do not wait for a trend.

### Log metric filters

| Metric | Pattern |
|---|---|
| `Capiro/EngagementApi/FatalBootstrapError` | `"Fatal engagement-api bootstrap error"` |
| `Capiro/EngagementApi/InvalidShadowPosture` | `"engagement runtime policy rejected"` |

---

## Events

| Rule | Matches |
|---|---|
| Deployment failure | `aws.ecs` · `ECS Deployment State Change` · `SERVICE_DEPLOYMENT_FAILED` |
| Unexpected task stop | `aws.ecs` · `ECS Task State Change` · `STOPPED`, excluding scaling drains |

The stopped-task rule filters out `Scaling activity initiated by …`. A planned
drain is not an incident, and a topic that pages on routine scaling stops being
believed.

---

## Dashboard

One compact dashboard named `capiro-<env>-engagement-api`:

- desired vs running tasks
- CPU and memory
- healthy hosts
- target 5xx and 4xx **counts by status class**
- latency p50 / p95
- shared Aurora connections
- fatal-bootstrap and invalid-posture counts

No widget can render message bodies, recipients, or campaign text, because no
metric carrying them exists.

---

## Where the ALB dimensions come from

Alarm dimensions need the ALB and target group in `app/<name>/<id>` and
`targetgroup/<name>/<id>` form. Both are derived from the ARNs already in the
config — `loadBalancerFullNameFromListenerArn` and `targetGroupFullNameFromArn`
— rather than added as new config fields that could drift from the ARNs beside
them. Both throw on a malformed ARN.

---

## Scope boundary

Micro-session 2.8 adds **no application logging change**. If the current
structured logs cannot distinguish service and route family, that is a separate
reviewed micro-session, not a quiet edit here.

The log group itself is created by the Service stack, because a task definition
cannot exist without a log destination. This construct adds metric filters,
alarms, events and the dashboard on top of it.
