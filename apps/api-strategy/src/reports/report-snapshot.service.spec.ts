import { describe, expect, it, jest } from "@jest/globals";
import {
  canonicalLogoKey,
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
      contextSummary: { activeDocuments: 0, staleDocuments: 0 },
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
    });
    expect(internal.strategy.summary).toBe(
      "Internal summary of unaccepted working material.",
    );
  });
});
