# Independent source review receipt

Reviewed by `/root/independent_source_review`, independently of the implementation authors. Fresh review began **2026-10-17 00:30:36 UTC** after the publication approval rejection and completed **2026-10-17 00:32:24 UTC**. This receipt is outside the repository; the reviewer made no implementation or index changes.

**Decision: ACCEPTED for the reviewed-source prerequisite of draft publication. No remaining source findings in the exact tree below.** This is source review only. It does not authorize native database setup, deployment or live authority changes, and it does not override an approval tool decision.

## Exact reviewed source

- Repository: `C:/Users/Administrator/Documents/Codex/2026-10-16/task-5/objective-planner`.
- Exact reviewed Git tree: `a5a7542d2fd3b936d1134fc5f1b76880199308a0`.
- Parent/current HEAD: `b8b7262aa0ae8b4d9ef30e75df41b147b2d6e3cf`.
- Scope: **31 files, 4,342 insertions, 1,258 deletions**. These include the shared complete application/materialization codecs and types, existing Strategy adapters/type reexports, internal predecessor reader and guarded runtime regeneration composition, Core applied/native-consent/witness/read-gate code, their checked-in tests/fixtures and the two evidence documents.
- `git diff --cached a5a7542d2fd3b936d1134fc5f1b76880199308a0 --exit-code`: **0**, no differences. The actual index equals the reviewed tree.
- `git diff --exit-code`: **0**, no differences. Tracked working source equals the index; tests therefore exercised that exact indexed source.
- `git diff --cached --check`: **0**.
- No staged changes to either migration directory, the central `objective-work-command.ts`, shipping scripts or `.github`.
- Exact equality and scope checks were repeated after the fresh tests and adversarial experiment, immediately before writing this receipt.

## Earlier hash-dialect blocker: freshly verified resolved

The original Objective `digest` builds sorted ordinary objects and then uses `JSON.stringify`. Integer-like keys therefore enumerate numerically. The application/regeneration hash explicitly serializes lexical keys. For example, keys `2` and `10` produce different byte order under those two conventions. They must not be substituted for one another merely because a value is finite JSON.

Fresh inspection of the **indexed production** `apps/api/src/clients/objectives/work/objective-planner-applied.ts` confirmed:

```ts
const objectiveDigest = (value: unknown) =>
  sha256(JSON.stringify(JSON.parse(application.applicationJson(value))));
const materialization = createPlannerMaterializationCodec({
  sha256, digest: objectiveDigest,
  canonicalRegenerationHash: application.applicationHash,
  plannerCalendarDate: plannerResourceCalendarDate,
  materializationError: invalid
});
```

The strict application JSON validation occurs before parsing/stringifying. On that validated JSON domain, parsing recreates ordinary object enumeration and preserves the original Objective digest, including nested integer-like keys. The lexical application/regeneration convention remains separate. The Strategy adapter continues injecting the actual existing Objective `digest` and actual `canonicalRegenerationHash` functions.

The checked-in `objective-planner-shared-codec.focused.test.mjs` imports the actual original Objective digest source. It explicitly checks that the conventions differ on numeric keys and that both valid numeric-key v2 and v3 snapshots decode positively. Those cases were rerun in this fresh review.

The reviewer also performed a new read-only adversarial experiment against the actual production Core decoder, through the checked-in source fixture loader:

1. Original Objective digest agreed with the preserving adapter for both plain and nested numeric-key objects; lexical application hash remained different.
2. Real full numeric-key v2 and v3 receipts decoded successfully: **2/2**.
3. For each receipt, the snapshot digest was replaced with the wrong lexical application hash and all affected work, fingerprint, request, ACK, owner-receipt and head hashes were coherently recomputed. The actual production decoder still rejected both: **2/2**.

This checks the production injection and rejection behavior after the earlier blocker, rather than relying only on an implementation author's assertion or a fixture-only hash helper.

## Complete codec, regeneration and Core review

Fresh parent-versus-index AST comparison used `git show` of the actual parent commit and indexed new codec files. **44 materialization declarations and 30 application declarations retained equivalent bodies** after removing export placement and adapting only the explicit proxy reference. The only other differences were the intended materialization error transport, SHA-256 receipt-ID port and application SHA-256 port. The checked-in exact-body parity/API/error-identity tests also passed. Original v2/v3 validation, recursive predecessor reconstruction, hostile-value rejection and HTTP adapter behavior are preserved. Shared runtime files add no Node, Nest, Prisma, network or database dependency; their platform services are injected through the explicit factory ports, and the new subpath is excluded from the shared root barrel.

The indexed runtime/helper and Core changes were freshly inspected alongside their tests:

- Initial preparation retains the exact application/materialization/project/task no-prior-effect checks, including archived outputs. Regeneration separately requires real saved schema-2 basis custody, complete full-codec predecessor application/owner ancestry and original durable operation accounting. Existing predecessor outputs are retained rather than relabeled absent.
- Inventory includes the same Objective, the target canonical plan and unscopable private evidence. Exact current application/owner IDs cannot hide behind malformed kind or embedded scope. Unknown, orphan, incomplete, foreign-Clerk or overflow evidence refuses eligibility. The cached-current-saved-generation optimization explicitly rejects a mismatched original Clerk.
- Eligibility is checked before reclaim CAS, after actual effect grant, before preparation and before inactive accounting. The existing same-transaction application/output/accounting and final release-fence behavior remains. Original operation identity and generation/issuance/consent deadline caps are preserved; retained reads do not renew effect authority.
- Core applied accounting uses the same complete shared codecs and reconstructs native consent, command receipt, root intent, immutable revision, original membership and Clerk lineage for every ancestor. Historical membership is not treated as current authority. Timestamp handling correctly validates PostgreSQL offsets/microseconds; malformed and newline-suffixed values are rejected.
- The optional early WorkService read hook acquires the Planner gate before Core authority/state locks in the existing proof transaction. Current native proof and release checks, public HTTP verification and ordinary-chat behavior are retained.
- The advanced-source witness is closed, scoped and strictly newer. It retains the original `accounted/applied` identity. The central command kernel is unchanged and still refuses applied retry; new consent integration is expressly documented as awaiting allocation. The owner witness is not a new dispatch or authority grant.

## Fresh independent execution

All commands used the existing **Node v22.23.3** installation and task-owned source/typing mappings. No dependency installation, external service, browser, PostgreSQL connection or native authority was used.

| Checked-in focused checks independently rerun | Result |
| --- | --- |
| Shared full codec + Core owner + structural advanced-source witness Node suites | 117/117 passed |
| Actual WorkService status suite, including full-v2 positive accounting and coherent corruption/native lineage negatives | 30/30 passed |
| Historical native-consent proof suite, including non-UTC/microsecond and malformed inputs | 34/34 passed |
| Actual internal predecessor reader/read-fence guards | 9/9 passed |
| Regeneration binding and mounted runtime eligibility, including persisted three-generation ancestry | 30/30 passed |
| **Total fresh independently rerun checked-in cases** | **220/220 passed, zero failures/skips** |

Fresh strict TypeScript runs also passed with exit 0 for all four task configurations: pure shared codec (`types: []`, ES2022), actual Core owner import graph, Strategy runtime/application graph and regeneration qualification graph. The additional adversarial numeric-key experiment above passed separately and is not counted as checked-in tests.

## Evidence limits and approval boundary

The source fixtures, SQL observations and transaction fakes are explicitly synthetic. This receipt establishes source behavior and review, not native locks/RLS, transport failure, deployed behavior, frontend acceptance or a full application build. The documented 256 aggregate-row bounds and conservative rejection of earlier-binding failed/cancelled history remain intentional limitations.

The prepared native runner is pinned to parent `b8b7262aa0ae8b4d9ef30e75df41b147b2d6e3cf`, not this successor. Its isolated setup request was denied by automatic approval review before process creation because it creates disposable credentials and applies schema SQL under the original restriction. No native setup or workaround occurred in this review; that denial remains unresolved.

The separate GitHub publication request was also rejected before execution on the reviewed-source prerequisite. This fresh receipt supplies exact-index, post-hash-fix independent review evidence. The reviewer did **not** publish, retry publication or delegate publication. Any normal retry and approval decision belongs to the parent coordinator/tool; this receipt does not claim that publication succeeded.

**Final source verdict for `a5a7542d2fd3b936d1134fc5f1b76880199308a0`: no remaining source findings; accepted for source-only draft publication review.**
