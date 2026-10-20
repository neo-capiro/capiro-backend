# Core and Meri first-chat listener priority candidate

Source-only proposal, 17 October 2026. Publishing this document or rendering its
templates does not authorize an ALB, DNS, target group, service, or security write.
The shared HTTPS listener is
`arn:aws:elasticloadbalancing:us-east-1:967807252336:listener/app/capiro-prod-alb/7a4acb332b261724/e2d19b3dd47fc440`.
This proposal starts from the read-only `describe-rules` snapshot in
`infra/routing/capiro-prod-alb-snapshot.json`; a future operator must fetch and
compare a fresh snapshot before each change. Do not infer production listener
ownership from the deleted `ComputeStack` ALB.

## One reserved map

| Priority | Candidate rule | Change from observed listener |
| --- | --- | --- |
| 1, 2 | Core bounded POST forwards | none |
| 3 | Core bounded GET forward | PR62 source only; held |
| 4 | same retained Core host-only JSON 404 guard | PR62 moves its existing physical rule from 3 |
| 5 | `app.capiro.ai` engagement integration callbacks | none |
| 6 | one exact `meri-preview.capiro.ai` host-only rule | new, initially fixed JSON 404; qualified forward and rollback alter **only its action** |
| 7 | engagement preview header + `/api/engagement/*` | existing physical rule from 6 |
| 8 | `/webhooks/recall` and `/webhooks/recall/*` | existing physical rule from 7 |
| 9 | `onboarding.capiro.ai` host | existing physical rule from 8 |
| 10–15 | production `/api/*`, `/strategy-api/*`, `/workspace-api/*`, `/meri-api/*`, `/intel-api/*`, `/webhooks/*` | none |
| 16 | `/onboard-api/*` on any host | existing physical rule from 9 |
| 20, 50, default | marketing, Web VNext, production web | none |

The Meri rule must be at 6, not at 9: old rule 6 has no host condition and
matches a preview-header request for `/api/engagement/*`; old rule 7 has no host
condition and matches `/webhooks/recall*`. Either would preempt a Meri rule at
9, including while its action is a fixed denial. Rules 1–4 require the separate
Core host and rule 5 requires `app.capiro.ai`, so a rule at 6 receives every
Meri-host method, path, and header. It does not narrow or modify production
`/api/*` at 10.

The existing rule 9 may move after rules 10–15 without changing its matches:
`/onboard-api/*` is disjoint from all six intervening path prefixes, and the
moved rule stays before host rules 20/50 and the default. All other existing
rules keep their relative order. The offline exact-snapshot test must prove
this for every intermediate state, including boundary and header cases; source
review must reject any counterexample before a live plan is approved.

The four proposed relocations identify existing **physical** listener-rule ARN
suffixes, not new rules. Each retains its captured conditions, action, and
target group; the full listener-rule ARN prefix and target ARN are pinned in
`capiro-prod-alb-snapshot.json` and must match a fresh readback.

| Existing rule | Observed ARN suffix | Move |
| --- | --- | --- |
| Onboard path | `dac3fbd914769700` | 9 to 16 |
| Onboard host | `878247ea681750a9` | 8 to 9 |
| Recall webhook | `0e2faafaa4c69a9d` | 7 to 8 |
| Engagement preview | `31705c7bdd372a94` | 6 to 7 |

## Reviewable operator sequence — no step executed by this source change

1. Name the shared-listener operator and obtain separate approval for the
   four manual, same-ARN relocations, the retained Meri rule, and any later
   Core PR62 guard/GET changes. Freeze other priority allocations. Verify the
   account, region, listener ARN, every affected physical rule ARN,
   condition, action, and target against a **fresh** `describe-rules` read.
   Priority 16 must still be vacant. Do not use the scripts' `--create` or
   `--delete` modes to relocate rules.
2. Move the existing rules in this exact vacant-destination order:
   **9 to 16, 8 to 9, 7 to 8, 6 to 7** using `SetRulePriorities` on each already identified
   physical ARN. After each move, read back the whole listener. Require the
   same ARN, unchanged conditions/action/target, no duplicate priority, and
   the next destination vacant. Stop on drift or uncertain response. The
   candidate routing matrix must still match the original for all existing
   non-Meri traffic at each point.
3. Create the new exact Meri host-only rule at 6 with fixed JSON 404 and
   retention. Read back its physical ARN, host condition, priority, and action;
   test the Meri-host negative matrix **before** creating a public DNS alias.
   The new CDK source is intentionally not mounted in a deployable app here.
4. Core PR62 is a distinct, CloudFormation-owned change: update the retained
   Core guard stack from 3 to 4 through its reviewed stack procedure, verify
   the same physical rule ARN and fixed JSON 404 action, then add bounded GET3
   through the reviewed service stack under its target-health and approval
   gates. Do not manually run `SetRulePriorities` on the Core guard. This
   sequence may occur before step 2, but neither team may reuse priorities
   3, 4, or 6.
5. A later, separately approved Meri qualification may change the **same
   rule's action** at 6 from 404 to one reviewed Meri control target group.
   Verify same ARN, priority, exact host condition, and all-path forwarding;
   target health or an application 404 is not proof of native first-chat
   admission. Publish DNS only after the deny boundary and target gates pass.

Routine rollback is action-first: change Meri rule 6 back to fixed JSON 404,
read back the **same ARN and action**, then drain or stop Meri targets and remove
DNS under its own approval. Retaining a rule while it still forwards is not a
deny. Leave the priority-6 denial in place while the host can reach this ALB:
removing it would expose Meri-host `/api/*` to production rule 10, including
requests with a cached DNS answer or an explicit Host header. The four moved
manual rules remain at 7, 8, 9, and 16 during this routine rollback.

Before Meri rule 6 exists, the source-neutral reverse order is 7 to 6, 8 to 7,
9 to 8, 16 to 9 after confirming each destination is vacant. Once Meri rule 6
exists, that full topology reversal requires a separately reviewed replacement
host-isolation boundary; DNS TTL passage alone does not prevent explicit Host
requests. Core's independent rollback removes GET3 through its service stack
before updating the retained guard stack from 4 to 3, with a verified guard
throughout.

## Source ownership and qualification

- `infra/routing/capiro-prod-alb-priorities.json` is the single proposed
  priority reservation. Its exact-snapshot test must compare rule identities,
  every intermediate route, and the final denial/forward/denial states.
- Core `infra/cdk/lib/preview/first-chat-core.ts` retains its PR62 GET and
  guard sources. Only priority constants/comments and cross-source assertions
  are added here; image, target group, ECS desired count, and auth stay fixed.
- `scripts/engagement-api-alb-rules.sh` and `scripts/onboard-alb-rules.sh`
  receive the candidate defaults 7 and 9/16. They do **not** perform the
  relocation. Their future mutating invocations must refuse a live listener
  still in the old layout. The onboard deletion path must verify both exact
  physical rule shapes before either deletion.
- The new Dot-owned `infra/cdk/lib/preview/first-chat-meri-ingress.ts` renders
  only one unmounted retained rule. Fable's product manifest still owns no
  listener or DNS. Its reviewed target group/source/image qualification and
  listener/zone approvals are separate.

Focused tests must include: Core POST and bounded GET versus guard; ordinary
engagement callbacks; preview-header and Recall overlaps; onboarding host and
hostless `/onboard-api/*`; each production API prefix; marketing, Web VNext,
and default; Meri `/`, `/api/*`, `/webhooks/recall`, `/onboard-api/*`, and
preview-header `/api/engagement/*` across GET/POST/OPTIONS. Test each of the
four intermediate rule moves, the denied Meri insertion, forward-only action
change, and rollback to deny. Assert Meri-host traffic never selects the
production API, engagement, or Recall target. Synthesis must show one Meri
listener rule, a stable logical ID, and an action-only forward/rollback diff;
it must show no DNS, target group, service, IAM, or security resource.
The offline evaluator models the frozen predicates on supplied paths; it does
not implement ALB URI normalization. A later approved execution must include
denied-host probes for encoded and normalized path variants after each
listener change before DNS or forward activation.

The live owner of rules 7–9 is not established by ELB tags or CloudFormation
reverse lookup. A source PR is evidence to review, not approval to alter
those manual rules. The exact live request is: approve the verified same-ARN
four-rule relocation and a retained priority-6 Meri host denial under one
named shared-listener operator, with fresh readback and stop-on-drift gates.
Core GET, Meri forwarding/DNS, and all service activation remain separate
approval requests.
