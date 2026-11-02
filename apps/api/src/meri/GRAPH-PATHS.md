# Current source-linked graph paths

`find_path_to` uses the existing `loadMeriGraph` owner and its current tenant,
actor-private memory, client-wall and governed-memory filters. A selected client
is passed into that source read before target handling. An inaccessible target
and an absent target both produce no returned route, without an existence claim.

The operation returns one deterministic shortest path per visible client, up to
five hops and twenty paths. Each edge retains exact canonical source references:
client-person IDs, tracked client/bill tuples, memory-item IDs, or logical cache
projection keys. Structural relationships are `direct`; analyst mentions are
`thematic`; cache projections are `derived`. These categories do not establish
influence or an ability to make an introduction. Derived keys identify a cache
projection, not a primary document. Path edges do not inherit rounded monetary
labels from the legacy graph presentation.

Path-only source reads use lookahead limits: 200 clients, 2,000 memory items,
4,000 memory edges, and 2,000 rows in each structural relationship source. The
canonical cache owner retains its own bounds. Every reached source limit,
missing governance schema, missing edge reference, path cap, or traversal cap
produces explicit partial coverage. Cache paths always disclose their bounded
projection because its depth/fanout cannot establish exhaustion. Traversal has
a shared 20,000-step ceiling. Existing overview output retains its prior shape.

`complete` means the declared search finished within this authorized projection
and depth. It does not mean every possible relationship is known. The output is
explicitly `current_only`; no historical window is accepted or fabricated from
the separate temporal Knowledge Plane owner.

Tests exercise the real path implementation and PostgreSQL source reads with
synthetic rows, including General and client wire vectors, walls, tenant and
private-note isolation, access revocation, memory expiry, bounds and unavailable
cache behavior. The old copied BFS test implementation is removed. The optional
`MEMORY_GRAPH_FIXTURE_FILE` keeps a local fixture and its private connection data
for reuse; the shared harness closes connections while preserving that database.
No production database, migration, model call or deployment is involved.
