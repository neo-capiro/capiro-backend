# Report JPEG extraction

## Source boundary

This cleanup is based on report readiness PR #65 at
`e305dfbee638023bf51596e576e83fd06144c6d4` (tree
`2a17b05939ef984d68fcb1c1f54b33785cc078b3`). Its report-image facade
remains the sole application-facing module and keeps its four exports:
`readRasterSize`, `sanitizeRasterAsset`, `containSize`, and `containBox`.
The exported `RasterSize` type remains available from that same path.
The PR #65 owner qualified its predecessor with 5/5 focused Jest suites,
31/31 tests, and API Strategy `tsc --noEmit` exit 0.

JPEG parsing, full decode validation, and metadata stripping now live in
`report-jpeg.ts`. PNG parsing and MIME dispatch stay in `report-image.ts`.
The shared dimension and pixel limits live in `report-raster-bounds.ts` so
both decoders apply the same policy without a circular import or duplicate
security limits. No route, Nest provider, database, migration, or package
manifest changed.

## Reachability

`AppModule` imports `StrategyModule`. Its guarded `StrategyController`
report preflight/export routes use `StrategyReportService`, whose DI providers
include the DOCX and PPTX renderers and logo/member-office readers. Those four
production modules import `report-image.ts`; the visual test harness does too.
A repository-wide source search found no dynamic `report-image` registration or
existing `report-jpeg` path. The facade must therefore remain in place.

## Focused qualification

- Frozen, script-disabled offline install in this task-owned checkout: 1290
  packages, zero downloads. The three API Strategy workspace dependencies
  built successfully. Local Prisma client generation passed; no database was
  contacted.
- `report-image.spec.ts` and `report-renderers.spec.ts`: 2/2 suites,
  25/25 tests passed under Node 24 with one Jest worker.
- `@capiro/api-strategy` `tsc --noEmit`: exit 0.
- A source comparison with the exact PR #65 Git blob found the moved JPEG
  function bodies and shared bounds function identical after removing their
  new export modifiers and normalizing the final blank line. The retained
  PNG/facade body was byte-identical.
- `git diff --check`: exit 0.

This qualification covers the changed behavior and source graph. It does not
claim a production build, native database run, image, or deployment.
