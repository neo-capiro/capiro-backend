import { config as dotenvConfig } from 'dotenv';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { distinctiveTokens, acronyms } from '../src/program-element/matching/pe-person-matcher.js';

/**
 * derive-office-program-links.ts — populate program_office_program_link so the
 * deployed role-chain read path (PersonRole.officeId -> [accepted link] -> Program
 * -> accepted PeProgramMatch -> peCode) actually surfaces the ~3.3k person->office
 * roles on PE pages. Spec: docs/plans/2026-07-04-office-program-matcher-spec.md.
 *
 * Deterministic (no LLM), review-gated, idempotent. Manages ONLY rows tagged with
 * its derived_by cohort; NEVER clobbers hand/import-created links (derived_by NULL).
 *
 * Signals per (office O, program P):
 *   B owner_in_office   an accepted person->program role's person is in O          -> accept
 *   A people_majority   >=3 AND >=50% of O's PE-mapped people resolve to P          -> accept
 *   D office_name_acr   O.name shares an ACRONYM with a P alias                     -> accept
 *   C por               O people whose programOfRecord acronym-matches P            -> candidate
 *   A people_minority   1-2 of O's people resolve to P                              -> candidate
 *   D office_name_token O.name shares a distinctive (non-acronym) token with P      -> candidate
 * Fuzzy/token-only never auto-accepts (matches pe-person / sam-opportunity matchers).
 *
 * Usage:
 *   tsx scripts/derive-office-program-links.ts                 # DRY RUN
 *   tsx scripts/derive-office-program-links.ts --commit
 *   flags: --min-conf=0 (drop pairs below), --limit=0 (0 = all)
 */
const COHORT = 'derive-office-program-links@v1';

function argNum(name: string, def: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
}

type Tier =
  | 'owner_in_office'
  | 'people_majority'
  | 'office_name_acr'
  | 'por'
  | 'people_minority'
  | 'office_name_token';

const ACCEPT_TIERS = new Set<Tier>(['owner_in_office', 'people_majority', 'office_name_acr']);
// Highest priority first.
const TIER_ORDER: Tier[] = [
  'owner_in_office',
  'people_majority',
  'office_name_acr',
  'por',
  'people_minority',
  'office_name_token',
];
const TIER_CONF: Record<Tier, number> = {
  owner_in_office: 0.95,
  people_majority: 0.9,
  office_name_acr: 0.9,
  por: 0.7,
  people_minority: 0.65,
  office_name_token: 0.6,
};

interface Pair {
  officeId: string;
  programId: string;
  owner: boolean;
  coPeople: Set<string>; // signal A
  porPeople: Set<string>; // signal C
  nameAcr: string | null; // signal D exact
  nameToken: string | null; // signal D token
}

function key(o: string, p: string): string {
  return `${o}::${p}`;
}

async function main(): Promise<void> {
  dotenvConfig();
  const commit = process.argv.includes('--commit');
  const minConf = argNum('min-conf', 0);
  const limit = argNum('limit', 0);

  const prisma = new PrismaService();
  await prisma.onModuleInit();

  try {
    // ── Load (all global reference tables) ──
    const [offices, programs, accepted, officeRoles, programRoles, people] = await Promise.all([
      prisma.programOffice.findMany({ select: { id: true, name: true, officeType: true } }),
      prisma.program.findMany({
        select: {
          id: true,
          canonicalName: true,
          aliases: { select: { alias: true, aliasType: true } },
        },
      }),
      prisma.peProgramMatch.findMany({
        where: { status: 'accepted' },
        select: { peCode: true, programId: true },
      }),
      prisma.personRole.findMany({
        where: { officeId: { not: null }, reviewStatus: { not: 'quarantined' } },
        select: { personId: true, officeId: true },
      }),
      prisma.personRole.findMany({
        where: { programId: { not: null }, reviewStatus: 'accepted' },
        select: { personId: true, programId: true },
      }),
      prisma.acquisitionPersonnel.findMany({
        where: { supersededAt: null },
        select: { id: true, pePrimary: true, programOfRecord: true },
      }),
    ]);

    // peCode (upper) -> set of accepted programIds
    const peToPrograms = new Map<string, Set<string>>();
    for (const m of accepted) {
      const k = m.peCode.toUpperCase();
      (peToPrograms.get(k) ?? peToPrograms.set(k, new Set()).get(k)!).add(m.programId);
    }

    // personId -> set of officeIds
    const personOffices = new Map<string, Set<string>>();
    for (const r of officeRoles) {
      if (!r.officeId) continue;
      (
        personOffices.get(r.personId) ?? personOffices.set(r.personId, new Set()).get(r.personId)!
      ).add(r.officeId);
    }

    // program acronym + distinctive-token indexes
    const programAcr = new Map<string, Set<string>>(); // programId -> acronyms (lowercase)
    const programTok = new Map<string, Set<string>>(); // programId -> distinctive tokens
    const acrToPrograms = new Map<string, Set<string>>();
    const tokToPrograms = new Map<string, Set<string>>();
    for (const p of programs) {
      const acrs = new Set<string>();
      const toks = new Set<string>();
      const texts = [p.canonicalName, ...p.aliases.map((a) => a.alias)];
      for (const t of texts) {
        for (const a of acronyms(t)) acrs.add(a);
        for (const w of distinctiveTokens(t)) toks.add(w);
      }
      // aliasType='acronym' aliases are acronyms even if lowercased in storage.
      for (const a of p.aliases) if (a.aliasType === 'acronym') acrs.add(a.alias.toLowerCase());
      programAcr.set(p.id, acrs);
      programTok.set(p.id, toks);
      for (const a of acrs)
        (acrToPrograms.get(a) ?? acrToPrograms.set(a, new Set()).get(a)!).add(p.id);
      for (const w of toks)
        (tokToPrograms.get(w) ?? tokToPrograms.set(w, new Set()).get(w)!).add(p.id);
    }

    const officeName = new Map(offices.map((o) => [o.id, o.name] as const));
    const officeType = new Map(offices.map((o) => [o.id, o.officeType] as const));
    const pairs = new Map<string, Pair>();
    const getPair = (o: string, p: string): Pair => {
      const k = key(o, p);
      let pair = pairs.get(k);
      if (!pair) {
        pair = {
          officeId: o,
          programId: p,
          owner: false,
          coPeople: new Set(),
          porPeople: new Set(),
          nameAcr: null,
          nameToken: null,
        };
        pairs.set(k, pair);
      }
      return pair;
    };

    // ── Signal B: owner-derived ──
    for (const r of programRoles) {
      if (!r.programId) continue;
      for (const o of personOffices.get(r.personId) ?? []) getPair(o, r.programId).owner = true;
    }

    // ── Signal A: person co-occurrence (+ per-office PE-mapped denominator) ──
    const officeMapped = new Map<string, Set<string>>(); // officeId -> people with any pePrimary->accepted match
    for (const person of people) {
      if (!person.pePrimary) continue;
      const progs = peToPrograms.get(person.pePrimary.toUpperCase());
      if (!progs || progs.size === 0) continue;
      const offs = personOffices.get(person.id);
      if (!offs) continue;
      for (const o of offs) {
        (officeMapped.get(o) ?? officeMapped.set(o, new Set()).get(o)!).add(person.id);
        for (const p of progs) getPair(o, p).coPeople.add(person.id);
      }
    }

    // ── Signal C: programOfRecord acronym match ──
    for (const person of people) {
      const por = person.programOfRecord;
      if (!por) continue;
      const offs = personOffices.get(person.id);
      if (!offs) continue;
      const acrs = acronyms(por);
      const progs = new Set<string>();
      for (const a of acrs) for (const pid of acrToPrograms.get(a) ?? []) progs.add(pid);
      for (const o of offs) for (const p of progs) getPair(o, p).porPeople.add(person.id);
    }

    // ── Signal D: office name overlap ──
    for (const o of offices) {
      const nameAcr = acronyms(o.name);
      const nameTok = distinctiveTokens(o.name);
      for (const a of nameAcr)
        for (const p of acrToPrograms.get(a) ?? []) {
          const pair = getPair(o.id, p);
          if (!pair.nameAcr) pair.nameAcr = a;
        }
      for (const w of nameTok)
        for (const p of tokToPrograms.get(w) ?? []) {
          const pair = getPair(o.id, p);
          if (!pair.nameToken) pair.nameToken = w;
        }
    }

    // ── Combine → tier/status/confidence ──
    interface Out {
      officeId: string;
      programId: string;
      tier: Tier;
      status: 'accepted' | 'candidate';
      confidence: number;
      relation: string;
      evidence: unknown[];
      matchBasis: string;
    }
    const outputs: Out[] = [];
    for (const pair of pairs.values()) {
      const mapped = officeMapped.get(pair.officeId)?.size ?? 0;
      const co = pair.coPeople.size;
      const evidence: Array<{ kind: string; detail: string; count?: number }> = [];
      const tiersHit: Tier[] = [];
      if (pair.owner) {
        tiersHit.push('owner_in_office');
        evidence.push({
          kind: 'owner_in_office',
          detail: 'an accepted program owner/role holder is in this office',
        });
      }
      if (co >= 3 && mapped > 0 && co / mapped >= 0.5) {
        tiersHit.push('people_majority');
        evidence.push({
          kind: 'people_majority',
          detail: `${co} of ${mapped} PE-mapped office people resolve here`,
          count: co,
        });
      } else if (co >= 1) {
        tiersHit.push('people_minority');
        evidence.push({
          kind: 'people_minority',
          detail: `${co} office ${co === 1 ? 'person' : 'people'} resolve here`,
          count: co,
        });
      }
      if (pair.nameAcr) {
        tiersHit.push('office_name_acr');
        evidence.push({
          kind: 'office_name_acr',
          detail: `office name shares acronym '${pair.nameAcr}'`,
        });
      }
      if (pair.porPeople.size > 0) {
        tiersHit.push('por');
        evidence.push({
          kind: 'por',
          detail: `${pair.porPeople.size} office people carry a matching program of record`,
          count: pair.porPeople.size,
        });
      }
      if (pair.nameToken && !pair.nameAcr) {
        tiersHit.push('office_name_token');
        evidence.push({
          kind: 'office_name_token',
          detail: `office name shares distinctive token '${pair.nameToken}'`,
        });
      }
      if (tiersHit.length === 0) continue;
      const tier = TIER_ORDER.find((t) => tiersHit.includes(t))!;
      const confidence = TIER_CONF[tier];
      if (confidence < minConf) continue;
      const ot = officeType.get(pair.officeId);
      const relation =
        ot === 'contracting_office'
          ? 'supports'
          : ot === 'pm' || ot === 'pae'
            ? 'executes'
            : 'manages';
      outputs.push({
        officeId: pair.officeId,
        programId: pair.programId,
        tier,
        status: ACCEPT_TIERS.has(tier) ? 'accepted' : 'candidate',
        confidence,
        relation,
        evidence,
        matchBasis: evidence.map((e) => e.detail).join('; '),
      });
    }
    outputs.sort((a, b) => b.confidence - a.confidence);
    const capped = limit > 0 ? outputs.slice(0, limit) : outputs;

    // ── Report ──
    const byTier: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const o of capped) {
      byTier[o.tier] = (byTier[o.tier] ?? 0) + 1;
      byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    }
    console.log(
      `[office-program] ${capped.length} proposed links (${commit ? 'COMMIT' : 'DRY-RUN'})`,
    );
    console.log(`  by tier:   ${JSON.stringify(byTier)}`);
    console.log(`  by status: ${JSON.stringify(byStatus)}`);
    for (const o of capped.slice(0, 15)) {
      console.log(
        `  ${o.status.padEnd(9)} ${o.tier.padEnd(16)} ${officeName.get(o.officeId)} -> program ${o.programId} — ${o.matchBasis}`,
      );
    }
    // Offices with an unusually high link count — flag for review.
    const perOffice = new Map<string, number>();
    for (const o of capped) perOffice.set(o.officeId, (perOffice.get(o.officeId) ?? 0) + 1);
    const busy = [...perOffice.entries()].filter(([, n]) => n > 20).sort((a, b) => b[1] - a[1]);
    if (busy.length)
      console.log(
        `  ⚠️ ${busy.length} office(s) with >20 links (review): ${busy
          .slice(0, 5)
          .map(([o, n]) => `${officeName.get(o)}=${n}`)
          .join(', ')}`,
      );

    if (!commit) {
      console.log('[office-program] dry-run — no writes.');
      return;
    }

    // ── Write: delete-and-rewrite own cohort; never touch non-cohort (hand/import) rows ──
    const del = await prisma.programOfficeProgramLink.deleteMany({ where: { derivedBy: COHORT } });
    let created = 0;
    let skippedExisting = 0;
    for (const o of capped) {
      const existing = await prisma.programOfficeProgramLink.findUnique({
        where: { officeId_programId: { officeId: o.officeId, programId: o.programId } },
        select: { id: true },
      });
      if (existing) {
        skippedExisting += 1; // a hand/import row owns this pair — preserve it
        continue;
      }
      await prisma.programOfficeProgramLink.create({
        data: {
          officeId: o.officeId,
          programId: o.programId,
          relation: o.relation,
          confidence: o.confidence,
          reviewStatus: o.status,
          evidence: o.evidence as object,
          evidenceTier: o.tier,
          matchBasis: o.matchBasis,
          derivedBy: COHORT,
        },
      });
      created += 1;
    }
    console.log(
      JSON.stringify(
        {
          cohortDeleted: del.count,
          created,
          skippedExisting,
          accepted: byStatus.accepted ?? 0,
          candidate: byStatus.candidate ?? 0,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.onModuleDestroy();
  }
}

const isDirectRun = /derive-office-program-links(\.[cm]?[tj]s)?$/.test(
  (process.argv[1] ?? '').replace(/\\/g, '/'),
);
if (isDirectRun) {
  void main().catch((err) => {
    console.error('[office-program] FAILED', err);
    process.exit(1);
  });
}

export { main };
