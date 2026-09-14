import { readFile } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { compareBudgetAmounts, type BudgetAmount } from '@capiro/shared';
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const object = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/** Operator-reviewed public source manifest. Exact original bytes are retained
 * by API; dry run is the default. This does not promote any private tracking. */
export async function importPhase8Manifest(prisma: PrismaClient, path: string, apply = false) {
  const file = resolve(path),
    manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  if (manifest.schema !== 'legiwatch.phase8.sources.v1')
    throw Error('TYPED_PHASE8_MANIFEST_REQUIRED');
  const documents = Array.isArray(manifest.documents) ? manifest.documents.map(object) : [],
    projects = Array.isArray(manifest.projects) ? manifest.projects.map(object) : [],
    amounts = Array.isArray(manifest.amounts) ? (manifest.amounts as BudgetAmount[]) : [],
    people = Array.isArray(manifest.personnel) ? manifest.personnel.map(object) : [],
    receipts = Array.isArray(manifest.receipts) ? manifest.receipts.map(object) : [],
    coverage = Array.isArray(manifest.coverage) ? manifest.coverage.map(object) : [];
  if (
    documents.length > 30 ||
    projects.length > 2000 ||
    amounts.length > 10000 ||
    people.length > 2000 ||
    receipts.length > 30 ||
    coverage.length > 100
  )
    throw Error('SOURCE_MANIFEST_LIMIT');
  const bytes = new Map<string, Buffer>();
  for (const source of [...documents, ...receipts]) {
    const url = new URL(String(source.sourceUrl));
    if (
      url.protocol !== 'https:' ||
      ![
        'www.flsenate.gov',
        'laws.flrules.org',
        'www.flhouse.gov',
        'floridalobbyist.gov',
        'floridafiscalportal.state.fl.us',
        'www.flgov.com',
        'flgov.com',
      ].includes(url.hostname)
    )
      throw Error('QUALIFIED_FLORIDA_PUBLISHER_REQUIRED');
    const local = resolve(dirname(file), String(source.bytesFile)),
      rel = relative(dirname(file), local);
    if (rel.startsWith('..') || isAbsolute(rel))
      throw Error('SOURCE_BYTES_MUST_BE_IN_MANIFEST_DIRECTORY');
    const data = await readFile(local);
    if (data.length > 20000000 || hash(data) !== source.contentHash)
      throw Error('ORIGINAL_SOURCE_BYTES_CHANGED');
    bytes.set(String(source.id), data);
  }
  const documentIds = new Set(documents.map((d) => d.id)),
    projectIds = new Set(projects.map((p) => p.id));
  if (documentIds.size !== documents.length || projectIds.size !== projects.length)
    throw Error('DUPLICATE_FISCAL_IDENTITY');
  for (const d of documents) {
    if (
      !Array.isArray(d.sections) ||
      !d.sections.length ||
      d.sections.length !== d.pageCount ||
      d.complete !== true
    )
      throw Error('COMPLETE_SELECTED_DOCUMENT_REQUIRED');
    for (const section of d.sections.map(object))
      if (
        typeof section.text !== 'string' ||
        !section.locator ||
        hash(section.text) !== section.hash
      )
        throw Error('EXTRACTION_SECTION_CHANGED');
  }
  for (const a of amounts) {
    const doc = documents.find((d) => d.id === a.documentId);
    if (
      !doc ||
      !projectIds.has(a.projectId) ||
      a.sourceRevision !== doc.contentHash ||
      a.fiscalYear !== doc.fiscalYear ||
      !a.locator ||
      a.qualified !== true
    )
      throw Error('EXACT_AMOUNT_SOURCE_REQUIRED');
    if (a.state === 'amount' && !compareBudgetAmounts(a, a).comparable)
      throw Error('INVALID_AMOUNT_BASIS');
    if (a.state !== 'amount' && a.minorUnits !== null)
      throw Error('UNKNOWN_AMOUNT_CANNOT_HAVE_VALUE');
  }
  // A name resemblance is not a crosswalk. A reviewed mapping must name an
  // existing Florida directory identity and its exact retained official URL.
  const personMappings = new Map<string, { id: string; url: string }>();
  for (const person of people) {
    if (!person.canonicalPersonId) continue;
    const member = await prisma.stateLegislator.findUnique({
        where: { id: String(person.canonicalPersonId) },
      }),
      mapping = object(person.identityMapping);
    if (
      !member ||
      member.state !== 'FL' ||
      !member.url ||
      mapping.canonicalSourceUrl !== member.url ||
      mapping.method !== 'reviewed_source_crosscheck' ||
      !mapping.reviewedBy ||
      !mapping.evidenceLocator
    )
      throw Error('REVIEWED_CANONICAL_PERSON_CROSSWALK_REQUIRED');
    personMappings.set(String(person.id), {
      id: member.id,
      url: '/directory/state-legislators/' + encodeURIComponent(member.id),
    });
  }
  const events = Array.isArray(manifest.events) ? manifest.events.map(object) : [];
  if (events.length > 10000) throw Error('EVENT_MANIFEST_LIMIT');
  for (const event of events) {
    if (
      !documentIds.has(event.documentId) ||
      (event.projectId && !projectIds.has(event.projectId)) ||
      ![
        'amount_change',
        'stage_change',
        'proviso_change',
        'veto_outcome',
        'schedule_revision',
      ].includes(String(event.kind)) ||
      !object(event.payload).locator
    )
      throw Error('EXACT_EVENT_EVIDENCE_REQUIRED');
    if (event.kind === 'amount_change') {
      const payload = object(event.payload),
        left = amounts.find((a) => a.id === payload.leftId),
        right = amounts.find((a) => a.id === payload.rightId);
      if (!left || !right || !compareBudgetAmounts(left, right).comparable)
        throw Error('COMPATIBLE_CHANGE_EVIDENCE_REQUIRED');
    }
  }
  const counts = {
    events: events.length,
    documents: documents.length,
    projects: projects.length,
    amounts: amounts.length,
    personnel: people.length,
    publishers: coverage.length,
  };
  if (!apply) return { mode: 'dry_run', ...counts };
  await prisma.$transaction(
    async (tx) => {
      for (const r of receipts)
        await tx.$executeRaw`INSERT INTO legiwatch_source_receipt(id,source,source_url,content_hash,scope,manifest,complete,content_bytes) VALUES(${String(r.id)},${String(r.source)},${String(r.sourceUrl)},${String(r.contentHash)},${JSON.stringify(r.scope)}::jsonb,${JSON.stringify(r.manifest)}::jsonb,${r.complete === true},${bytes.get(String(r.id))!}) ON CONFLICT DO NOTHING`;
      for (const d of documents) {
        const receiptId = hash(String(d.id) + ':receipt');
        await tx.$executeRaw`INSERT INTO legiwatch_source_receipt(id,source,source_url,content_hash,scope,manifest,complete,content_bytes) VALUES(${receiptId},'florida-budget',${String(d.sourceUrl)},${String(d.contentHash)},${JSON.stringify({ fiscalYear: d.fiscalYear, session: d.sessionKey })}::jsonb,${JSON.stringify({ pages: d.pageCount, extractionVersion: d.extractionVersion, retainedAmounts: amounts.filter((a) => a.documentId === d.id).length })}::jsonb,${d.complete === true},${bytes.get(String(d.id))!}) ON CONFLICT DO NOTHING`;
        await tx.$executeRaw`INSERT INTO florida_budget_document(id,publisher,source_url,content_hash,title,fiscal_year,session_key,chamber,stage,role,offer,publication_date,receipt_id,sections,metadata,complete) VALUES(${String(d.id)},${String(d.publisher)},${String(d.sourceUrl)},${String(d.contentHash)},${String(d.title)},${String(d.fiscalYear)},${String(d.sessionKey)},${String(d.chamber)},${String(d.stage)},${String(d.role)},${d.offer ? String(d.offer) : null},${d.publicationDate ? String(d.publicationDate) : null},${receiptId},${JSON.stringify(d.sections)}::jsonb,${JSON.stringify(d.metadata ?? {})}::jsonb,${d.complete === true}) ON CONFLICT DO NOTHING`;
      }
      for (const p of projects)
        await tx.$executeRaw`INSERT INTO florida_budget_project(id,fiscal_year,title,agency,identities,relations,evidence) VALUES(${String(p.id)},${String(p.fiscalYear)},${String(p.title)},${p.agency ? String(p.agency) : null},${JSON.stringify(p.identities)}::jsonb,${JSON.stringify(p.relations)}::jsonb,${JSON.stringify(p.evidence)}::jsonb) ON CONFLICT DO NOTHING`;
      for (const a of amounts)
        await tx.$executeRaw`INSERT INTO florida_budget_amount(id,project_id,document_id,observation) VALUES(${a.id},${a.projectId},${a.documentId},${JSON.stringify(a)}::jsonb) ON CONFLICT DO NOTHING`;
      for (const d of documents)
        await tx.$executeRaw`INSERT INTO florida_budget_event(id,document_id,kind,payload) VALUES(${hash('new-document:' + String(d.id))},${String(d.id)},'new_document',${JSON.stringify({ title: d.title, sourceUrl: d.sourceUrl, revision: d.contentHash, stage: d.stage, role: d.role, locator: 'complete-document' })}::jsonb) ON CONFLICT DO NOTHING`;
      for (const event of events)
        await tx.$executeRaw`INSERT INTO florida_budget_event(id,project_id,document_id,kind,payload) VALUES(${hash(JSON.stringify(event))},${event.projectId ? String(event.projectId) : null},${String(event.documentId)},${String(event.kind)},${JSON.stringify(event.payload)}::jsonb) ON CONFLICT DO NOTHING`;
      for (const p of people) {
        if (!receipts.some((r) => r.id === p.receiptId)) throw Error('PERSONNEL_RECEIPT_REQUIRED');
        await tx.$executeRaw`INSERT INTO florida_personnel_observation(id,source_key,revision,kind,name,branch,registration_year,firm,principal,old_role,new_role,announced_date,effective_date,withdrawal_date,confirmation,canonical_person_id,directory_url,source_url,receipt_id,payload) VALUES(${String(p.id)},${String(p.sourceKey)},${String(p.revision)},${String(p.kind)},${String(p.name)},${p.branch ? String(p.branch) : null},${p.registrationYear ? Number(p.registrationYear) : null},${p.firm ? String(p.firm) : null},${p.principal ? String(p.principal) : null},${p.oldRole ? String(p.oldRole) : null},${p.newRole ? String(p.newRole) : null},${p.announcedDate ? String(p.announcedDate) : null},${p.effectiveDate ? String(p.effectiveDate) : null},${p.withdrawalDate ? String(p.withdrawalDate) : null},${String(p.confirmation)},${personMappings.get(String(p.id))?.id ?? null},${personMappings.get(String(p.id))?.url ?? null},${String(p.sourceUrl)},${String(p.receiptId)},${JSON.stringify({ ...object(p.payload), identityMapping: p.identityMapping ?? object(p.payload).identityMapping })}::jsonb) ON CONFLICT DO NOTHING`;
      }
      for (const c of coverage)
        await tx.$executeRaw`INSERT INTO legiwatch_source_coverage(id,publisher,source_group,source_url,status,evidence,owner) VALUES(${String(c.id)},${String(c.publisher)},${String(c.sourceGroup)},${c.sourceUrl ? String(c.sourceUrl) : null},${String(c.status)},${JSON.stringify(c.evidence)}::jsonb,${String(c.owner)}) ON CONFLICT(id) DO UPDATE SET source_url=EXCLUDED.source_url,status=EXCLUDED.status,evidence=EXCLUDED.evidence,version=legiwatch_source_coverage.version+1 WHERE legiwatch_source_coverage.status<>'excluded' AND (legiwatch_source_coverage.evidence IS DISTINCT FROM EXCLUDED.evidence OR legiwatch_source_coverage.status<>EXCLUDED.status)`;
    },
    { timeout: 120000 },
  );
  return { mode: 'applied', ...counts };
}
if (require.main === module) {
  const path = process.argv.find((a) => a.startsWith('--manifest='))?.slice(11);
  if (!path) throw Error('--manifest=exact-source-manifest.json required');
  const prisma = new PrismaClient();
  importPhase8Manifest(prisma, path, process.argv.includes('--apply'))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
