import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Stage D: the Capiro-generated 07_current_plan.md projection. READ-ONLY and
 * LLM-free — a deterministic render of live strategy state into the pack's
 * current-plan shape (src/context/templates/07_current_plan.md is the
 * contract), so agents consume the SAME plan the planner persists instead of a
 * second manually maintained copy.
 */
@Injectable()
export class CurrentPlanExportService {
  constructor(private readonly prisma: PrismaService) {}

  async exportCurrentPlan(tenantId: string, strategyId: string): Promise<{ markdown: string }> {
    const strategy = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spStrategy.findFirst({
        where: { id: strategyId },
        include: {
          nodes: {
            orderBy: [{ startsOn: 'asc' }, { createdAt: 'asc' }],
            include: { artifacts: true },
          },
        },
      }),
    );
    if (!strategy) throw new NotFoundException('Strategy not found');

    const today = new Date().toISOString().slice(0, 10);
    const todayMs = Date.parse(today);

    const frontmatter = [
      '---',
      'document_type: current_plan',
      'schema_version: "1.0"',
      'state: active',
      'scope: strategy',
      `client_id: "${strategy.clientId}"`,
      `strategy_id: "${strategy.id}"`,
      'node_id: null',
      `as_of: "${today}"`,
      'valid_until: null',
      'owner: "system"',
      'authority: firm_approved',
      'source_of_truth: true',
      'supersedes: null',
      'confidentiality: client_confidential',
      'generated_by: "Capiro"',
      '---',
    ].join('\n');

    const header =
      '| node_id | Kind | Subject | Title | Start date | End date | FY-quarter | Owner | Status | Dependencies | Blockers | Acceptance criteria | Artifact link |';
    const separator = '|---|---|---|---|---|---|---|---|---|---|---|---|---|';

    const rows = strategy.nodes.map((n) => {
      const cells = [
        n.id,
        capitalize(n.kind),
        capitalize(n.subject),
        escapeCell(n.title),
        isoDate(n.startsOn),
        n.endsOn ? isoDate(n.endsOn) : '',
        fyQuarter(n.startsOn),
        escapeCell(n.ownerUserId ?? ''),
        capitalize(n.status),
        n.dependsOnIds.join(';'),
        '', // Blockers — Stage E wires unresolved-context conflicts
        '', // Acceptance criteria — authored, not derivable from node state
        n.artifacts.length > 0
          ? n.artifacts.map((a) => `${a.artifactType}:${escapeCell(a.artifactRef)}`).join(';')
          : 'null',
      ];
      return `| ${cells.join(' | ')} |`;
    });

    // ---- Plan health: computed WITHOUT any LLM, from node state alone. ----
    const unowned = strategy.nodes.filter((n) => !n.ownerUserId).length;
    // Overdue = past its end date and actually part of the plan. `active` is a
    // LIVE (not terminal) status, so it counts; `suggested` is an unaccepted
    // Meri proposal — not committed work — so it never counts as overdue.
    const overdue = strategy.nodes.filter(
      (n) => n.endsOn !== null && n.endsOn.getTime() < todayMs && n.status !== 'suggested',
    ).length;
    // Gates/decisions with no dependency edges have nothing guarding them.
    const gatesMissingPrereqs = strategy.nodes.filter(
      (n) => (n.kind === 'gate' || n.kind === 'decision') && n.dependsOnIds.length === 0,
    ).length;

    const planHealth = [
      '## Plan health',
      '',
      `- Unowned nodes: ${unowned}`,
      `- Overdue nodes: ${overdue}`,
      // Stage E wires real context-conflict detection; until then this is
      // structurally 0 (no conflict source exists to block on).
      '- Nodes blocked by unresolved context: 0',
      `- Gates missing prerequisites: ${gatesMissingPrereqs}`,
      // Stage G wires execution-eligibility; structurally 0 until then.
      '- Execution-ready nodes: 0',
    ].join('\n');

    const markdown = [
      frontmatter,
      '',
      '# Current plan',
      '',
      header,
      separator,
      ...rows,
      '',
      planHealth,
      '',
    ].join('\n');

    return { markdown };
  }
}

/**
 * Federal fiscal-year quarter from a calendar date: FY starts Oct 1, so a
 * month >= October belongs to FY(year+1); quarters are Oct-Dec=Q1, Jan-Mar=Q2,
 * Apr-Jun=Q3, Jul-Sep=Q4. Rendered as the pack's 'FY2027 Q2' label.
 */
export function fyQuarter(date: Date): string {
  const month = date.getUTCMonth() + 1; // 1..12
  const year = date.getUTCFullYear();
  const fy = month >= 10 ? year + 1 : year;
  const quarter = month >= 10 ? 1 : Math.floor((month - 1) / 3) + 2;
  return `FY${fy} Q${quarter}`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 'in_progress' -> 'In progress', 'action' -> 'Action'. */
function capitalize(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Markdown-table cell safety for free-string cells (title, ownerUserId,
 * artifactRef): a literal '|' would split the row, and a newline would
 * terminate it mid-table — letting cell content forge whole sections/rows in
 * the agent-consumed document. Collapse line breaks to a space, escape pipes.
 */
function escapeCell(value: string): string {
  return value.replace(/\r\n|[\r\n]/g, ' ').replace(/\|/g, '\\|');
}
