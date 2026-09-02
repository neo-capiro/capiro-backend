import { describe, expect, it, jest } from "@jest/globals";
import {
  canonicalLogoKey,
  REPORT_CAPACITY_LIMITS,
  reportReadinessErrors,
  ReportSnapshotService,
} from "./report-snapshot.service.js";

describe("report snapshot logo key policy", () => {
  const tenantId = "tenant-1";
  const clientId = "client-1";
  const uploadId = "00000000-0000-4000-8000-000000000001";

  it.each([`tenants/${tenantId}/clients/${clientId}/logos/${uploadId}.jpeg`])(
    "accepts confirmed client logo key %s",
    (key) => {
      expect(canonicalLogoKey(key, tenantId, clientId)).toBe(key);
    },
  );

  it.each([
    `tenants/${tenantId}/clients/${clientId}/logo.png`,
    `tenants/${tenantId}/clients/${clientId}/logo-uploads/${uploadId}.png`,
    `tenants/client-logo-uploads/${tenantId}/${clientId}/${uploadId}.png`,
    `tenants/tenant-2/clients/${clientId}/logos/${uploadId}.png`,
    `tenants/${tenantId}/clients/client-2/logos/${uploadId}.png`,
    `tenants/${tenantId}/clients/${clientId}/logos/not-a-uuid.png`,
  ])("rejects unconfirmed or foreign logo key %s", (key) => {
    expect(canonicalLogoKey(key, tenantId, clientId)).toBeNull();
  });
});

describe("report snapshot transaction", () => {
  it("loads every report section in a repeatable-read transaction", async () => {
    const withTenant = jest.fn(async () => ({
      strategy: {
        id: "strategy-1",
        clientId: "client-1",
        title: "Growth strategy",
        type: "growth",
        goal: null,
        meriSummary: "Internal summary of unaccepted working material.",
        targetDate: null,
        ownerUserId: null,
        lastEditedAt: null,
        nodes: [],
        artifacts: [],
      },
      client: null,
      members: [],
      versions: [],
      firmPhases: [],
      referenceRows: [],
      contextDocuments: [],
      openMaterialConflicts: 0,
      agentRuns: [],
      changeSets: [],
    }));
    const service = new ReportSnapshotService({ withTenant } as never);

    const snapshot = await service.build("tenant-1", "strategy-1", {
      format: "docx",
      audience: "client",
      useClientLogo: true,
      includeRoadmap: true,
      includeEvidenceAppendix: true,
      includeChangeLog: false,
      includeInternalNotes: false,
      includeAgentHistory: false,
      includeNarrative: true,
      includeMemberProfiles: true,
    });

    expect(withTenant).toHaveBeenCalledWith("tenant-1", expect.any(Function), {
      isolationLevel: "RepeatableRead",
    });
    expect(snapshot.strategy.summary).toBeNull();

    const internal = await service.build("tenant-1", "strategy-1", {
      format: "docx",
      audience: "internal",
      useClientLogo: true,
      includeRoadmap: true,
      includeEvidenceAppendix: true,
      includeChangeLog: false,
      includeInternalNotes: false,
      includeAgentHistory: false,
      includeNarrative: true,
      includeMemberProfiles: true,
    });
    expect(internal.strategy.summary).toBe(
      "Internal summary of unaccepted working material.",
    );
  });

  it("reports 1 of 20 client steps while preserving the full internal plan", async () => {
    const contextFindMany = jest.fn(async (_args: Record<string, unknown>) => [
      {
        id: "context-1",
        title: "Approved strategy brief",
        templateKey: "01_strategy_brief",
        content: approvedBrief,
        frontmatter: {
          authority: "client_approved",
          confidentiality: "client_confidential",
          source_of_truth: true,
          as_of: "2026-08-20",
        },
        validUntil: new Date("2026-12-31T00:00:00.000Z"),
        updatedAt: new Date("2026-08-20T12:00:00.000Z"),
        facts: [],
      },
    ]);
    const tx = fakeTransaction(contextFindMany);
    const withTenant = jest.fn(
      async (
        _tenantId: string,
        work: (transaction: typeof tx) => Promise<unknown>,
      ) => work(tx),
    );
    const service = new ReportSnapshotService({ withTenant } as never);

    const client = await service.build(
      "tenant-1",
      "strategy-1",
      reportOptions("client"),
    );
    const internal = await service.build(
      "tenant-1",
      "strategy-1",
      reportOptions("internal"),
    );

    expect(client.inclusion).toMatchObject({
      liveNodes: 20,
      includedNodes: 1,
      omittedNodes: 19,
      includedByStatus: { active: 1 },
      omittedByStatus: { suggested: 17, draft: 2 },
      placeholderNodes: 2,
    });
    expect(client.health.totalNodes).toBe(1);
    expect(client.allLiveHealth.totalNodes).toBe(20);
    expect(client.context.sections.length).toBeGreaterThan(0);
    expect(client.nodes[0]?.sources).toEqual([]);
    expect(client.artifacts).toEqual([]);
    expect(client.counts.artifacts).toBe(0);
    expect(client.firmPhases).toEqual([]);
    expect(client.referenceWindows).toEqual([]);
    const serializedClient = JSON.stringify(client);
    expect(serializedClient).not.toContain("workspace-draft-1");
    expect(serializedClient).not.toContain("outreach-record-2");
    expect(serializedClient).not.toContain("Internal positioning");
    expect(serializedClient).not.toContain("Internal legislative window");
    expect(internal.inclusion).toMatchObject({
      liveNodes: 20,
      includedNodes: 20,
      omittedNodes: 0,
    });
    expect(internal.nodes).toHaveLength(20);
    expect(internal.nodes[0]?.sources).toEqual([
      { section: "Internal research memo", ref: "memo:1" },
    ]);
    expect(internal.artifacts).toEqual([
      {
        nodeId: "node-1",
        artifactType: "workspace_draft",
        artifactRef: "workspace-draft-1",
      },
      {
        nodeId: "node-2",
        artifactType: "outreach_record",
        artifactRef: "outreach-record-2",
      },
    ]);
    expect(internal.counts.artifacts).toBe(2);
    expect(internal.firmPhases).toEqual([
      {
        label: "Internal positioning",
        startFy: 2026,
        startQ: 4,
        endFy: 2027,
        endQ: 1,
      },
    ]);
    expect(internal.referenceWindows).toEqual([
      {
        kind: "congress_milestone",
        label: "Internal legislative window",
        startsOn: "2026-09-01",
        endsOn: "2026-09-30",
        fy: null,
      },
    ]);

    const where = contextFindMany.mock.calls[0]?.[0]?.where as {
      OR: Array<Record<string, unknown>>;
    };
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { scope: "firm", clientId: null, scopeRef: null },
        { scope: "client", clientId: "client-1", scopeRef: null },
        {
          scope: "strategy",
          clientId: "client-1",
          scopeRef: "strategy-1",
        },
      ]),
    );
    expect(
      where.OR.some(
        (entry) => entry.clientId === "client-1" && !("scope" in entry),
      ),
    ).toBe(false);
  });

  it("scopes conflicts before counting and requires both facts to remain active", async () => {
    const scopedFactId = "fact-scoped";
    const unrelated = Array.from({ length: 200 }, (_, index) => ({
      factAId: `other-a-${index}`,
      factBId: `other-b-${index}`,
    }));
    const conflictRows = [
      ...unrelated,
      { factAId: scopedFactId, factBId: "fact-active" },
      { factAId: scopedFactId, factBId: "fact-rejected" },
      { factAId: "fact-superseded", factBId: scopedFactId },
    ];
    const conflictFindMany = jest.fn(async (args: Record<string, unknown>) => {
      const where = args.where as {
        OR?: Array<{
          factAId?: { in?: string[] };
          factBId?: { in?: string[] };
        }>;
      };
      const scopedIds = new Set(
        (where.OR ?? []).flatMap((condition) => [
          ...(condition.factAId?.in ?? []),
          ...(condition.factBId?.in ?? []),
        ]),
      );
      const filtered =
        scopedIds.size > 0
          ? conflictRows.filter(
              (row) => scopedIds.has(row.factAId) || scopedIds.has(row.factBId),
            )
          : conflictRows;
      return typeof args.take === "number"
        ? filtered.slice(0, args.take)
        : filtered;
    });
    const factFindMany = jest.fn(async (args: Record<string, unknown>) => {
      const where = args.where as {
        id?: { in?: string[] };
        state?: string;
      };
      expect(where.state).toBe("active");
      const activeIds = new Set([scopedFactId, "fact-active"]);
      return (where.id?.in ?? [])
        .filter((id) => activeIds.has(id))
        .map((id) => ({ id }));
    });
    const contextFindMany = jest.fn(async (_args: Record<string, unknown>) => [
      {
        id: "context-with-conflict",
        title: "Approved strategy brief",
        templateKey: "01_strategy_brief",
        content: approvedBrief,
        frontmatter: {
          authority: "client_approved",
          confidentiality: "client_confidential",
          source_of_truth: true,
          as_of: "2026-08-20",
        },
        validUntil: new Date("2026-12-31T00:00:00.000Z"),
        updatedAt: new Date("2026-08-20T12:00:00.000Z"),
        facts: [
          {
            id: scopedFactId,
            fact: "The authorization window is open.",
            sourceRef: "heading:Established facts",
            authority: "client_approved",
            asOf: new Date("2026-08-20T00:00:00.000Z"),
            confidence: 1,
          },
        ],
      },
    ]);
    const tx = fakeTransaction(contextFindMany, {
      conflictFindMany,
      factFindMany,
    });
    const withTenant = jest.fn(
      async (
        _tenantId: string,
        work: (transaction: typeof tx) => Promise<unknown>,
      ) => work(tx),
    );

    const snapshot = await new ReportSnapshotService({
      withTenant,
    } as never).build("tenant-1", "strategy-1", reportOptions("client"));

    expect(snapshot.context.openMaterialConflicts).toBe(1);
    const conflictQuery = conflictFindMany.mock.calls[0]?.[0];
    expect(conflictQuery).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          material: true,
          state: "open",
          OR: [
            { factAId: { in: [scopedFactId] } },
            { factBId: { in: [scopedFactId] } },
          ],
        }),
      }),
    );
    expect(conflictQuery).not.toHaveProperty("take");
    expect(factFindMany).toHaveBeenCalledTimes(1);
  });

  it("blocks rather than silently truncating oversized node sources and dependencies", async () => {
    const tx = fakeTransaction(async () => [], {
      mutateNodes: (nodes) => {
        nodes[0]!.provenance = {
          sources: Array.from(
            { length: REPORT_CAPACITY_LIMITS.sourcesPerNode + 1 },
            (_, index) => ({
              section: `Approved source ${index + 1}`,
              ref: `source:${index + 1}`,
            }),
          ),
        };
        nodes[0]!.dependsOnIds = Array.from(
          { length: REPORT_CAPACITY_LIMITS.dependenciesPerNode + 1 },
          (_, index) => `dependency-${index + 1}`,
        );
      },
    });
    const withTenant = jest.fn(
      async (
        _tenantId: string,
        work: (transaction: typeof tx) => Promise<unknown>,
      ) => work(tx),
    );

    const service = new ReportSnapshotService({
      withTenant,
    } as never);
    const snapshot = await service.build(
      "tenant-1",
      "strategy-1",
      reportOptions("internal"),
    );
    const preflight = await service.preflight(
      "tenant-1",
      "strategy-1",
      reportOptions("internal"),
    );

    expect(snapshot.nodes[0]).toMatchObject({
      id: "node-1",
      sourceCount: REPORT_CAPACITY_LIMITS.sourcesPerNode + 1,
    });
    expect(snapshot.nodes[0]!.sources).toHaveLength(
      REPORT_CAPACITY_LIMITS.sourcesPerNode,
    );
    expect(snapshot.nodes[0]!.dependsOnIds).toHaveLength(
      REPORT_CAPACITY_LIMITS.dependenciesPerNode,
    );
    expect(snapshot.capacityErrors.map(({ code }) => code)).toEqual([
      "REPORT_NODE_SOURCE_LIMIT_EXCEEDED",
      "REPORT_NODE_DEPENDENCY_LIMIT_EXCEEDED",
    ]);
    expect(reportReadinessErrors(snapshot).map(({ code }) => code)).toEqual([
      "REPORT_NODE_SOURCE_LIMIT_EXCEEDED",
      "REPORT_NODE_DEPENDENCY_LIMIT_EXCEEDED",
    ]);
    expect(preflight.report.ready).toBe(false);
    expect(preflight.errors.map(({ code }) => code)).toEqual([
      "REPORT_NODE_SOURCE_LIMIT_EXCEEDED",
      "REPORT_NODE_DEPENDENCY_LIMIT_EXCEEDED",
    ]);
  });
});

const approvedBrief = `---
authority: client_approved
confidentiality: client_confidential
source_of_truth: true
as_of: "2026-08-20"
---
# Strategy brief
## Current position
- The authorization window is open now.
## Definition of success
- Secure durable program language.
`;

function reportOptions(audience: "client" | "internal") {
  return {
    format: "docx" as const,
    audience,
    useClientLogo: false,
    includeRoadmap: true,
    includeEvidenceAppendix: true,
    includeChangeLog: false,
    includeInternalNotes: false,
    includeAgentHistory: false,
    includeNarrative: true,
    includeMemberProfiles: true,
  };
}

function fakeTransaction(
  contextFindMany: (args: Record<string, unknown>) => Promise<unknown[]>,
  overrides: {
    conflictFindMany?: (
      args: Record<string, unknown>,
    ) => Promise<Array<{ factAId: string; factBId: string }>>;
    factFindMany?: (
      args: Record<string, unknown>,
    ) => Promise<Array<{ id: string }>>;
    mutateNodes?: (
      nodes: Array<{
        id: string;
        dependsOnIds: string[];
        provenance: unknown;
      }>,
    ) => void;
  } = {},
): Record<string, unknown> {
  const statuses = [
    "active",
    ...Array.from({ length: 17 }, () => "suggested"),
    "draft",
    "draft",
  ];
  const nodes = statuses.map((status, index) => ({
    id: `node-${index + 1}`,
    kind: index === 5 ? "decision" : index === 6 ? "risk" : "action",
    subject: index % 2 ? "committee" : "deliverable",
    title:
      index === 18
        ? "New step"
        : index === 19
          ? "Test Step Member #2"
          : `Substantive plan step ${index + 1}`,
    note: null,
    ownerUserId: index < 2 ? "user-1" : null,
    status,
    startsOn: new Date(
      `2026-09-${String((index % 20) + 1).padStart(2, "0")}T00:00:00.000Z`,
    ),
    endsOn: new Date(
      `2026-10-${String((index % 20) + 1).padStart(2, "0")}T00:00:00.000Z`,
    ),
    openEnded: false,
    dependsOnIds: [],
    provenance:
      index === 0
        ? {
            sources: [{ section: "Internal research memo", ref: "memo:1" }],
          }
        : null,
    targetRef: null,
  }));
  overrides.mutateNodes?.(nodes);
  const strategy = {
    id: "strategy-1",
    clientId: "client-1",
    title: "Program strategy",
    type: "authorization",
    goal: "Secure durable authorization language.",
    meriSummary: "Internal working summary.",
    targetDate: new Date("2026-12-15T00:00:00.000Z"),
    ownerUserId: "user-1",
    lastEditedAt: new Date("2026-08-29T12:00:00.000Z"),
    nodes,
    artifacts: [
      {
        nodeId: "node-1",
        artifactType: "workspace_draft",
        artifactRef: "workspace-draft-1",
      },
      {
        nodeId: "node-2",
        artifactType: "outreach_record",
        artifactRef: "outreach-record-2",
      },
    ],
  };
  return {
    spStrategy: { findFirst: jest.fn(async () => strategy) },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) =>
      strings.join(" ").includes("FROM clients")
        ? [
            {
              id: "client-1",
              name: "Northstar Systems",
              logoS3Key: null,
              logoContentType: null,
              description: "A mission technology company.",
              productDescription: "Secure program systems.",
              profileType: "company",
              sectorTag: "defense",
              website: "https://example.test",
            },
          ]
        : [
            {
              clerkUserId: "user-1",
              firstName: "Avery",
              lastName: "Cole",
            },
          ],
    ),
    spVersion: { findMany: jest.fn(async () => []) },
    spFirmPhase: {
      findMany: jest.fn(async () => [
        {
          label: "Internal positioning",
          startFy: 2026,
          startQ: 4,
          endFy: 2027,
          endQ: 1,
        },
      ]),
    },
    spReferenceEntry: {
      findMany: jest.fn(async () => [
        {
          kind: "congress_milestone",
          label: "Internal legislative window",
          startsOn: new Date("2026-09-01T00:00:00.000Z"),
          endsOn: new Date("2026-09-30T00:00:00.000Z"),
          fy: null,
        },
      ]),
    },
    spReferenceOverride: { findMany: jest.fn(async () => []) },
    spContextDocument: { findMany: contextFindMany },
    spContextConflict: {
      findMany: jest.fn(overrides.conflictFindMany ?? (async () => [])),
    },
    spContextFact: {
      findMany: jest.fn(overrides.factFindMany ?? (async () => [])),
    },
    spAgentRun: { findMany: jest.fn(async () => []) },
    spChangeSet: { findMany: jest.fn(async () => []) },
  };
}
