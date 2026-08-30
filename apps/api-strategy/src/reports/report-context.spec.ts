import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assembleReportContext,
  isClientSafeContextFrontmatter,
  type ReportContextDocumentInput,
} from "./report-context.js";

const AS_OF = "2026-08-30";

function contextDocument(
  overrides: Partial<ReportContextDocumentInput> = {},
): ReportContextDocumentInput {
  return {
    id: "doc-1",
    title: "Strategy brief",
    templateKey: "01_strategy_brief",
    content: [
      "---",
      "authority: client_approved",
      "confidentiality: client_confidential",
      "source_of_truth: true",
      'as_of: "2026-08-20"',
      "---",
      "# Strategy brief",
      "",
      "## Current position",
      "- Agency staff confirmed the submission remains in scope.",
      "",
      "## Definition of success",
      "- Secure written support before the committee deadline.",
    ].join("\n"),
    frontmatter: null,
    validUntil: new Date("2026-09-30T00:00:00.000Z"),
    updatedAt: new Date("2026-08-21T12:00:00.000Z"),
    facts: [],
    ...overrides,
  };
}

describe("assembleReportContext", () => {
  it("parses approved client context from stored markdown frontmatter", () => {
    const result = assembleReportContext([contextDocument()], "client", AS_OF);

    expect(result.excludedDocuments).toBe(0);
    expect(result.documents).toEqual([
      expect.objectContaining({
        id: "doc-1",
        authority: "client_approved",
        confidentiality: "client_confidential",
        asOf: "2026-08-20",
        highlightCount: 2,
      }),
    ]);
    expect(result.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "intelligence",
          items: expect.arrayContaining([
            expect.objectContaining({
              text: "Agency staff confirmed the submission remains in scope.",
              sourceTitle: "Strategy brief",
            }),
          ]),
        }),
        expect.objectContaining({
          key: "outcomes",
          items: expect.arrayContaining([
            expect.objectContaining({
              text: "Secure written support before the committee deadline.",
            }),
          ]),
        }),
      ]),
    );
  });

  it("excludes stale, firm-internal, non-source-of-truth, and working-draft documents from a client report", () => {
    const documents = [
      contextDocument({
        id: "stale",
        validUntil: new Date("2026-08-29T00:00:00.000Z"),
      }),
      contextDocument({
        id: "firm-internal",
        frontmatter: {
          authority: "firm_approved",
          confidentiality: "firm_internal",
          source_of_truth: true,
          as_of: "2026-08-20",
        },
      }),
      contextDocument({
        id: "not-source-of-truth",
        frontmatter: {
          authority: "client_approved",
          confidentiality: "client_confidential",
          source_of_truth: false,
          as_of: "2026-08-20",
        },
      }),
      contextDocument({
        id: "working-draft",
        frontmatter: {
          authority: "working_draft",
          confidentiality: "client_confidential",
          source_of_truth: true,
          as_of: "2026-08-20",
        },
      }),
      contextDocument({
        id: "missing-confidentiality",
        frontmatter: {
          authority: "client_approved",
          source_of_truth: true,
          as_of: "2026-08-20",
        },
      }),
      contextDocument({
        id: "unknown-confidentiality",
        frontmatter: {
          authority: "client_approved",
          confidentiality: "public",
          source_of_truth: true,
          as_of: "2026-08-20",
        },
      }),
    ];

    const result = assembleReportContext(documents, "client", AS_OF);

    expect(result.documents).toEqual([]);
    expect(result.facts).toEqual([]);
    expect(result.sections).toEqual([]);
    expect(result.excludedDocuments).toBe(6);
  });

  it("suppresses labels, seed ids, empty bullets, and date placeholders in a blank context template", () => {
    const blankTemplate = readFileSync(
      join(__dirname, "../context/templates/01_strategy_brief.md"),
      "utf8",
    );
    const result = assembleReportContext(
      [
        contextDocument({
          content: blankTemplate,
          frontmatter: {
            authority: "client_approved",
            confidentiality: "client_confidential",
            source_of_truth: true,
            as_of: "2026-08-20",
          },
        }),
      ],
      "client",
      AS_OF,
    );

    expect(result.documents).toEqual([
      expect.objectContaining({ highlightCount: 0 }),
    ]);
    expect(result.sections).toEqual([]);
  });

  it("includes active facts from an eligible document and filters a working-draft fact for a client audience", () => {
    const document = contextDocument({
      templateKey: "08_evidence_register",
      facts: [
        {
          id: "fact-approved",
          fact: "The agency published the controlling guidance.",
          sourceRef: "heading:Established facts",
          authority: null,
          asOf: null,
          confidence: 1.4,
        },
        {
          id: "fact-draft",
          fact: "A working assumption still needs confirmation.",
          sourceRef: "heading:Working assumptions",
          authority: "working_draft",
          asOf: new Date("2026-08-25T00:00:00.000Z"),
          confidence: 0.55,
        },
      ],
    });

    const client = assembleReportContext([document], "client", AS_OF);
    expect(client.facts).toEqual([
      expect.objectContaining({
        id: "fact-approved",
        authority: "client_approved",
        asOf: "2026-08-20",
        confidence: 1,
      }),
    ]);
    expect(
      client.sections.find((section) => section.key === "evidence")?.items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "The agency published the controlling guidance.",
        }),
      ]),
    );

    const internal = assembleReportContext([document], "internal", AS_OF);
    expect(internal.facts.map((fact) => fact.id)).toEqual([
      "fact-approved",
      "fact-draft",
    ]);
  });

  it("assembles every approved highlight, including content after the former 120k and 40-item cutoffs", () => {
    const highlightCount = 55;
    const highlights = Array.from(
      { length: highlightCount },
      (_, index) => `- Approved context item ${index + 1}.`,
    );
    const document = contextDocument({
      content: [
        "---",
        "authority: client_approved",
        "confidentiality: client_confidential",
        "source_of_truth: true",
        'as_of: "2026-08-20"',
        "---",
        `<!--${"x".repeat(125_000)}-->`,
        "# Overview",
        ...highlights,
      ].join("\n"),
    });

    const result = assembleReportContext([document], "client", AS_OF);
    const section = result.sections.find(
      (candidate) => candidate.key === "situation",
    );

    expect(Buffer.byteLength(document.content, "utf8")).toBeGreaterThan(
      120_000,
    );
    expect(result.documents[0]?.highlightCount).toBe(highlightCount);
    expect(section?.items).toHaveLength(highlightCount);
    expect(section?.items.map((item) => item.text)).toEqual(
      highlights.map((item) => item.slice(2)),
    );
  });

  it("assembles more than 160 approved facts without per-document or total sampling", () => {
    const factCount = 175;
    const facts = Array.from({ length: factCount }, (_, index) => ({
      id: `fact-${index + 1}`,
      fact: `Approved evidence fact ${index + 1}.`,
      sourceRef: "heading:Established facts",
      authority: "client_approved",
      asOf: new Date("2026-08-20T00:00:00.000Z"),
      confidence: 0.95,
    }));
    const document = contextDocument({
      templateKey: "08_evidence_register",
      content: [
        "---",
        "authority: client_approved",
        "confidentiality: client_confidential",
        "source_of_truth: true",
        'as_of: "2026-08-20"',
        "---",
        "# Evidence register",
      ].join("\n"),
      facts,
    });

    const result = assembleReportContext([document], "client", AS_OF);
    const evidence = result.sections.find(
      (section) => section.key === "evidence",
    );

    expect(result.facts).toHaveLength(factCount);
    expect(result.facts.map((fact) => fact.id)).toEqual(
      facts.map((fact) => fact.id),
    );
    expect(evidence?.items).toHaveLength(factCount);
    expect(evidence?.items.at(-1)?.text).toBe(
      `Approved evidence fact ${factCount}.`,
    );
  });

  it("preserves a complete approved statement instead of clipping its text", () => {
    const statement =
      `The complete approved record says ${"detail ".repeat(180)}`.trim();
    const result = assembleReportContext(
      [
        contextDocument({
          content: [
            "---",
            "authority: client_approved",
            "confidentiality: client_confidential",
            "source_of_truth: true",
            'as_of: "2026-08-20"',
            "---",
            "# Current position",
            statement,
          ].join("\n"),
        }),
      ],
      "client",
      AS_OF,
    );

    expect(statement.length).toBeGreaterThan(900);
    expect(result.sections.flatMap((section) => section.items)[0]?.text).toBe(
      statement,
    );
  });

  it("categorizes known templates into executive narrative sections", () => {
    const templates = [
      ["03_ask_and_options", "ask"],
      ["04_stakeholder_map", "stakeholders"],
      ["05_calendar_and_deadlines", "timing"],
      ["08_evidence_register", "evidence"],
      ["10_decision_log", "decisions"],
    ] as const;
    const documents = templates.map(([templateKey], index) =>
      contextDocument({
        id: `doc-${index}`,
        title: templateKey,
        templateKey,
        content: [
          "---",
          "authority: client_approved",
          "confidentiality: client_confidential",
          "source_of_truth: true",
          'as_of: "2026-08-20"',
          "---",
          "# Overview",
          `Confirmed item ${index + 1}.`,
        ].join("\n"),
      }),
    );

    const result = assembleReportContext(documents, "client", AS_OF);
    for (const [templateKey, expectedKey] of templates) {
      expect(
        result.sections
          .find((section) => section.key === expectedKey)
          ?.items.some((item) => item.sourceTitle === templateKey),
      ).toBe(true);
    }
  });

  it("includes working-draft and firm-internal context in an internal report", () => {
    const documents = [
      contextDocument({
        id: "working-draft",
        frontmatter: {
          authority: "working_draft",
          confidentiality: "client_confidential",
          source_of_truth: true,
          as_of: "2026-08-20",
        },
      }),
      contextDocument({
        id: "firm-internal",
        frontmatter: {
          authority: "firm_approved",
          confidentiality: "firm_internal",
          source_of_truth: true,
          as_of: "2026-08-20",
        },
      }),
    ];

    expect(assembleReportContext(documents, "client", AS_OF).documents).toEqual(
      [],
    );
    expect(
      assembleReportContext(documents, "internal", AS_OF).documents.map(
        (document) => document.id,
      ),
    ).toEqual(["working-draft", "firm-internal"]);
  });

  it("withholds practitioner-only operating sections from a client narrative", () => {
    const document = contextDocument({
      templateKey: "10_decision_log",
      content: [
        "---",
        "authority: firm_approved",
        "confidentiality: client_confidential",
        "source_of_truth: true",
        'as_of: "2026-08-20"',
        "---",
        "# Decision log",
        "## Confirmed decision",
        "- Proceed with the preferred authorization path.",
        "## Instructions to Meri",
        "- Do not recommend a rejected option unless its revisit trigger is met.",
      ].join("\n"),
      facts: [
        {
          id: "fact-confirmed-decision",
          fact: "The preferred authorization path was confirmed.",
          sourceRef: "heading:Confirmed decision",
          authority: "firm_approved",
          asOf: null,
          confidence: 1,
        },
        {
          id: "fact-meri-instruction",
          fact: "Meri must not revisit the rejected option.",
          sourceRef: "heading:Instructions to Meri",
          authority: "firm_approved",
          asOf: null,
          confidence: 1,
        },
        {
          id: "fact-watcher-rule",
          fact: "The watcher should interrupt on an opposition signal.",
          sourceRef: "row:Watcher rules:1",
          authority: "firm_approved",
          asOf: null,
          confidence: 1,
        },
      ],
    });

    const client = assembleReportContext([document], "client", AS_OF);
    const clientText = client.sections.flatMap((section) =>
      section.items.map((item) => item.text),
    );
    expect(clientText).toContain(
      "Proceed with the preferred authorization path.",
    );
    expect(clientText).not.toContain(
      "Do not recommend a rejected option unless its revisit trigger is met.",
    );
    expect(client.facts.map((fact) => fact.id)).toEqual([
      "fact-confirmed-decision",
    ]);

    const internal = assembleReportContext([document], "internal", AS_OF);
    const internalText = internal.sections.flatMap((section) =>
      section.items.map((item) => item.text),
    );
    expect(internalText).toContain(
      "Do not recommend a rejected option unless its revisit trigger is met.",
    );
    expect(internal.facts.map((fact) => fact.id)).toEqual([
      "fact-confirmed-decision",
      "fact-meri-instruction",
      "fact-watcher-rule",
    ]);
  });

  it("excludes operational template documents and facts from a client report", () => {
    const document = contextDocument({
      templateKey: "07_current_plan",
      frontmatter: {
        authority: "firm_approved",
        confidentiality: "client_confidential",
        source_of_truth: true,
        as_of: "2026-08-20",
      },
      facts: [
        {
          id: "fact-draft-plan",
          fact: "Suggested outreach is still awaiting practitioner review.",
          sourceRef: "row:Suggested plan:1",
          authority: "firm_approved",
          asOf: new Date("2026-08-20T00:00:00.000Z"),
          confidence: 1,
        },
      ],
    });

    const client = assembleReportContext([document], "client", AS_OF);
    expect(client.documents).toEqual([]);
    expect(client.facts).toEqual([]);
    expect(client.sections).toEqual([]);
    expect(client.excludedDocuments).toBe(1);

    const internal = assembleReportContext([document], "internal", AS_OF);
    expect(internal.documents).toHaveLength(1);
    expect(internal.facts.map((fact) => fact.id)).toEqual(["fact-draft-plan"]);
  });
});

describe("isClientSafeContextFrontmatter", () => {
  it("requires an approved authority, client-safe confidentiality, and source-of-truth status", () => {
    expect(
      isClientSafeContextFrontmatter({
        authority: "client_approved",
        confidentiality: "client_confidential",
        source_of_truth: true,
      }),
    ).toBe(true);
    expect(
      isClientSafeContextFrontmatter({
        authority: "working_draft",
        confidentiality: "client_confidential",
        source_of_truth: true,
      }),
    ).toBe(false);
    expect(
      isClientSafeContextFrontmatter({
        authority: "firm_approved",
        confidentiality: "firm_internal",
        source_of_truth: true,
      }),
    ).toBe(false);
    expect(
      isClientSafeContextFrontmatter({
        authority: "client_approved",
        confidentiality: "client_confidential",
        source_of_truth: false,
      }),
    ).toBe(false);
    expect(
      isClientSafeContextFrontmatter({
        authority: "client_approved",
        source_of_truth: true,
      }),
    ).toBe(false);
    expect(
      isClientSafeContextFrontmatter({
        authority: "client_approved",
        confidentiality: "public",
        source_of_truth: true,
      }),
    ).toBe(false);
  });
});
