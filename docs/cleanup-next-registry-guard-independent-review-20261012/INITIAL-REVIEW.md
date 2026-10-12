# Independent registry ownership prototype review

Frozen prototype `9c7bd2de80ae29fd2987fc3b079ca326295cdfcb`, tree
`5451288b936e08c505c5fd9ca5a0896bcdf6bd56`, is **not accepted**. The 31 original
author controls reproduce as passing, but the additional inert corpus records
17 red expectations among 24 probes. This is a source-prototype review; no
deployed authorization bypass or application behavior change is claimed.

The only evaluated implementation is the pure guard itself on synthetic
`Map<string,string>` source data and JSON-shaped configurations. Application
source strings are parsed/bound as data, never imported or evaluated. No
production module, real registry profile, provider, message, model, DB,
migration, native Prisma, credentials/permissions, AWS or network operation
ran. This worktree changes only this independent review packet. The prototype
and all original tests remain byte-identical.

## Findings requiring repair or an explicit bounded contract

| Finding | Source | Exact additional evidence and practical scope |
| --- | --- | --- |
| A declaration is treated as a named module export without proof | `check-registry-ownership.mjs:22–40,128–144` | Non-exported, function-nested, namespace-nested and default-only `canonicalRoute` each produce `errors: []` with a consumer's runtime named import. The edge checks only the consumer's local import symbol; the owner need not actually provide that named export. |
| A consumer can import a nonexistent owner export | `:73–96,138–144` | The profile/consumer can name `absentExport` while the owner's canonical declaration remains `canonicalRoute`; the guard accepts. Neither source export existence nor edge-to-owned-symbol correspondence is checked. Configuration is evidence, not proof that the module provides a binding. |
| Destructured variable copies escape the declaration census | `:25–31` | Object shorthand, renamed object and array destructuring bindings named `canonicalRoute` in another scoped file are accepted. `add` discards all non-Identifier binding names. Existing plain/nested function and class-method duplicate controls do not cover these forms. |
| A variable's declaration fingerprint loses statement semantics | `:43–51` | `export const vocabulary` and `export let vocabulary` hash equally, as do exported/local variable statements. Printing only the `VariableDeclaration` omits declaration-list flags and outer statement export modifiers. This contradicts the stated modifier preservation. Literal changes still alter the digest. |
| Duplicate proof entries pass | `:116–150` | Duplicate symbols, exact edges and exact carriers all pass. Profile IDs are deduplicated, but members are not. A malformed data profile can appear to contain more independent ownership/consumer/carrier proofs than it has. |
| Edge/carrier scope is not closed to its profile | `:126,138–149` | A supplied source Map can contain a consumer or carrier outside that profile's roots and pass. A single-root CLI may omit such files and then refuse, but the pure function and a multi-profile union can see them. Profile-level closure must be explicit. |
| Parameter bindings are outside the ownership census | `:29–37` | Plain and destructured parameters carrying the owned identifier pass. These two probes are conservative global-namespace strengthening checks. They are not duplicate implementations or runtime bypasses by themselves. If the intended protocol tracks only registry/implementation declarations, state that limitation and retain actual consumer import-shadow checks. |

The first four findings block the proposed ownership/export/carrier claims.
The next two need a closed profile contract. The parameter probes must not be
silently counted as a deployment flaw: either adopt a defined all-binding
namespace protocol or explicitly bound the ownership census and its claims.

## Suggested bounded repair

Verify each owned symbol as one allowed top-level named export in the owner
source. Refuse nested/default-only/local declarations for that protocol, or
explicitly implement and test a finite export-alias protocol. Inspect the owner
AST's exports for every consumer edge; a named import in a different file cannot
prove that export. Runtime imports must not borrow erased interface/type exports.
Do not perform module execution or filesystem resolution to establish this.

Recursively enumerate owned bindings in object/array binding patterns, with
renamed property keys distinguished from actual local names. Keep lexical
consumer reference proof based on the exact imported symbol and current
shadowing, not name-text matches. Clarify whether parameters/imports/type-space
bindings are declaration-uniqueness subjects; canonical named imports must not
be falsely counted as duplicate owner declarations.

Fingerprint a variable's complete declaration context, including its declaration
list flags and outer statement modifiers, while preserving the intended
comments/whitespace normalization. Multi-declaration/destructuring/loop/nested
variables need a deliberate supported-or-refused protocol. Reject duplicate
symbol/edge/carrier entries and require all owner/edge/carrier paths to belong
to that exact profile's roots, even when another profile supplies the source.

Retain the original 31 names and bodies, all raw original passes and the exact
red corpus. Add permanent inert controls and rerun the unchanged independent
corpus against a newly frozen repair head/tree. Do not rewrite the original red
result or count a deliberately narrowed parameter policy as a repair without
explaining it.

## Passing controls and remaining gates

All 31 original author checks pass in this environment. The independent corpus
also passes canonical baseline, plain duplicate declaration refusal, namespace
import refusal, parameter import-shadow refusal, literal-sensitive digest,
comments/whitespace normalization and a source string containing an inert throw.
Those positives do not close the additional findings.

The prototype has no canonical `registry-ownership.json` at this frozen head;
its CLI/configuration is intentionally incomplete and not accepted. No actual
canonical profile, package alias, CI wiring or clean configured native tooling
was assessed. Later root-owned data/CI/package work requires its own exact source
identity and re-review. Application facade/extraction edits remain held pending
parent path/retirement coordination. No production-dead-code or retirement
acceptance is inferred from this prototype.
