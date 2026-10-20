import { describe, expect, it } from "@jest/globals";
import { buildWarnings } from "./report-snapshot-policy.js";

describe("report snapshot warning policy", () => {
  it("preserves simultaneous warning order and singular audience copy", () => {
    expect(
      buildWarnings({
        memberProfilesOmitted: 1,
        clientFound: false,
        hasGoal: false,
        health: {
          score: 100,
          label: "On track",
          coveragePct: 100,
          groundingPct: null,
          timelinessPct: null,
          totalNodes: 2,
          ownedNodes: 2,
          totalGates: 0,
          groundedGates: 0,
          datedNodes: 0,
          overdueNodes: 0,
        },
        logo: {
          available: false,
          supported: false,
          contentType: null,
          objectKey: null,
        },
        logoRequested: true,
        staleDocuments: 1,
        openMaterialConflicts: 0,
        audience: "client",
        inclusion: {
          liveNodes: 2,
          includedNodes: 1,
          omittedNodes: 1,
          includedByStatus: { active: 1 },
          omittedByStatus: { draft: 1 },
          placeholderNodes: 0,
        },
        narrativeItems: 1,
        contextFacts: 1,
        excludedContextDocuments: 0,
        decisions: 1,
        risks: 1,
      }),
    ).toEqual([
      {
        code: "MEMBER_PROFILES_TRUNCATED",
        message:
          "1 additional member office will appear as plain stakeholder targets; the report profiles the first 12.",
      },
      {
        code: "CLIENT_RECORD_UNAVAILABLE",
        message:
          "The client record could not be resolved; the report will use a generic label.",
      },
      {
        code: "MISSING_STRATEGY_GOAL",
        message:
          "The strategy has no explicit goal; the executive summary will be shorter.",
      },
      {
        code: "WORKING_PLAN_ITEMS_OMITTED",
        message:
          "1 of 2 live plan steps will be included. 1 draft item is excluded until reviewed and moved to In progress or Active.",
      },
      {
        code: "CLIENT_LOGO_UNAVAILABLE",
        message:
          "No client logo is on file; the report will use typography-only branding.",
      },
      {
        code: "STALE_CONTEXT",
        message: "1 active context document is past its review date.",
      },
    ]);
  });
});
