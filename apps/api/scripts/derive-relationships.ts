/**
 * derive-relationships (BL-0): builds the money graph's typed edges (§1.3) from
 * signals that already exist in the DB. Deterministic joins only — no fuzzy
 * matching is ever auto-accepted (candidates require review, mirroring
 * PeProgramMatch discipline).
 *
 *  1. related_pe_exhibit (accepted, high): raw.pDocDetail.relatedPEs — the P-40
 *     exhibit's own "Related PEs" field. Zero-inference: the document says so.
 *  2. same_program family (accepted, high): two lines with ACCEPTED
 *     PeProgramMatch rows to the same Program. Typed by appropriation pair:
 *       RDT&E → PROC  = rdte_to_procurement
 *       PROC  → OM    = procurement_to_om
 *       same type / other pairs = same_program
 *     Per-program pair cap (default 60) guards clique blowup on huge programs;
 *     capped programs are logged loudly, never silently truncated.
 *  3. predecessor_successor (CANDIDATE, med): a line with a termination
 *     budget_action whose title shares >= 60% of its significant tokens with a
 *     same-service line that is funded in the current cycle. This is the F26
 *     consolidation heuristic; candidates render dashed + labeled and are
 *     promoted only by human review.
 *
 * Regenerable: --commit deletes this verb's derivedBy cohort and rewrites.
 * Human-reviewed rows (derivedBy='review') are never touched.
 *
 *   derive-relationships [--commit] [--pair-cap 60]
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';

dotenvConfig();

const DERIVED_BY = 'derive-relationships@v1';
const PE_TOKEN = /\b\d{7}[A-Z]{1,2}\b/g;

interface EdgeRow {
  fromPeCode: string;
  toPeCode: string;
  relType: string;
  confidence: string;
  status: string;
  evidence: string;
  evidenceJson: Record<string, unknown>;
}

const STOP_TOKENS = new Set([
  'the', 'and', 'for', 'of', 'to', 'in', 'a', 'an', 'system', 'systems', 'program',
  'support', 'development', 'advanced', 'technology', 'equipment', 'modification',
  'mods', 'spares', 'other',
]);

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t)),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit += 1;
  return hit / Math.min(a.size, b.size);
}

function relTypeFor(fromType: string | null, toType: string | null): string {
  const f = (fromType ?? '').toUpperCase();
  const t = (toType ?? '').toUpperCase();
  if (f.startsWith('RDT') && t === 'PROC') return 'rdte_to_procurement';
  if (f === 'PROC' && t === 'OM') return 'procurement_to_om';
  return 'same_program';
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const pairCap = Number(arg('pair-cap') ?? 60);
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const lines = await prisma.programElement.findMany({
      where: { retiredAt: null },
      select: { peCode: true, title: true, service: true, appropriationType: true, raw: true },
    });
    const byCode = new Map(lines.map((l) => [l.peCode, l]));
    const edges = new Map<string, EdgeRow>();
    const put = (e: EdgeRow) => {
      if (e.fromPeCode === e.toPeCode) return;
      if (!byCode.has(e.fromPeCode) || !byCode.has(e.toPeCode)) return;
      const key = `${e.fromPeCode}|${e.toPeCode}|${e.relType}`;
      const reverseKey = `${e.toPeCode}|${e.fromPeCode}|${e.relType}`;
      // Symmetric types keep one direction only.
      if (e.relType === 'same_program' && edges.has(reverseKey)) return;
      if (!edges.has(key)) edges.set(key, e);
    };

    // ── 1. P-40 related PEs ─────────────────────────────────────────────────
    let relatedPeHits = 0;
    for (const l of lines) {
      const raw = l.raw as { pDocDetail?: { relatedPEs?: string | null } | null } | null;
      const related = raw?.pDocDetail?.relatedPEs;
      if (!related) continue;
      for (const m of related.match(PE_TOKEN) ?? []) {
        if (!byCode.has(m)) continue;
        relatedPeHits += 1;
        put({
          fromPeCode: l.peCode,
          toPeCode: m,
          relType: 'related_pe_exhibit',
          confidence: 'high',
          status: 'accepted',
          evidence: `P-40 exhibit for ${l.peCode} lists ${m} under "Related PEs".`,
          evidenceJson: { source: 'pDocDetail.relatedPEs', value: related },
        });
      }
    }

    // ── 2. Same accepted Program ───────────────────────────────────────────
    const matches = await prisma.peProgramMatch.findMany({
      where: { status: 'accepted' },
      select: { peCode: true, programId: true, program: { select: { canonicalName: true } } },
    });
    const byProgram = new Map<string, { name: string; peCodes: Set<string> }>();
    for (const m of matches) {
      const g = byProgram.get(m.programId) ?? { name: m.program.canonicalName, peCodes: new Set() };
      g.peCodes.add(m.peCode);
      byProgram.set(m.programId, g);
    }
    const cappedPrograms: string[] = [];
    for (const [, g] of byProgram) {
      const codes = [...g.peCodes].filter((c) => byCode.has(c)).sort();
      let pairs = 0;
      outer: for (let i = 0; i < codes.length; i += 1) {
        for (let j = i + 1; j < codes.length; j += 1) {
          if (pairs >= pairCap) {
            cappedPrograms.push(`${g.name} (${codes.length} lines)`);
            break outer;
          }
          const a = byCode.get(codes[i]!)!;
          const b = byCode.get(codes[j]!)!;
          // Direction: development → fielding → sustainment.
          const rank = (x: typeof a) => {
            const t = (x.appropriationType ?? '').toUpperCase();
            return t.startsWith('RDT') ? 0 : t === 'PROC' ? 1 : t === 'OM' ? 2 : 3;
          };
          const [from, to] = rank(a) <= rank(b) ? [a, b] : [b, a];
          put({
            fromPeCode: from.peCode,
            toPeCode: to.peCode,
            relType: relTypeFor(from.appropriationType, to.appropriationType),
            confidence: 'high',
            status: 'accepted',
            evidence: `Both lines carry accepted matches to the same program: ${g.name}.`,
            evidenceJson: { program: g.name, via: 'pe_program_match(accepted)' },
          });
          pairs += 1;
        }
      }
    }

    // ── 3. Consolidation candidates (predecessor_successor) ───────────────
    const terminations = await prisma.budgetAction.findMany({
      where: { action: 'termination', derivedBy: 'derive-budget-actions@v1' },
      select: { peCode: true, fy: true, note: true },
    });
    // All termination actions are stamped with the current cycle FY by
    // derive-budget-actions; max() keeps this robust if that ever changes.
    const currentCycleFy = terminations.reduce<number | null>(
      (max, t) => (max === null || t.fy > max ? t.fy : max),
      null,
    );
    let consolidationCandidates = 0;
    if (currentCycleFy !== null) {
      // Lines funded in the current cycle, grouped by service for the scan.
      const liveByService = new Map<string, Array<{ peCode: string; tokens: Set<string>; title: string }>>();
      const liveCodes = new Set(
        (
          await prisma.programElementYear.findMany({
            where: { fy: currentCycleFy, request: { not: null } },
            select: { peCode: true },
          })
        ).map((y) => y.peCode),
      );
      for (const l of lines) {
        if (!liveCodes.has(l.peCode)) continue;
        const svc = l.service ?? '';
        const list = liveByService.get(svc) ?? [];
        list.push({ peCode: l.peCode, tokens: titleTokens(l.title), title: l.title });
        liveByService.set(svc, list);
      }
      for (const term of terminations) {
        const dead = byCode.get(term.peCode);
        if (!dead) continue;
        const deadTokens = titleTokens(dead.title);
        if (deadTokens.size < 2) continue; // too generic to match honestly
        for (const cand of liveByService.get(dead.service ?? '') ?? []) {
          const ov = overlap(deadTokens, cand.tokens);
          if (ov < 0.6) continue;
          consolidationCandidates += 1;
          put({
            fromPeCode: term.peCode,
            toPeCode: cand.peCode,
            relType: 'predecessor_successor',
            confidence: 'med',
            status: 'candidate',
            evidence: `"${dead.title}" has no FY${currentCycleFy} entry while same-service "${cand.title}" is funded — ${Math.round(ov * 100)}% title-token overlap. Needs review.`,
            evidenceJson: {
              overlap: Math.round(ov * 100) / 100,
              terminationNote: term.note,
              service: dead.service,
            },
          });
        }
      }
    }

    const rows = [...edges.values()];
    const byType = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.relType] = (acc[r.relType] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      JSON.stringify(
        {
          verb: DERIVED_BY,
          commit,
          lines: lines.length,
          relatedPeHits,
          programGroups: byProgram.size,
          consolidationCandidates,
          cappedPrograms,
          edges: rows.length,
          byType,
          samples: rows.slice(0, 5).map((r) => `${r.fromPeCode} -[${r.relType}]-> ${r.toPeCode}`),
        },
        null,
        2,
      ),
    );

    if (!commit) {
      console.log('DRY RUN — re-run with --commit to write.');
      return;
    }
    await prisma.$transaction(async (tx) => {
      await tx.budgetLineRelationship.deleteMany({ where: { derivedBy: DERIVED_BY } });
      for (let i = 0; i < rows.length; i += 1000) {
        await tx.budgetLineRelationship.createMany({
          data: rows.slice(i, i + 1000).map((r) => ({
            fromPeCode: r.fromPeCode,
            toPeCode: r.toPeCode,
            relType: r.relType,
            confidence: r.confidence,
            status: r.status,
            evidence: r.evidence,
            evidenceJson: r.evidenceJson as Prisma.InputJsonValue,
            derivedBy: DERIVED_BY,
          })),
          skipDuplicates: true,
        });
      }
    });
    console.log(JSON.stringify({ written: rows.length }));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
