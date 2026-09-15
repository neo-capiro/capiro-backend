import { describe, expect, it, jest } from "@jest/globals";
import {
  ConflictException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ReportExportDto } from "./dto/report-export.dto.js";
import type {
  ExecutiveReportSnapshot,
  ReportInclusion,
} from "./report.types.js";
import {
  assertExpectedSnapshotHash,
  buildReportFilename,
  MAX_IN_PROCESS_EXPORTS,
  MAX_RENDERED_REPORT_BYTES,
  REPORT_SNAPSHOT_CHANGED,
  StrategyReportService,
} from "./strategy-report.service.js";

const CURRENT_HASH = "b".repeat(64);
const STALE_HASH = "a".repeat(64);

describe("strategy report snapshot contract", () => {
  it("keeps partial preflight callers on the established defaults", async () => {
    const { service, build, preflightFromSnapshot } = preflightService();

    const result = await service.preflight("tenant-1", "strategy-1", {
      format: "docx",
      audience: "internal",
    });

    const expectedOptions = {
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
    };
    expect(build).toHaveBeenCalledWith("tenant-1", "strategy-1", expectedOptions);
    expect(preflightFromSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotHash: CURRENT_HASH }),
      expectedOptions,
    );
    expect(result.memberOffices).toEqual({ referenced: 0, resolved: 0, withPhoto: 0 });
    expect(result.narrative).toEqual({
      available: false,
      reason: "disabled in test",
      requested: true,
    });
  });

  it("normalizes the complete preflight option set with client redaction", async () => {
    const { service, build } = preflightService();

    await service.preflight("tenant-1", "strategy-1", {
      format: "pptx",
      audience: "client",
      useClientLogo: false,
      includeRoadmap: false,
      includeEvidenceAppendix: false,
      includeChangeLog: true,
      includeInternalNotes: true,
      includeAgentHistory: true,
      includeNarrative: false,
      includeMemberProfiles: false,
    });

    expect(build).toHaveBeenCalledWith("tenant-1", "strategy-1", {
      format: "pptx",
      audience: "client",
      useClientLogo: false,
      includeRoadmap: false,
      includeEvidenceAppendix: false,
      includeChangeLog: false,
      includeInternalNotes: false,
      includeAgentHistory: false,
      includeNarrative: false,
      includeMemberProfiles: false,
    });
  });

  it("keeps callers without an expected hash backward compatible", () => {
    expect(() =>
      assertExpectedSnapshotHash(undefined, CURRENT_HASH),
    ).not.toThrow();
    expect(() =>
      assertExpectedSnapshotHash(CURRENT_HASH, CURRENT_HASH),
    ).not.toThrow();
  });

  it("returns a stable 409 payload for a stale preflight", () => {
    expect.assertions(5);
    try {
      assertExpectedSnapshotHash(STALE_HASH, CURRENT_HASH);
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      const response = (error as ConflictException).getResponse();
      expect(response).toMatchObject({
        code: REPORT_SNAPSHOT_CHANGED,
        expectedSnapshotHash: STALE_HASH,
        currentSnapshotHash: CURRENT_HASH,
      });
      expect(response).toHaveProperty("message");
      expect((error as ConflictException).getStatus()).toBe(409);
      expect(REPORT_SNAPSHOT_CHANGED).toBe("REPORT_SNAPSHOT_CHANGED");
    }
  });

  it("rejects a mismatch before logo reads, rendering, or audit writes", async () => {
    const build = jest.fn(async () => ({ snapshotHash: CURRENT_HASH }));
    const logoRead = jest.fn();
    const docxRender = jest.fn();
    const pptxRender = jest.fn();
    const withTenantUser = jest.fn();
    const logActivity = jest.fn();
    const memberResolve = jest.fn();
    const narrativeGenerate = jest.fn();
    const service = new StrategyReportService(
      { build } as never,
      { read: logoRead } as never,
      { render: docxRender } as never,
      { render: pptxRender } as never,
      { render: jest.fn(), available: true, unavailableReason: null } as never,
      { available: true } as never,
      { withTenantUser } as never,
      { logActivity } as never,
      { resolve: memberResolve, photo: jest.fn() } as never,
      { availability: () => ({ available: true, reason: null }), generate: narrativeGenerate } as never,
    );

    await expect(
      service.export("tenant-1", "actor-1", "strategy-1", {
        format: "docx",
        audience: "client",
        expectedSnapshotHash: STALE_HASH,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(build).toHaveBeenCalledTimes(1);
    expect(logoRead).not.toHaveBeenCalled();
    expect(docxRender).not.toHaveBeenCalled();
    expect(pptxRender).not.toHaveBeenCalled();
    expect(memberResolve).not.toHaveBeenCalled();
    expect(narrativeGenerate).not.toHaveBeenCalled();
    expect(withTenantUser).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });
});

function preflightService() {
  const build = jest.fn(async () => ({
    snapshotHash: CURRENT_HASH,
    members: [],
    options: { includeMemberProfiles: true, includeNarrative: true },
  }));
  const preflightFromSnapshot = jest.fn(() => ({ report: { ready: true } }));
  const service = new StrategyReportService(
    { build, preflightFromSnapshot } as never,
    { read: jest.fn() } as never,
    { render: jest.fn() } as never,
    { render: jest.fn() } as never,
    { render: jest.fn(), available: true, unavailableReason: null } as never,
    { available: true } as never,
    { withTenantUser: jest.fn() } as never,
    { logActivity: jest.fn() } as never,
    { resolve: jest.fn(async () => []), photo: jest.fn(async () => null) } as never,
    {
      availability: () => ({ available: false, reason: "disabled in test" }),
      generate: jest.fn(async () => null),
    } as never,
  );
  return { service, build, preflightFromSnapshot };
}

/*
 * The rest of this file is orchestration-level coverage for StrategyReportService
 * beyond the snapshot-hash contract above: every collaborator (snapshot builder,
 * renderers, logo reader, prisma, versioning) is stubbed with jest.fn() so these
 * tests exercise only the service's own logic — the payload-size ceiling, the
 * in-process export semaphore/queue, the release lifecycle wired to the
 * controller's response finish/close handlers, and the exact shape written to
 * the activity-log audit row.
 */

const TENANT = "tenant-1";
const ACTOR = "user-1";
const STRATEGY = "strategy-1";

interface LogActivityAudit {
  format: string;
  audience: string;
  snapshotHash: string;
  versionId: string | null;
  filename: string;
  byteLength: number;
  clientLogoRequested: boolean;
  clientLogoIncluded: boolean;
  inclusion: ReportInclusion;
  content: {
    contextDocuments: number;
    contextFacts: number;
    narrativeSections: number;
  };
  sections: {
    roadmap: boolean;
    evidenceAppendix: boolean;
    changeLog: boolean;
    internalNotes: boolean;
    agentHistory: boolean;
    narrative: boolean;
    memberProfiles: boolean;
  };
  memberOffices: { referenced: number; resolved: number; withPhoto: number };
  narrative: Record<string, unknown>;
}

interface LogActivityOpts {
  tenantId: string;
  actorUserId: string | null;
  authorKind: string;
  action: string;
  entityType: string;
  entityId: string;
  strategyId?: string;
  before?: unknown;
  after?: LogActivityAudit;
}

function exportDto(overrides: Partial<ReportExportDto> = {}): ReportExportDto {
  return {
    format: "docx",
    audience: "client",
    useClientLogo: true,
    includeRoadmap: true,
    includeEvidenceAppendix: true,
    includeChangeLog: false,
    includeInternalNotes: false,
    includeAgentHistory: false,
    ...overrides,
  } as ReportExportDto;
}

function baseSnapshot(
  overrides: Partial<ExecutiveReportSnapshot> = {},
): ExecutiveReportSnapshot {
  const health = {
    score: 90,
    label: "On track" as const,
    coveragePct: 100,
    groundingPct: null,
    timelinessPct: 100,
    totalNodes: 1,
    ownedNodes: 1,
    totalGates: 0,
    groundedGates: 0,
    datedNodes: 1,
    overdueNodes: 0,
  };
  return {
    snapshotHash: "a".repeat(64),
    asOf: "2026-08-30",
    strategy: {
      id: STRATEGY,
      title: "Growth Strategy",
      type: "growth",
      // A non-empty goal keeps reportReadinessErrors() satisfied for both
      // audiences regardless of the fixture's own `options.audience`.
      goal: "Win the deal",
      summary: null,
      targetDate: null,
      ownerName: "Owner",
      lastEditedAt: null,
    },
    client: {
      id: "client-1",
      name: "Acme Corp",
      logo: {
        available: false,
        supported: false,
        contentType: null,
        objectKey: null,
      },
    },
    version: { id: "version-1", createdAt: null, note: null },
    health,
    allLiveHealth: health,
    counts: {
      nodes: 1,
      actions: 1,
      decisions: 0,
      gates: 0,
      milestones: 0,
      risks: 0,
      artifacts: 0,
    },
    inclusion: {
      liveNodes: 1,
      includedNodes: 1,
      omittedNodes: 0,
      includedByStatus: { in_progress: 1 },
      omittedByStatus: {},
      placeholderNodes: 0,
    },
    nodes: [],
    members: [],
    artifacts: [],
    firmPhases: [],
    referenceWindows: [],
    context: {
      activeDocuments: 0,
      includedDocuments: 0,
      excludedDocuments: 0,
      staleDocuments: 0,
      openMaterialConflicts: 0,
      documents: [],
      facts: [],
      sections: [],
    },
    activity: { versions: [], agentRuns: [], changeSets: [] },
    options: {
      format: "docx",
      audience: "client",
      useClientLogo: true,
      includeRoadmap: true,
      includeEvidenceAppendix: true,
      includeChangeLog: false,
      includeInternalNotes: false,
      includeAgentHistory: false,
      includeNarrative: false,
      includeMemberProfiles: true,
    },
    warnings: [],
    capacityErrors: [],
    ...overrides,
  };
}

function makeService(
  options: {
    snapshot?: ExecutiveReportSnapshot;
    renderedBytes?: Buffer;
  } = {},
) {
  const snapshot = options.snapshot ?? baseSnapshot();
  const renderedBytes = options.renderedBytes ?? Buffer.from("ooxml-bytes");

  const tx = {
    spStrategy: {
      findFirst: jest.fn(async () => ({ id: snapshot.strategy.id })),
    },
  };
  const snapshots = { build: jest.fn(async () => snapshot), preflight: jest.fn() };
  const logos = { read: jest.fn(async () => null) };
  const docx = { render: jest.fn(async () => renderedBytes) };
  const pptx = { render: jest.fn(async () => renderedBytes) };
  const pdf = {
    render: jest.fn(async () => renderedBytes),
    available: true,
    unavailableReason: null,
  };
  const pdfBrowser = { available: true };
  const versioning = {
    logActivity: jest.fn(async (_tx: unknown, _opts: LogActivityOpts) => undefined),
  };
  const prisma = {
    withTenantUser: jest.fn(
      async (
        _tenantId: string,
        _userId: string,
        fn: (tx: unknown) => unknown,
      ) => fn(tx),
    ),
  };

  const memberOffices = {
    resolve: jest.fn(async () => []),
    photo: jest.fn(async () => null),
  };
  const narrative = {
    availability: () => ({ available: false, reason: "disabled in test" }),
    generate: jest.fn(async () => null),
  };

  const service = new StrategyReportService(
    snapshots as never,
    logos as never,
    docx as never,
    pptx as never,
    pdf as never,
    pdfBrowser as never,
    prisma as never,
    versioning as never,
    memberOffices as never,
    narrative as never,
  );

  return {
    service,
    snapshot,
    snapshots,
    logos,
    docx,
    pptx,
    pdf,
    versioning,
    prisma,
    tx,
    memberOffices,
    narrative,
  };
}

describe("StrategyReportService — MAX_RENDERED_REPORT_BYTES enforcement", () => {
  it("accepts a rendered report exactly at the byte ceiling", async () => {
    const { service, docx } = makeService();
    docx.render.mockResolvedValue(Buffer.alloc(MAX_RENDERED_REPORT_BYTES));

    const result = await service.export(TENANT, ACTOR, STRATEGY, exportDto());

    expect(result.bytes.length).toBe(MAX_RENDERED_REPORT_BYTES);
  });

  it("rejects a rendered report one byte over the ceiling before any audit write", async () => {
    const { service, docx, versioning } = makeService();
    docx.render.mockResolvedValue(Buffer.alloc(MAX_RENDERED_REPORT_BYTES + 1));

    await expect(
      service.export(TENANT, ACTOR, STRATEGY, exportDto()),
    ).rejects.toThrow(PayloadTooLargeException);
    expect(versioning.logActivity).not.toHaveBeenCalled();
  });
});

describe("StrategyReportService — MAX_IN_PROCESS_EXPORTS admission control", () => {
  it(`rejects the ${MAX_IN_PROCESS_EXPORTS + 1}th concurrent export while ${MAX_IN_PROCESS_EXPORTS} are outstanding`, async () => {
    const { service } = makeService();

    const leases = Array.from({ length: MAX_IN_PROCESS_EXPORTS }, () =>
      service.export(TENANT, ACTOR, STRATEGY, exportDto()),
    );

    await expect(
      service.export(TENANT, ACTOR, STRATEGY, exportDto()),
    ).rejects.toThrow(ServiceUnavailableException);

    // Clean up: drain the queue so nothing is left dangling past the test.
    for (const lease of leases) {
      (await lease).release();
    }
  });

  it("queues an admitted export behind an unreleased one and only starts it once released", async () => {
    const { service, docx } = makeService();

    const first = service.export(TENANT, ACTOR, STRATEGY, exportDto());
    const second = service.export(TENANT, ACTOR, STRATEGY, exportDto());

    const lease1 = await first;
    // `second` was admitted (didn't throw) but must still be parked: its
    // generateExport work cannot have started while `first`'s lease is held.
    expect(docx.render).toHaveBeenCalledTimes(1);

    lease1.release();
    const lease2 = await second;
    expect(docx.render).toHaveBeenCalledTimes(2);

    lease2.release();
  });
});

describe("StrategyReportService — export release lifecycle", () => {
  it("frees its slot automatically when generation throws, without an explicit release", async () => {
    const { service, docx } = makeService();
    docx.render.mockRejectedValueOnce(new Error("render exploded"));

    const failing = service.export(TENANT, ACTOR, STRATEGY, exportDto());
    const queued = Array.from({ length: MAX_IN_PROCESS_EXPORTS - 1 }, () =>
      service.export(TENANT, ACTOR, STRATEGY, exportDto()),
    );

    // The queue is full (failing + 3 queued == MAX_IN_PROCESS_EXPORTS); a 5th
    // is rejected until the failure above releases its slot.
    await expect(
      service.export(TENANT, ACTOR, STRATEGY, exportDto()),
    ).rejects.toThrow(ServiceUnavailableException);

    await expect(failing).rejects.toThrow("render exploded");

    // The failed export's slot freed itself, and its queue position was
    // handed to the next in line without anyone calling release().
    const nextInLine = await queued[0]!;
    expect(nextInLine.bytes).toBeInstanceOf(Buffer);

    // Release strictly in queue order — each is still parked behind the one
    // before it, so releasing out of order would deadlock the awaits.
    nextInLine.release();
    const third = await queued[1]!;
    third.release();
    const fourth = await queued[2]!;
    fourth.release();
  });

  it("does not double-free a slot when release() is called twice (finish + close both firing)", async () => {
    const { service } = makeService();

    const leases = Array.from({ length: MAX_IN_PROCESS_EXPORTS }, () =>
      service.export(TENANT, ACTOR, STRATEGY, exportDto()),
    );
    const lease1 = await leases[0]!;
    lease1.release();
    lease1.release(); // simulates both response 'finish' and 'close' firing

    // Exactly one slot should have been freed: one more export is admitted...
    const fifth = service.export(TENANT, ACTOR, STRATEGY, exportDto());
    // ...but a second would only fit if the double-release had freed two.
    await expect(
      service.export(TENANT, ACTOR, STRATEGY, exportDto()),
    ).rejects.toThrow(ServiceUnavailableException);

    // Release in dependency order: each queued export (and `fifth`, admitted
    // last) is parked behind the one before it, so this must go in order.
    for (const lease of [...leases.slice(1), fifth]) {
      (await lease).release();
    }
  });
});

describe("StrategyReportService — activity-log audit shape", () => {
  it("writes only the redacted export summary: no report prose, bytes, or storage keys", async () => {
    const snapshot = baseSnapshot({
      snapshotHash: "b".repeat(64),
      version: { id: "version-77", createdAt: null, note: null },
      inclusion: {
        liveNodes: 3,
        includedNodes: 2,
        omittedNodes: 1,
        includedByStatus: { in_progress: 2 },
        omittedByStatus: { suggested: 1 },
        placeholderNodes: 0,
      },
      context: {
        activeDocuments: 2,
        includedDocuments: 2,
        excludedDocuments: 0,
        staleDocuments: 0,
        openMaterialConflicts: 0,
        documents: [],
        facts: [
          {
            id: "fact-1",
            text: "Committee vote scheduled for Q4.",
            documentTitle: "Committee Brief",
            templateKey: "brief",
            sourceRef: "brief:1",
            authority: null,
            asOf: null,
            confidence: null,
          },
        ],
        sections: [{ key: "situation", title: "Situation", items: [] }],
      },
    });
    const renderedBytes = Buffer.from("pptx-payload");
    const { service, versioning, tx } = makeService({ snapshot, renderedBytes });
    const dto = exportDto({
      format: "pptx",
      audience: "internal",
      useClientLogo: false,
      includeRoadmap: false,
      includeEvidenceAppendix: false,
      includeChangeLog: true,
      includeInternalNotes: true,
      includeAgentHistory: true,
    });

    const result = await service.export(TENANT, ACTOR, STRATEGY, dto);

    expect(versioning.logActivity).toHaveBeenCalledTimes(1);
    const [calledTx, opts] = versioning.logActivity.mock.calls[0]!;
    expect(calledTx).toBe(tx);
    expect(opts.before).toBeUndefined();
    expect(opts).toMatchObject({
      tenantId: TENANT,
      actorUserId: ACTOR,
      authorKind: "person",
      action: "strategy.report.exported",
      entityType: "strategy",
      entityId: STRATEGY,
      strategyId: STRATEGY,
    });

    const expectedFilename = buildReportFilename(
      snapshot.client.name,
      snapshot.strategy.title,
      snapshot.asOf,
      "pptx",
      "internal",
    );
    const after = opts.after!;
    expect(after).toEqual({
      format: "pptx",
      audience: "internal",
      snapshotHash: snapshot.snapshotHash,
      versionId: "version-77",
      filename: expectedFilename,
      byteLength: renderedBytes.length,
      clientLogoRequested: false,
      clientLogoIncluded: false,
      inclusion: {
        liveNodes: 3,
        includedNodes: 2,
        omittedNodes: 1,
        includedByStatus: { in_progress: 2 },
        omittedByStatus: { suggested: 1 },
        placeholderNodes: 0,
      },
      content: {
        contextDocuments: 2,
        contextFacts: 1,
        narrativeSections: 1,
      },
      sections: {
        roadmap: false,
        evidenceAppendix: false,
        changeLog: true,
        internalNotes: true,
        agentHistory: true,
        narrative: true,
        memberProfiles: true,
      },
      memberOffices: { referenced: 0, resolved: 0, withPhoto: 0 },
      // Narrative defaults on; the stubbed generator returns null, so the
      // audit records the deterministic fallback — never prose or a model id.
      narrative: { requested: true, status: "fallback" },
    });
    // Locks the key set closed: a future field added to `after` (report
    // prose, rendered bytes, an S3 object key) fails this test immediately.
    expect(Object.keys(after).sort()).toEqual(
      [
        "audience",
        "byteLength",
        "clientLogoIncluded",
        "clientLogoRequested",
        "content",
        "filename",
        "format",
        "inclusion",
        "memberOffices",
        "narrative",
        "sections",
        "snapshotHash",
        "versionId",
      ].sort(),
    );
    expect(Object.keys(after.sections).sort()).toEqual(
      [
        "agentHistory",
        "changeLog",
        "evidenceAppendix",
        "internalNotes",
        "memberProfiles",
        "narrative",
        "roadmap",
      ].sort(),
    );
    expect(Object.keys(after.content).sort()).toEqual(
      ["contextDocuments", "contextFacts", "narrativeSections"].sort(),
    );

    result.release();
  });
});
