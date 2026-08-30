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
  contextItems,
  criticalNodes,
  dateRange,
  decisionsAndRisks,
  evidenceItems,
  executiveSummary,
  focusAreas,
  formatDate,
  kindLabel,
  leadershipAgenda,
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
  ReportNarrativeItem,
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
    const workingPlanNodes = internalWorkingPlanNodes(snapshot);
    const deliverySnapshot =
      workingPlanNodes.length > 0
        ? {
            ...snapshot,
            nodes: snapshot.nodes.filter(
              (node) =>
                !workingPlanNodes.some((working) => working.id === node.id),
            ),
          }
        : snapshot;
    const children: Array<Paragraph | Table> = [];
    children.push(...cover(snapshot, logo));
    children.push(new Paragraph({ children: [new PageBreak()] }));

    children.push(sectionHeading("Executive brief"));
    for (const line of executiveSummary(snapshot))
      children.push(bodyParagraph(line));

    children.push(subheading("Strategy at a glance"));
    children.push(
      twoColumnFacts([
        ["Strategy", snapshot.strategy.title],
        ["Client", snapshot.client.name],
        ["Strategy type", strategyTypeLabel(snapshot.strategy.type)],
        ["Accountable lead", snapshot.strategy.ownerName],
        ["Target date", formatDate(snapshot.strategy.targetDate)],
        ["Plan as of", formatDate(snapshot.asOf)],
        [
          "Report scope",
          snapshot.options.audience === "client"
            ? `${snapshot.inclusion.includedNodes} reviewed delivery step${snapshot.inclusion.includedNodes === 1 ? "" : "s"}`
            : workingPlanNodes.length > 0
              ? `${deliverySnapshot.nodes.length} committed · ${workingPlanNodes.length} pending review`
              : `${snapshot.inclusion.includedNodes} of ${snapshot.inclusion.liveNodes} live plan steps`,
        ],
      ]),
    );
    if (
      snapshot.options.audience === "internal" &&
      snapshot.inclusion.omittedNodes > 0
    ) {
      children.push(
        mutedParagraph(
          `${snapshot.inclusion.omittedNodes} live plan step${snapshot.inclusion.omittedNodes === 1 ? " is" : "s are"} outside this ${snapshot.options.audience}-audience report because of review status or content quality.`,
        ),
      );
    }

    children.push(
      callout(
        `Delivery readiness · ${snapshot.health.label} · ${snapshot.health.score}/100`,
        healthNarrative(snapshot),
        snapshot.health.score >= 80
          ? COLORS.teal
          : snapshot.health.score >= 60
            ? COLORS.gold
            : COLORS.red,
      ),
    );
    children.push(healthTable(snapshot));
    if (workingPlanNodes.length > 0) {
      children.push(
        mutedParagraph(
          "Internal delivery readiness includes committed and working-plan items; the review queue is separated below and is not represented as committed delivery.",
        ),
      );
    }

    const agenda = leadershipAgenda(deliverySnapshot);
    if (agenda.length > 0) {
      children.push(subheading("Leadership agenda"));
      children.push(leadershipAgendaTable(agenda));
    }

    children.push(sectionHeading("Objectives, outcomes, and primary ask"));
    const outcomeItems = contextItems(snapshot, ["outcomes"]);
    const askItems = contextItems(snapshot, ["ask"]);
    if (snapshot.strategy.goal) {
      children.push(subheading("Objective"));
      children.push(bodyParagraph(snapshot.strategy.goal));
    }
    appendNarrative(
      children,
      "Approved outcomes and definition of success",
      outcomeItems,
    );
    appendNarrative(children, "Primary ask and strategic options", askItems);
    if (
      !snapshot.strategy.goal &&
      outcomeItems.length === 0 &&
      askItems.length === 0
    ) {
      children.push(
        mutedParagraph(
          "No approved objective, outcome criteria, or primary ask is available in the current report snapshot.",
        ),
      );
    }

    const situationItems = contextItems(snapshot, ["situation", "timing"]);
    const constraintItems = contextItems(snapshot, ["constraints"]);
    const stakeholderItems = contextItems(snapshot, ["stakeholders"]);
    const intelligenceItems = contextItems(snapshot, ["intelligence"]);
    const stakeholderNodes = deliverySnapshot.nodes.filter(
      (node) => node.targetLabel,
    );
    const hasClientProfile = Boolean(
      snapshot.client.profile &&
      (snapshot.client.profile.description ||
        snapshot.client.profile.productDescription ||
        snapshot.client.profile.profileType ||
        snapshot.client.profile.sectorTag ||
        snapshot.client.profile.website),
    );
    if (
      hasClientProfile ||
      situationItems.length > 0 ||
      constraintItems.length > 0 ||
      stakeholderItems.length > 0 ||
      stakeholderNodes.length > 0 ||
      intelligenceItems.length > 0
    ) {
      children.push(sectionHeading("Situation and operating context"));
      if (hasClientProfile) appendClientContext(children, snapshot);
      appendNarrative(children, "Current situation and timing", situationItems);
      appendNarrative(
        children,
        "Constraints and sensitivities",
        constraintItems,
      );
      appendNarrative(children, "Stakeholder path", stakeholderItems);
      if (stakeholderNodes.length > 0) {
        children.push(subheading("Stakeholder assignments"));
        children.push(stakeholderPathTable(stakeholderNodes));
      }
      appendNarrative(children, "Recent intelligence", intelligenceItems);
    }

    const areas = focusAreas(deliverySnapshot);
    if (areas.length > 0) {
      children.push(sectionHeading("Plan focus areas"));
      for (const area of areas) {
        children.push(subheading(`${area.title} · ${area.nodes.length} steps`));
        children.push(focusAreaDescription(area.description));
        const displayed = area.nodes.slice(0, 4);
        for (const node of displayed) children.push(nodeBullet(snapshot, node));
        if (displayed.length < area.nodes.length) {
          children.push(
            mutedParagraph(
              `Showing ${displayed.length} of ${area.nodes.length} steps in this focus area; every step appears in the complete action register.`,
            ),
          );
        }
      }
    }

    if (workingPlanNodes.length > 0) {
      children.push(sectionHeading("Working-plan review queue"));
      children.push(
        bodyParagraph(
          "The following Suggested, Draft, and Internal review items remain working material. They require review before they are treated as committed delivery.",
        ),
      );
      children.push(actionRegisterTable(snapshot, workingPlanNodes));
    }

    children.push(sectionHeading("Leadership priorities"));
    const leadershipPriorities = criticalNodes(deliverySnapshot);
    children.push(
      nodeTable(
        snapshot,
        leadershipPriorities,
        "No plan priorities are available.",
      ),
    );
    if (leadershipPriorities.length < deliverySnapshot.nodes.length) {
      children.push(
        mutedParagraph(
          `Showing the ${leadershipPriorities.length} highest-priority steps from ${deliverySnapshot.nodes.length} committed plan steps.`,
        ),
      );
    }

    const risksAndDecisions = decisionsAndRisks(deliverySnapshot);
    const decisionContext = contextItems(snapshot, ["decisions"]);
    if (risksAndDecisions.length > 0 || decisionContext.length > 0) {
      children.push(sectionHeading("Decision agenda and risk response"));
      appendNarrative(children, "Approved decision context", decisionContext);
      const decisions = risksAndDecisions.filter(
        (node) => node.kind === "decision",
      );
      const risks = risksAndDecisions.filter((node) => node.kind === "risk");
      if (decisions.length > 0) {
        children.push(subheading("Decision points"));
        children.push(nodeTable(snapshot, decisions, ""));
      }
      if (risks.length > 0) {
        children.push(subheading("Risks and response ownership"));
        children.push(nodeTable(snapshot, risks, ""));
        if (
          snapshot.options.audience === "client" &&
          !snapshot.options.includeInternalNotes
        ) {
          children.push(
            mutedParagraph(
              "Risk response detail is shown only when it is recorded in approved client-safe context; the exporter does not infer mitigations.",
            ),
          );
        }
      }
    }

    if (snapshot.options.includeRoadmap) {
      children.push(sectionHeading("Delivery roadmap"));
      const roadmapGroups = roadmap(deliverySnapshot);
      for (const group of roadmapGroups.filter(
        (entry) => entry.nodes.length > 0,
      )) {
        children.push(subheading(group.label));
        for (const node of group.nodes)
          children.push(nodeBullet(snapshot, node));
      }
      if (
        snapshot.firmPhases.length > 0 ||
        snapshot.referenceWindows.length > 0
      ) {
        children.push(subheading("Planning calendar context"));
        const displayedPhases = snapshot.firmPhases;
        for (const phase of displayedPhases) {
          children.push(
            bulletParagraph(
              `${phase.label}: FY${phase.startFy} Q${phase.startQ} – FY${phase.endFy} Q${phase.endQ}`,
            ),
          );
        }
        const displayedWindows = relevantReferenceWindows(snapshot);
        for (const window of displayedWindows) {
          const timing = window.fy
            ? `FY${window.fy}`
            : window.startsOn
              ? `${formatDate(window.startsOn)}${window.endsOn ? ` – ${formatDate(window.endsOn)}` : ""}`
              : "Current";
          children.push(bulletParagraph(`${window.label}: ${timing}`));
        }
        if (
          displayedWindows.length > 0 &&
          displayedWindows.length < snapshot.referenceWindows.length
        ) {
          children.push(
            mutedParagraph(
              `Showing ${displayedWindows.length} of ${snapshot.referenceWindows.length} reference windows that intersect the report horizon.`,
            ),
          );
        }
      }
    }

    if (deliverySnapshot.nodes.length >= 6) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
    children.push(
      sectionHeading(
        workingPlanNodes.length > 0
          ? "Committed delivery register"
          : "Complete action register",
      ),
    );
    children.push(
      deliverySnapshot.nodes.length > 0
        ? actionRegisterTable(snapshot, deliverySnapshot.nodes)
        : bodyParagraph("No committed delivery steps are available."),
    );
    const unassignedDelivery = deliverySnapshot.nodes.filter(
      (node) => !node.ownerAssigned,
    ).length;
    if (unassignedDelivery > 0) {
      children.push(
        mutedParagraph(
          `${unassignedDelivery} committed plan step${unassignedDelivery === 1 ? " remains" : "s remain"} unassigned.`,
        ),
      );
    }

    const evidence = evidenceItems(snapshot);
    const grounded = deliverySnapshot.nodes.filter(
      (node) => node.sources.length > 0,
    );
    const hasEvidenceAppendix =
      snapshot.options.includeEvidenceAppendix &&
      (evidence.length > 0 ||
        grounded.length > 0 ||
        snapshot.artifacts.length > 0 ||
        snapshot.context.documents.length > 0);
    if (hasEvidenceAppendix) {
      // No forced PageBreak here: an unconditional break right after a table
      // that already lands near a page boundary (e.g. a large working-plan
      // queue pushing the delivery register onto a near-full page) can
      // render as a fully blank page in Word/LibreOffice — reproduced with a
      // 20-node/17-suggested-item strategy. Every other section transition in
      // this document already flows naturally without a forced break; this
      // one now matches that pattern instead of risking a blank page.
      children.push(sectionHeading("Evidence and context source register"));
      if (evidence.length > 0) {
        children.push(subheading("Approved evidence and facts"));
        children.push(evidenceTable(evidence));
      }
      if (grounded.length > 0) {
        children.push(subheading("Evidence linked to plan steps"));
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
      if (snapshot.context.documents.length > 0) {
        children.push(subheading("Context source register"));
        children.push(contextSourceTable(snapshot));
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
      description:
        snapshot.options.audience === "client"
          ? `Executive strategy report prepared for ${snapshot.client.name}`
          : `Generated from strategy snapshot ${snapshot.snapshotHash.slice(0, 12)}`,
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

function focusAreaDescription(text: string): Paragraph {
  return new Paragraph({
    keepNext: true,
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

function appendClientContext(
  children: Array<Paragraph | Table>,
  snapshot: ExecutiveReportSnapshot,
): void {
  const profile = snapshot.client.profile;
  if (!profile) return;
  children.push(subheading("Client context"));
  const descriptors: Array<[string, string]> = [];
  if (profile.profileType) descriptors.push(["Profile", profile.profileType]);
  if (profile.sectorTag) descriptors.push(["Sector", profile.sectorTag]);
  if (profile.website) descriptors.push(["Website", profile.website]);
  if (descriptors.length > 0) children.push(twoColumnFacts(descriptors));
  if (profile.description) {
    children.push(
      labeledParagraph("Organization", clip(profile.description, 900)),
    );
  }
  if (profile.productDescription) {
    children.push(
      labeledParagraph(
        "Product or program context",
        clip(profile.productDescription, 900),
      ),
    );
  }
}

function appendNarrative(
  children: Array<Paragraph | Table>,
  title: string,
  items: readonly ReportNarrativeItem[],
): void {
  if (items.length === 0) return;
  children.push(subheading(title));
  for (const item of items) {
    children.push(narrativeParagraph(item));
    children.push(narrativeSourceParagraph(item));
  }
}

function labeledParagraph(label: string, text: string): Paragraph {
  return new Paragraph({
    keepNext: false,
    children: [
      new TextRun({
        text: `${label}: `,
        bold: true,
        size: 20,
        color: COLORS.blue,
      }),
      new TextRun({ text, size: 20, color: COLORS.ink }),
    ],
  });
}

function narrativeParagraph(item: ReportNarrativeItem): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    keepNext: true,
    spacing: { after: 30 },
    children: [
      ...(item.label
        ? [
            new TextRun({
              text: `${item.label}: `,
              bold: true,
              size: 19,
              color: COLORS.blue,
            }),
          ]
        : []),
      new TextRun({ text: item.text, size: 19, color: COLORS.ink }),
    ],
  });
}

function narrativeSourceParagraph(item: ReportNarrativeItem): Paragraph {
  const details = [
    item.sourceTitle,
    item.asOf ? `as of ${formatDate(item.asOf)}` : null,
    item.authority ? kindLabel(item.authority) : null,
    item.confidence === null
      ? null
      : `${Math.round(item.confidence * 100)}% confidence`,
  ].filter((part): part is string => Boolean(part));
  return new Paragraph({
    indent: { left: 360 },
    spacing: { after: 100 },
    children: [
      new TextRun({
        text: `Source: ${details.join(" · ")}`,
        size: 14,
        color: COLORS.slate,
        italics: true,
      }),
    ],
  });
}

function leadershipAgendaTable(
  items: ReturnType<typeof leadershipAgenda>,
): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      headerRow(["Leadership action", "Owner / timing"]),
      ...items.map(
        (item, index) =>
          new TableRow({
            cantSplit: true,
            children: [
              richCell(item.title, kindLabel(item.tone)),
              cell(
                item.detail,
                false,
                index % 2 === 0 ? COLORS.pale : COLORS.white,
              ),
            ],
          }),
      ),
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

function actionRegisterTable(
  snapshot: ExecutiveReportSnapshot,
  nodes: readonly ReportNode[] = snapshot.nodes,
): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      headerRow([
        "Plan step",
        "Type / status",
        "Owner",
        "Timing",
        "Stakeholder / target",
      ]),
      ...nodes.map(
        (node) =>
          new TableRow({
            cantSplit: true,
            children: [
              richCell(
                node.title,
                snapshot.options.includeInternalNotes ? node.note : null,
              ),
              cell(`${kindLabel(node.kind)} · ${statusLabel(node.status)}`),
              cell(node.ownerName),
              cell(dateRange(node)),
              cell(node.targetLabel ?? "—"),
            ],
          }),
      ),
    ],
  });
}

function stakeholderPathTable(nodes: readonly ReportNode[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      headerRow(["Stakeholder / target", "Plan step", "Owner", "Timing"]),
      ...nodes.map(
        (node) =>
          new TableRow({
            cantSplit: true,
            children: [
              cell(node.targetLabel ?? "—", true),
              cell(node.title),
              cell(node.ownerName),
              cell(dateRange(node)),
            ],
          }),
      ),
    ],
  });
}

function evidenceTable(items: ReturnType<typeof evidenceItems>): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      headerRow(["Evidence or approved fact", "Source", "As of", "Confidence"]),
      ...items.map(
        (item) =>
          new TableRow({
            cantSplit: true,
            children: [
              richCell(item.text, null),
              cell(item.source),
              cell(formatDate(item.asOf)),
              cell(
                item.confidence === null
                  ? "Not stated"
                  : `${Math.round(item.confidence * 100)}%`,
              ),
            ],
          }),
      ),
    ],
  });
}

function contextSourceTable(snapshot: ExecutiveReportSnapshot): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      headerRow([
        "Source",
        "Context type",
        "Authority",
        "As of / review",
        "Highlights",
      ]),
      ...snapshot.context.documents.map(
        (document) =>
          new TableRow({
            cantSplit: true,
            children: [
              cell(document.title),
              cell(kindLabel(document.templateKey.replace(/^\d+_/, ""))),
              cell(
                document.authority
                  ? kindLabel(document.authority)
                  : "Not stated",
              ),
              cell(
                [
                  document.asOf ? `As of ${formatDate(document.asOf)}` : null,
                  document.validUntil
                    ? `Review by ${formatDate(document.validUntil)}`
                    : null,
                ]
                  .filter((part): part is string => Boolean(part))
                  .join(" · ") || "Not stated",
              ),
              cell(String(document.highlightCount)),
            ],
          }),
      ),
    ],
  });
}

function relevantReferenceWindows(
  snapshot: ExecutiveReportSnapshot,
): ExecutiveReportSnapshot["referenceWindows"] {
  const asOf = Date.parse(`${snapshot.asOf}T00:00:00.000Z`);
  if (!Number.isFinite(asOf)) return snapshot.referenceWindows;
  const fallbackEnd = asOf + 180 * 86_400_000;
  const target = snapshot.strategy.targetDate
    ? Date.parse(`${snapshot.strategy.targetDate}T00:00:00.000Z`)
    : Number.NaN;
  const horizonEnd = Number.isFinite(target)
    ? Math.max(fallbackEnd, target)
    : fallbackEnd;
  const horizonStart = asOf - 30 * 86_400_000;
  const fiscalYears = new Set<number>();
  for (
    let year = federalFiscalYear(horizonStart);
    year <= federalFiscalYear(horizonEnd);
    year++
  ) {
    fiscalYears.add(year);
  }
  return snapshot.referenceWindows.filter((window) => {
    if (window.fy !== null) return fiscalYears.has(window.fy);
    const starts = window.startsOn
      ? Date.parse(`${window.startsOn}T00:00:00.000Z`)
      : Number.NaN;
    const ends = window.endsOn
      ? Date.parse(`${window.endsOn}T00:00:00.000Z`)
      : starts;
    if (!Number.isFinite(starts) && !Number.isFinite(ends)) return false;
    const normalizedStart = Number.isFinite(starts) ? starts : ends;
    const normalizedEnd = Number.isFinite(ends) ? ends : starts;
    return normalizedStart <= horizonEnd && normalizedEnd >= horizonStart;
  });
}

function internalWorkingPlanNodes(
  snapshot: ExecutiveReportSnapshot,
): ReportNode[] {
  if (snapshot.options.audience !== "internal") return [];
  const workingStatuses = new Set(["suggested", "draft", "internal_review"]);
  return snapshot.nodes.filter((node) => workingStatuses.has(node.status));
}

function federalFiscalYear(value: number): number {
  const date = new Date(value);
  return date.getUTCFullYear() + (date.getUTCMonth() >= 9 ? 1 : 0);
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
