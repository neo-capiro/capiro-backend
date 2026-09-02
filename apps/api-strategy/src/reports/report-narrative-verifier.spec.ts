import { describe, expect, it } from "@jest/globals";
import { verifyReportNarrative } from "./report-narrative-verifier.js";
import type {
  ReportNarrativeEnvelope,
  ReportNarrativeEvidence,
  ReportNarrativeSection,
} from "./report-narrative.types.js";

const evidence: ReportNarrativeEvidence[] = [
  {
    id: "plan:strategy",
    sourceTitle: "Strategy plan",
    text:
      "Strategy title: Authorization Strategy for Program Continuity. Type: Authorization. Client: Northstar Systems. Plan as of: Aug 30, 2026. Target date: Dec 15, 2026. Accountable lead: Avery Cole. Objective: Secure durable authorization language while preserving implementation flexibility.",
  },
  {
    id: "plan:health",
    sourceTitle: "Delivery readiness",
    text: "Delivery readiness score 84 of 100 (On track). 4 of 4 steps assigned. 1 of 1 gates grounded. 1 step overdue.",
  },
  {
    id: "plan:node:decision",
    sourceTitle: "Plan step: Select the preferred authorization path",
    text: "Plan step: Select the preferred authorization path. Type: Decision. Status: In progress. Owner: Jordan Lee. Timing: Sep 15, 2026.",
  },
  {
    id: "ctx:situation:1",
    sourceTitle: "Approved strategy brief",
    text: "A compressed committee calendar makes early alignment essential. Committee staff expects a quantified evidence pack of 12 exhibits.",
  },
  {
    id: "member:52480",
    sourceTitle: "Member office: Sen. Maria Cantwell",
    text: "Member office: Sen. Maria Cantwell. Party: Democratic. State: Washington. Chamber: Senate. Washington office: 511 Hart Senate Office Building, Washington, DC 20510. Phone: (202) 224-3441.",
  },
];

describe("report narrative verifier", () => {
  it("accepts grounded prose and attaches source titles", () => {
    const result = verifyReportNarrative({
      evidence,
      envelope: envelope([
        section("executive_summary", [
          {
            text: "Northstar Systems is pursuing durable authorization language while preserving implementation flexibility, with the plan on track at 84 of 100 and a target date of Dec 15, 2026.",
            evidenceIds: ["plan:strategy", "plan:health"],
          },
          {
            text: "Jordan Lee will select the preferred authorization path by Sep 15, 2026, against a compressed committee calendar that makes early alignment essential.",
            evidenceIds: ["plan:node:decision", "ctx:situation:1"],
          },
        ]),
      ]),
    });

    expect(result.rejectedParagraphs).toBe(0);
    expect(result.acceptedParagraphs).toBe(2);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.paragraphs[0]!.sourceTitles).toEqual([
      "Strategy plan",
      "Delivery readiness",
    ]);
  });

  it("rejects a paragraph whose number is not in its cited evidence", () => {
    const result = verifyReportNarrative({
      evidence,
      envelope: envelope([
        section("executive_summary", [
          {
            text: "The plan is on track at 91 of 100.",
            evidenceIds: ["plan:health"],
          },
        ]),
      ]),
    });
    expect(result.sections).toHaveLength(0);
    expect(result.rejections).toEqual([
      expect.objectContaining({
        sectionId: "executive_summary",
        reason: "ungrounded_number",
        detail: "91",
      }),
    ]);
  });

  it("requires numbers to be grounded in the CITED evidence, not just anywhere", () => {
    const result = verifyReportNarrative({
      evidence,
      envelope: envelope([
        section("situation", [
          {
            // 84 exists in plan:health, but this paragraph cites only the brief.
            text: "Committee staff expects 84 exhibits in the evidence pack.",
            evidenceIds: ["ctx:situation:1"],
          },
        ]),
      ]),
    });
    expect(result.rejections[0]?.reason).toBe("ungrounded_number");
  });

  it("accepts thousands separators, percentages and currency written differently", () => {
    const result = verifyReportNarrative({
      evidence: [
        {
          id: "e",
          sourceTitle: "Brief",
          text: "The program request is $1,250,000 with 45% matching funds for 2027.",
        },
      ],
      envelope: envelope([
        section("situation", [
          {
            text: "The request totals $1250000, backed by 45% matching funds in 2027.",
            evidenceIds: ["e"],
          },
        ]),
      ]),
    });
    expect(result.rejectedParagraphs).toBe(0);
  });

  it("rejects a date that does not match a cited evidence date", () => {
    const result = verifyReportNarrative({
      evidence,
      envelope: envelope([
        section("roadmap_outlook", [
          {
            text: "The preferred path decision lands on September 22, 2026.",
            evidenceIds: ["plan:node:decision"],
          },
        ]),
      ]),
    });
    expect(result.rejections[0]).toEqual(
      expect.objectContaining({
        reason: "ungrounded_date",
        detail: "September 22, 2026",
      }),
    );
  });

  it("accepts month-only and long-form dates that match evidence", () => {
    const result = verifyReportNarrative({
      evidence,
      envelope: envelope([
        section("roadmap_outlook", [
          {
            text: "The decision is scheduled for mid-September, with the 15 September 2026 milestone framing the near term.",
            evidenceIds: ["plan:node:decision"],
          },
        ]),
      ]),
    });
    // "15 September 2026" is day-first; the verifier only understands
    // month-first prose, so the 15 is checked as a number (present) and
    // "September 2026" as a month/year (present).
    expect(result.rejectedParagraphs).toBe(0);
  });

  it("rejects names and acronyms that appear nowhere in the evidence packet", () => {
    const fabricatedSenator = verifyReportNarrative({
      evidence,
      envelope: envelope([
        section("stakeholders", [
          {
            text: "Sen. Maria Cantwell and Sen. Patty Murray anchor the Senate path.",
            evidenceIds: ["member:52480"],
          },
        ]),
      ]),
    });
    expect(fabricatedSenator.rejections[0]).toEqual(
      expect.objectContaining({ reason: "ungrounded_name", detail: "Patty" }),
    );

    const fabricatedBill = verifyReportNarrative({
      evidence,
      envelope: envelope([
        section("situation", [
          {
            text: "NDAA conference timing compresses the committee calendar.",
            evidenceIds: ["ctx:situation:1"],
          },
        ]),
      ]),
    });
    expect(fabricatedBill.rejections[0]).toEqual(
      expect.objectContaining({ reason: "ungrounded_name", detail: "NDAA" }),
    );
  });

  it("rejects a party affiliation the evidence does not state", () => {
    const result = verifyReportNarrative({
      evidence,
      envelope: envelope([
        section("stakeholders", [
          {
            text: "Sen. Maria Cantwell, a Republican from Washington, chairs the effort.",
            evidenceIds: ["member:52480"],
          },
        ]),
      ]),
    });
    expect(result.rejections[0]).toEqual(
      expect.objectContaining({ reason: "ungrounded_name", detail: "Republican" }),
    );
  });

  it("does not treat ordinary sentence-initial words or report vocabulary as names", () => {
    const result = verifyReportNarrative({
      evidence,
      envelope: envelope([
        section("constraints_and_timing", [
          {
            text: "Early alignment matters because the committee calendar is compressed. Leadership should expect the evidence pack to carry 12 exhibits.",
            evidenceIds: ["ctx:situation:1"],
          },
        ]),
      ]),
    });
    expect(result.rejectedParagraphs).toBe(0);
  });

  it("rejects paragraphs that leak evidence ids, placeholders or markdown", () => {
    const result = verifyReportNarrative({
      evidence,
      envelope: envelope([
        section("situation", [
          { text: "See plan:health for the score.", evidenceIds: ["plan:health"] },
          { text: "The client, [CLIENT NAME], is on track.", evidenceIds: ["plan:health"] },
          { text: "**Bold** claims are on track.", evidenceIds: ["plan:health"] },
        ]),
      ]),
    });
    expect(result.rejections.map((entry) => entry.reason)).toEqual([
      "leaked_marker",
      "leaked_marker",
      "leaked_marker",
    ]);
  });

  it("rejects structural problems: unknown sections, missing or unknown citations, empties, overflow", () => {
    const result = verifyReportNarrative({
      evidence,
      envelope: envelope([
        {
          id: "made_up" as never,
          paragraphs: [{ text: "Anything.", evidenceIds: ["plan:health"] }],
        },
        section("executive_summary", [
          { text: "No citation.", evidenceIds: [] },
          { text: "Bad citation.", evidenceIds: ["plan:missing"] },
          { text: "   ", evidenceIds: ["plan:health"] },
          { text: "x".repeat(1_500), evidenceIds: ["plan:health"] },
        ]),
      ]),
    });
    expect(result.rejections.map((entry) => entry.reason)).toEqual([
      "unknown_section",
      "no_evidence_cited",
      "unknown_evidence_id",
      "empty_text",
      "too_long",
    ]);
    expect(result.sections).toHaveLength(0);
  });

  it("caps paragraphs per section and ignores a duplicated section id", () => {
    const paragraphs = Array.from({ length: 6 }, () => ({
      text: "The plan is on track at 84 of 100.",
      evidenceIds: ["plan:health"],
    }));
    const result = verifyReportNarrative({
      evidence,
      envelope: envelope([
        section("executive_summary", paragraphs),
        section("executive_summary", paragraphs.slice(0, 1)),
      ]),
    });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.paragraphs).toHaveLength(4);
    expect(
      result.rejections.filter((entry) => entry.reason === "too_many_paragraphs"),
    ).toHaveLength(2);
    expect(
      result.rejections.filter((entry) => entry.reason === "unknown_section"),
    ).toHaveLength(1);
  });

  it("tolerates a malformed envelope without throwing", () => {
    const result = verifyReportNarrative({
      evidence,
      envelope: {
        sections: [
          { id: "situation", paragraphs: "nope" },
          { id: "stakeholders", paragraphs: [{ text: 42, evidenceIds: "x" }] },
        ],
      } as unknown as ReportNarrativeEnvelope,
    });
    expect(result.sections).toHaveLength(0);
    expect(result.model).toBe("unknown");
    expect(result.rejections.map((entry) => entry.reason)).toEqual([
      "empty_text",
    ]);
  });
});

function envelope(sections: ReportNarrativeSection[]): ReportNarrativeEnvelope {
  return {
    sections,
    model: "test-model",
    generatedAt: "2026-08-30T12:00:00.000Z",
    usage: { inputTokens: 100, outputTokens: 50 },
    attempts: 1,
    droppedParagraphs: 0,
    usedFallback: false,
  };
}

function section(
  id: ReportNarrativeSection["id"],
  paragraphs: ReportNarrativeSection["paragraphs"],
): ReportNarrativeSection {
  return { id, paragraphs };
}
