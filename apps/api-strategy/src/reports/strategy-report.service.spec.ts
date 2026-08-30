import { ConflictException } from "@nestjs/common";
import { jest } from "@jest/globals";
import {
  assertExpectedSnapshotHash,
  REPORT_SNAPSHOT_CHANGED,
  StrategyReportService,
} from "./strategy-report.service.js";

const CURRENT_HASH = "b".repeat(64);
const STALE_HASH = "a".repeat(64);

describe("strategy report snapshot contract", () => {
  it("keeps partial preflight callers on the established defaults", async () => {
    const preflight = jest.fn(async () => ({ report: { ready: true } }));
    const service = reportService({ preflight });

    await service.preflight("tenant-1", "strategy-1", {
      format: "docx",
      audience: "internal",
    });

    expect(preflight).toHaveBeenCalledWith("tenant-1", "strategy-1", {
      format: "docx",
      audience: "internal",
      useClientLogo: true,
      includeRoadmap: true,
      includeEvidenceAppendix: true,
      includeChangeLog: false,
      includeInternalNotes: false,
      includeAgentHistory: false,
    });
  });

  it("normalizes the complete preflight option set with client redaction", async () => {
    const preflight = jest.fn(async () => ({ report: { ready: true } }));
    const service = reportService({ preflight });

    await service.preflight("tenant-1", "strategy-1", {
      format: "pptx",
      audience: "client",
      useClientLogo: false,
      includeRoadmap: false,
      includeEvidenceAppendix: false,
      includeChangeLog: true,
      includeInternalNotes: true,
      includeAgentHistory: true,
    });

    expect(preflight).toHaveBeenCalledWith("tenant-1", "strategy-1", {
      format: "pptx",
      audience: "client",
      useClientLogo: false,
      includeRoadmap: false,
      includeEvidenceAppendix: false,
      includeChangeLog: false,
      includeInternalNotes: false,
      includeAgentHistory: false,
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
    const service = new StrategyReportService(
      { build } as never,
      { read: logoRead } as never,
      { render: docxRender } as never,
      { render: pptxRender } as never,
      { withTenantUser } as never,
      { logActivity } as never,
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
    expect(withTenantUser).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });
});

function reportService(snapshots: { preflight: jest.Mock }) {
  return new StrategyReportService(
    snapshots as never,
    { read: jest.fn() } as never,
    { render: jest.fn() } as never,
    { render: jest.fn() } as never,
    { withTenantUser: jest.fn() } as never,
    { logActivity: jest.fn() } as never,
  );
}
