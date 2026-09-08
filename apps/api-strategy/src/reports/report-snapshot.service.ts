import { checkFiscalCycle } from '@capiro/strategy-verifier';
import { createHash } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  ATTACHED_ARTIFACT_WHERE,
  LIVE_NODE_WHERE,
} from "../strategy/live-node.js";
import { computeReportHealth } from "./report-health.js";
import {
  extractMemberRef,
  includeNodeForAudience,
  isPlaceholderReportTitle,
  reportStatusForAudience,
} from "./report-policy.js";
import { assembleReportContext } from "./report-context.js";
import { reportSectionReadiness } from "./report-content.js";
import { ooxmlSafeValue } from "./report-text.js";
import type {
  ExecutiveReportSnapshot,
  NormalizedReportOptions,
  ReportCounts,
  ReportIssue,
  ReportLogoDescriptor,
  ReportMemberProfile,
  ReportNode,
  ReportPreflight,
  ReportProvenanceSource,
} from "./report.types.js";

interface ClientBrandRow {
  id: string;
  name: string;
  logoS3Key: string | null;
  logoContentType: string | null;
  description: string | null;
  productDescription: string | null;
  profileType: string | null;
  sectorTag: string | null;
  website: string | null;
}

interface MemberRow {
  clerkUserId: string;
  firstName: string | null;
  lastName: string | null;
}

const SUPPORTED_LOGO_TYPES = new Set(["image/png", "image/jpeg"]);
export const REPORT_CAPACITY_LIMITS = {
  nodes: 300,
  artifacts: 600,
  sourcesPerNode: 20,
  dependenciesPerNode: 100,
  contextDocuments: 40,
  contextFactsPerDocument: 80,
  contextSourceBytes: 2 * 1024 * 1024,
  snapshotBytes: 8 * 1024 * 1024,
  /** Member-office profiles drawn in one report; the rest stay as target labels. */
  memberProfiles: 12,
} as const;

@Injectable()
export class ReportSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  async preflight(
    tenantId: string,
    strategyId: string,
    options: NormalizedReportOptions,
  ): Promise<ReportPreflight> {
    const snapshot = await this.build(tenantId, strategyId, options);
    return this.preflightFromSnapshot(snapshot, options);
  }

  /** Readiness view of an already-built snapshot (no second database read). */
  preflightFromSnapshot(
    snapshot: ExecutiveReportSnapshot,
    options: NormalizedReportOptions,
  ): ReportPreflight {
    const errors = reportReadinessErrors(snapshot);
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
        audience: options.audience,
        format: options.format,
        snapshotHash: snapshot.snapshotHash,
        readiness:
          errors.length > 0
            ? "blocked"
            : snapshot.warnings.length > 0
              ? "review"
              : "ready",
      },
      client: { id: snapshot.client.id, name: snapshot.client.name },
      version: { ...snapshot.version, note: null },
      health: snapshot.health,
      allLiveHealth: snapshot.allLiveHealth,
      counts: snapshot.counts,
      inclusion: snapshot.inclusion,
      content: {
        contextDocuments: snapshot.context.includedDocuments,
        excludedContextDocuments: snapshot.context.excludedDocuments,
        narrativeSections: snapshot.context.sections.length,
        narrativeItems: snapshot.context.sections.reduce(
          (total, section) => total + section.items.length,
          0,
        ),
        contextFacts: snapshot.context.facts.length,
        evidenceLinkedNodes: snapshot.nodes.filter(
          (node) => node.sources.length > 0,
        ).length,
      },
      sections: reportSectionReadiness(snapshot),
      logo: publicLogo,
      // Directory resolution and narrative availability are filled in by
      // StrategyReportService; the snapshot only knows what the plan references.
      memberOffices: {
        referenced: snapshot.members.length,
        resolved: 0,
        withPhoto: 0,
      },
      narrative: {
        available: false,
        reason: null,
        requested: options.includeNarrative,
      },
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
        const liveNodeIds = strategy.nodes.map((node) => node.id);
        const contextWhere = {
          state: "active" as const,
          OR: [
            { scope: "firm" as const, clientId: null, scopeRef: null },
            {
              scope: "client" as const,
              clientId: strategy.clientId,
              scopeRef: null,
            },
            {
              scope: "strategy" as const,
              clientId: strategy.clientId,
              scopeRef: strategyId,
            },
            ...(liveNodeIds.length > 0
              ? [
                  {
                    scope: "node" as const,
                    clientId: strategy.clientId,
                    scopeRef: { in: liveNodeIds },
                  },
                ]
              : []),
          ],
        };

        const [
          clientRows,
          memberRows,
          versions,
          firmPhases,
          referenceBaseline,
          referenceOverrides,
          contextDocuments,
          agentRuns,
          changeSets,
        ] = await Promise.all([
          tx.$queryRaw<ClientBrandRow[]>`
          SELECT
            id::text AS id,
            name,
            logo_s3_key AS "logoS3Key",
            logo_content_type AS "logoContentType",
            description,
            product_description AS "productDescription",
            profile_type AS "profileType",
            sector_tag AS "sectorTag",
            website
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
          tx.spContextDocument.findMany({
            where: contextWhere,
            orderBy: [{ templateKey: "asc" }, { updatedAt: "desc" }],
            take: REPORT_CAPACITY_LIMITS.contextDocuments + 1,
            select: {
              id: true,
              title: true,
              templateKey: true,
              content: true,
              frontmatter: true,
              validUntil: true,
              updatedAt: true,
              facts: {
                where: { state: "active" },
                orderBy: [{ asOf: "desc" }, { createdAt: "desc" }],
                take: REPORT_CAPACITY_LIMITS.contextFactsPerDocument + 1,
                select: {
                  id: true,
                  fact: true,
                  sourceRef: true,
                  authority: true,
                  asOf: true,
                  confidence: true,
                },
              },
            },
          }),
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

        const scopedFactIds = new Set(
          contextDocuments.flatMap((document) =>
            document.facts.map((fact) => fact.id),
          ),
        );
        const scopedFactIdList = [...scopedFactIds];
        // Scope first so another client's newer conflicts cannot crowd a
        // relevant row out of an arbitrary tenant-wide sample. A conflict is
        // reportable only while both referenced facts remain active.
        const relevantConflictRows =
          scopedFactIdList.length > 0
            ? await tx.spContextConflict.findMany({
                where: {
                  material: true,
                  state: "open",
                  OR: [
                    { factAId: { in: scopedFactIdList } },
                    { factBId: { in: scopedFactIdList } },
                  ],
                },
                select: { factAId: true, factBId: true },
              })
            : [];
        const conflictFactIds = [
          ...new Set(
            relevantConflictRows.flatMap((row) => [row.factAId, row.factBId]),
          ),
        ];
        const activeConflictFactIds = new Set(
          conflictFactIds.length > 0
            ? (
                await tx.spContextFact.findMany({
                  where: {
                    id: { in: conflictFactIds },
                    state: "active",
                  },
                  select: { id: true },
                })
              ).map((fact) => fact.id)
            : [],
        );
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
          contextDocuments,
          openMaterialConflicts: relevantConflictRows.filter(
            (row) =>
              activeConflictFactIds.has(row.factAId) &&
              activeConflictFactIds.has(row.factBId),
          ).length,
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

    const mappedNodes: ReportNode[] = loaded.strategy.nodes
      .slice(0, REPORT_CAPACITY_LIMITS.nodes)
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
          memberRef: extractMemberRef(node.targetRef),
        };
      });
    let nodes = mappedNodes.filter((node) =>
      includeNodeForAudience(node.status, options.audience),
    );
    const omittedNodes = mappedNodes.filter(
      (node) => !includeNodeForAudience(node.status, options.audience),
    );
    const inclusion = {
      liveNodes: mappedNodes.length,
      includedNodes: nodes.length,
      omittedNodes: omittedNodes.length,
      includedByStatus: countStatuses(nodes),
      omittedByStatus: countStatuses(omittedNodes),
      placeholderNodes: mappedNodes.filter((node) =>
        isPlaceholderReportTitle(node.title),
      ).length,
    };
    const includedNodeIds = new Set(nodes.map((node) => node.id));
    // Artifact references identify internal workspace drafts and outreach
    // records. The artifact model has no client-visible classification, so
    // these links must remain internal until an explicit safe classification
    // is added and enforced here.
    const artifacts =
      options.audience === "internal"
        ? loaded.strategy.artifacts
            .slice(0, REPORT_CAPACITY_LIMITS.artifacts)
            .filter((artifact) => includedNodeIds.has(artifact.nodeId))
        : [];
    const allLiveHealth = computeReportHealth(mappedNodes, asOfDate);
    const contextDocuments = loaded.contextDocuments.slice(
      0,
      REPORT_CAPACITY_LIMITS.contextDocuments,
    );
    const context = assembleReportContext(
      contextDocuments,
      options.audience,
      asOf,
    );
    const factsById = new Map(context.facts.map((fact) => [fact.id, fact]));
    nodes = nodes.map((node) => {
      const sources = node.sources.flatMap((source) => {
        const factId = source.ref?.startsWith("fact:")
          ? source.ref.slice("fact:".length)
          : null;
        // Arbitrary provenance labels can name internal memos, systems, or
        // working sessions. A client snapshot may retain only sources that can
        // be resolved to an audience-safe context fact.
        if (!factId) return options.audience === "client" ? [] : [source];
        const fact = factsById.get(factId);
        if (!fact) return options.audience === "client" ? [] : [source];
        return [
          {
            section: fact.documentTitle,
            ref:
              options.audience === "internal"
                ? `${fact.sourceRef} · fact:${fact.id}`
                : fact.sourceRef,
          },
        ];
      });
      return {
        ...node,
        sources,
        sourceCount:
          options.audience === "client" ? sources.length : node.sourceCount,
      };
    });
    const health = computeReportHealth(nodes, asOfDate);
    const counts = countPlan(nodes, artifacts.length);
    const memberProfiles = options.includeMemberProfiles
      ? collectMemberProfiles(nodes)
      : [];
    const members = memberProfiles.slice(
      0,
      REPORT_CAPACITY_LIMITS.memberProfiles,
    );
    const staleDocuments = contextDocuments.filter(
      (document) =>
        document.validUntil !== null &&
        document.validUntil.getTime() < asOfDate.getTime(),
    ).length;

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
    const warnings = buildWarnings({
      clientFound: Boolean(loaded.client),
      hasGoal: Boolean(loaded.strategy.goal?.trim()),
      health,
      logo,
      logoRequested: options.useClientLogo,
      staleDocuments,
      openMaterialConflicts: loaded.openMaterialConflicts,
      audience: options.audience,
      inclusion,
      narrativeItems: context.sections.reduce(
        (total, section) => total + section.items.length,
        0,
      ),
      contextFacts: context.facts.length,
      excludedContextDocuments: context.excludedDocuments,
      decisions: counts.decisions,
      risks: counts.risks,
      memberProfilesOmitted: memberProfiles.length - members.length,
    });

    warnings.push(...checkFiscalCycle(nodes, `${loaded.strategy.title} ${loaded.strategy.goal ?? ''}`).map((issue) => ({ code: 'CALENDAR_CYCLE_REVIEW', message: issue.message })));

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
        profile: {
          description: loaded.client?.description?.trim() || null,
          productDescription: loaded.client?.productDescription?.trim() || null,
          profileType: loaded.client?.profileType?.trim() || null,
          sectorTag: loaded.client?.sectorTag?.trim() || null,
          website: loaded.client?.website?.trim() || null,
        },
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
      allLiveHealth,
      counts,
      inclusion,
      nodes,
      members,
      artifacts: artifacts.map((artifact) => ({
        nodeId: artifact.nodeId,
        artifactType: artifact.artifactType,
        artifactRef: artifact.artifactRef,
      })),
      // Firm phases and reference windows are operating configuration, not
      // client report content. Keep them out of client snapshots so no
      // renderer can accidentally expose them.
      firmPhases: options.audience === "internal" ? loaded.firmPhases : [],
      referenceWindows:
        options.audience === "internal"
          ? loaded.referenceRows.map((row) => ({
              kind: row.kind,
              label: row.label,
              startsOn: dbDate(row.startsOn),
              endsOn: dbDate(row.endsOn),
              fy: row.fy,
            }))
          : [],
      context: {
        activeDocuments: contextDocuments.length,
        includedDocuments: context.documents.length,
        excludedDocuments: context.excludedDocuments,
        staleDocuments,
        openMaterialConflicts: loaded.openMaterialConflicts,
        documents: context.documents,
        facts: context.facts,
        sections: context.sections,
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
        artifactRows:
          options.audience === "internal"
            ? loaded.strategy.artifacts.length
            : 0,
        maxSourcesPerNode: loaded.strategy.nodes.reduce(
          (maximum, node) =>
            Math.max(maximum, extractSources(node.provenance).length),
          0,
        ),
        maxDependenciesPerNode: loaded.strategy.nodes.reduce(
          (maximum, node) => Math.max(maximum, node.dependsOnIds.length),
          0,
        ),
        contextDocumentRows: loaded.contextDocuments.length,
        contextFactsExceeded: loaded.contextDocuments.some(
          (document) =>
            document.facts.length >
            REPORT_CAPACITY_LIMITS.contextFactsPerDocument,
        ),
        contextSourceBytes: loaded.contextDocuments.reduce(
          (total, document) =>
            total + Buffer.byteLength(document.content, "utf8"),
          0,
        ),
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
  maxSourcesPerNode?: number;
  maxDependenciesPerNode?: number;
  contextDocumentRows?: number;
  contextSourceBytes?: number;
  contextFactsExceeded?: boolean;
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
  if ((input.maxSourcesPerNode ?? 0) > REPORT_CAPACITY_LIMITS.sourcesPerNode) {
    issues.push({
      code: "REPORT_NODE_SOURCE_LIMIT_EXCEEDED",
      message: `At least one live plan step has more than ${REPORT_CAPACITY_LIMITS.sourcesPerNode} provenance sources. Remove obsolete sources or split that step before exporting.`,
    });
  }
  if (
    (input.maxDependenciesPerNode ?? 0) >
    REPORT_CAPACITY_LIMITS.dependenciesPerNode
  ) {
    issues.push({
      code: "REPORT_NODE_DEPENDENCY_LIMIT_EXCEEDED",
      message: `At least one live plan step has more than ${REPORT_CAPACITY_LIMITS.dependenciesPerNode} dependencies. Simplify or split that step before exporting.`,
    });
  }
  if (
    (input.contextDocumentRows ?? 0) > REPORT_CAPACITY_LIMITS.contextDocuments
  ) {
    issues.push({
      code: "REPORT_CONTEXT_LIMIT_EXCEEDED",
      message: `This strategy resolves more than ${REPORT_CAPACITY_LIMITS.contextDocuments} active context documents. Archive or supersede older context before exporting.`,
    });
  }
  if (input.contextFactsExceeded) {
    issues.push({
      code: "REPORT_CONTEXT_FACT_LIMIT_EXCEEDED",
      message: `At least one context document has more than ${REPORT_CAPACITY_LIMITS.contextFactsPerDocument} active facts. Supersede obsolete facts or split that source before exporting.`,
    });
  }
  if (
    (input.contextSourceBytes ?? 0) > REPORT_CAPACITY_LIMITS.contextSourceBytes
  ) {
    issues.push({
      code: "REPORT_CONTEXT_CONTENT_LIMIT_EXCEEDED",
      message:
        "The active context pack is too large for one executive report. Supersede obsolete context or split oversized documents before exporting.",
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

/** One readiness policy is used by both preflight and the export endpoint. */
export function reportReadinessErrors(
  snapshot: ExecutiveReportSnapshot,
): ReportIssue[] {
  const errors: ReportIssue[] = [...snapshot.capacityErrors];
  if (snapshot.counts.nodes === 0) {
    errors.unshift({
      code: "NO_REPORTABLE_PLAN_STEPS",
      message:
        snapshot.options.audience === "client"
          ? "Move at least one reviewed plan step to In progress, Active or Completed before generating a client report."
          : "Add at least one live plan step before generating an executive report.",
    });
  }
  if (
    snapshot.options.audience === "client" &&
    snapshot.inclusion.placeholderNodes > 0
  ) {
    errors.push({
      code: "CLIENT_PLACEHOLDER_CONTENT",
      message:
        "Rename or remove placeholder and test plan steps before generating a client-ready report.",
    });
  }
  if (
    snapshot.options.audience === "client" &&
    snapshot.context.openMaterialConflicts > 0
  ) {
    errors.push({
      code: "CLIENT_CONTEXT_CONFLICT",
      message:
        "Resolve material context conflicts before generating a client-ready report.",
    });
  }
  const hasNarrative = snapshot.context.sections.some((section) =>
    ["situation", "outcomes", "ask"].includes(section.key),
  );
  if (
    snapshot.options.audience === "client" &&
    !snapshot.strategy.goal?.trim() &&
    !hasNarrative
  ) {
    errors.push({
      code: "CLIENT_EXECUTIVE_PREMISE_MISSING",
      message:
        "Add a strategy goal or an approved strategy brief before generating a client-ready report.",
    });
  }
  return errors;
}

function countStatuses(nodes: readonly ReportNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes)
    counts[node.status] = (counts[node.status] ?? 0) + 1;
  return counts;
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
  audience: "client" | "internal";
  inclusion: ExecutiveReportSnapshot["inclusion"];
  narrativeItems: number;
  contextFacts: number;
  excludedContextDocuments: number;
  decisions: number;
  risks: number;
  memberProfilesOmitted: number;
}): ReportIssue[] {
  const warnings: ReportIssue[] = [];
  if (input.memberProfilesOmitted > 0) {
    warnings.push({
      code: "MEMBER_PROFILES_TRUNCATED",
      message: `${input.memberProfilesOmitted} additional member office${input.memberProfilesOmitted === 1 ? "" : "s"} will appear as plain stakeholder targets; the report profiles the first ${REPORT_CAPACITY_LIMITS.memberProfiles}.`,
    });
  }
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
  if (input.audience === "client" && input.inclusion.omittedNodes > 0) {
    const reasons = Object.entries(input.inclusion.omittedByStatus)
      .map(([status, count]) => `${count} ${status.replace(/_/g, " ")}`)
      .join(", ");
    warnings.push({
      code: "WORKING_PLAN_ITEMS_OMITTED",
      message: `${input.inclusion.includedNodes} of ${input.inclusion.liveNodes} live plan steps will be included. ${reasons} item${input.inclusion.omittedNodes === 1 ? " is" : "s are"} excluded until reviewed and moved to In progress or Active.`,
    });
  }
  if (input.inclusion.placeholderNodes > 0) {
    warnings.push({
      code: "PLACEHOLDER_PLAN_CONTENT",
      message: `${input.inclusion.placeholderNodes} placeholder or test plan step${input.inclusion.placeholderNodes === 1 ? " needs" : "s need"} to be renamed or removed before a client deliverable is ready.`,
    });
  }
  if (input.narrativeItems === 0) {
    warnings.push({
      code: "NO_APPROVED_STRATEGIC_CONTEXT",
      message:
        input.audience === "client"
          ? "No approved, client-confidential context is available for the situation, outcomes, ask, constraints, or stakeholder narrative."
          : "No active context document contributes narrative detail; the report will rely on the plan alone.",
    });
  }
  if (input.audience === "client" && input.excludedContextDocuments > 0) {
    warnings.push({
      code: "CONTEXT_WITHHELD_FOR_AUDIENCE",
      message: `${input.excludedContextDocuments} active context document${input.excludedContextDocuments === 1 ? " is" : "s are"} excluded because it is stale, internal, or not marked as an approved source of truth.`,
    });
  }
  if (input.decisions === 0 && input.risks === 0) {
    warnings.push({
      code: "NO_DECISIONS_OR_RISKS",
      message:
        "No decision or risk steps are recorded, so the leadership agenda will not include a decision-and-risk register.",
    });
  }
  if (input.contextFacts === 0 && input.health.groundedGates === 0) {
    warnings.push({
      code: "NO_REPORT_EVIDENCE",
      message:
        "No approved context facts or evidence-grounded gates are available for the evidence section.",
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

/**
 * Group included plan steps by the congressional or state member they target.
 * Staff targets are not member offices. Order follows first plan appearance so
 * the profile section reads in the same sequence as the plan itself.
 */
export function collectMemberProfiles(
  nodes: readonly ReportNode[],
): ReportMemberProfile[] {
  const byId = new Map<string, ReportMemberProfile>();
  for (const node of nodes) {
    const ref = node.memberRef;
    if (!ref || ref.sourceDirectory === "staff") continue;
    const existing = byId.get(ref.memberId);
    if (existing) {
      existing.nodeIds.push(node.id);
      // Prefer the most complete stored reference across the steps; a stored
      // member name always beats a free-text target label.
      existing.memberName ??= ref.memberName;
      existing.party ??= ref.party;
      existing.state ??= ref.state;
      existing.chamber ??= ref.chamber;
      existing.committee ??= ref.committee;
      existing.name =
        existing.memberName ??
        (existing.name === "Member office"
          ? (node.targetLabel ?? existing.name)
          : existing.name);
      continue;
    }
    byId.set(ref.memberId, {
      ...ref,
      name: ref.memberName ?? node.targetLabel ?? "Member office",
      nodeIds: [node.id],
    });
  }
  return [...byId.values()];
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
