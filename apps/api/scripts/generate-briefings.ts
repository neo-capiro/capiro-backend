/**
 * Generate daily client briefings for all active clients with confirmed LDA mappings.
 * Stores results as IntelligenceInsight with category='briefing'.
 *   npx tsx scripts/generate-briefings.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
dotenvConfig();

const prisma = new PrismaClient();

const MODEL = 'gpt-4o-mini';
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const DAILY_BRIEFING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['heroSummary', 'whatsNew', 'whatsComing', 'suggestedActions'],
  properties: {
    heroSummary: { type: 'string' },
    whatsNew: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'source', 'detail', 'citation'],
        properties: {
          title: { type: 'string' },
          source: { type: 'string' },
          detail: { type: 'string' },
          citation: { type: 'string' },
        },
      },
    },
    whatsComing: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'date', 'type', 'action'],
        properties: {
          title: { type: 'string' },
          date: { type: 'string' },
          type: { type: 'string' },
          action: { type: 'string' },
        },
      },
    },
    suggestedActions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'rationale', 'urgency'],
        properties: {
          action: { type: 'string' },
          rationale: { type: 'string' },
          urgency: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a senior federal government affairs analyst. Generate structured daily intelligence briefings from the provided data. Be specific and actionable, this is for senior lobbyists.`;

async function callOpenAi(prompt: string): Promise<string> {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set');
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      instructions: SYSTEM_PROMPT,
      input: prompt,
      text: {
        format: {
          type: 'json_schema',
          name: 'daily_briefing',
          strict: true,
          schema: DAILY_BRIEFING_SCHEMA,
        },
      },
    }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`OpenAI error: ${JSON.stringify(json).slice(0, 200)}`);

  const output = Array.isArray(json.output) ? json.output : [];
  for (const item of output) {
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? ((item as Record<string, unknown>).content as unknown[])
      : [];
    for (const part of content) {
      const text = (part as Record<string, unknown>).text;
      if (typeof text === 'string') return text;
    }
  }
  if (typeof json.output_text === 'string') return json.output_text;
  return '';
}

async function generateBriefingForClient(
  clientId: string,
  clientName: string,
  tenantId: string,
): Promise<string | null> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const fourteenDaysOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  // Get LDA issue codes
  const ldaMapping = await prisma.$queryRaw<Array<{ external_id: string }>>`
    SELECT external_id FROM client_intel_mapping
    WHERE client_id = ${clientId}::uuid AND source = 'lda' AND confirmed = true
    LIMIT 1
  `;

  let issueCodes: string[] = [];
  if (ldaMapping.length) {
    const codeRows = await prisma.$queryRaw<Array<{ issue_codes: string[] }>>`
      SELECT COALESCE(issue_codes, '{}') AS issue_codes
      FROM lda_client WHERE id = ${Number(ldaMapping[0]!.external_id)}
    `;
    issueCodes = codeRows[0]?.issue_codes ?? [];
  }

  // Gather context in parallel
  const [ldaMatch, recentChanges, upcomingHearings, commentDeadlines, capabilities] =
    await Promise.all([
      prisma.$queryRaw<
        Array<{
          name: string;
          total_filings: number;
          total_spending: number | null;
          issue_codes: string[];
          similarity: number;
        }>
      >`
      SELECT name, total_filings, total_spending::float, COALESCE(issue_codes, '{}') as issue_codes,
             similarity(name, ${clientName}) as similarity
      FROM lda_client WHERE similarity(name, ${clientName}) > 0.3
      ORDER BY similarity DESC LIMIT 1
    `.catch(() => []),
      prisma
        .$queryRawUnsafe<
          Array<{ title: string; source: string; change_type: string; description: string }>
        >(
          `SELECT title, source, change_type, description FROM intelligence_change
       WHERE detected_at >= $1
         AND (related_client_ids @> ARRAY[$2]::uuid[]
              ${issueCodes.length ? `OR related_issues && ARRAY[${issueCodes.map((_, i) => `$${i + 3}`).join(',')}]::text[]` : ''})
       ORDER BY detected_at DESC LIMIT 20`,
          yesterday,
          clientId,
          ...issueCodes,
        )
        .catch(() => []),
      prisma.$queryRaw<
        Array<{ committee_name: string; title: string; date: Date; chamber: string }>
      >`
      SELECT committee_name, title, date, chamber FROM committee_hearing
      WHERE date >= ${now} AND date <= ${fourteenDaysOut}
      ORDER BY date ASC LIMIT 10
    `.catch(() => []),
      prisma.$queryRaw<
        Array<{ title: string; type: string; comment_end_date: Date; agency_names: string[] }>
      >`
      SELECT title, type, comment_end_date, agency_names FROM federal_register_document
      WHERE type IN ('PROPOSED_RULE', 'RULE')
        AND comment_end_date > ${now} AND comment_end_date <= ${fourteenDaysOut}
      ORDER BY comment_end_date ASC LIMIT 10
    `.catch(() => []),
      prisma.$queryRaw<Array<{ name: string; sector: string | null }>>`
      SELECT name, sector FROM client_capabilities
      WHERE client_id = ${clientId}::uuid AND tenant_id = ${tenantId}::uuid
    `.catch(() => []),
    ]);

  const contextParts: string[] = [];
  contextParts.push(`CLIENT: ${clientName}`);
  if (capabilities.length)
    contextParts.push(`CAPABILITIES: ${capabilities.map((c) => c.name).join(', ')}`);

  if (ldaMatch.length) {
    const m = ldaMatch[0]!;
    contextParts.push(
      `LDA MATCH: ${m.name} (${Math.round(m.similarity * 100)}% confidence), filings: ${m.total_filings}, spending: ${m.total_spending ? `$${(m.total_spending / 1e6).toFixed(1)}M` : 'unknown'}`,
    );
    if (m.issue_codes.length) contextParts.push(`  Issue areas: ${m.issue_codes.join(', ')}`);
  }

  if (recentChanges.length) {
    contextParts.push(
      `WHAT'S NEW (24h):\n  ${recentChanges.map((c) => `[${c.source}/${c.change_type}] ${c.title}`).join('\n  ')}`,
    );
  } else {
    contextParts.push(`WHAT'S NEW (24h): No significant changes detected`);
  }

  if (upcomingHearings.length) {
    contextParts.push(
      `UPCOMING HEARINGS (14d):\n  ${upcomingHearings
        .map((h) => {
          const daysOut = Math.ceil((new Date(h.date).getTime() - now.getTime()) / 86400000);
          return `${h.committee_name}, "${String(h.title).slice(0, 70)}" (${daysOut}d, ${h.chamber})`;
        })
        .join('\n  ')}`,
    );
  }

  if (commentDeadlines.length) {
    contextParts.push(
      `COMMENT DEADLINES (14d):\n  ${commentDeadlines
        .map((r) => {
          const daysLeft = Math.ceil(
            (new Date(r.comment_end_date).getTime() - now.getTime()) / 86400000,
          );
          return `"${String(r.title).slice(0, 70)}" (${r.type}, ${daysLeft}d left, ${(r.agency_names as string[]).slice(0, 2).join('/')})`;
        })
        .join('\n  ')}`,
    );
  }

  const prompt = `Generate a structured daily intelligence briefing for the client below.

${contextParts.join('\n')}

Return structured JSON with heroSummary, whatsNew, whatsComing, and suggestedActions.`;

  const text = await callOpenAi(prompt);
  return text;
}

async function main() {
  if (!OPENAI_KEY) {
    console.error('[generate-briefings] OPENAI_API_KEY not set, aborting');
    process.exit(1);
  }

  const startedAt = new Date();
  console.log(`[generate-briefings] starting at ${startedAt.toISOString()}`);

  const tenants = await prisma.$queryRaw<Array<{ id: string; slug: string }>>`
    SELECT id, slug FROM tenants WHERE status = 'active'
  `;
  console.log(`[generate-briefings] ${tenants.length} active tenants`);

  let generated = 0;
  let errors = 0;

  for (const tenant of tenants) {
    // Get active clients with at least one confirmed LDA mapping
    const clients = await prisma.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT DISTINCT c.id, c.name
      FROM clients c
      JOIN client_intel_mapping m ON m.client_id = c.id AND m.source = 'lda' AND m.confirmed = true
      WHERE c.tenant_id = ${tenant.id}::uuid
        AND c.profile_status = 'ACTIVE'
    `;

    console.log(`[generate-briefings] tenant=${tenant.slug}, ${clients.length} clients to brief`);

    for (const client of clients) {
      const t0 = Date.now();
      try {
        const text = await generateBriefingForClient(client.id, client.name, tenant.id);
        if (!text) {
          errors++;
          continue;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          const match = text.match(/\{[\s\S]*\}/);
          if (!match) {
            errors++;
            continue;
          }
          parsed = JSON.parse(match[0]) as Record<string, unknown>;
        }

        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
        await prisma.intelligenceInsight.create({
          data: {
            // GAI-01: a per-client briefing is tenant-derived — scope it to the
            // tenant/client so it is never served cross-tenant. (Previously this
            // row carried NO tenant marker at all, which is why the migration
            // soft-expires historical 'briefing' rows rather than backfilling.)
            tenantId: tenant.id,
            clientId: client.id,
            category: 'briefing',
            title: `Daily briefing: ${client.name}`,
            body: typeof parsed.heroSummary === 'string' ? parsed.heroSummary : '',
            severity: 'info',
            dataPoints: parsed as Record<string, unknown>,
            expiresAt,
          },
        });

        generated++;
        console.log(`[generate-briefings] ${client.name}, done in ${Date.now() - t0}ms`);
      } catch (err) {
        errors++;
        console.error(`[generate-briefings] ${client.name}, error:`, err);
      }
    }
  }

  console.log(
    `[generate-briefings] done. Generated ${generated} briefings, ${errors} errors. Elapsed: ${Date.now() - startedAt.getTime()}ms`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
