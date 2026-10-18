import { describe, expect, it } from "@jest/globals";
import {
  kindLabel as legacyKindLabel,
  statusLabel as legacyStatusLabel,
  strategyTypeLabel as legacyStrategyTypeLabel,
} from "./report-content.js";
import { kindLabel, statusLabel, strategyTypeLabel } from "./report-labels.js";

describe("report labels shared across renderers", () => {
  it("preserves the report-content exports used by existing callers", () => {
    expect(legacyKindLabel).toBe(kindLabel);
    expect(legacyStatusLabel).toBe(statusLabel);
    expect(legacyStrategyTypeLabel).toBe(strategyTypeLabel);
  });

  it("keeps the stored step statuses and fallback presentation", () => {
    expect(statusLabel("draft")).toBe("Draft");
    expect(statusLabel("in_progress")).toBe("In progress");
    expect(statusLabel("internal_review")).toBe("Internal review");
    expect(statusLabel("active")).toBe("Active");
    expect(statusLabel("suggested")).toBe("Suggested");
    expect(statusLabel("completed")).toBe("Completed");
    expect(statusLabel("needs-owner_review")).toBe("Needs Owner Review");
  });

  it("keeps strategy labels and the unknown-type fallback", () => {
    expect(strategyTypeLabel("appropriations")).toBe("Appropriations");
    expect(strategyTypeLabel("authorization")).toBe("Authorization");
    expect(strategyTypeLabel("regulatory")).toBe("Regulatory / policy");
    expect(strategyTypeLabel("coalition")).toBe("Coalition / positioning");
    expect(strategyTypeLabel("procurement")).toBe("Contract / procurement");
    expect(strategyTypeLabel("earmark")).toBe("Grant / earmark");
    expect(strategyTypeLabel("amendment")).toBe("Amendment ask");
    expect(strategyTypeLabel("future_policy")).toBe("Future Policy");
  });

  it("formats node kinds and source authorities without changing case rules", () => {
    expect(kindLabel("decision_gate")).toBe("Decision Gate");
    expect(kindLabel("external-authoritative")).toBe("External Authoritative");
  });
});
