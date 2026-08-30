import { createHash } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  ATTACHED_ARTIFACT_WHERE,
  LIVE_NODE_WHERE,
} from "../strategy/live-node.js";
import { computeReportHealth } from "./report-health.js";
import {
  includeNodeForAudience,
  reportStatusForAudience,
} from "./report-policy.js";
import { ooxmlSafeValue } from "./report-text.js";
import type {
  ExecutiveReportSnapshot,
  NormalizedReportOptions,
  ReportCounts,
  ReportIssue,
  ReportLogoDescriptor,
  ReportNode,
  ReportPreflight,
  ReportProvenanceSource,
} from "./report.types.js";

interface ClientBrandRow {
  id: string;
  name: string;
  logoS3Key: string | null;
  logoContentType: string | null;
}

interface MemberRow {
  clerkUserId: string;
  firstName: string | null;
  lastName: string | null;
}

interface CountRow {
  count: number;
}

const SUPPORTED_LOGO_TYPES = new Set(["image/png", "image/jpeg"]);
export const REPORT_CAPACITY_LIMITS = {
  nodes: 300,
  artifacts: 600,
  sourcesPerNode: 20,
  dependenciesPerNode: 100,
  snapshotBytes: 8 * 1024 * 1024,
} as const;

@Injectable()
export class ReportSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  async preflight(
    tenantId: string,
    strategyId: string,
    audience: "client" | "internal" = "client",
  ): Promise<ReportPreflight> {
    const snapshot = await this.build(tenantId, strategyId, {
      format: "docx",
      audience,
      useClientLogo: true,
      includeRoadmap: true,
      includeEvidenceAppendix: true,
      includeChangeLog: false,
      includeInternalNotes: false,
      includeAgentHistory: false,
    });
    const errors: ReportIssue[] = [...snapshot.capacityErrors];
    if (snapshot.counts.nodes === 0) {
      errors.unshift({
        code: "NO_ACTIVE_NODES",
        message:
          "Add at least one active plan step before generating an executive report.",
      });
    }
    const { objectKey: _privateObjectKey, ...publicLogo } =
      snapshot.client.logo;
    return {
      report: {
        strategyId: snapshot.strategy.id,
        title: snapshot.strategy.title,
        type: snapshot.strategy.type,
        ready: errors.length === 0,
        asOf: snapshot.asOf,
        formats: ["docx", "pptx"],
      },
      client: { id: snapshot.client.id, name: snapshot.client.name },
      version: { ...snapshot.version, note: null },
      health: snapshot.health,
      counts: snapshot.counts,
      logo: publicLogo,
      warnings: snapshot.warnings,
      errors,
    };
  }

  async build(
    tenantId: string,
    strategyId: string,
    options: NormalizedReportOptions,
  ): Promise<ExecutiveReportSnapshot> {
    const asOf = new Date().toISOString().slice(0, 10);
    const asOfDate = new Date(`${asOf}T00:00:00.000Z`);

    const loaded = await this.prisma.withTenant(
      tenantId,
      async (tx) => {
        const strategy = await tx.spStrategy.findFirst({
          where: { id: strategyId, archivedAt: null },
          include: {
            nodes: {
              where: { ...LIVE_NODE_WHERE },
              orderBy: [{ startsOn: "asc" }, { createdAt: "asc" }],
              take: REPORT_CAPACITY_LIMITS.nodes + 1,
              select: {
                id: true,
                kind: true,
                subject: true,
                title: true,
                note: true,
                ownerUserId: true,
                status: true,
                startsOn: true,
                endsOn: true,
                openEnded: true,
                dependsOnIds: true,
                provenance: true,
                targetRef: true,
              },
            },
            artifacts: {
              where: { ...ATTACHED_ARTIFACT_WHERE },
              orderBy: { createdAt: "asc" },
              take: REPORT_CAPACITY_LIMITS.artifacts + 1,
              select: {
                nodeId: true,
                artifactType: true,
                artifactRef: true,
              },
            },
          },
        });
        if (!strategy) throw new NotFoundException("Strategy not found");

        const [
          clientRows,
          memberRows,
          versions,
          firmPhases,
          referenceBaseline,
          referenceOverrides,
          contextSummary,
          openMaterialConflictRows,
          agentRuns,
          changeSets,
        ] = await Promise.all([
          tx.$queryRaw<ClientBrandRow[]>`
          SELECT
            id::text AS id,
            name,
            logo_s3_key AS "logoS3Key",
            logo_content_type AS "logoContentType"
          FROM clients
          WHERE id = ${strategy.clientId}::uuid
            AND tenant_id = ${tenantId}::uuid
          LIMIT 1
        `,
          tx.$queryRaw<MemberRow[]>`
          SELECT
            u.clerk_user_id AS "clerkUserId",
            u.first_name AS "firstName",
            u.last_name AS "lastName"
          FROM tenant_memberships tm
          JOIN users u ON u.id = tm.user_id
          WHERE tm.tenant_id = ${tenantId}::uuid
            AND tm.status::text = 'active'
          LIMIT 1000
        `,
          tx.spVersion.findMany({
            where: { strategyId },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 12,
            select: { id: true, note: true, authorKind: true, createdAt: true },
          }),
          tx.spFirmPhase.findMany({
            orderBy: { position: "asc" },
            take: 100,
            select: {
              label: true,
              startFy: true,
              startQ: true,
              endFy: true,
              endQ: true,
            },
          }),
          tx.spReferenceEntry.findMany({
            where: { active: true },
            orderBy: { position: "asc" },
            take: 200,
            select: {
              kind: true,
              label: true,
              startsOn: true,
              endsOn: true,
              fy: true,
            },
          }),
          tx.spReferenceOverride.findMany({
            where: { active: true },
            orderBy: { position: "asc" },
            take: 200,
            select: {
              kind: true,
              label: true,
              startsOn: true,
              endsOn: true,
              fy: true,
            },
          }),
          Promise.all([
            tx.spContextDocument.count({
              where: {
                state: "active",
                OR: [
                  { clientId: strategy.clientId },
                  { scope: "strategy", scopeRef: strategyId },
                  { scope: "firm", clientId: null },
                ],
              },
            }),
            tx.spContextDocument.count({
              where: {
                state: "active",
                validUntil: { lt: asOfDate },
                OR: [
                  { clientId: strategy.clientId },
                  { scope: "strategy", scopeRef: strategyId },
                  { scope: "firm", clientId: null },
                ],
              },
            }),
          ]).then(([activeDocuments, staleDocuments]) => ({
            activeDocuments,
            staleDocuments,
          })),
          tx.$queryRaw<CountRow[]>`
            SELECT COUNT(*)::int AS count
            FROM sp_context_conflict c
            WHERE c.tenant_id = ${tenantId}::uuid
              AND c.material = true
              AND c.state::text = 'open'
              AND (
                EXISTS (
                  SELECT 1
                  FROM sp_context_fact f
                  WHERE f.id = c.fact_a_id
                    AND f.tenant_id = ${tenantId}::uuid
                    AND f.client_id = ${strategy.clientId}::uuid
                    AND f.state::text = 'active'
                )
                OR EXISTS (
                  SELECT 1
                  FROM sp_context_fact f
                  WHERE f.id = c.fact_b_id
                    AND f.tenant_id = ${tenantId}::uuid
                    AND f.client_id = ${strategy.clientId}::uuid
                    AND f.state::text = 'active'
                )
              )
          `,
          tx.spAgentRun.findMany({
            where: { strategyId },
            orderBy: { createdAt: "desc" },
            take: 20,
            select: {
              state: true,
              trigger: true,
              startedAt: true,
              finishedAt: true,
              createdAt: true,
              waitingReason: true,
            },
          }),
          tx.spChangeSet.findMany({
            where: { strategyId },
            orderBy: { createdAt: "desc" },
            take: 20,
            select: {
              summary: true,
              risk: true,
              status: true,
              createdAt: true,
              appliedAt: true,
            },
          }),
        ]);

        return {
          strategy,
          client: clientRows[0] ?? null,
          members: memberRows,
          versions,
          firmPhases,
          referenceRows: mergeReferenceRows(
            referenceBaseline,
            referenceOverrides,
          ),
          contextSummary,
          openMaterialConflicts: openMaterialConflictRows[0]?.count ?? 0,
          agentRuns,
          changeSets,
        };
      },
      {
        // Every section must describe the same database state. Repeatable reads
        // prevent a concurrent edit from mixing strategy/nodes, context, version,
        // and activity data from different moments in one exported report.
        isolationLevel: "RepeatableRead",
      },
    );

    const memberNames = new Map(
      loaded.members.map((member) => [
        member.clerkUserId,
        [member.firstName, member.lastName].filter(Boolean).join(" ").trim() ||
          "Team member",
      ]),
    );
    const ownerName = (userId: string | null | undefined): string =>
      userId ? (memberNames.get(userId) ?? "Team member") : "Unassigned";

    const nodes: ReportNode[] = loaded.strategy.nodes
      .slice(0, REPORT_CAPACITY_LIMITS.nodes)
      .filter((node) => includeNodeForAudience(node.status, options.audience))
      .map((node) => {
        const allSources = extractSources(node.provenance);
        return {
          id: node.id,
          kind: node.kind,
          subject: node.subject,
          title: node.title,
          note: options.includeInternalNotes ? node.note : null,
          ownerAssigned: Boolean(node.ownerUserId),
          ownerName: ownerName(node.ownerUserId),
          status: reportStatusForAudience(node.status, options.audience),
          startsOn: dbDate(node.startsOn)!,
          endsOn: dbDate(node.endsOn),
          openEnded: node.openEnded,
          dependsOnIds: node.dependsOnIds.slice(
            0,
            REPORT_CAPACITY_LIMITS.dependenciesPerNode,
          ),
          sources: allSources.slice(0, REPORT_CAPACITY_LIMITS.sourcesPerNode),
          sourceCount: allSources.length,
          targetLabel: extractTargetLabel(node.targetRef),
        };
      });
    const includedNodeIds = new Set(nodes.map((node) => node.id));
    const artifacts = loaded.strategy.artifacts
      .slice(0, REPORT_CAPACITY_LIMITS.artifacts)
      .filter((artifact) => includedNodeIds.has(artifact.nodeId));
    const health = computeReportHealth(nodes, asOfDate);
    const counts = countPlan(nodes, artifacts.length);

    const rawLogoKey = loaded.client?.logoS3Key ?? null;
    const canonicalKey = canonicalLogoKey(
      rawLogoKey,
      tenantId,
      loaded.strategy.clientId,
    );
    const contentType = normalizeContentType(
      loaded.client?.logoContentType ?? null,
    );
    const logo: ReportLogoDescriptor = {
      available: Boolean(rawLogoKey),
      supported: Boolean(
        canonicalKey && contentType && SUPPORTED_LOGO_TYPES.has(contentType),
      ),
      contentType,
      objectKey: canonicalKey,
    };
    const staleDocuments = loaded.contextSummary.staleDocuments;
    const warnings = buildWarnings({
      clientFound: Boolean(loaded.client),
      hasGoal: Boolean(loaded.strategy.goal?.trim()),
      health,
      logo,
      logoRequested: options.useClientLogo,
      staleDocuments,
      openMaterialConflicts: loaded.openMaterialConflicts,
    });

    const latestVersion = loaded.versions[0];
    const capacityErrors: ReportIssue[] = [];
    const withoutHash: Omit<ExecutiveReportSnapshot, "snapshotHash"> = {
      asOf,
      strategy: {
        id: loaded.strategy.id,
        title: loaded.strategy.title,
        type: loaded.strategy.type,
        goal: loaded.strategy.goal,
        // This opaque model summary is generated from the full working plan,
        // including suggestions, notes, and Meri context. Client-facing prose
        // must instead be derived only from approved plan fields.
        summary:
          options.audience === "internal" ? loaded.strategy.meriSummary : null,
        targetDate: dbDate(loaded.strategy.targetDate),
        ownerName: ownerName(loaded.strategy.ownerUserId),
        lastEditedAt: iso(loaded.strategy.lastEditedAt),
      },
      client: {
        id: loaded.strategy.clientId,
        name: loaded.client?.name?.trim() || "Client",
        logo,
      },
      version: {
        id: latestVersion?.id ?? null,
        createdAt: iso(latestVersion?.createdAt ?? null),
        note:
          options.audience === "internal"
            ? (latestVersion?.note ?? null)
            : null,
      },
      health,
      counts,
      nodes,
      artifacts: artifacts.map((artifact) => ({
        nodeId: artifact.nodeId,
        artifactType: artifact.artifactType,
        artifactRef: artifact.artifactRef,
      })),
      firmPhases: loaded.firmPhases,
      referenceWindows: loaded.referenceRows.map((row) => ({
        kind: row.kind,
        label: row.label,
        startsOn: dbDate(row.startsOn),
        endsOn: dbDate(row.endsOn),
        fy: row.fy,
      })),
      context: {
        activeDocuments: loaded.contextSummary.activeDocuments,
        staleDocuments,
        openMaterialConflicts: loaded.openMaterialConflicts,
      },
      activity: {
        versions: (options.includeChangeLog ? loaded.versions : []).map(
          (version) => ({
            id: version.id,
            note: version.note,
            authorKind: version.authorKind,
            createdAt: version.createdAt.toISOString(),
          }),
        ),
        agentRuns: (options.includeAgentHistory ? loaded.agentRuns : []).map(
          (run) => ({
            state: run.state,
            trigger: run.trigger,
            startedAt: iso(run.startedAt),
            finishedAt: iso(run.finishedAt),
            createdAt: run.createdAt.toISOString(),
            waitingReason: run.waitingReason,
          }),
        ),
        changeSets: (options.includeAgentHistory ? loaded.changeSets : []).map(
          (changeSet) => ({
            summary: changeSet.summary,
            risk: changeSet.risk,
            status: changeSet.status,
            createdAt: changeSet.createdAt.toISOString(),
            appliedAt: iso(changeSet.appliedAt),
          }),
        ),
      },
      options,
      warnings,
      capacityErrors,
    };
    // Office Open XML accepts only XML 1.0 characters. Normalize every stored
    // string before hashing so the audit hash describes the rendered payload.
    const safeWithoutHash = ooxmlSafeValue(withoutHash);
    const estimatedBytes = Buffer.byteLength(
      stableJson(safeWithoutHash),
      "utf8",
    );
    safeWithoutHash.capacityErrors.push(
      ...reportCapacityIssues({
        nodeRows: loaded.strategy.nodes.length,
        artifactRows: loaded.strategy.artifacts.length,
        estimatedBytes,
      }),
    );
    return {
      ...safeWithoutHash,
      snapshotHash: hashSnapshot(safeWithoutHash),
    };
  }
}

export function reportCapacityIssues(input: {
  nodeRows: number;
  artifactRows: number;
  estimatedBytes: number;
}): ReportIssue[] {
  const issues: ReportIssue[] = [];
  if (input.nodeRows > REPORT_CAPACITY_LIMITS.nodes) {
    issues.push({
      code: "REPORT_NODE_LIMIT_EXCEEDED",
      message: `This strategy has more than ${REPORT_CAPACITY_LIMITS.nodes} active plan steps. Archive or split the plan before exporting.`,
    });
  }
  if (input.artifactRows > REPORT_CAPACITY_LIMITS.artifacts) {
    issues.push({
      code: "REPORT_ARTIFACT_LIMIT_EXCEEDED",
      message: `This strategy has more than ${REPORT_CAPACITY_LIMITS.artifacts} attached artifacts. Remove older attachments before exporting.`,
    });
  }
  if (input.estimatedBytes > REPORT_CAPACITY_LIMITS.snapshotBytes) {
    issues.push({
      code: "REPORT_SNAPSHOT_LIMIT_EXCEEDED",
      message:
        "This strategy contains too much report content for one executive export. Shorten notes or split the plan before exporting.",
    });
  }
  return issues;
}

function countPlan(
  nodes: readonly ReportNode[],
  artifacts: number,
): ReportCounts {
  const count = (kind: ReportNode["kind"]) =>
    nodes.filter((node) => node.kind === kind).length;
  return {
    nodes: nodes.length,
    actions: count("action"),
    decisions: count("decision"),
    gates: count("gate"),
    milestones: count("milestone"),
    risks: count("risk"),
    artifacts,
  };
}

function buildWarnings(input: {
  clientFound: boolean;
  hasGoal: boolean;
  health: ExecutiveReportSnapshot["health"];
  logo: ReportLogoDescriptor;
  logoRequested: boolean;
  staleDocuments: number;
  openMaterialConflicts: number;
}): ReportIssue[] {
  const warnings: ReportIssue[] = [];
  if (!input.clientFound) {
    warnings.push({
      code: "CLIENT_RECORD_UNAVAILABLE",
      message:
        "The client record could not be resolved; the report will use a generic label.",
    });
  }
  if (!input.hasGoal) {
    warnings.push({
      code: "MISSING_STRATEGY_GOAL",
      message:
        "The strategy has no explicit goal; the executive summary will be shorter.",
    });
  }
  const unowned = input.health.totalNodes - input.health.ownedNodes;
  if (unowned > 0) {
    warnings.push({
      code: "UNASSIGNED_PLAN_STEPS",
      message: `${unowned} plan step${unowned === 1 ? " is" : "s are"} unassigned.`,
    });
  }
  const ungrounded = input.health.totalGates - input.health.groundedGates;
  if (ungrounded > 0) {
    warnings.push({
      code: "UNGROUNDED_GATES",
      message: `${ungrounded} gate${ungrounded === 1 ? " has" : "s have"} no evidence source.`,
    });
  }
  if (input.health.overdueNodes > 0) {
    warnings.push({
      code: "OVERDUE_PLAN_STEPS",
      message: `${input.health.overdueNodes} plan step${input.health.overdueNodes === 1 ? " is" : "s are"} overdue.`,
    });
  }
  if (input.logoRequested && !input.logo.available) {
    warnings.push({
      code: "CLIENT_LOGO_UNAVAILABLE",
      message:
        "No client logo is on file; the report will use typography-only branding.",
    });
  } else if (input.logoRequested && !input.logo.supported) {
    warnings.push({
      code: "CLIENT_LOGO_UNSUPPORTED",
      message:
        "The client logo cannot be embedded. Upload a PNG or JPEG for report branding.",
    });
  }
  if (input.staleDocuments > 0) {
    warnings.push({
      code: "STALE_CONTEXT",
      message: `${input.staleDocuments} active context document${input.staleDocuments === 1 ? " is" : "s are"} past its review date.`,
    });
  }
  if (input.openMaterialConflicts > 0) {
    warnings.push({
      code: "MATERIAL_CONTEXT_CONFLICTS",
      message: `${input.openMaterialConflicts} material context conflict${input.openMaterialConflicts === 1 ? " remains" : "s remain"} unresolved.`,
    });
  }
  return warnings;
}

export function extractSources(value: unknown): ReportProvenanceSource[] {
  if (!isRecord(value) || !Array.isArray(value.sources)) return [];
  return value.sources.flatMap((source) => {
    if (
      !isRecord(source) ||
      typeof source.section !== "string" ||
      !source.section.trim()
    )
      return [];
    return [
      {
        section: source.section.trim(),
        ref:
          typeof source.ref === "string" && source.ref.trim()
            ? source.ref.trim()
            : null,
      },
    ];
  });
}

export function extractTargetLabel(value: unknown): string | null {
  if (!isRecord(value)) return null;
  // Opaque directory/member ids are deliberately excluded: a client report
  // may show a resolved human-readable target, never an implementation id.
  for (const key of ["memberName", "committee", "agency", "name", "label"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim();
  }
  return null;
}

export function canonicalLogoKey(
  key: string | null,
  tenantId: string,
  clientId: string,
): string | null {
  if (!key) return null;
  const prefix = `tenants/${tenantId}/clients/${clientId}/`;
  if (!key.startsWith(prefix)) return null;
  const tail = key.slice(prefix.length);
  return /^logos\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpe?g)$/i.test(
    tail,
  )
    ? key
    : null;
}

function normalizeContentType(value: string | null): string | null {
  if (!value) return null;
  return value.split(";", 1)[0]!.trim().toLowerCase() || null;
}

function mergeReferenceRows<T extends { kind: string }>(
  baseline: T[],
  overrides: T[],
): T[] {
  const kinds = new Set([
    ...baseline.map((row) => row.kind),
    ...overrides.map((row) => row.kind),
  ]);
  return [...kinds].flatMap((kind) => {
    const tenantRows = overrides.filter((row) => row.kind === kind);
    return tenantRows.length > 0
      ? tenantRows
      : baseline.filter((row) => row.kind === kind);
  });
}

function hashSnapshot(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function dbDate(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}
