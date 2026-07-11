/**
 * move-ndaa-conference.ts — one-time data move for the NDAA-conference split.
 *
 *   tsx scripts/move-ndaa-conference.ts           # DRY RUN (default): writes nothing
 *   tsx scripts/move-ndaa-conference.ts --commit  # apply
 *
 * Context: the `program_element_year.conference` column historically held the NDAA
 * (authorization-track) conference-report value, but it is DOCUMENTED + CONSUMED as
 * the appropriations-lifecycle "conference" rung (see @capiro/shared
 * FUNDING_CURRENT_PRECEDENCE) — so that NDAA number wrongly won as the "current"
 * appropriations figure. The schema now has a dedicated `ndaa_conference` column
 * (outside the ladder). This migrates the value AND its provenance out of `conference`.
 *
 * `conference` is only ever written by the NDAA conference loader, so EVERY non-null
 * value / 'conference'-keyed provenance is NDAA-sourced — the move is complete + safe
 * by that invariant, and robust to historical rows loaded without per-field logging.
 *
 * THREE things move, or a later `rebuild-pe-years` (which reassembles the canonical row
 * from the source-value log) would silently rewrite the NDAA value back into
 * `conference` and reintroduce the ladder bug:
 *   1. canonical column     program_element_year.conference        -> ndaa_conference
 *   2. source-value log      program_element_year_source_value.field_name 'conference' -> 'ndaaConference'
 *   3. raw provenance maps   raw_jsonb.{sourceAttribution,fieldSources,datesAdded}.conference -> .ndaaConference
 *
 * Idempotent: each step's WHERE excludes already-migrated rows, so a re-run is a no-op.
 * Non-destructive: values/labels are moved (COALESCE-preserving a fresh ndaa write),
 * never deleted. DRY RUN by default.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';

dotenvConfig();

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const commit = flag('commit');
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    // ── Counts (candidates for each of the three moves) ──────────────────────
    const [{ n: colCandidates }] = await prisma.$queryRaw<Array<{ n: number }>>(
      Prisma.sql`SELECT count(*)::int AS n FROM program_element_year WHERE conference IS NOT NULL`,
    );
    const [{ n: logCandidates }] = await prisma.$queryRaw<Array<{ n: number }>>(
      Prisma.sql`SELECT count(*)::int AS n FROM program_element_year_source_value WHERE field_name = 'conference'`,
    );
    const [{ n: rawCandidates }] = await prisma.$queryRaw<Array<{ n: number }>>(
      Prisma.sql`
        SELECT count(*)::int AS n FROM program_element_year
        WHERE raw_jsonb->'sourceAttribution' ? 'conference'
           OR raw_jsonb->'fieldSources' ? 'conference'
           OR raw_jsonb->'datesAdded' ? 'conference'`,
    );

    // Audit: how many column-candidates have a corroborating conference_report source row.
    const [{ n: corroborated }] = await prisma.$queryRaw<Array<{ n: number }>>(
      Prisma.sql`
        SELECT count(DISTINCT (y.pe_code, y.fy))::int AS n
        FROM program_element_year y
        JOIN program_element_year_source_value v
          ON v.pe_code = y.pe_code AND v.fy = y.fy AND v.source LIKE 'conference_report_fy%'
        WHERE y.conference IS NOT NULL`,
    );

    const samples = await prisma.$queryRaw<Array<{ peCode: string; fy: number; val: number }>>(
      Prisma.sql`
        SELECT pe_code AS "peCode", fy, conference::float8 AS val
        FROM program_element_year
        WHERE conference IS NOT NULL
        ORDER BY abs(conference) DESC
        LIMIT 15`,
    );

    let movedColumn = 0;
    let movedLog = 0;
    let movedRaw = 0;
    if (commit) {
      // 1. Canonical column. COALESCE keeps a fresh ndaa_conference write if one already
      //    landed (never clobbers it) while still nulling the stale legacy conference —
      //    so the row can't be left with an orphaned conference value.
      movedColumn = await prisma.$executeRaw(
        Prisma.sql`UPDATE program_element_year
          SET ndaa_conference = COALESCE(ndaa_conference, conference), conference = NULL
          WHERE conference IS NOT NULL`,
      );

      // 2. Source-value log field name (drives rebuild-pe-years).
      movedLog = await prisma.$executeRaw(
        Prisma.sql`UPDATE program_element_year_source_value
          SET field_name = 'ndaaConference'
          WHERE field_name = 'conference'`,
      );

      // 3. Raw provenance maps (drive the UI source labels / dates). Rename the
      //    'conference' sub-key to 'ndaaConference' in each map, unless a fresh write
      //    already populated 'ndaaConference' there (then just drop the stale key).
      //    Map keys are hardcoded constants, inlined via Prisma.raw (no user input) so
      //    the jsonb path operators are unambiguously typed.
      for (const mapKey of ['sourceAttribution', 'fieldSources', 'datesAdded']) {
        const mk = Prisma.raw(`'${mapKey}'`);
        const oldPath = Prisma.raw(`'{${mapKey},conference}'`);
        const newPath = Prisma.raw(`'{${mapKey},ndaaConference}'`);
        movedRaw += await prisma.$executeRaw(
          Prisma.sql`UPDATE program_element_year
            SET raw_jsonb = jsonb_set(
              raw_jsonb #- ${oldPath}::text[],
              ${newPath}::text[],
              raw_jsonb->${mk}->'conference'
            )
            WHERE raw_jsonb->${mk} ? 'conference'
              AND NOT (raw_jsonb->${mk} ? 'ndaaConference')`,
        );
        // Fresh ndaaConference already present → just remove the stale 'conference' key.
        movedRaw += await prisma.$executeRaw(
          Prisma.sql`UPDATE program_element_year
            SET raw_jsonb = raw_jsonb #- ${oldPath}::text[]
            WHERE raw_jsonb->${mk} ? 'conference'
              AND raw_jsonb->${mk} ? 'ndaaConference'`,
        );
      }
    }

    console.log(
      JSON.stringify(
        {
          mode: commit ? 'COMMIT' : 'DRY-RUN',
          column: { candidates: colCandidates, moved: movedColumn },
          sourceValueLog: { candidates: logCandidates, moved: movedLog },
          rawProvenance: { candidates: rawCandidates, updated: movedRaw },
          corroboratedByConferenceReportSource: corroborated,
        },
        null,
        2,
      ),
    );
    if (samples.length > 0) {
      console.log(
        `\nSamples (conference -> ndaa_conference)${commit ? ' [applied]' : ' [dry-run, not applied]'}:`,
      );
      console.log(samples.map((r) => `  ${r.peCode} FY${r.fy}: ${r.val}`).join('\n'));
    }
    if (!commit && colCandidates + logCandidates + rawCandidates > 0) {
      console.log(
        '\nRe-run with --commit to apply. Idempotent + non-destructive (moves value + provenance, never deletes).',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
