/**
 * WS-D — build browser-safe district boundary artifacts (District Nexus).
 *
 * Two source rails, one output format:
 *   current ('C'): Census cartographic national CD shapefile -> GeoJSON
 *   future  ('F'): LegiStorm KML, read from OUR OWN S3 (kmlS3Key) -> GeoJSON
 *
 * Usage:
 *   pnpm --filter @capiro/api build:district-boundary-artifacts                        # DRY RUN
 *   pnpm --filter @capiro/api build:district-boundary-artifacts -- --commit
 *   pnpm --filter @capiro/api build:district-boundary-artifacts -- --status=C --states=TX,WY
 *   pnpm --filter @capiro/api build:district-boundary-artifacts -- --commit --status=F
 *
 * Dry run by default (house convention): fetches and validates everything,
 * prints the summary, writes NOTHING to S3 or the database.
 *
 * The vendor KML URL is never touched here — only `kmlS3Key`, the re-hosted
 * copy in our own bucket. The raw LegiStorm URL embeds our API key in its
 * path, so re-fetching it is a secret-handling problem, not a convenience.
 *
 * PRE-REQ for --status=F: `kmlS3Key` is only populated by
 * `sync-legistorm-districts --commit --with-kml`, which the weekly cron does
 * NOT pass. Until that backfill runs, the future rail has no input and this
 * script reports zero future features rather than failing.
 *
 * Commit execution is wrapped in runWithSyncRun so the run lands in sync_run
 * and emits exactly one INGESTION_METRIC, like every other ingestion job.
 */
import { gzipSync } from 'node:zlib';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import {
  artifactKey,
  buildCollectionFromCensus,
  buildFeature,
  grossCentroidMismatch,
  hashArtifact,
  kmlToGeometry,
  manifestKey,
  toFeatureCollection,
  type BoundaryFeature,
  type BoundaryManifest,
  type BoundarySource,
  type Position,
} from '../src/directory/boundary-artifact.util.js';

const SYNC_SOURCE = 'build-district-boundary-artifacts';

/**
 * Census cartographic (pre-generalized) national congressional-district file.
 * Cartographic, NOT TIGER/Line: no national TIGER CD file exists, and the
 * 500k generalization is what keeps the artifact inside a sane browser budget
 * (measured ~5.1 MB gzipped / 441 features at 500k). Overridable so a new
 * vintage doesn't require a code change.
 */
const DEFAULT_CENSUS_CD_URL =
  'https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_cd119_500k.zip';

interface Options {
  commit: boolean;
  /** Which rails to build. */
  statuses: readonly ('C' | 'F')[];
  /** Restrict to these USPS codes (diagnostics / a cheap first run). */
  states: ReadonlySet<string> | null;
  censusUrl: string;
}

/** Parse process.argv into CLI options. Unknown flags are ignored. */
export function parseArgs(argv: string[]): Options {
  const args = argv.slice(2);
  const statusArg = args.find((a) => a.startsWith('--status='));
  const rawStatus = statusArg ? statusArg.slice('--status='.length).trim().toUpperCase() : 'BOTH';
  const statuses: ('C' | 'F')[] =
    rawStatus === 'C' ? ['C'] : rawStatus === 'F' ? ['F'] : ['C', 'F'];

  const statesArg = args.find((a) => a.startsWith('--states='));
  const states = statesArg
    ? new Set(
        statesArg
          .slice('--states='.length)
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter((s) => s.length > 0),
      )
    : null;

  const urlArg = args.find((a) => a.startsWith('--census-url='));

  return {
    commit: args.includes('--commit'),
    statuses,
    states: states && states.size > 0 ? states : null,
    censusUrl: urlArg ? urlArg.slice('--census-url='.length) : DEFAULT_CENSUS_CD_URL,
  };
}

/** Aggregate-only summary — never a vendor URL, never a member identifier. */
export function formatSummary(payload: Record<string, unknown>): string {
  return `BUILD_DISTRICT_BOUNDARY_ARTIFACTS_SUMMARY ${JSON.stringify(payload)}`;
}

interface RailResult {
  status: 'C' | 'F';
  source: BoundarySource;
  vintage: string;
  features: BoundaryFeature[];
  warnings: string[];
}

/** Download + parse the national Census CD shapefile into boundary features. */
async function buildCurrentRail(
  options: Options,
  districtIdFor: (state: string, code: string) => string | null,
): Promise<RailResult> {
  const response = await fetch(options.censusUrl);
  if (!response.ok) {
    throw new Error(`Census shapefile fetch failed: ${response.status} ${response.statusText}`);
  }
  const zip = await response.arrayBuffer();

  // Imported lazily and NOT hoisted to a static import, deliberately. shpjs's
  // package exports map sends `import` to a Node-safe ESM entry but `require`
  // to a browser UMD bundle that references `self` — so a static import makes
  // this module unloadable under jest (CJS), failing the spec on `self is not
  // defined` before a single assertion runs. Lazy also means the ~1MB
  // shapefile parser is only loaded when the current rail is actually built.
  const { default: shp } = await import('shpjs');

  // shpjs unzips and reprojects to WGS84 itself. A national file yields one
  // FeatureCollection; a multi-layer zip would yield an array.
  const parsed = await shp(zip);
  const collections = Array.isArray(parsed) ? parsed : [parsed];
  const rawFeatures = collections.flatMap((c) => (c.features ?? []) as Array<{
    properties?: unknown;
    geometry?: unknown;
  }>);

  const { features, vintage, warnings } = buildCollectionFromCensus(rawFeatures, {
    legislativeDistrictIdFor: districtIdFor,
    ...(options.states ? { onlyStates: options.states } : {}),
  });

  return {
    status: 'C',
    source: 'census_cartographic_500k',
    vintage: vintage ?? 'unknown',
    features,
    warnings,
  };
}

interface FutureDistrictRow {
  id: string;
  state: string;
  districtNo: string | null;
  name: string;
  kmlS3Key: string | null;
}

/** Read each future district's re-hosted KML from our bucket and convert it. */
async function buildFutureRail(
  rows: readonly FutureDistrictRow[],
  s3: S3Client,
  bucket: string,
  currentCentroids: Map<string, Position>,
  districtCodeFor: (row: FutureDistrictRow) => string | null,
): Promise<RailResult> {
  const features: BoundaryFeature[] = [];
  const warnings: string[] = [];

  for (const row of rows) {
    if (!row.kmlS3Key) {
      warnings.push(`${row.id}: no kmlS3Key yet (needs sync-legistorm-districts --with-kml)`);
      continue;
    }
    const districtCode = districtCodeFor(row);
    if (!districtCode) {
      warnings.push(`${row.id}: districtNo ${String(row.districtNo)} is not expressible as a facility code`);
      continue;
    }

    let kmlText: string;
    try {
      const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: row.kmlS3Key }));
      if (!out.Body) {
        warnings.push(`${row.id}: boundary object missing from storage`);
        continue;
      }
      kmlText = await out.Body.transformToString();
    } catch (error) {
      warnings.push(`${row.id}: could not read boundary from storage (${String(error)})`);
      continue;
    }

    const geometry = kmlToGeometry(kmlText);
    if (!geometry) {
      warnings.push(`${row.id}: KML contained no usable polygon`);
      continue;
    }

    const built = buildFeature({
      state: row.state,
      districtCode,
      status: 'F',
      // A future row's vintage is its own LegiStorm identity: there is no
      // congress number for a map that hasn't taken effect yet.
      vintage: 'legistorm',
      name: row.name,
      legislativeDistrictId: row.id,
      geometry,
    });
    if ('problems' in built) {
      warnings.push(`${row.id}: ${built.problems.join('; ')}`);
      continue;
    }

    // Cross-validate against the current map for the same district. A real
    // redistricting moves a centroid a little; a KML attached to the wrong
    // district moves it a lot.
    const currentCentroid = currentCentroids.get(`${row.state}-${districtCode}`);
    if (currentCentroid) {
      const { mismatch, distanceDegrees } = grossCentroidMismatch(
        built.feature.properties.centroid,
        currentCentroid,
      );
      if (mismatch) {
        warnings.push(
          `${row.id}: future centroid is ${distanceDegrees.toFixed(1)}deg from the current ${row.state}-${districtCode} centroid — verify the KML belongs to this district`,
        );
      }
    }

    features.push(built.feature);
  }

  return { status: 'F', source: 'legistorm_kml', vintage: 'legistorm', features, warnings };
}

/** Serialize + gzip an artifact, returning everything needed to publish it. */
function prepareArtifact(rail: RailResult): {
  key: string;
  hash: string;
  body: Buffer;
  manifest: BoundaryManifest;
} {
  const collection = toFeatureCollection(rail.features);
  const serialized = JSON.stringify(collection);
  const hash = hashArtifact(serialized);
  const body = gzipSync(Buffer.from(serialized, 'utf8'));
  const key = artifactKey(rail.status, rail.vintage, hash);
  return {
    key,
    hash,
    body,
    manifest: {
      status: rail.status === 'C' ? 'current' : 'future',
      vintage: rail.vintage,
      generatedAt: new Date().toISOString(),
      districtCount: rail.features.length,
      source: rail.source,
      hash,
      artifactKey: key,
      gzipBytes: body.byteLength,
      warnings: rail.warnings,
    },
  };
}

async function publishArtifact(
  s3: S3Client,
  bucket: string,
  prepared: ReturnType<typeof prepareArtifact>,
  status: 'C' | 'F',
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: prepared.key,
      Body: prepared.body,
      ContentType: 'application/geo+json',
      ContentEncoding: 'gzip',
      // Safe ONLY because the key is content-addressed: a changed boundary set
      // produces a different key rather than mutating a cached object. This is
      // the repo's first use of CacheControl — deliberate, not copied.
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
  // The manifest is the mutable pointer clients read to discover that hash, so
  // it must NOT inherit the immutable policy.
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: manifestKey(status),
      Body: JSON.stringify(prepared.manifest, null, 2),
      ContentType: 'application/json',
      CacheControl: 'no-cache',
    }),
  );
}

async function main(): Promise<void> {
  dotenvConfig();
  const options = parseArgs(process.argv);

  const bucket = process.env.DIRECTORY_S3_BUCKET ?? 'updated-directory-967807252336-us-east-1';
  const region = process.env.AWS_REGION_DEFAULT ?? process.env.AWS_REGION ?? 'us-east-1';
  const s3 = new S3Client({ region });
  const prisma = new PrismaClient();

  try {
    // Every congressional district row we know about, used to attach
    // LegislativeDistrict.id to current features and to drive the future rail.
    const districtRows = await prisma.legislativeDistrict.findMany({
      where: { chamber: 'house', ...(options.states ? { state: { in: [...options.states] } } : {}) },
      select: { id: true, state: true, districtNo: true, name: true, kmlS3Key: true, status: true },
    });

    const { toFacilityDistrictCode } = await import('../src/common/district-code.util.js');
    const codeFor = (row: { state: string; districtNo: string | null }): string | null =>
      toFacilityDistrictCode(row.state, row.districtNo);

    const currentIdByKey = new Map<string, string>();
    for (const row of districtRows) {
      if (row.status !== 'C') continue;
      const code = codeFor(row);
      if (code) currentIdByKey.set(`${row.state}-${code}`, row.id);
    }

    const rails: RailResult[] = [];
    const currentCentroids = new Map<string, Position>();

    if (options.statuses.includes('C')) {
      const rail = await buildCurrentRail(
        options,
        (state, code) => currentIdByKey.get(`${state}-${code}`) ?? null,
      );
      for (const f of rail.features) {
        currentCentroids.set(f.id, f.properties.centroid);
      }
      rails.push(rail);
    }

    if (options.statuses.includes('F')) {
      const futureRows = districtRows.filter((r) => r.status === 'F');
      rails.push(
        await buildFutureRail(futureRows, s3, bucket, currentCentroids, codeFor),
      );
    }

    const prepared = rails.map((rail) => ({ rail, artifact: prepareArtifact(rail) }));

    const summary = {
      source: SYNC_SOURCE,
      committed: options.commit,
      bucket,
      rails: prepared.map(({ rail, artifact }) => ({
        status: rail.status,
        source: rail.source,
        vintage: rail.vintage,
        districtCount: rail.features.length,
        gzipBytes: artifact.body.byteLength,
        gzipMb: Number((artifact.body.byteLength / 1024 / 1024).toFixed(2)),
        hash: artifact.hash,
        key: artifact.key,
        warningCount: rail.warnings.length,
      })),
    };
    console.log(formatSummary(summary));
    for (const { rail } of prepared) {
      // Warnings are the point of the dry run — print them all, not a sample.
      for (const w of rail.warnings) console.warn(`[${SYNC_SOURCE}] WARN ${rail.status}: ${w}`);
    }

    if (!options.commit) {
      console.log(
        `[${SYNC_SOURCE}] DRY RUN — nothing written to S3 or the database. Pass --commit to publish.`,
      );
      return;
    }

    await runWithSyncRun(
      // Same `as never` precedent as the other module-scope-PrismaClient
      // scripts (see sync-legistorm-districts.ts for the reasoning).
      prisma as never,
      SYNC_SOURCE,
      async () => {
        let updated = 0;
        for (const { rail, artifact } of prepared) {
          if (rail.features.length === 0) {
            console.warn(
              `[${SYNC_SOURCE}] status ${rail.status} produced zero features — not publishing an empty artifact.`,
            );
            continue;
          }
          await publishArtifact(s3, bucket, artifact, rail.status);

          const builtAt = new Date();
          for (const feature of rail.features) {
            const id = feature.properties.legislativeDistrictId;
            if (!id) continue; // a Census district we have no LegiStorm row for
            await prisma.legislativeDistrict.update({
              where: { id },
              data: {
                geoJsonS3Key: artifact.key,
                boundaryBboxJson: feature.properties.bbox,
                boundaryCentroidJson: feature.properties.centroid,
                boundarySource: rail.source,
                boundaryBuiltAt: builtAt,
                boundaryHash: artifact.hash,
              },
            });
            updated += 1;
          }
        }
        return { inserted: 0, updated, skipped: 0, errors: 0 };
      },
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked directly, so the spec can import the pure helpers.
if (process.argv[1] && process.argv[1].includes('build-district-boundary-artifacts')) {
  main().catch((error) => {
    console.error(`[${SYNC_SOURCE}] FAILED`, error);
    process.exit(1);
  });
}
