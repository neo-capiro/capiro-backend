# P1 canonical meeting normalization correction — source only

This is an additive successor to frozen 4e850f5f367bdf9843d356627a2b7b6c5149258d, responding to independent RETURN 7045b2be75d822a78a226136a540f98abd7b05c2b87c9be6892fb84af7cc283b. The original candidate, its SQL/evidence and every existing migration remain intact. No PostgreSQL connection, SQL execution, role/grant/application operation, runtime/library upgrade or deployment occurred. Parent retains those actions; this source requires the same independent review.

## Exact composition

Use these source artifacts for subsequent parent-owned qualification, in order:

1. 00-canonical-contact-helper-forward.sql in this directory.
2. 01-meeting335-canonical-forward.sql in this directory, **replacing the unqualified proposal** in the frozen domain directory as the planned meeting predecessor. Do not apply both proposals.
3. The byte-identical ../private-sql-db-domains-20261031/02-research-classic-forward.sql.
4. The coupled successor private-sql-db.service.ts, generated normalization pins and canonical runtime admission.

No migration identities are assigned here. Existing14 view definitions are unchanged. The corrected meeting view changes only contact normalization and its prerequisite. Same tenant/actor/client/manual/ownership predicates, explicit-assignment precedence, existence/multiplicity semantics and both saved meeting-side OPERATOR(public.=) citext expressions remain unchanged. Research/Classic scopes, fixed projections, GUC binding, 19-view/23-tenant-source catalog, 266 owner source columns, users4 and existing raw/helper-view denial remain unchanged. One pure scalar function is the necessary added owned object.

## Canonical algorithm and data

The helper implements trim().toLowerCase() for all strings representable in the existing PostgreSQL UTF8 text storage domain. It never calls server lower, ICU, locale-aware regular expressions, external code or data tables. No new alphabet, address or input-length restriction is imposed. PostgreSQL UTF8 cannot store U+0000 or surrogate code points; the offline comparison also covers U+0000, while the parent SQL corpus covers the actual storage domain.

Generation independently parses the exact Unicode17 UnicodeData.txt simple lowercase mappings, unconditional SpecialCasing.txt mappings, and DerivedCoreProperties.txt Cased/Case_Ignorable properties. The only locale-neutral contextual lowercase rule in that pinned SpecialCasing file is Final_Sigma; the generator asserts this exact list and refuses an unexpected rule. Locale-specific Lithuanian/Turkish/Azeri mappings do not belong to JavaScript default toLowerCase.

The generator then compares those independently parsed definitions against **every one of the 1,112,064 Unicode scalars** in the pinned canonical Node runtime, including identity/unassigned code points, property overlaps and ECMAScript trim membership. It produces 1,488 changed lowercase mappings, 7,158 context-property code points, and exactly 25 trim code points. Unconditional multicodepoint lowercase is retained, including U+0130 -> U+0069 U+0307. Newer mappings such as U+1C89 -> U+1C8A and U+10570 -> U+10597 are data entries, not exceptions.

The SQL helper trims only the explicit ECMAScript character set and splits the remaining UTF8 text into scalar characters. Its reverse pass records whether the next non-Case_Ignorable original character is Cased; its forward pass tracks the preceding equivalent witness and applies final sigma only when preceded by a Cased witness and not followed by one. Case_Ignorable takes precedence when a scalar has both properties. All state comes from original input characters, never already-lowercased output. Other characters use the pinned mapping or remain unchanged. Mapping/property JSON is dollar-quoted and trim characters use chr values, so parsing does not depend on standard_conforming_strings.

PostgreSQL documents UTF8 ascii/chr as Unicode code-point operations and NULL-delimiter string_to_array as splitting into characters: [PostgreSQL16 strings](https://www.postgresql.org/docs/16/functions-string.html). Unicode defines the default/simple/unconditional/contextual relationship in the pinned [SpecialCasing17 data](https://www.unicode.org/Public/17.0.0/ucd/SpecialCasing.txt). Generated Unicode data is covered by the adjacent UNICODE-LICENSE.txt (Unicode License V3); source data copyright Unicode, Inc.

## Runtime and definition admission

private-sql-normalization-runtime.ts is lazy and has no import-time effects. Before obtaining any DB client, it requires the exact canonical implementation tuple:

node24.22.1 / v8 13.6.233.17-node.58 / ICU78.3 / Unicode17.0.

It computes once per process a semantic SHA256 over every scalar's nonidentity lowercase mapping, Cased/Case_Ignorable/trim behavior, then both FinalSigma contexts for every relevant scalar (including overlaps, repeated ignorables and adjacent sigma). It compares this to the generated fingerprint. The exact runtime tuple pins the implementation of the normative algorithm; the full data/behavior fingerprint prevents accepting matching version labels with different tables or relevant behavior. The computation consumes the existing request deadline and does not widen a query budget. This is an availability guard, not a new authorization owner.

The actual canonical *deployed* runtime is not asserted to match this locally observed tuple. Parent/Release must verify the intended artifact tuple and semantic fingerprint before the transition. A different canonical implementation fails closed; this task neither upgrades it nor treats a different version as implicitly compatible.

The role check requires exactly one named helper with the exact text signature/argument metadata, PL/pgSQL language, nonlogin projection owner, SECURITY INVOKER, immutable/strict/parallel-safe flags, no leakproof/definer/support/default/OUT behavior, exact search_path=pg_catalog config and exact SHA256 of its complete pg_proc.prosrc. The body hash binds its full algorithm and generated data. It also rejects any other owner/reader-owned function.

The function has no data access, dynamic SQL, definer authority or PUBLIC grant. Its owner retains ownership and the dedicated reader receives non-grantable EXECUTE only. PostgreSQL requires callers of a view to be able to call its referenced functions even for owner-owned views; hence that exact reader EXECUTE is necessary ([CREATE VIEW notes](https://www.postgresql.org/docs/16/sql-createview.html)). The ACL check rejects PUBLIC, other grantees and reader grant option. The helper is absent from model SQL allowlists and source catalogs. The dedicated reader can intrinsically transform supplied text through this pure helper; it cannot acquire data or privileges by doing so.

## Offline evidence and reproducibility

generate.mjs accepts an explicit local UCD directory and performs no network/database access. All three source file SHA256 values and every generated algorithm/data/runtime/body pin are in normalization-pins.json. The original ICU-based SQL's canonical hash is checked before deriving the corrected meeting proposal. Running the generator on the pinned inputs reproduces all generated outputs.

Example commands, from the checkout:

    node docs/private-sql-db-normalization-20261031/generate.mjs <owned-offline-UCD17-directory>
    node docs/private-sql-db-normalization-20261031/verify-offline.mjs

The generator requires the canonical tuple above. Parent already has the three downloaded official source files in the additive author evidence directory normalization-ucd17; do not fetch mutable “latest” data as a substitute. Source URLs are exactly https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt, https://www.unicode.org/Public/17.0.0/ucd/SpecialCasing.txt and https://www.unicode.org/Public/17.0.0/ucd/DerivedCoreProperties.txt.

verify-offline.mjs extracts actual mapping/property/trim constants from emitted SQL and models its two passes. It compares all scalars, 3,336,192 scalar context cases and 14,558 context/trim sequences to native JavaScript; all four combinations of Cased/Case_Ignorable are covered. Context sequences exercise all pairs of property-class strings up to length three, adjacent sigmas, multicodepoint output, newer-Unicode characters and long ignorable runs. This is source/algorithm proof; it is explicitly **not PostgreSQL parsing or execution**.

Focused Jest exercises actual runtime fingerprint/version refusal, service refusal before DB access, and the helper's admitted definition/ACL contract, preserving the earlier transport/capture/deadline tests. Scoped TypeScript covers the affected production/service/runtime dependency closure. Existing unaffected registry/domain evidence is reused.

## Parent-owned qualification still required

qualification-normalization.mjs has no driver, connection, credential, fixture writer or CLI. It exports a finite corpus and a read-adapter assertion function for the parent's existing isolated actual-role harness. Parent must allocate its bounds before running it. The corpus covers every PostgreSQL-representable scalar individually and in three FinalSigma contexts, plus all property-class sequence/trim cases and long runs. Queries are read-only, batched at 1–4096 strings (default1024), and use the supplied parent's cancellation/deadline callback; no source rows are read or copied. Null STRICT behavior is a separate assertion.

Required actual checks:

- Parse/apply only the exact canonical helper/corrected meeting/domain source in the isolated schema and authenticate as the actual dedicated reader, not admin SET ROLE. Check exact stored body hash, signature, flags and ACL. Run the full normalization corpus. Repeat the smaller changed-mapping/context set under the server's actual old ICU/default locale and any relevant standard_conforming_strings setting to show the helper does not depend on those settings.
- Compare actual saved meeting association results to the canonical ordinary Prisma reader under the **unchanged real citext type/operator/column collation**, including uppercase and lowercase U+1C89/U+1C8A and U+10570/U+10597, U+0130, final sigma, duplicate contacts, padded contacts, padded meeting-side values and all accepted ownership/association cases. Helper equality alone does not establish this separate boundary.
- In isolated rollback cases, tamper with body/data, signature/defaults, owner, definer/leakproof/strict/volatility/parallel flags, path/config, ACL, reader grant option, PUBLIC/other execute grant or added owner-owned function: strict role admission must fail. Missing helper, missing reader EXECUTE and wrong canonical JS runtime/fingerprint must fail before data is released. Restore and requalify between cases.
- Reuse and complete the unchanged Research/Classic/raw/helper-view/currentness/pool/catalog-transition matrix in the frozen domain qualification document. Keep all new sources unavailable until the coupled gates and source/wire receivers are ready.

The prior ICU-existence/sample shortcut is superseded for this proposed implementation. There is no assumed equivalence with ICU67 and no need to change the server ICU: the helper carries its case data. Actual PostgreSQL/citext qualification, independent exact-successor review, final migration identities and coordinated source/schema release remain open.
