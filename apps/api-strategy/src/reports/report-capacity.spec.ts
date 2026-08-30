import { describe, expect, it } from "@jest/globals";
import {
  REPORT_CAPACITY_LIMITS,
  reportCapacityIssues,
} from "./report-snapshot.service.js";

describe("executive report capacity policy", () => {
  it("accepts a snapshot at every configured boundary", () => {
    expect(
      reportCapacityIssues({
        nodeRows: REPORT_CAPACITY_LIMITS.nodes,
        artifactRows: REPORT_CAPACITY_LIMITS.artifacts,
        estimatedBytes: REPORT_CAPACITY_LIMITS.snapshotBytes,
      }),
    ).toEqual([]);
  });

  it("reports each input budget violation for preflight and export", () => {
    expect(
      reportCapacityIssues({
        nodeRows: REPORT_CAPACITY_LIMITS.nodes + 1,
        artifactRows: REPORT_CAPACITY_LIMITS.artifacts + 1,
        estimatedBytes: REPORT_CAPACITY_LIMITS.snapshotBytes + 1,
      }).map(({ code }) => code),
    ).toEqual([
      "REPORT_NODE_LIMIT_EXCEEDED",
      "REPORT_ARTIFACT_LIMIT_EXCEEDED",
      "REPORT_SNAPSHOT_LIMIT_EXCEEDED",
    ]);
  });
});
