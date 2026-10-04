# Independent review — frozen v4 private Case12 reservation owner/census

**Disposition: PASS_SOURCE_LOCAL_PORTS_ONLY**

This is a source/evidence review of the frozen v4 packet only. No DB, cloud/AWS, provider, journal, or native calls were made; no tests were executed in this review; no source files were edited. The only file written is this review. The packet’s recorded independent v4 run reports 74/74 tests passing (exit 0), and its six targeted v3 checkpoint-corruption reproductions all report `accepted: false`. I reviewed the exact v4 source, regression tests, run records, and the bundled Python reducer to assess those claims and the protocol correspondence.

## V4 checkpoint correction: confirmed at source level

The Python protocol’s `reduce_fresh` (windows-capture-spend.py, especially lines 206–237, 273–278, 373–384) derives protocol-3 state from the journal: `knownSettledCostMicros` is the accumulated settled charge; `conservativeApprovalCostMicros` is kept separate; global committed cost is settled plus conservative approval plus any active held ceiling; remaining reservation is the global cap less committed; Case12 usage is settled charge or, while held, the full ceiling, with a separate Case12 remaining amount. It retains the fixed historical-prefix digest and the `UNRESOLVED_SEPARATE_NOT_REPLACED` older-cost boundary. The native reserve path appends one `case12_setup_reserved` row, reduces the resulting journal, flushes/readbacks the journal, and returns updated file identity/hash/byte descriptors.

The v4 owner now checks the protocol-3 snapshot’s exact top-level key set (including the conditional Case12 pair), fixed protocol/global/per-case/prefix/older-cost values, safe nonnegative integer monetary counters and bounds, and the committed/remaining equations with known, conservative, and active-held costs kept distinct. It validates the active held ceiling and derives the Case12 used/remaining pair from Case12 rows. At reserve it constructs the exact expected post-snapshot from the pre-snapshot plus only the one new event, active-run, global-held, and Case12 deltas, then compares the complete snapshot. The exact new row fields/event/sequence/time and event values are checked; previous run keys and rows must remain equal; directory/file key sets and non-journal file descriptors must not change; the journal file identity must remain the same while its hash is a strict hash string and bytes increase. Native uncertainty or an unproved post-reserve result poisons the owner and retains the hold; it cannot retry a reserve.

This closes the prior F1 malformed-string arithmetic and unvalidated-snapshot-delta defect for the implemented source boundary. It preserves settled versus conservative versus held accounting, the global and per-case ceilings, the old-prefix/older-cost boundary, and the exact post-reserve delta. The pre/post checkpoint hashes and provider-plan `aggregateCheckpointSha256` are bound as described in the source and exercised by the recorded local tests. The native reducer remains the authority for deriving the journal snapshot and actual file digest; the factory’s structural checks do not authenticate injected JSON or replace that reducer.

## Census correction: confirmed at source level

The census inspector rejects relevant non-approved tasks by task-definition family as well as task metadata, independently of group/starter labels; it covers API/API-migration, projection-worker, Meri, and every revision of the exact pinned nightly family. The v4 tests include projection service overlap, the exact nightly definition with absent and unrelated starters, an older nightly revision, and a foreign-group API-family task. Reviewed census hash/pin fields are required to be strings before regex validation. The fixed read plan uses one AWS CLI attempt, and target enumeration explicitly includes `--no-paginate` (as does the RUNNING task list). These are read-plan data and pure inspection only, not proof of transport execution or authenticated AWS observations.

## Prior findings and provenance

The preserved prior Hermes review (`evidence/prior-review/review.md`, SHA-256 `09bdeb539d25345b7385e3923d1dfce96253daa55c76ed46afe12cb6de8fb1a1`) and independent assessment remain intact. Its six accepted v3 checkpoint-corruption cases are now rejected in the v4 recorded reproduction (`evidence/independent/checkpoint-repros.json`); the committed-string case rejects at construction, and the five post-reserve mutations reject with the poisoned-hold outcome.

F2 is not treated as a demonstrated live AWS bypass: changing command/roles in synthetic JSON while retaining the same exact immutable task-definition ARN is not an actual revision mutation when the approved ARN and native response are authenticated. The census inspector still is not native authority. A separately fixed native transport and reviewed immutable approved pins/configuration remain mandatory; synthetic JSON must not be promoted into authority.

F3 remains an explicit root-composition prerequisite, not qualified by this pass. The factory’s `bindDispatch`/`bindTask` shape gates do not prove exact serialized helper bytes, their hash, an authenticated RegisterTaskDefinition/RunTask acknowledgement joined to that exact input and task definition, or same-acknowledged-task readback. Before any live use, root must enforce exact serialized bytes and size, one dispatch/one claim with no replay, authenticate the registration/run acknowledgement and joins, and allow only same-task readback. Production `nativeRequest`, `consumeCostAuthority`, the actual compiled provider-plan validator/deterministic planner, and native cost-authority/census composition are also still required. The source factory is not native authority.

The provenance distinction is preserved: the configured Hermes v2 implementation attempt timed out at its 720-second bound (exit 124) without source; the candidate v4 implementation is supervisor-authored. The separate prior configured Hermes v1 review and its findings/assessment are preserved. This review does not attribute the v4 candidate to the timed-out implementation attempt or overwrite that raw failure record.

## Evidence reviewed

- Candidate owner SHA-256: `e56bacef6c6c6cbee954797ad9aba9451cef713d03e153becc238d3a6146dba5`
- Candidate census SHA-256: `ba44d0c89175654da6f624e2a444b5f0e21cfc70fe41879d84ef1e1ecbd08aac`
- Python protocol source as captured in the packet, including `reduce_fresh` and `execute_fresh`
- Recorded v4 test log: 74 passed, 0 failed; execution record exit 0, explicitly synthetic/controlled ports only
- Independent checkpoint repro record: all six prior accepted corruptions rejected
- Census and checkpoint regression tests; v4 notes, manifest, and preserved prior review/assessment

**Limit:** This is source-local and recorded-test evidence only. No setup, capture, live acceptance, native-port qualification, dispatch, shipping, or production readiness authority follows.
