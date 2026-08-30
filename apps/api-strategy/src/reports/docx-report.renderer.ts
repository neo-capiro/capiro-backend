import { Injectable } from "@nestjs/common";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertInchesToTwip,
} from "docx";
import {
  clip,
  criticalNodes,
  dateRange,
  decisionsAndRisks,
  executiveSummary,
  formatDate,
  kindLabel,
  nodeDetail,
  roadmap,
  statusLabel,
  strategyTypeLabel,
} from "./report-content.js";
import { containSize, readRasterSize } from "./report-image.js";
import { ooxmlSafeValue } from "./report-text.js";
import type {
  ClientLogoAsset,
  ExecutiveReportSnapshot,
  ReportNode,
} from "./report.types.js";

const COLORS = {
  navy: "102A43",
  blue: "1F5A7A",
  teal: "2C7A7B",
  gold: "C49A5A",
  ink: "243B53",
  slate: "526D82",
  mist: "EAF0F5",
  pale: "F6F8FA",
  white: "FFFFFF",
  line: "D9E2EC",
  red: "B42318",
} as const;

const CELL_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
  left: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
  right: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
};

@Injectable()
export class DocxReportRenderer {
  async render(
    snapshot: ExecutiveReportSnapshot,
    logo: ClientLogoAsset | null,
  ): Promise<Buffer> {
    // Defense in depth for direct renderer callers outside snapshot loading.
    snapshot = ooxmlSafeValue(snapshot);
    const children: Array<Paragraph | Table> = [];
    children.push(...cover(snapshot, logo));
    children.push(new Paragraph({ children: [new PageBreak()] }));

    children.push(sectionHeading("Executive summary"));
    for (const line of executiveSummary(snapshot))
      children.push(bodyParagraph(line));
    children.push(
      callout(
        `${snapshot.health.label} · ${snapshot.health.score}/100`,
        healthNarrative(snapshot),
        snapshot.health.score >= 80
          ? COLORS.teal
          : snapshot.health.score >= 60
            ? COLORS.gold
            : COLORS.red,
      ),
    );

    children.push(sectionHeading("Strategy at a glance"));
    children.push(
      twoColumnFacts([
        ["Strategy", snapshot.strategy.title],
        ["Client", snapshot.client.name],
        ["Strategy type", strategyTypeLabel(snapshot.strategy.type)],
        ["Accountable lead", snapshot.strategy.ownerName],
        ["Target date", formatDate(snapshot.strategy.targetDate)],
        ["Plan as of", formatDate(snapshot.asOf)],
      ]),
    );

    children.push(sectionHeading("Plan health"));
    children.push(healthTable(snapshot));

    children.push(sectionHeading("Leadership priorities"));
    const leadershipPriorities = criticalNodes(snapshot);
    children.push(
      nodeTable(
        snapshot,
        leadershipPriorities,
        "No plan priorities are available.",
      ),
    );
    if (leadershipPriorities.length < snapshot.nodes.length) {
      children.push(
        mutedParagraph(
          `Showing the ${leadershipPriorities.length} highest-priority steps from ${snapshot.nodes.length} current plan steps.`,
        ),
      );
    }

    const risksAndDecisions = decisionsAndRisks(snapshot);
    children.push(sectionHeading("Decisions and risk posture"));
    children.push(
      risksAndDecisions.length
        ? nodeTable(snapshot, risksAndDecisions, "")
        : bodyParagraph(
            "No decisions or risks are currently recorded in the plan.",
          ),
    );

    if (snapshot.options.includeRoadmap) {
      children.push(sectionHeading("90-day roadmap"));
      for (const group of roadmap(snapshot)) {
        children.push(subheading(group.label));
        if (group.nodes.length === 0) {
          children.push(mutedParagraph("No plan steps in this window."));
        } else {
          for (const node of group.nodes)
            children.push(nodeBullet(snapshot, node));
        }
      }
      if (
        snapshot.firmPhases.length > 0 ||
        snapshot.referenceWindows.length > 0
      ) {
        children.push(subheading("Planning calendar context"));
        const displayedPhases = snapshot.firmPhases.slice(0, 8);
        for (const phase of displayedPhases) {
          children.push(
            bulletParagraph(
              `${phase.label}: FY${phase.startFy} Q${phase.startQ} – FY${phase.endFy} Q${phase.endQ}`,
            ),
          );
        }
        if (displayedPhases.length < snapshot.firmPhases.length) {
          children.push(
            mutedParagraph(
              `Showing ${displayedPhases.length} of ${snapshot.firmPhases.length} loaded firm phases.`,
            ),
          );
        }
        const displayedWindows = snapshot.referenceWindows.slice(0, 8);
        for (const window of displayedWindows) {
          const timing = window.fy
            ? `FY${window.fy}`
            : window.startsOn
              ? `${formatDate(window.startsOn)}${window.endsOn ? ` – ${formatDate(window.endsOn)}` : ""}`
              : "Current";
          children.push(bulletParagraph(`${window.label}: ${timing}`));
        }
        if (displayedWindows.length < snapshot.referenceWindows.length) {
          children.push(
            mutedParagraph(
              `Showing ${displayedWindows.length} of ${snapshot.referenceWindows.length} loaded reference windows.`,
            ),
          );
        }
      }
    }

    children.push(sectionHeading("Accountability and stakeholders"));
    const accountable = snapshot.nodes.filter(
      (node) => node.ownerName !== "Unassigned" || Boolean(node.targetLabel),
    );
    children.push(
      accountable.length
        ? accountabilityTable(accountable)
        : bodyParagraph(
            "Accountable owners and stakeholder targets have not yet been assigned.",
          ),
    );

    if (snapshot.options.includeEvidenceAppendix) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
      children.push(sectionHeading("Evidence and outputs appendix"));
      const grounded = snapshot.nodes.filter((node) => node.sources.length > 0);
      if (grounded.length === 0) {
        children.push(
          bodyParagraph(
            "No evidence sources are attached to current plan steps.",
          ),
        );
      } else {
        for (const node of grounded) {
          children.push(subheading(node.title));
          for (const source of node.sources) {
            const reference =
              snapshot.options.audience === "internal" && source.ref
                ? `${source.section} · ${source.ref}`
                : source.section;
            children.push(bulletParagraph(reference));
          }
          const sourceCount = node.sourceCount ?? node.sources.length;
          if (node.sources.length < sourceCount) {
            children.push(
              mutedParagraph(
                `Showing ${node.sources.length} of ${sourceCount} attached sources for this step.`,
              ),
            );
          }
        }
      }
      const artifactCounts = new Map<string, number>();
      for (const artifact of snapshot.artifacts) {
        artifactCounts.set(
          artifact.artifactType,
          (artifactCounts.get(artifact.artifactType) ?? 0) + 1,
        );
      }
      if (artifactCounts.size > 0) {
        children.push(subheading("Connected outputs"));
        for (const [type, count] of artifactCounts) {
          children.push(bulletParagraph(`${kindLabel(type)}: ${count}`));
        }
        if (snapshot.options.audience === "internal") {
          const displayedArtifacts = snapshot.artifacts.slice(0, 30);
          for (const artifact of displayedArtifacts) {
            children.push(
              mutedParagraph(
                `${kindLabel(artifact.artifactType)} · ${artifact.artifactRef}`,
              ),
            );
          }
          if (displayedArtifacts.length < snapshot.artifacts.length) {
            children.push(
              mutedParagraph(
                `Showing ${displayedArtifacts.length} of ${snapshot.artifacts.length} connected-output references.`,
              ),
            );
          }
        }
      }
    }

    if (snapshot.options.audience === "internal") {
      children.push(...internalAppendix(snapshot));
    }

    const confidentiality =
      snapshot.options.audience === "client"
        ? "Confidential · Prepared for client discussion"
        : "Confidential · Internal working document";
    const document = new Document({
      creator: "Capiro",
      title: `${snapshot.strategy.title} — Executive Strategy Report`,
      subject: `Executive strategy report for ${snapshot.client.name}`,
      description: `Generated from strategy snapshot ${snapshot.snapshotHash.slice(0, 12)}`,
      styles: {
        default: {
          document: {
            run: { font: "Aptos", size: 20, color: COLORS.ink },
            paragraph: { spacing: { after: 120, line: 276 } },
          },
        },
      },
      sections: [
        {
          properties: {
            page: {
              margin: {
                top: convertInchesToTwip(0.72),
                right: convertInchesToTwip(0.75),
                bottom: convertInchesToTwip(0.72),
                left: convertInchesToTwip(0.75),
              },
            },
          },
          headers: {
            default: new Header({
              children: [
                new Paragraph({
                  alignment: AlignmentType.RIGHT,
                  children: [
                    new TextRun({
                      text: `${snapshot.client.name}  |  Executive Strategy Report`,
                      size: 16,
                      color: COLORS.slate,
                    }),
                  ],
                }),
              ],
            }),
          },
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({
                      text: `${confidentiality}   ·   `,
                      size: 15,
                      color: COLORS.slate,
                    }),
                    new TextRun({
                      children: ["Page ", PageNumber.CURRENT],
                      size: 15,
                      color: COLORS.slate,
                    }),
                  ],
                }),
              ],
            }),
          },
          children,
        },
      ],
    });
    return Packer.toBuffer(document);
  }
}

function cover(
  snapshot: ExecutiveReportSnapshot,
  logo: ClientLogoAsset | null,
): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const size = logo?.dimensions ?? (logo ? readRasterSize(logo) : null);
  if (logo && size) {
    const fitted = containSize(size, 260, 88);
    paragraphs.push(
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { after: 900 },
        children: [
          new ImageRun({
            type: logo.contentType === "image/png" ? "png" : "jpg",
            data: logo.bytes,
            transformation: { width: fitted.width, height: fitted.height },
            altText: {
              name: `${snapshot.client.name} logo`,
              title: `${snapshot.client.name} logo`,
              description: "Client brand mark",
            },
          }),
        ],
      }),
    );
  } else {
    paragraphs.push(
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { after: 900 },
        children: [
          new TextRun({
            text: snapshot.client.name.toUpperCase(),
            bold: true,
            size: 20,
            color: COLORS.blue,
          }),
        ],
      }),
    );
  }
  paragraphs.push(
    new Paragraph({
      spacing: { after: 180 },
      children: [
        new TextRun({
          text: "EXECUTIVE STRATEGY REPORT",
          bold: true,
          size: 18,
          color: COLORS.teal,
          characterSpacing: 120,
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 220 },
      children: [
        new TextRun({
          text: snapshot.strategy.title,
          bold: true,
          size: 48,
          color: COLORS.navy,
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 680 },
      children: [
        new TextRun({
          text: `${strategyTypeLabel(snapshot.strategy.type)} · Prepared for ${snapshot.client.name}`,
          size: 24,
          color: COLORS.slate,
        }),
      ],
    }),
    new Paragraph({
      border: {
        top: { style: BorderStyle.SINGLE, size: 16, color: COLORS.gold },
      },
      spacing: { before: 180, after: 160 },
      children: [
        new TextRun({
          text: `Plan as of ${formatDate(snapshot.asOf)}`,
          bold: true,
          size: 22,
          color: COLORS.ink,
        }),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({
          text:
            snapshot.options.audience === "client"
              ? "CONFIDENTIAL · CLIENT DISCUSSION DRAFT"
              : "CONFIDENTIAL · INTERNAL WORKING DRAFT",
          bold: true,
          size: 16,
          color: COLORS.slate,
        }),
      ],
    }),
  );
  return paragraphs;
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    keepNext: true,
    spacing: { before: 300, after: 140 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 10, color: COLORS.teal },
    },
    children: [new TextRun({ text, bold: true, size: 30, color: COLORS.navy })],
  });
}

function subheading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    keepNext: true,
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text, bold: true, size: 23, color: COLORS.blue })],
  });
}

function bodyParagraph(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, size: 20, color: COLORS.ink })],
  });
}

function mutedParagraph(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text, size: 17, color: COLORS.slate, italics: true }),
    ],
  });
}

function bulletParagraph(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    children: [new TextRun({ text, size: 19, color: COLORS.ink })],
  });
}

function nodeBullet(
  snapshot: ExecutiveReportSnapshot,
  node: ReportNode,
): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    children: [
      new TextRun({
        text: node.title,
        bold: true,
        size: 19,
        color: COLORS.ink,
      }),
      new TextRun({
        text: ` — ${nodeDetail(snapshot, node)}`,
        size: 17,
        color: COLORS.slate,
      }),
    ],
  });
}

function callout(title: string, body: string, accent: string): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            borders: CELL_BORDERS,
            shading: {
              type: ShadingType.CLEAR,
              fill: COLORS.pale,
              color: "auto",
            },
            margins: { top: 160, bottom: 160, left: 180, right: 180 },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: title,
                    bold: true,
                    size: 24,
                    color: accent,
                  }),
                ],
              }),
              new Paragraph({
                children: [
                  new TextRun({ text: body, size: 18, color: COLORS.ink }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function twoColumnFacts(rows: Array<[string, string]>): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      ([label, value], index) =>
        new TableRow({
          cantSplit: true,
          children: [
            cell(label, true, index % 2 === 0 ? COLORS.mist : COLORS.pale),
            cell(value, false, index % 2 === 0 ? COLORS.mist : COLORS.pale),
          ],
        }),
    ),
  });
}

function healthTable(snapshot: ExecutiveReportSnapshot): Table {
  const health = snapshot.health;
  const items: Array<[string, string, string]> = [
    ["Overall", `${health.score}/100`, health.label],
    [
      "Ownership",
      `${health.coveragePct}%`,
      `${health.ownedNodes} of ${health.totalNodes} assigned`,
    ],
    [
      "Grounding",
      `${health.groundingPct}%`,
      `${health.groundedGates} of ${health.totalGates} gates`,
    ],
    [
      "Timeliness",
      `${health.timelinessPct}%`,
      `${health.overdueNodes} overdue`,
    ],
  ];
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        cantSplit: true,
        children: items.map(
          ([label, value, note]) =>
            new TableCell({
              borders: CELL_BORDERS,
              shading: {
                type: ShadingType.CLEAR,
                fill: COLORS.pale,
                color: "auto",
              },
              margins: { top: 140, bottom: 140, left: 120, right: 120 },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: label.toUpperCase(),
                      bold: true,
                      size: 14,
                      color: COLORS.slate,
                    }),
                  ],
                }),
                new Paragraph({
                  children: [
                    new TextRun({
                      text: value,
                      bold: true,
                      size: 28,
                      color: COLORS.navy,
                    }),
                  ],
                }),
                new Paragraph({
                  children: [
                    new TextRun({ text: note, size: 15, color: COLORS.slate }),
                  ],
                }),
              ],
            }),
        ),
      }),
    ],
  });
}

function nodeTable(
  snapshot: ExecutiveReportSnapshot,
  nodes: ReportNode[],
  emptyMessage: string,
): Table | Paragraph {
  if (nodes.length === 0) return bodyParagraph(emptyMessage);
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      headerRow(["Priority", "Owner", "Timing", "Status"]),
      ...nodes.map(
        (node) =>
          new TableRow({
            cantSplit: true,
            children: [
              richCell(
                node.title,
                snapshot.options.includeInternalNotes ? node.note : null,
              ),
              cell(node.ownerName),
              cell(dateRange(node)),
              cell(`${kindLabel(node.kind)} · ${statusLabel(node.status)}`),
            ],
          }),
      ),
    ],
  });
}

function accountabilityTable(nodes: ReportNode[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      headerRow(["Plan step", "Accountable owner", "Stakeholder / target"]),
      ...nodes.map(
        (node) =>
          new TableRow({
            cantSplit: true,
            children: [
              cell(node.title),
              cell(node.ownerName),
              cell(node.targetLabel ?? "—"),
            ],
          }),
      ),
    ],
  });
}

function internalAppendix(
  snapshot: ExecutiveReportSnapshot,
): Array<Paragraph | Table> {
  const result: Array<Paragraph | Table> = [
    new Paragraph({ children: [new PageBreak()] }),
    sectionHeading("Internal governance appendix"),
    twoColumnFacts([
      ["Snapshot", snapshot.snapshotHash.slice(0, 16)],
      ["Current version", snapshot.version.id?.slice(0, 12) ?? "No version"],
      ["Active context documents", String(snapshot.context.activeDocuments)],
      [
        "Context documents past review",
        String(snapshot.context.staleDocuments),
      ],
      [
        "Open material conflicts",
        String(snapshot.context.openMaterialConflicts),
      ],
      ["Connected artifacts", String(snapshot.counts.artifacts)],
    ]),
  ];
  if (snapshot.options.includeChangeLog) {
    result.push(subheading("Recent plan changes (latest report sample)"));
    if (snapshot.activity.versions.length === 0)
      result.push(mutedParagraph("No version history is available."));
    for (const version of snapshot.activity.versions) {
      result.push(
        bulletParagraph(
          `${formatDate(version.createdAt)} · ${version.authorKind === "meri" ? "Meri" : "Team"} · ${version.note}`,
        ),
      );
    }
  }
  if (snapshot.options.includeAgentHistory) {
    result.push(
      subheading("Automation and watch history (latest report sample)"),
    );
    if (snapshot.activity.agentRuns.length === 0)
      result.push(mutedParagraph("No agent runs are recorded."));
    const displayedRuns = snapshot.activity.agentRuns.slice(0, 15);
    for (const run of displayedRuns) {
      result.push(
        bulletParagraph(
          `${formatDate(run.createdAt)} · ${statusLabel(run.state)} · ${kindLabel(run.trigger)}${
            run.waitingReason ? ` · Waiting: ${run.waitingReason}` : ""
          }`,
        ),
      );
    }
    if (displayedRuns.length < snapshot.activity.agentRuns.length) {
      result.push(
        mutedParagraph(
          `Showing ${displayedRuns.length} of ${snapshot.activity.agentRuns.length} runs loaded into this recent report sample; older history is not included.`,
        ),
      );
    }
    const displayedChangeSets = snapshot.activity.changeSets.slice(0, 15);
    for (const changeSet of displayedChangeSets) {
      result.push(
        mutedParagraph(
          `${statusLabel(changeSet.status)} · ${kindLabel(changeSet.risk)} risk · ${changeSet.summary}`,
        ),
      );
    }
    if (displayedChangeSets.length < snapshot.activity.changeSets.length) {
      result.push(
        mutedParagraph(
          `Showing ${displayedChangeSets.length} of ${snapshot.activity.changeSets.length} records loaded into this recent report sample; older history is not included.`,
        ),
      );
    }
  }
  return result;
}

function headerRow(labels: string[]): TableRow {
  return new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: labels.map((label) =>
      cell(label, true, COLORS.navy, COLORS.white),
    ),
  });
}

function richCell(title: string, note: string | null): TableCell {
  return new TableCell({
    borders: CELL_BORDERS,
    margins: { top: 90, bottom: 90, left: 100, right: 100 },
    children: [
      new Paragraph({
        children: [
          new TextRun({ text: title, bold: true, size: 18, color: COLORS.ink }),
        ],
      }),
      ...(note?.trim()
        ? [
            new Paragraph({
              children: [
                new TextRun({
                  text: clip(note, 600),
                  size: 15,
                  color: COLORS.slate,
                }),
              ],
            }),
          ]
        : []),
    ],
  });
}

function cell(
  value: string,
  bold = false,
  fill: string = COLORS.white,
  color: string = COLORS.ink,
): TableCell {
  return new TableCell({
    borders: CELL_BORDERS,
    shading: { type: ShadingType.CLEAR, fill, color: "auto" },
    margins: { top: 90, bottom: 90, left: 100, right: 100 },
    children: [
      new Paragraph({
        children: [new TextRun({ text: value, bold, size: 17, color })],
      }),
    ],
  });
}

function healthNarrative(snapshot: ExecutiveReportSnapshot): string {
  const parts = [
    `${snapshot.health.ownedNodes}/${snapshot.health.totalNodes} steps assigned`,
    `${snapshot.health.groundedGates}/${snapshot.health.totalGates} gates grounded`,
    `${snapshot.health.overdueNodes} overdue`,
  ];
  return `Current plan health reflects ${parts.join(", ")}. The score is deterministic and based on ownership, evidence grounding, and timeliness.`;
}
