#!/usr/bin/env tsx
/**
 * Generate a branded HTML report card for a client.
 * Usage: tsx scripts/generate-report-card-docx.ts <clientId> <tenantId> [--period quarter|year]
 *
 * Outputs an HTML file to /tmp/report-card-<clientId>.html
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const clientId = args[0];
  const tenantId = args[1];
  const periodArg = args.find((a) => a.startsWith('--period='))?.split('=')[1];
  const period: 'quarter' | 'year' = periodArg === 'year' ? 'year' : 'quarter';

  if (!clientId || !tenantId) {
    console.error('Usage: tsx scripts/generate-report-card-docx.ts <clientId> <tenantId> [--period=quarter|year]');
    process.exit(1);
  }

  console.log(`Generating ${period} report card for client ${clientId} (tenant ${tenantId})...`);

  const days = period === 'quarter' ? 90 : 365;
  const now = new Date();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // Fetch client + tenant
  const [client, tenant] = await Promise.all([
    prisma.client.findFirst({ where: { id: clientId }, select: { id: true, name: true, sectorTag: true } }),
    prisma.tenant.findFirst({ where: { id: tenantId }, select: { name: true } }),
  ]);

  if (!client) { console.error('Client not found'); process.exit(1); }

  // Activity metrics
  const [meetings, outreachRecords, tasksCompleted, debriefs, mailThreads, submissions] = await Promise.all([
    prisma.meeting.count({ where: { clientId, tenantId, startsAt: { gte: start } } }),
    prisma.outreachRecord.count({ where: { clientId, tenantId, sentAt: { gte: start }, deletedAt: null } }),
    prisma.engagementTask.count({ where: { clientId, tenantId, status: 'done', updatedAt: { gte: start } } }),
    prisma.meetingDebrief.count({ where: { clientId, tenantId, createdAt: { gte: start } } }),
    prisma.mailThread.count({ where: { clientId, tenantId, lastMessageAt: { gte: start } } }),
    prisma.clientSubmissionHistory.findMany({
      where: { clientId, tenantId },
      include: { capability: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  // Intelligence metrics
  const ldaMapping = await prisma.clientIntelMapping.findFirst({
    where: { clientId, source: 'lda', confirmed: true },
  });
  let lobbySpend = 0;
  let competitorCount = 0;
  if (ldaMapping) {
    const spendRows = await prisma.$queryRaw<Array<{ total: number }>>`
      SELECT COALESCE(SUM(income), 0)::float AS total FROM lda_filing WHERE client_id = ${Number(ldaMapping.externalId)}
    `;
    lobbySpend = spendRows[0]?.total ?? 0;

    const codeRows = await prisma.$queryRaw<Array<{ issue_codes: string[] }>>`
      SELECT COALESCE(issue_codes, '{}') AS issue_codes FROM lda_client WHERE id = ${Number(ldaMapping.externalId)}
    `;
    const issueCodes = codeRows[0]?.issue_codes ?? [];
    if (issueCodes.length) {
      const countRows = await prisma.$queryRaw<Array<{ count: string }>>`
        SELECT COUNT(DISTINCT id)::text AS count FROM lda_client
        WHERE issue_codes && ${issueCodes}::text[] AND id != ${Number(ldaMapping.externalId)}
      `;
      competitorCount = parseInt(countRows[0]?.count ?? '0', 10);
    }
  }

  const contractingMapping = await prisma.clientIntelMapping.findFirst({
    where: {
      clientId,
      source: 'contracting',
      confirmed: true,
      reviewStatus: 'confirmed',
      rollUpAwards: true,
    },
  });
  let contractWins = 0;
  if (contractingMapping) {
    const rows = await prisma.$queryRaw<Array<{ total: number }>>`
      SELECT COALESCE(total_contracts, 0)::float AS total FROM federal_contractor WHERE id = ${contractingMapping.externalId}::uuid
    `;
    contractWins = rows[0]?.total ?? 0;
  }

  const quarterNum = Math.ceil((now.getMonth() + 1) / 3);
  const periodLabel = period === 'quarter' ? `Q${quarterNum} FY${now.getFullYear()}` : `FY${now.getFullYear()}`;

  const fmt = (n: number) =>
    n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${n.toLocaleString()}`;

  const outcomeRows = submissions.map((s) => `
    <tr>
      <td>${escHtml(s.title)}</td>
      <td>${escHtml(s.fiscalYear)}</td>
      <td><span class="badge badge-${badgeClass(s.outcomeType)}">${escHtml(s.outcomeType)}</span></td>
      <td>${escHtml(s.capability?.name ?? '-')}</td>
      <td>${escHtml(s.notes ?? '-')}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(client.name)}, ${periodLabel} Intelligence Report Card</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Helvetica, Arial, sans-serif; color: #1a1a2e; background: #f8f9fa; }
  .page { max-width: 900px; margin: 0 auto; background: #fff; padding: 48px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 24px; border-bottom: 3px solid #1c2e4a; margin-bottom: 32px; }
  .header-left h1 { font-size: 24px; font-weight: 700; color: #1c2e4a; }
  .header-left p { color: #6b7280; margin-top: 4px; font-size: 14px; }
  .tenant-name { font-size: 13px; font-weight: 600; color: #4b5563; text-align: right; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 32px; }
  .kpi-card { background: #f0f4ff; border-radius: 8px; padding: 16px; text-align: center; }
  .kpi-value { font-size: 28px; font-weight: 700; color: #1c2e4a; }
  .kpi-label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
  section { margin-bottom: 32px; }
  section h2 { font-size: 16px; font-weight: 700; color: #1c2e4a; border-left: 4px solid #3b82f6; padding-left: 10px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #1c2e4a; color: #fff; text-align: left; padding: 8px 12px; font-weight: 600; }
  td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; }
  tr:last-child td { border-bottom: none; }
  tr:nth-child(even) td { background: #f9fafb; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .badge-won { background: #d1fae5; color: #065f46; }
  .badge-in_progress { background: #fef3c7; color: #92400e; }
  .badge-lost { background: #fee2e2; color: #991b1b; }
  .badge-pending { background: #e5e7eb; color: #374151; }
  .forward-look { background: #f0f4ff; border-radius: 8px; padding: 20px; white-space: pre-wrap; font-size: 14px; line-height: 1.7; }
  .health-trend { display: flex; align-items: flex-end; gap: 6px; height: 80px; padding: 12px 0; }
  .health-bar { flex: 1; background: #3b82f6; border-radius: 3px 3px 0 0; min-height: 4px; position: relative; }
  .health-bar:hover::after { content: attr(data-label); position: absolute; top: -22px; left: 50%; transform: translateX(-50%); background: #1c2e4a; color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 10px; white-space: nowrap; }
  .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e5e7eb; text-align: center; color: #9ca3af; font-size: 11px; }
  @media print { body { background: white; } .page { padding: 24px; } }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="header-left">
      <h1>${escHtml(client.name)}, Intelligence Report Card</h1>
      <p>${periodLabel} &nbsp;·&nbsp; ${start.toLocaleDateString()} – ${now.toLocaleDateString()}</p>
    </div>
    <div class="tenant-name">${escHtml(tenant?.name ?? '')}</div>
  </div>

  <div class="kpi-grid">
    <div class="kpi-card"><div class="kpi-value">${meetings}</div><div class="kpi-label">Meetings</div></div>
    <div class="kpi-card"><div class="kpi-value">${outreachRecords}</div><div class="kpi-label">Outreach Sent</div></div>
    <div class="kpi-card"><div class="kpi-value">${tasksCompleted}</div><div class="kpi-label">Tasks Completed</div></div>
    <div class="kpi-card"><div class="kpi-value">${debriefs}</div><div class="kpi-label">Debriefs Filed</div></div>
    <div class="kpi-card"><div class="kpi-value">${mailThreads}</div><div class="kpi-label">Mail Threads</div></div>
    <div class="kpi-card"><div class="kpi-value">${fmt(lobbySpend)}</div><div class="kpi-label">Total LDA Spend</div></div>
    <div class="kpi-card"><div class="kpi-value">${fmt(contractWins)}</div><div class="kpi-label">Contract Wins</div></div>
    <div class="kpi-card"><div class="kpi-value">${competitorCount.toLocaleString()}</div><div class="kpi-label">Competitors</div></div>
  </div>

  <section>
    <h2>Outcomes</h2>
    ${submissions.length > 0 ? `
    <table>
      <thead><tr><th>Submission</th><th>FY</th><th>Outcome</th><th>Capability</th><th>Notes</th></tr></thead>
      <tbody>${outcomeRows}</tbody>
    </table>` : '<p style="color:#6b7280;font-size:13px;">No submissions recorded for this period.</p>'}
  </section>

  <section>
    <h2>Forward Look</h2>
    <div class="forward-look">${escHtml('[AI forward look not available in standalone script mode, run via API for AI-generated narrative]')}</div>
  </section>

  <div class="footer">Generated by Capiro Intelligence Platform &nbsp;·&nbsp; ${now.toLocaleDateString()} ${now.toLocaleTimeString()}</div>
</div>
</body>
</html>`;

  const outPath = path.join(os.tmpdir(), `report-card-${clientId}.html`);
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`Report card written to: ${outPath}`);

  await prisma.$disconnect();
}

function escHtml(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function badgeClass(outcomeType: string): string {
  if (outcomeType === 'won') return 'won';
  if (outcomeType === 'lost') return 'lost';
  if (outcomeType === 'in_progress') return 'in_progress';
  return 'pending';
}

main().catch((e) => { console.error(e); process.exit(1); });
