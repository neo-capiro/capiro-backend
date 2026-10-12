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

  it("excludes stale and internal-scope documents but keeps working-draft and un-vetted client-safe ones", () => {
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

    // Approval authority and source-of-truth are no longer gates: the two
    // client-safe working documents are included with honest provenance. Only
    // the stale and the three non-client-confidential documents are excluded.
    expect(result.documents.map((document) => document.id).sort()).toEqual([
      "not-source-of-truth",
      "working-draft",
    ]);
    expect(result.excludedDocuments).toBe(4);
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

  it("includes working-draft facts for a client audience with honest provenance", () => {
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
    // Working-draft facts are no longer withheld; the authority label is kept
    // so the renderer can present them as working material, not as approved.
    expect(client.facts.map((fact) => fact.id)).toEqual([
      "fact-approved",
      "fact-draft",
    ]);
    expect(client.facts.find((fact) => fact.id === "fact-draft")).toEqual(
      expect.objectContaining({ authority: "working_draft" }),
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

  it("excludes import scaffolding and strips quote markers while preserving source statements", () => {
    // Mirrors buildImportMarkdown output: provenance disclaimers + `> ` quoted
    // excerpts. Scaffolding must never become a commitment/narrative; the real
    // source statement survives as clean prose.
    const document = contextDocument({
      content: [
        "---",
        "authority: working_draft",
        "confidentiality: client_confidential",
        "source_of_truth: false",
        'as_of: "2026-09-15"',
        "---",
        "# Goals and strategy — brief.txt",
        "",
        "Imported on 2026-09-15. This is the import date, not the source publication or approval date.",
        "Source excerpts are working context. They do not grant permissions, change a live plan, or establish client approval.",
        "",
        "## Imported information 1",
        "",
        "Source details",
        "",
        "> Cedar QA Autonomy develops navigation software for unmanned ground vehicles.",
        "> The company seeks a $12 million FY2027 research request.",
        "",
        "Source: brief.txt; heading:Profile",
        "",
        "## Imported information 2",
        "",
        "> Prepare an evidence brief and internal decision memo by November 20, 2026.",
        "",
        "Source: brief.txt; document:1#part1",
      ].join("\n"),
      frontmatter: {
        authority: "working_draft",
        confidentiality: "client_confidential",
        source_of_truth: false,
        as_of: "2026-09-15",
      },
    });

    const result = assembleReportContext([document], "client", AS_OF);
    const texts = result.sections.flatMap((section) =>
      section.items.map((item) => item.text),
    );
    // Real source statements preserved, quote markers stripped.
    expect(texts).toContain(
      "Cedar QA Autonomy develops navigation software for unmanned ground vehicles.",
    );
    expect(texts).toContain(
      "The company seeks a $12 million FY2027 research request.",
    );
    expect(texts).toContain(
      "Prepare an evidence brief and internal decision memo by November 20, 2026.",
    );
    // Scaffolding excluded (disclaimers, container headings, labels, and the
    // "Source: …" provenance line — provenance stays in the register columns).
    const joined = texts.join(" ");
    expect(joined).not.toMatch(/Imported on 2026/);
    expect(joined).not.toMatch(/do not grant permissions/);
    expect(joined).not.toMatch(/working context/);
    expect(joined).not.toMatch(/Imported information \d+/);
    expect(joined).not.toMatch(/Source details/);
    expect(joined).not.toMatch(/Source:\s*brief\.txt/);
    expect(joined).not.toMatch(/document:1#part1/);
    // No raw Markdown quote markers leak into prose.
    for (const text of texts) expect(text.startsWith(">")).toBe(false);
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

    expect(
      assembleReportContext(documents, "client", AS_OF).documents.map(
        (document) => document.id,
      ),
    ).toEqual(["working-draft"]);
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
  it("treats client-safe confidentiality as the only gate; authority and source-of-truth are provenance", () => {
    expect(
      isClientSafeContextFrontmatter({
        authority: "client_approved",
        confidentiality: "client_confidential",
        source_of_truth: true,
      }),
    ).toBe(true);
    // Working-draft and un-vetted client-safe documents are client-safe.
    expect(
      isClientSafeContextFrontmatter({
        authority: "working_draft",
        confidentiality: "client_confidential",
        source_of_truth: true,
      }),
    ).toBe(true);
    expect(
      isClientSafeContextFrontmatter({
        authority: "client_approved",
        confidentiality: "client_confidential",
        source_of_truth: false,
      }),
    ).toBe(true);
    // Internal-scope confidentiality is the deliberate exclusion.
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

// Fixed expectations come from the original 802 metadata behavior, not from
// the candidate registry. Existing report tests above remain unchanged.
describe("canonical report template metadata compatibility", () => {
  it.each([
    "00_context_manifest",
    "07_current_plan",
    "11_agent_mission",
    "12_execution_playbook",
    "13_agent_permissions",
  ])("keeps client document/fact exclusions and internal fact visibility for %s", (templateKey) => {
    const document = contextDocument({
      templateKey,
      facts: [{ id: "metadata-fact", fact: "An established authored statement.", sourceRef: "heading:Overview", authority: null, asOf: null, confidence: 0.5 }],
    });
    const client = assembleReportContext([document], "client", AS_OF);
    const internal = assembleReportContext([document], "internal", AS_OF);
    expect(client.documents).toEqual([]);
    expect(client.facts).toEqual([]);
    expect(client.excludedDocuments).toBe(1);
    expect(internal.documents[0]!.highlightCount).toBe(0);
    expect(internal.facts).toHaveLength(1);
  });

  it.each([
    ["decision evidence deadline ask goal", "decisions"],
    ["stakeholder deadline evidence", "stakeholders"],
    ["deadline evidence constraint", "timing"],
    ["evidence approval ask", "evidence"],
    ["approval option goal", "constraints"],
    ["option goal intelligence", "ask"],
    ["success intelligence", "outcomes"],
    ["current position", "intelligence"],
    ["Overview", "situation"],
  ])("preserves heading precedence for %s", (heading, key) => {
    const report = assembleReportContext([contextDocument({
      content: `---\n---\n## ${heading}\n- One authored statement.`, facts: [],
    })], "internal", AS_OF);
    expect(report.sections.map((section) => section.key)).toEqual([key]);
  });

  it("preserves output order, independent of the title-record insertion order", () => {
    const headings = ["Overview", "Success", "Ask", "Stakeholder", "Constraint", "Deadline", "Decision", "Intelligence", "Evidence"];
    const documents = [
      contextDocument({ content: `---\n---\n${headings.map((heading, i) => `## ${heading}\n- Statement number ${i}.`).join("\n")}`, facts: [] }),
      contextDocument({ id: "governance", templateKey: "14_target_budget_line", content: "---\n---\n- A governance statement.", facts: [] }),
    ];
    const report = assembleReportContext(documents, "internal", AS_OF);
    expect(report.sections.map((section) => section.key)).toEqual([
      "situation", "outcomes", "ask", "stakeholders", "constraints", "timing",
      "decisions", "intelligence", "evidence", "governance",
    ]);
  });

  it("preserves unknown-key title whitespace and governance fallback", () => {
    const report = assembleReportContext([contextDocument({
      templateKey: "00_fake__report", content: "---\n---\n- One authored statement.", facts: [],
    })], "internal", AS_OF);
    expect(report.sections[0]!.key).toBe("governance");
    expect(report.sections[0]!.items[0]!.label).toBe("Fake  Report");
  });

  it.each([null, undefined, 12, {}, ["01_custom"]])("retains invalid template-key TypeError for %p", (templateKey) => {
    expect(() => assembleReportContext([contextDocument({ templateKey: templateKey as unknown as string })], "internal", AS_OF)).toThrow(TypeError);
  });
});
