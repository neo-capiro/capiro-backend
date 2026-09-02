import { Injectable } from "@nestjs/common";
import PptxGenJS from "pptxgenjs";
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
  roadmap,
  statusLabel,
  strategyTypeLabel,
} from "./report-content.js";
import { containBox, readRasterSize } from "./report-image.js";
import {
  narrativeSection,
  type VerifiedNarrativeParagraph,
  type VerifiedReportNarrative,
} from "./report-narrative.types.js";
import { ooxmlSafeValue } from "./report-text.js";
import {
  buildTimelineModel,
  timelineHorizonLabel,
  type TimelineModel,
} from "./report-timeline.js";
import type {
  ClientLogoAsset,
  ExecutiveReportSnapshot,
  ReportMemberDetail,
  ReportNarrativeItem,
  ReportNode,
  ReportRasterAsset,
  ReportRenderExtras,
} from "./report.types.js";

type Slide = ReturnType<PptxGenJS["addSlide"]>;

interface DisplayItem {
  text: string;
  detail?: string;
}

interface SourceRegisterEntry {
  section: string;
  text: string;
  source: string;
  detail: string;
}

const C = {
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
  green: "18794E",
} as const;

const TIMELINE_ROWS_PER_SLIDE = 7;
const MEMBER_CARDS_PER_SLIDE = 3;
const TIMELINE_TONES: Record<ReportNode["kind"], string> = {
  action: C.teal,
  decision: C.blue,
  gate: C.gold,
  milestone: C.gold,
  risk: C.red,
};

@Injectable()
export class PptxReportRenderer {
  async render(
    snapshot: ExecutiveReportSnapshot,
    logo: ClientLogoAsset | null,
    extras: ReportRenderExtras = {},
  ): Promise<Buffer> {
    // Defense in depth for direct renderer callers outside snapshot loading.
    snapshot = ooxmlSafeValue(snapshot);
    const narrative = extras.narrative
      ? ooxmlSafeValue(extras.narrative)
      : null;
    const memberDetails = (extras.memberDetails ?? [])
      .map((detail) => ooxmlSafeValue(detail))
      .filter((detail) =>
        snapshot.members.some((member) => member.memberId === detail.memberId),
      );
    const memberPhotos =
      extras.memberPhotos ?? new Map<string, ReportRasterAsset>();
    const prose = (id: Parameters<typeof narrativeSection>[1]) =>
      narrativeSection(narrative, id);
    const workingPlanNodes = internalWorkingPlanNodes(snapshot);
    const deliverySnapshot: ExecutiveReportSnapshot =
      workingPlanNodes.length > 0
        ? {
            ...snapshot,
            nodes: snapshot.nodes.filter(
              (node) =>
                !workingPlanNodes.some((working) => working.id === node.id),
            ),
          }
        : snapshot;
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    pptx.author = "Capiro";
    pptx.company = "Capiro";
    pptx.subject = `Executive strategy report for ${snapshot.client.name}`;
    pptx.title = `${snapshot.strategy.title} — Executive Strategy Report`;
    pptx.theme = {
      headFontFace: "Aptos Display",
      bodyFontFace: "Aptos",
    };

    let slideNumber = 0;
    const nextSlide = (title: string, kicker?: string): Slide => {
      const slide = pptx.addSlide();
      slideNumber += 1;
      slide.background = { color: C.white };
      slide.addShape(pptx.ShapeType.rect, {
        x: 0,
        y: 0,
        w: 0.18,
        h: 7.5,
        fill: { color: C.teal },
        line: { color: C.teal },
      });
      if (kicker) {
        slide.addText(kicker.toUpperCase(), {
          x: 0.65,
          y: 0.32,
          w: 7.7,
          h: 0.22,
          fontFace: "Aptos",
          fontSize: 9,
          bold: true,
          charSpacing: 1.5,
          color: C.teal,
          margin: 0,
        });
      }
      const titleFontSize =
        title.length > 34 ? 27 : title.length > 28 ? 29 : 32;
      slide.addText(title, {
        x: 0.65,
        y: kicker ? 0.62 : 0.42,
        w: 12.0,
        h: 0.52,
        fontFace: "Aptos Display",
        fontSize: titleFontSize,
        bold: true,
        color: C.navy,
        margin: 0,
        fit: "shrink",
      });
      slide.addShape(pptx.ShapeType.line, {
        x: 0.65,
        y: 1.22,
        w: 12.0,
        h: 0,
        line: { color: C.line, width: 1 },
      });
      addFooter(slide, snapshot, slideNumber);
      slide.addNotes(sourceNote(snapshot, title));
      return slide;
    };
    const sourceRegister = buildSourceRegister(snapshot);

    // Cover
    const cover = pptx.addSlide();
    slideNumber += 1;
    cover.background = { color: C.navy };
    cover.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 0.22,
      h: 7.5,
      fill: { color: C.gold },
      line: { color: C.gold },
    });
    cover.addText("EXECUTIVE STRATEGY REPORT", {
      x: 0.75,
      y: 0.72,
      w: 5.8,
      h: 0.3,
      fontSize: 11,
      bold: true,
      charSpacing: 2.4,
      color: "7ED0CE",
      margin: 0,
    });
    const coverTitleSize =
      snapshot.strategy.title.length > 88
        ? 34
        : snapshot.strategy.title.length > 60
          ? 38
          : 44;
    cover.addText(clip(snapshot.strategy.title, 120), {
      x: 0.75,
      y: 1.22,
      w: 8.1,
      h: 2.48,
      fontFace: "Aptos Display",
      fontSize: coverTitleSize,
      bold: true,
      color: C.white,
      breakLine: false,
      valign: "middle",
      margin: 0,
      fit: "shrink",
    });
    cover.addText(
      `${strategyTypeLabel(snapshot.strategy.type)} · ${snapshot.client.name}`,
      {
        x: 0.75,
        y: 4.05,
        w: 7.8,
        h: 0.42,
        fontSize: 18,
        color: C.mist,
        margin: 0,
        fit: "shrink",
      },
    );
    cover.addText(`Plan as of ${formatDate(snapshot.asOf)}`, {
      x: 0.75,
      y: 5.55,
      w: 4.2,
      h: 0.32,
      fontSize: 12,
      bold: true,
      color: C.white,
      margin: 0,
    });
    cover.addText(
      snapshot.options.audience === "client"
        ? "CONFIDENTIAL · CLIENT DISCUSSION DRAFT"
        : "CONFIDENTIAL · INTERNAL WORKING DRAFT",
      {
        x: 0.75,
        y: 6.15,
        w: 5.8,
        h: 0.25,
        fontSize: 9,
        bold: true,
        charSpacing: 1.2,
        color: "9FB3C8",
        margin: 0,
      },
    );
    addLogo(
      pptx,
      cover,
      logo,
      snapshot.client.name,
      { x: 9.55, y: 0.78, w: 2.75, h: 1.2 },
      true,
    );
    cover.addNotes(sourceNote(snapshot));

    // Leadership summary
    const executiveProse = prose("executive_summary");
    {
      const slide = nextSlide("Leadership summary", "Current posture");
      const summary = executiveSummary(snapshot);
      const lead = executiveProse[0]?.text ?? summary[0] ?? "";
      slide.addText(clip(lead, executiveProse.length ? 520 : 340), {
        x: 0.72,
        y: 1.55,
        w: 7.3,
        h: 2.1,
        fontSize: executiveProse.length ? 15.5 : 18,
        color: C.ink,
        breakLine: false,
        valign: "top",
        margin: 0,
        paraSpaceAfter: 10,
        fit: "shrink",
      });
      addHealthCard(pptx, slide, snapshot, 8.45, 1.5, 4.1, 2.15);
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.72,
        y: 3.94,
        w: 11.84,
        h: 0.9,
        fill: { color: C.pale },
        line: { color: C.line, width: 1 },
      });
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.72,
        y: 3.94,
        w: 0.1,
        h: 0.9,
        fill: { color: C.teal },
        line: { color: C.teal },
      });
      slide.addText("OBJECTIVE", {
        x: 0.98,
        y: 4.16,
        w: 1.12,
        h: 0.2,
        fontSize: 9,
        bold: true,
        charSpacing: 1.3,
        color: C.teal,
        margin: 0,
      });
      slide.addText(
        clip(
          snapshot.strategy.goal ?? "No explicit objective is recorded.",
          180,
        ),
        {
          x: 2.05,
          y: 4.08,
          w: 10.05,
          h: 0.5,
          fontSize: 14,
          color: C.ink,
          margin: 0,
          valign: "middle",
          fit: "shrink",
        },
      );
      const focus = criticalNodes(deliverySnapshot, 2);
      slide.addText(
        focus.length < deliverySnapshot.nodes.length
          ? `IMMEDIATE FOCUS · ${focus.length} OF ${deliverySnapshot.nodes.length}`
          : "IMMEDIATE FOCUS",
        {
          x: 0.72,
          y: 5.18,
          w: 3,
          h: 0.24,
          fontSize: 9,
          bold: true,
          charSpacing: 1.5,
          color: C.teal,
          margin: 0,
        },
      );
      addBullets(
        slide,
        focus.map(
          (node) => `${clip(node.title, 64)} — ${clip(node.ownerName, 28)}`,
        ),
        {
          x: 0.72,
          y: 5.52,
          w: 11.75,
          h: 1.05,
          fontSize: 15.5,
        },
      );
      if (focus.length < deliverySnapshot.nodes.length) {
        slide.addText("Complete action register in appendix", {
          x: 9.15,
          y: 5.18,
          w: 3.3,
          h: 0.22,
          fontSize: 9,
          italic: true,
          align: "right",
          color: C.slate,
          margin: 0,
        });
      }
      if (snapshot.options.audience === "internal") {
        const workingPlanCount = workingPlanNodes.length;
        if (workingPlanCount > 0) {
          slide.addText(
            `WORKING PLAN · ${workingPlanCount} suggested, draft, or review item${workingPlanCount === 1 ? "" : "s"} included for internal review — not committed client delivery`,
            {
              x: 0.72,
              y: 6.72,
              w: 11.75,
              h: 0.18,
              fontSize: 8.5,
              bold: true,
              color: C.gold,
              margin: 0,
              fit: "shrink",
            },
          );
        }
      }
    }

    // Executive narrative (grounded prose beyond the lead paragraph)
    if (executiveProse.length > 1) {
      const slide = nextSlide("Executive narrative", "The story of the plan");
      addProseColumns(pptx, slide, executiveProse.slice(1, 4), {
        x: 0.72,
        y: 1.52,
        w: 11.85,
        h: 4.95,
        accent: C.teal,
      });
    }

    // Situation and stakes
    {
      const narrativeItems = contextItems(snapshot, [
        "situation",
        "intelligence",
        "timing",
      ]);
      const profile = snapshot.client.profile;
      const profileContext = [
        profile?.description,
        profile?.productDescription,
      ].filter((value): value is string => Boolean(value?.trim()));
      const situation: DisplayItem[] = [
        ...profileContext.map((text) => ({
          text,
          detail: [profile?.sectorTag, profile?.profileType]
            .filter(Boolean)
            .join(" · "),
        })),
        ...narrativeItems.map(narrativeDisplayItem),
      ];
      const situationProse = prose("situation");
      const slide = nextSlide(
        "Situation and stakes",
        situationProse.length
          ? "What shapes the strategy"
          : situation.length > 4
            ? `What shapes the strategy · Showing 4 of ${situation.length} context points`
            : "What shapes the strategy",
      );
      if (situationProse.length) {
        addProsePanel(pptx, slide, "STRATEGIC CONTEXT", situationProse, {
          x: 0.72,
          y: 1.52,
          w: 7.35,
          h: 4.95,
          accent: C.teal,
        });
      } else {
        addTextPanel(
          pptx,
          slide,
          situation.length > 4
            ? `STRATEGIC CONTEXT · 4 OF ${situation.length}`
            : "STRATEGIC CONTEXT",
          situation.slice(0, 4),
          {
            x: 0.72,
            y: 1.52,
            w: 7.35,
            h: 4.95,
            accent: C.teal,
            empty:
              "No audience-safe situation narrative is recorded; the operating signals at right reflect the stored plan only.",
          },
        );
      }
      addSignalPanel(pptx, slide, snapshot, 8.32, 1.52, 4.25, 4.95);
    }

    // Objective, leadership ask, and success definition
    {
      const asks = contextItems(snapshot, ["ask", "decisions"]);
      const outcomes = contextItems(snapshot, ["outcomes"]);
      const objectivesProse = prose("objectives_and_ask");
      const decisionFallback = decisionsAndRisks(deliverySnapshot)
        .filter((node) => node.kind === "decision")
        .map(nodeDisplayItem);
      const outcomeFallback = deliverySnapshot.nodes
        .filter((node) => node.kind === "gate" || node.kind === "milestone")
        .map(nodeDisplayItem);
      const askItems = asks.length
        ? asks.map(narrativeDisplayItem)
        : decisionFallback;
      const successItems = outcomes.length
        ? outcomes.map(narrativeDisplayItem)
        : outcomeFallback;
      const slide = nextSlide(
        "Objective, ask and success",
        "What leadership is aligning around",
      );
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.72,
        y: 1.5,
        w: 11.85,
        h: 1.34,
        fill: { color: C.navy },
        line: { color: C.navy },
      });
      slide.addText("OBJECTIVE", {
        x: 1.0,
        y: 1.78,
        w: 1.35,
        h: 0.22,
        fontSize: 9,
        bold: true,
        charSpacing: 1.4,
        color: "7ED0CE",
        margin: 0,
      });
      slide.addText(
        snapshot.strategy.goal?.trim() ||
          "No explicit strategy objective is recorded.",
        {
          x: 2.25,
          y: 1.68,
          w: 9.9,
          h: 0.74,
          fontSize: 18,
          bold: true,
          color: C.white,
          margin: 0,
          valign: "middle",
          fit: "shrink",
        },
      );
      if (objectivesProse.length) {
        addProsePanel(pptx, slide, "OUTCOMES AND THE ASK", objectivesProse, {
          x: 0.72,
          y: 3.12,
          w: 5.78,
          h: 3.28,
          accent: C.gold,
        });
      } else {
        addTextPanel(
          pptx,
          slide,
          askItems.length > 3
            ? `LEADERSHIP ASK · 3 OF ${askItems.length}`
            : "LEADERSHIP ASK",
          askItems.slice(0, 3),
          {
            x: 0.72,
            y: 3.12,
            w: 5.78,
            h: 3.28,
            accent: C.gold,
            empty: "No explicit leadership ask or decision is recorded.",
          },
        );
      }
      addTextPanel(
        pptx,
        slide,
        successItems.length > 3
          ? `SUCCESS LOOKS LIKE · 3 OF ${successItems.length}`
          : "SUCCESS LOOKS LIKE",
        successItems.slice(0, 3),
        {
          x: 6.76,
          y: 3.12,
          w: 5.81,
          h: 3.28,
          accent: C.green,
          empty: "No explicit outcome or success criterion is recorded.",
        },
      );
    }

    // Strategic focus areas
    {
      const defined = focusAreas(deliverySnapshot);
      const covered = new Set(
        defined.flatMap((area) => area.nodes.map((node) => node.id)),
      );
      const remaining = deliverySnapshot.nodes.filter(
        (node) => !covered.has(node.id),
      );
      const areas = [
        ...defined,
        ...(remaining.length
          ? [
              {
                title: "Other execution priorities",
                description:
                  "Additional included work that supports delivery of the strategy.",
                nodes: remaining,
              },
            ]
          : []),
      ];
      const shown = areas.slice(0, 4);
      const slide = nextSlide(
        "Strategic focus areas",
        areas.length > shown.length
          ? `How the work fits together · Showing ${shown.length} of ${areas.length} areas`
          : "How the work fits together",
      );
      shown.forEach((area, index) =>
        addFocusAreaCard(pptx, slide, area, index),
      );
      if (shown.length === 0) {
        slide.addText("No focus areas can be formed from the current plan.", {
          x: 0.9,
          y: 2.0,
          w: 11.0,
          h: 0.5,
          fontSize: 19,
          italic: true,
          color: C.slate,
          margin: 0,
        });
      }
      slide.addText(
        `${deliverySnapshot.nodes.length} included plan step${deliverySnapshot.nodes.length === 1 ? "" : "s"} · Complete action register in appendix`,
        {
          x: 0.75,
          y: 6.62,
          w: 11.7,
          h: 0.22,
          fontSize: 9.5,
          italic: true,
          align: "right",
          color: C.slate,
          margin: 0,
        },
      );
    }

    // Health
    {
      const slide = nextSlide(
        "Plan health and delivery confidence",
        "Deterministic assessment",
      );
      const metrics: Array<[string, number, string]> = [
        [
          "Ownership",
          snapshot.health.coveragePct,
          `${snapshot.health.ownedNodes}/${snapshot.health.totalNodes} steps assigned`,
        ],
        [
          "Evidence grounding",
          snapshot.health.groundingPct,
          `${snapshot.health.groundedGates}/${snapshot.health.totalGates} gates grounded`,
        ],
        [
          "Timeliness",
          snapshot.health.timelinessPct,
          `${snapshot.health.overdueNodes} steps overdue`,
        ],
      ];
      slide.addText(String(snapshot.health.score), {
        x: 0.82,
        y: 1.68,
        w: 2.15,
        h: 1.15,
        fontSize: 51,
        bold: true,
        align: "center",
        color: healthColor(snapshot.health.score),
        margin: 0,
      });
      slide.addText(`${snapshot.health.label}\nOVERALL HEALTH`, {
        x: 0.82,
        y: 2.82,
        w: 2.15,
        h: 0.72,
        fontSize: 12,
        bold: true,
        align: "center",
        color: C.slate,
        margin: 0,
        breakLine: false,
      });
      metrics.forEach(([label, value, note], index) => {
        const y = 1.62 + index * 1.43;
        slide.addText(label, {
          x: 3.45,
          y,
          w: 2.4,
          h: 0.3,
          fontSize: 18,
          bold: true,
          color: C.ink,
          margin: 0,
        });
        slide.addText(`${value}%`, {
          x: 10.95,
          y,
          w: 1.1,
          h: 0.3,
          fontSize: 18,
          bold: true,
          align: "right",
          color: healthColor(value),
          margin: 0,
        });
        slide.addShape(pptx.ShapeType.rect, {
          x: 3.45,
          y: y + 0.43,
          w: 8.62,
          h: 0.16,
          fill: { color: C.mist },
          line: { color: C.mist },
        });
        slide.addShape(pptx.ShapeType.rect, {
          x: 3.45,
          y: y + 0.43,
          w: Math.max(0.06, 8.62 * (value / 100)),
          h: 0.16,
          fill: { color: healthColor(value) },
          line: { color: healthColor(value) },
        });
        slide.addText(note, {
          x: 3.45,
          y: y + 0.68,
          w: 8.5,
          h: 0.26,
          fontSize: 12,
          color: C.slate,
          margin: 0,
        });
      });
      slide.addText(
        "Health is calculated from plan ownership (40%), evidence grounding (35%), and timeliness (25%).",
        {
          x: 3.45,
          y: 6.18,
          w: 8.7,
          h: 0.28,
          fontSize: 9.5,
          color: C.slate,
          italic: true,
          margin: 0,
        },
      );
    }

    // Critical moves
    {
      const nodes = criticalNodes(deliverySnapshot, 6);
      const slide = nextSlide(
        "Critical moves",
        nodes.length < deliverySnapshot.nodes.length
          ? `What leadership should track · Showing ${nodes.length} of ${deliverySnapshot.nodes.length}`
          : "What leadership should track",
      );
      nodes.forEach((node, index) =>
        addNodeCard(pptx, slide, snapshot, node, index),
      );
      if (nodes.length < deliverySnapshot.nodes.length) {
        slide.addText("Complete action register in appendix", {
          x: 8.7,
          y: 6.62,
          w: 3.75,
          h: 0.22,
          fontSize: 9.5,
          italic: true,
          align: "right",
          color: C.slate,
          margin: 0,
        });
      }
    }

    if (snapshot.options.includeRoadmap) {
      const roadmapProse = prose("roadmap_outlook");
      const timeline = buildTimelineModel(
        deliverySnapshot,
        deliverySnapshot.nodes,
      );
      if (timeline) {
        const pages = chunk(timeline.rows, TIMELINE_ROWS_PER_SLIDE);
        pages.forEach((rows, pageIndex) => {
          const slide = nextSlide(
            "Delivery timeline",
            pages.length > 1
              ? `${timelineHorizonLabel(timeline)} · Steps ${pageIndex * TIMELINE_ROWS_PER_SLIDE + 1}–${pageIndex * TIMELINE_ROWS_PER_SLIDE + rows.length} of ${timeline.rows.length}`
              : timelineHorizonLabel(timeline),
          );
          addTimelineSlide(
            pptx,
            slide,
            snapshot,
            timeline,
            rows,
            pageIndex === 0 ? (roadmapProse[0]?.text ?? null) : null,
          );
        });
      }
      const groups = roadmap(deliverySnapshot);
      addRoadmapSlide(
        pptx,
        nextSlide("Near-term roadmap", "Now through 60 days"),
        groups.slice(0, 3),
      );
      addRoadmapSlide(
        pptx,
        nextSlide("90-day and longer-range roadmap", "Sustaining momentum"),
        groups.slice(3),
      );
    }

    // Member offices in the plan
    if (memberDetails.length > 0) {
      const pages = chunk(memberDetails, MEMBER_CARDS_PER_SLIDE);
      pages.forEach((details, pageIndex) => {
        const slide = nextSlide(
          "Member offices in the plan",
          pages.length > 1
            ? `Congressional offices targeted by plan steps · ${pageIndex * MEMBER_CARDS_PER_SLIDE + 1}–${pageIndex * MEMBER_CARDS_PER_SLIDE + details.length} of ${memberDetails.length}`
            : "Congressional offices targeted by plan steps",
        );
        details.forEach((detail, index) =>
          addMemberCard(
            pptx,
            slide,
            snapshot,
            detail,
            memberPhotos.get(detail.memberId) ?? null,
            index,
          ),
        );
        slide.addText(
          "Portraits and Washington office details are drawn from the public congressional directory at export time.",
          {
            x: 0.75,
            y: 6.62,
            w: 11.7,
            h: 0.22,
            fontSize: 9.5,
            italic: true,
            align: "right",
            color: C.slate,
            margin: 0,
          },
        );
      });
    }

    // Stakeholders and operating constraints
    {
      const stakeholderProse = prose("stakeholders");
      const constraintProse = prose("constraints_and_timing");
      const stakeholderNarrative = contextItems(snapshot, ["stakeholders"]);
      const stakeholderItems: DisplayItem[] = [
        ...stakeholderNarrative.map(narrativeDisplayItem),
        ...uniqueStrings(
          deliverySnapshot.nodes
            .map((node) => node.targetLabel)
            .filter(isString),
        ).map((target) => ({
          text: target,
          detail: "Named stakeholder or target in the current plan",
        })),
      ];
      const constraintNarrative = contextItems(snapshot, [
        "constraints",
        "timing",
      ]);
      const constraintItems: DisplayItem[] = [
        ...constraintNarrative.map(narrativeDisplayItem),
        ...deliverySnapshot.nodes
          .filter((node) => node.kind === "risk")
          .map((node) => ({
            text: node.title,
            detail: `${node.ownerName} · ${dateRange(node)}`,
          })),
      ];
      const slide = nextSlide(
        "Stakeholders and operating constraints",
        "Who matters and what can shape delivery",
      );
      if (stakeholderProse.length) {
        addProsePanel(pptx, slide, "STAKEHOLDER FOCUS", stakeholderProse, {
          x: 0.72,
          y: 1.52,
          w: 5.78,
          h: 4.95,
          accent: C.blue,
        });
      } else {
        addTextPanel(
          pptx,
          slide,
          stakeholderItems.length > 5
            ? `STAKEHOLDER FOCUS · 5 OF ${stakeholderItems.length}`
            : "STAKEHOLDER FOCUS",
          stakeholderItems.slice(0, 5),
          {
            x: 0.72,
            y: 1.52,
            w: 5.78,
            h: 4.95,
            accent: C.blue,
            empty: "No stakeholder narrative or named targets are recorded.",
          },
        );
      }
      if (constraintProse.length) {
        addProsePanel(pptx, slide, "CONSTRAINTS & TIMING", constraintProse, {
          x: 6.78,
          y: 1.52,
          w: 5.79,
          h: 4.95,
          accent: C.red,
        });
      } else {
        addTextPanel(
          pptx,
          slide,
          constraintItems.length > 5
            ? `CONSTRAINTS & RISKS · 5 OF ${constraintItems.length}`
            : "CONSTRAINTS & RISKS",
          constraintItems.slice(0, 5),
          {
            x: 6.78,
            y: 1.52,
            w: 5.79,
            h: 4.95,
            accent: C.red,
            empty: "No explicit constraint, timing issue, or risk is recorded.",
          },
        );
      }
    }

    // Decisions and risks
    {
      const slide = nextSlide(
        "Decision agenda and risk posture",
        "Leadership attention",
      );
      const decisionProse = prose("decisions_and_risks");
      if (decisionProse.length) {
        // Slide real estate belongs to the register; the grounded framing goes
        // into presenter notes so the speaker has it verbatim.
        slide.addNotes(
          `${decisionProse.map((paragraph) => paragraph.text).join("\n\n")}\n\n${sourceNote(snapshot, "Decision agenda and risk posture")}`,
        );
      }
      const items = decisionsAndRisks(deliverySnapshot);
      const panelLimit = snapshot.options.includeInternalNotes ? 3 : 5;
      const allDecisions = items.filter((node) => node.kind === "decision");
      const allRisks = items.filter((node) => node.kind === "risk");
      const decisions = allDecisions.slice(0, panelLimit);
      const risks = allRisks.slice(0, panelLimit);
      addListPanel(
        pptx,
        slide,
        "DECISIONS",
        decisions,
        snapshot,
        0.72,
        1.55,
        5.9,
        C.blue,
        false,
        allDecisions.length - decisions.length,
      );
      addListPanel(
        pptx,
        slide,
        "RISKS",
        risks,
        snapshot,
        6.78,
        1.55,
        5.82,
        C.red,
        false,
        allRisks.length - risks.length,
      );
    }

    // Accountability
    {
      const allRows = deliverySnapshot.nodes.filter(
        (node) => node.ownerName !== "Unassigned" || node.targetLabel,
      );
      const rows = allRows.slice(0, 7);
      const slide = nextSlide(
        "Accountability and stakeholder focus",
        rows.length < allRows.length
          ? `Who owns what · ${rows.length} of ${allRows.length} priority assignments`
          : "Who owns what",
      );
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.7,
        y: 1.52,
        w: 11.9,
        h: 0.48,
        fill: { color: C.navy },
        line: { color: C.navy },
      });
      addColumns(
        slide,
        ["PLAN STEP", "ACCOUNTABLE OWNER", "STAKEHOLDER / TARGET"],
        1.62,
        C.white,
        true,
      );
      rows.forEach((node, index) => {
        const y = 2.06 + index * 0.62;
        if (index % 2 === 0) {
          slide.addShape(pptx.ShapeType.rect, {
            x: 0.7,
            y: y - 0.06,
            w: 11.9,
            h: 0.56,
            fill: { color: C.pale },
            line: { color: C.pale },
          });
        }
        addColumns(
          slide,
          [
            clip(node.title, 64),
            clip(node.ownerName, 30),
            clip(node.targetLabel ?? "—", 44),
          ],
          y,
          C.ink,
          false,
        );
      });
      if (rows.length === 0) {
        slide.addText(
          "Owners and stakeholder targets have not yet been assigned.",
          {
            x: 0.9,
            y: 2.35,
            w: 10.8,
            h: 0.4,
            fontSize: 18,
            color: C.slate,
            italic: true,
            margin: 0,
          },
        );
      }
      slide.addText(
        `${allRows.length} of ${deliverySnapshot.nodes.length} included steps have an owner or stakeholder target · Complete action register in appendix`,
        {
          x: 0.75,
          y: 6.58,
          w: 11.7,
          h: 0.24,
          fontSize: 9.5,
          italic: true,
          align: "right",
          color: C.slate,
          margin: 0,
        },
      );
    }

    // Leadership agenda and next steps
    {
      const fullAgenda = leadershipAgenda(
        deliverySnapshot,
        Math.max(24, deliverySnapshot.nodes.length * 5),
      );
      const agenda = fullAgenda.slice(0, 6);
      const slide = nextSlide(
        "Leadership agenda and next steps",
        agenda.length < fullAgenda.length
          ? `Decisions and actions · Showing ${agenda.length} of ${fullAgenda.length}`
          : "Decisions and actions",
      );
      agenda.forEach((item, index) => addAgendaRow(pptx, slide, item, index));
      if (agenda.length === 0) {
        slide.addText("No immediate leadership action is identified.", {
          x: 0.9,
          y: 2.0,
          w: 11.0,
          h: 0.5,
          fontSize: 19,
          italic: true,
          color: C.slate,
          margin: 0,
        });
      }
      slide.addText(
        "Underlying plan steps are listed in the action register.",
        {
          x: 0.75,
          y: 6.6,
          w: 11.7,
          h: 0.22,
          fontSize: 9.5,
          italic: true,
          align: "right",
          color: C.slate,
          margin: 0,
        },
      );
    }

    const contextEvidence = evidenceItems(snapshot);
    const groundedNodes = deliverySnapshot.nodes.filter(
      (node) => node.sources.length > 0,
    );
    const evidenceDisplay = evidenceDisplayItems(
      contextEvidence,
      groundedNodes,
    );
    const hasEvidence =
      evidenceDisplay.length > 0 ||
      snapshot.artifacts.length > 0 ||
      sourceRegister.length > 0;

    if (snapshot.options.includeEvidenceAppendix && hasEvidence) {
      const shownEvidence = evidenceDisplay.slice(0, 4);
      const slide = nextSlide(
        "Evidence and confidence",
        shownEvidence.length < evidenceDisplay.length
          ? `Decision support · Showing ${shownEvidence.length} of ${evidenceDisplay.length} evidence items`
          : "Decision support",
      );
      addTextPanel(
        pptx,
        slide,
        shownEvidence.length < evidenceDisplay.length
          ? `EVIDENCE & SOURCES · ${shownEvidence.length} OF ${evidenceDisplay.length}`
          : "EVIDENCE & SOURCES",
        shownEvidence,
        {
          x: 0.72,
          y: 1.55,
          w: 7.45,
          h: 4.95,
          accent: C.teal,
          empty:
            "No dedicated evidence highlights are recorded; connected source and output counts are shown at right.",
        },
      );
      slide.addShape(pptx.ShapeType.rect, {
        x: 8.45,
        y: 1.55,
        w: 4.12,
        h: 4.95,
        fill: { color: C.navy },
        line: { color: C.navy },
      });
      slide.addText("DECISION SUPPORT", {
        x: 8.78,
        y: 1.9,
        w: 3.4,
        h: 0.25,
        fontSize: 9,
        bold: true,
        charSpacing: 1.4,
        color: "7ED0CE",
        margin: 0,
      });
      slide.addText(String(sourceRegister.length), {
        x: 8.78,
        y: 2.38,
        w: 3.4,
        h: 0.85,
        fontSize: 40,
        bold: true,
        color: C.white,
        margin: 0,
      });
      slide.addText("SOURCE REGISTER ITEMS", {
        x: 8.78,
        y: 3.18,
        w: 3.25,
        h: 0.22,
        fontSize: 9,
        bold: true,
        color: C.mist,
        margin: 0,
      });
      addBullets(
        slide,
        [
          `${contextEvidence.length} approved context evidence items`,
          `${groundedNodes.length} source-linked plan steps`,
          `${snapshot.artifacts.length} connected outputs`,
          `${snapshot.health.groundedGates}/${snapshot.health.totalGates} gates grounded`,
        ],
        {
          x: 8.78,
          y: 3.68,
          w: 3.25,
          h: 1.75,
          fontSize: 15,
          color: C.mist,
        },
      );
    }

    // The appendix is intentionally paginated rather than capped. Every
    // included plan step appears exactly once even when main slides summarize.
    // Working-plan items are committed-delivery-excluded here — they get
    // their own paginated appendix below instead, so no step is emitted twice.
    const actionPages = chunk(deliverySnapshot.nodes, 5);
    actionPages.forEach((nodes, pageIndex) => {
      const first = pageIndex * 5 + 1;
      const last = first + nodes.length - 1;
      const slide = nextSlide(
        "Action register",
        `Appendix · Steps ${first}–${last} of ${deliverySnapshot.nodes.length}`,
      );
      addActionRegisterPage(pptx, slide, nodes);
    });

    if (snapshot.options.includeEvidenceAppendix) {
      const sourcePages = chunk(sourceRegister, 5);
      sourcePages.forEach((entries, pageIndex) => {
        const first = pageIndex * 5 + 1;
        const last = first + entries.length - 1;
        const slide = nextSlide(
          "Source register",
          `Appendix · Sources ${first}–${last} of ${sourceRegister.length}`,
        );
        addSourceRegisterPage(pptx, slide, entries);
      });
    }

    if (snapshot.options.audience === "internal") {
      if (workingPlanNodes.length > 0) {
        // Paginated like the action register above: every working-plan item
        // appears exactly once across these pages, never just the first 5.
        const workingPages = chunk(workingPlanNodes, 5);
        workingPages.forEach((nodes, pageIndex) => {
          const first = pageIndex * 5 + 1;
          const last = first + nodes.length - 1;
          const slide = nextSlide(
            "Working plan and review queue",
            workingPlanNodes.length > 5
              ? `Internal appendix · Steps ${first}–${last} of ${workingPlanNodes.length} uncommitted items`
              : "Internal appendix · Uncommitted items",
          );
          slide.addShape(pptx.ShapeType.rect, {
            x: 0.72,
            y: 1.5,
            w: 11.85,
            h: 0.78,
            fill: { color: "FFF6E5" },
            line: { color: C.gold, width: 1 },
          });
          slide.addText(
            "Suggested, draft, and internal-review items are working-plan material. They are included for internal review and are not committed client delivery.",
            {
              x: 1.0,
              y: 1.72,
              w: 11.25,
              h: 0.34,
              fontSize: 13,
              bold: true,
              color: C.ink,
              margin: 0,
              fit: "shrink",
            },
          );
          addTextPanel(
            pptx,
            slide,
            workingPlanNodes.length > 5
              ? `REVIEW QUEUE · ${first}–${last} OF ${workingPlanNodes.length}`
              : "REVIEW QUEUE",
            nodes.map(nodeDisplayItem),
            {
              x: 0.72,
              y: 2.55,
              w: 8.0,
              h: 3.9,
              accent: C.gold,
              empty: "No working-plan items are included.",
            },
          );
          addWorkingStatusPanel(
            pptx,
            slide,
            workingPlanNodes,
            8.98,
            2.55,
            3.59,
            3.9,
          );
        });
      }

      const slide = nextSlide(
        "Internal governance snapshot",
        "Internal appendix",
      );
      const governance = [
        `Snapshot ${snapshot.snapshotHash.slice(0, 16)}`,
        `Current version ${snapshot.version.id?.slice(0, 12) ?? "not available"}`,
        `${snapshot.context.activeDocuments} active context documents`,
        `${snapshot.context.staleDocuments} context documents past review`,
        `${snapshot.context.openMaterialConflicts} open material conflicts`,
        ...(snapshot.options.includeNarrative
          ? [
              narrative
                ? `Narrative: ${narrative.acceptedParagraphs} paragraphs accepted, ${narrative.rejectedParagraphs} rejected by verification, ${narrative.orchestratorDroppedParagraphs} dropped upstream (${narrative.model})`
                : "Narrative: requested but unavailable; deterministic content rendered",
            ]
          : []),
      ];
      addBullets(slide, governance, {
        x: 0.8,
        y: 1.65,
        w: 5.65,
        h: 3.3,
        fontSize: 18,
      });
      if (snapshot.options.includeChangeLog) {
        const recentVersions = snapshot.activity.versions.slice(0, 4);
        const recentChangesHeading =
          recentVersions.length < snapshot.activity.versions.length
            ? `RECENT PLAN CHANGE SAMPLE · ${recentVersions.length} OF ${snapshot.activity.versions.length} LOADED`
            : "RECENT PLAN CHANGE SAMPLE";
        slide.addText(recentChangesHeading, {
          x: 6.7,
          y: 1.62,
          w: 4.4,
          h: 0.24,
          fontSize: 9,
          bold: true,
          charSpacing: 1.4,
          color: C.teal,
          margin: 0,
        });
        addBullets(
          slide,
          recentVersions.map(
            (version) =>
              `${formatDate(version.createdAt)} · ${clip(version.note, 70)}`,
          ),
          { x: 6.7, y: 2.02, w: 5.35, h: 3.75, fontSize: 14 },
        );
      }
    }

    if (
      snapshot.options.audience === "internal" &&
      snapshot.options.includeAgentHistory
    ) {
      const slide = nextSlide(
        "Automation and watch history",
        "Internal appendix",
      );
      const states = new Map<string, number>();
      for (const run of snapshot.activity.agentRuns)
        states.set(run.state, (states.get(run.state) ?? 0) + 1);
      addBullets(
        slide,
        [...states].map(
          ([state, count]) =>
            `${statusLabel(state)}: ${count} run${count === 1 ? "" : "s"}`,
        ),
        { x: 0.78, y: 1.62, w: 4.25, h: 3.7, fontSize: 18 },
      );
      slide.addText(
        `Counts reflect the latest ${snapshot.activity.agentRuns.length} runs loaded into this report sample.`,
        {
          x: 0.78,
          y: 5.72,
          w: 4.25,
          h: 0.38,
          fontSize: 9.5,
          italic: true,
          color: C.slate,
          margin: 0,
        },
      );
      const recentChangeSets = snapshot.activity.changeSets.slice(0, 5);
      const recentActivityHeading =
        recentChangeSets.length < snapshot.activity.changeSets.length
          ? `RECENT WATCH / CHANGE SAMPLE · ${recentChangeSets.length} OF ${snapshot.activity.changeSets.length} LOADED`
          : "RECENT WATCH / CHANGE SAMPLE";
      slide.addText(recentActivityHeading, {
        x: 5.35,
        y: 1.62,
        w: 5.9,
        h: 0.24,
        fontSize: 9,
        bold: true,
        charSpacing: 1.4,
        color: C.teal,
        margin: 0,
      });
      addBullets(
        slide,
        recentChangeSets.map(
          (changeSet) =>
            `${statusLabel(changeSet.status)} · ${kindLabel(changeSet.risk)} · ${clip(changeSet.summary, 80)}`,
        ),
        { x: 5.35, y: 2.02, w: 6.8, h: 4.15, fontSize: 15 },
      );
    }

    const raw = await pptx.write({ outputType: "nodebuffer" });
    if (Buffer.isBuffer(raw)) return raw;
    if (raw instanceof Uint8Array) return Buffer.from(raw);
    if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw));
    throw new Error("PptxGenJS returned a non-binary payload");
  }
}

function narrativeDisplayItem(item: ReportNarrativeItem): DisplayItem {
  return {
    text: item.text,
    detail: [
      item.label,
      item.sourceTitle,
      item.asOf ? `As of ${formatDate(item.asOf)}` : null,
      confidenceLabel(item.confidence),
    ]
      .filter(isString)
      .join(" · "),
  };
}

function internalWorkingPlanNodes(
  snapshot: ExecutiveReportSnapshot,
): ReportNode[] {
  if (snapshot.options.audience !== "internal") return [];
  const workingStatuses = new Set(["suggested", "draft", "internal_review"]);
  return snapshot.nodes.filter((node) => workingStatuses.has(node.status));
}

function nodeDisplayItem(node: ReportNode): DisplayItem {
  return {
    text: node.title,
    detail: `${kindLabel(node.kind)} · ${node.ownerName} · ${dateRange(node)}`,
  };
}

function addTextPanel(
  pptx: PptxGenJS,
  slide: Slide,
  heading: string,
  items: DisplayItem[],
  options: {
    x: number;
    y: number;
    w: number;
    h: number;
    accent: string;
    empty: string;
  },
): void {
  slide.addShape(pptx.ShapeType.rect, {
    x: options.x,
    y: options.y,
    w: options.w,
    h: options.h,
    fill: { color: C.pale },
    line: { color: C.line, width: 1 },
  });
  slide.addShape(pptx.ShapeType.rect, {
    x: options.x,
    y: options.y,
    w: options.w,
    h: 0.08,
    fill: { color: options.accent },
    line: { color: options.accent },
  });
  slide.addText(heading, {
    x: options.x + 0.28,
    y: options.y + 0.3,
    w: options.w - 0.56,
    h: 0.24,
    fontSize: 9,
    bold: true,
    charSpacing: 1.25,
    color: options.accent,
    margin: 0,
    fit: "shrink",
  });
  if (items.length === 0) {
    slide.addText(options.empty, {
      x: options.x + 0.3,
      y: options.y + 0.88,
      w: options.w - 0.6,
      h: Math.min(1.1, options.h - 1.15),
      fontSize: 14,
      italic: true,
      color: C.slate,
      margin: 0,
      valign: "top",
      fit: "shrink",
    });
    return;
  }

  const top = options.y + 0.78;
  const available = options.h - 1.02;
  const gap = items.length >= 5 ? 0.04 : 0.08;
  const rowHeight =
    (available - gap * Math.max(0, items.length - 1)) / items.length;
  items.forEach((item, index) => {
    const rowY = top + index * (rowHeight + gap);
    const compact = items.length >= 5;
    slide.addText("•", {
      x: options.x + 0.27,
      y: rowY + 0.02,
      w: 0.17,
      h: 0.22,
      fontSize: compact ? 11 : 13,
      bold: true,
      color: options.accent,
      margin: 0,
    });
    slide.addText(item.text, {
      x: options.x + 0.5,
      y: rowY,
      w: options.w - 0.82,
      h: item.detail ? rowHeight * 0.62 : rowHeight - 0.04,
      fontSize: compact ? 11.2 : 12.4,
      bold: true,
      color: C.ink,
      margin: 0,
      valign: "top",
      fit: "shrink",
    });
    if (item.detail) {
      slide.addText(item.detail, {
        x: options.x + 0.5,
        y: rowY + rowHeight * 0.62,
        w: options.w - 0.82,
        h: Math.max(0.16, rowHeight * 0.3),
        fontSize: compact ? 8.8 : 9.5,
        color: C.slate,
        margin: 0,
        valign: "top",
        fit: "shrink",
      });
    }
    if (index < items.length - 1) {
      slide.addShape(pptx.ShapeType.line, {
        x: options.x + 0.5,
        y: rowY + rowHeight + gap / 2,
        w: options.w - 0.82,
        h: 0,
        line: { color: C.line, width: 0.5 },
      });
    }
  });
}

function addSignalPanel(
  pptx: PptxGenJS,
  slide: Slide,
  snapshot: ExecutiveReportSnapshot,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  slide.addShape(pptx.ShapeType.rect, {
    x,
    y,
    w,
    h,
    fill: { color: C.navy },
    line: { color: C.navy },
  });
  slide.addText("OPERATING SIGNALS", {
    x: x + 0.3,
    y: y + 0.34,
    w: w - 0.6,
    h: 0.24,
    fontSize: 9,
    bold: true,
    charSpacing: 1.35,
    color: "7ED0CE",
    margin: 0,
  });
  const liveNodes = snapshot.inclusion?.liveNodes ?? snapshot.nodes.length;
  const includedNodes =
    snapshot.inclusion?.includedNodes ?? snapshot.nodes.length;
  const signals: Array<[string, string]> = [
    [
      snapshot.options.audience === "client"
        ? "Reviewed delivery plan"
        : "Audience-ready plan",
      snapshot.options.audience === "client"
        ? `${includedNodes} steps`
        : `${includedNodes}/${liveNodes} steps`,
    ],
    [
      "Accountability",
      `${snapshot.health.ownedNodes}/${snapshot.health.totalNodes} assigned`,
    ],
    ["Schedule pressure", `${snapshot.health.overdueNodes} overdue`],
    [
      "Decision grounding",
      `${snapshot.health.groundedGates}/${snapshot.health.totalGates} gates`,
    ],
    [
      "Approved context",
      `${snapshot.context.includedDocuments ?? snapshot.context.activeDocuments} documents`,
    ],
    ["Material conflicts", String(snapshot.context.openMaterialConflicts)],
  ];
  signals.forEach(([label, value], index) => {
    const rowY = y + 0.92 + index * 0.61;
    slide.addText(label, {
      x: x + 0.3,
      y: rowY,
      w: 2.25,
      h: 0.24,
      fontSize: 11.5,
      color: C.mist,
      margin: 0,
    });
    slide.addText(value, {
      x: x + 2.45,
      y: rowY,
      w: w - 2.75,
      h: 0.24,
      fontSize: 12,
      bold: true,
      align: "right",
      color: C.white,
      margin: 0,
      fit: "shrink",
    });
    if (index < signals.length - 1) {
      slide.addShape(pptx.ShapeType.line, {
        x: x + 0.3,
        y: rowY + 0.4,
        w: w - 0.6,
        h: 0,
        line: { color: "36566F", width: 0.6 },
      });
    }
  });
}

function addWorkingStatusPanel(
  pptx: PptxGenJS,
  slide: Slide,
  nodes: ReportNode[],
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  slide.addShape(pptx.ShapeType.rect, {
    x,
    y,
    w,
    h,
    fill: { color: C.navy },
    line: { color: C.navy },
  });
  slide.addText("QUEUE BY STATUS", {
    x: x + 0.3,
    y: y + 0.34,
    w: w - 0.6,
    h: 0.22,
    fontSize: 9,
    bold: true,
    charSpacing: 1.3,
    color: "7ED0CE",
    margin: 0,
  });
  const statuses = ["suggested", "draft", "internal_review"];
  statuses.forEach((status, index) => {
    const count = nodes.filter((node) => node.status === status).length;
    const rowY = y + 1.02 + index * 0.82;
    slide.addText(statusLabel(status), {
      x: x + 0.3,
      y: rowY,
      w: 1.9,
      h: 0.28,
      fontSize: 12,
      color: C.mist,
      margin: 0,
    });
    slide.addText(String(count), {
      x: x + 2.25,
      y: rowY - 0.07,
      w: w - 2.55,
      h: 0.42,
      fontSize: 21,
      bold: true,
      align: "right",
      color: C.white,
      margin: 0,
    });
  });
}

function addFocusAreaCard(
  pptx: PptxGenJS,
  slide: Slide,
  area: ReturnType<typeof focusAreas>[number],
  index: number,
): void {
  const column = index % 2;
  const row = Math.floor(index / 2);
  const x = 0.72 + column * 6.04;
  const y = 1.52 + row * 2.48;
  slide.addShape(pptx.ShapeType.rect, {
    x,
    y,
    w: 5.8,
    h: 2.22,
    fill: { color: row % 2 === 0 ? C.pale : C.white },
    line: { color: C.line, width: 1 },
  });
  slide.addShape(pptx.ShapeType.rect, {
    x,
    y,
    w: 0.1,
    h: 2.22,
    fill: { color: C.teal },
    line: { color: C.teal },
  });
  slide.addText(area.title, {
    x: x + 0.28,
    y: y + 0.2,
    w: 4.55,
    h: 0.34,
    fontSize: 16,
    bold: true,
    color: C.navy,
    margin: 0,
    fit: "shrink",
  });
  slide.addText(
    `${area.nodes.length} step${area.nodes.length === 1 ? "" : "s"}`,
    {
      x: x + 4.68,
      y: y + 0.22,
      w: 0.82,
      h: 0.24,
      fontSize: 10,
      bold: true,
      align: "right",
      color: C.teal,
      margin: 0,
    },
  );
  slide.addText(area.description, {
    x: x + 0.28,
    y: y + 0.62,
    w: 5.15,
    h: 0.38,
    fontSize: 10.5,
    color: C.slate,
    margin: 0,
    fit: "shrink",
  });
  const listed = area.nodes.slice(0, 2);
  listed.forEach((node, nodeIndex) => {
    const nodeY = y + 1.08 + nodeIndex * 0.43;
    slide.addText("•", {
      x: x + 0.28,
      y: nodeY,
      w: 0.16,
      h: 0.18,
      fontSize: 10,
      bold: true,
      color: C.teal,
      margin: 0,
    });
    slide.addText(`${node.title} — ${node.ownerName}`, {
      x: x + 0.5,
      y: nodeY,
      w: 4.85,
      h: 0.36,
      fontSize: 10.2,
      color: C.ink,
      margin: 0,
      valign: "top",
      fit: "shrink",
    });
  });
  if (listed.length < area.nodes.length) {
    slide.addText(`+${area.nodes.length - listed.length} more in appendix`, {
      x: x + 0.28,
      y: y + 1.94,
      w: 5.1,
      h: 0.18,
      fontSize: 8.5,
      italic: true,
      align: "right",
      color: C.slate,
      margin: 0,
    });
  }
}

function addAgendaRow(
  pptx: PptxGenJS,
  slide: Slide,
  item: ReturnType<typeof leadershipAgenda>[number],
  index: number,
): void {
  const y = 1.52 + index * 0.82;
  const accent = agendaToneColor(item.tone);
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.72,
    y,
    w: 11.85,
    h: 0.68,
    fill: { color: index % 2 === 0 ? C.pale : C.white },
    line: { color: C.line, width: 0.6 },
  });
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 0.95,
    y: y + 0.14,
    w: 0.39,
    h: 0.39,
    fill: { color: accent },
    line: { color: accent },
  });
  slide.addText(String(index + 1), {
    x: 0.95,
    y: y + 0.19,
    w: 0.39,
    h: 0.2,
    fontSize: 9,
    bold: true,
    align: "center",
    color: C.white,
    margin: 0,
  });
  slide.addText(item.title, {
    x: 1.55,
    y: y + 0.1,
    w: 7.25,
    h: 0.45,
    fontSize: 13.5,
    bold: true,
    color: C.ink,
    margin: 0,
    valign: "middle",
    fit: "shrink",
  });
  slide.addText(item.detail, {
    x: 8.95,
    y: y + 0.12,
    w: 3.25,
    h: 0.4,
    fontSize: 10.5,
    align: "right",
    color: C.slate,
    margin: 0,
    valign: "middle",
    fit: "shrink",
  });
}

function agendaToneColor(
  tone: ReturnType<typeof leadershipAgenda>[number]["tone"],
): string {
  if (tone === "risk") return C.red;
  if (tone === "decision") return C.gold;
  if (tone === "evidence") return C.teal;
  if (tone === "ownership") return C.blue;
  return C.green;
}

function evidenceDisplayItems(
  contextEvidence: ReturnType<typeof evidenceItems>,
  groundedNodes: ReportNode[],
): DisplayItem[] {
  const combined: DisplayItem[] = [
    ...contextEvidence.map((item) => ({
      text: item.text,
      detail: [
        item.source,
        item.asOf ? `As of ${formatDate(item.asOf)}` : null,
        confidenceLabel(item.confidence),
      ]
        .filter(isString)
        .join(" · "),
    })),
    ...groundedNodes.map((node) => ({
      text: node.title,
      detail: `Plan sources: ${uniqueStrings(
        node.sources.map((source) => source.section),
      ).join(", ")}`,
    })),
  ];
  const seen = new Set<string>();
  return combined.filter((item) => {
    const key = normalized(item.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildSourceRegister(
  snapshot: ExecutiveReportSnapshot,
): SourceRegisterEntry[] {
  const entries: SourceRegisterEntry[] = [];
  for (const section of snapshot.context.sections ?? []) {
    for (const item of section.items) {
      entries.push({
        section: section.title,
        text: item.text,
        source: item.sourceTitle,
        detail: [
          item.label,
          authorityLabel(item.authority),
          item.asOf ? `As of ${formatDate(item.asOf)}` : null,
          confidenceLabel(item.confidence),
          snapshot.options.audience === "internal" ? item.sourceRef : null,
        ]
          .filter(isString)
          .join(" · "),
      });
    }
  }
  for (const fact of snapshot.context.facts ?? []) {
    entries.push({
      section: "Approved context fact",
      text: fact.text,
      source: fact.documentTitle,
      detail: [
        authorityLabel(fact.authority),
        fact.asOf ? `As of ${formatDate(fact.asOf)}` : null,
        confidenceLabel(fact.confidence),
        snapshot.options.audience === "internal" ? fact.sourceRef : null,
      ]
        .filter(isString)
        .join(" · "),
    });
  }
  for (const node of snapshot.nodes) {
    for (const source of node.sources) {
      entries.push({
        section: kindLabel(node.kind),
        text: node.title,
        source: source.section,
        detail: [
          `${node.ownerName} · ${dateRange(node)}`,
          snapshot.options.audience === "internal" ? source.ref : null,
        ]
          .filter(isString)
          .join(" · "),
      });
    }
  }
  for (const document of snapshot.context.documents ?? []) {
    entries.push({
      section: "Context document",
      text: document.title,
      source:
        snapshot.options.audience === "internal"
          ? document.templateKey || "Strategy context"
          : "Approved strategy context",
      detail: [
        authorityLabel(document.authority),
        document.asOf ? `As of ${formatDate(document.asOf)}` : null,
        `${document.highlightCount} selected highlight${document.highlightCount === 1 ? "" : "s"}`,
      ]
        .filter(isString)
        .join(" · "),
    });
  }
  if (snapshot.options.audience === "internal") {
    for (const artifact of snapshot.artifacts) {
      entries.push({
        section: "Connected output",
        text: kindLabel(artifact.artifactType),
        source: artifact.artifactRef,
        detail: `Linked to plan step ${artifact.nodeId}`,
      });
    }
  }

  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = [entry.section, entry.text, entry.source]
      .map(normalized)
      .join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addActionRegisterPage(
  pptx: PptxGenJS,
  slide: Slide,
  nodes: ReportNode[],
): void {
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7,
    y: 1.5,
    w: 11.9,
    h: 0.48,
    fill: { color: C.navy },
    line: { color: C.navy },
  });
  addRegisterColumns(
    slide,
    ["PLAN STEP", "TYPE / STATUS", "OWNER", "TIMING", "TARGET / SOURCES"],
    1.62,
    C.white,
    true,
  );
  nodes.forEach((node, index) => {
    const y = 2.07 + index * 0.86;
    if (index % 2 === 0) {
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.7,
        y: y - 0.08,
        w: 11.9,
        h: 0.74,
        fill: { color: C.pale },
        line: { color: C.pale },
      });
    }
    const sourceCount = node.sourceCount ?? node.sources.length;
    addRegisterColumns(
      slide,
      [
        node.title,
        `${kindLabel(node.kind)} · ${statusLabel(node.status)}`,
        node.ownerName,
        dateRange(node),
        node.targetLabel ||
          (sourceCount
            ? `${sourceCount} source${sourceCount === 1 ? "" : "s"}`
            : "—"),
      ],
      y,
      C.ink,
      false,
    );
  });
  slide.addText(
    "All included plan steps are represented once in this register.",
    {
      x: 0.75,
      y: 6.58,
      w: 11.7,
      h: 0.22,
      fontSize: 9.5,
      italic: true,
      align: "right",
      color: C.slate,
      margin: 0,
    },
  );
}

function addRegisterColumns(
  slide: Slide,
  values: [string, string, string, string, string],
  y: number,
  color: string,
  bold: boolean,
): void {
  const columns = [
    { x: 0.9, w: 4.05 },
    { x: 5.08, w: 1.55 },
    { x: 6.75, w: 1.7 },
    { x: 8.57, w: 2.02 },
    { x: 10.71, w: 1.65 },
  ];
  values.forEach((value, index) => {
    slide.addText(value, {
      x: columns[index]!.x,
      y,
      w: columns[index]!.w,
      h: bold ? 0.25 : 0.52,
      fontSize: bold ? 8.5 : index === 0 ? 10.8 : 9.5,
      bold: bold || index === 0,
      color,
      margin: 0,
      valign: bold ? "middle" : "top",
      fit: "shrink",
    });
  });
}

function addSourceRegisterPage(
  pptx: PptxGenJS,
  slide: Slide,
  entries: SourceRegisterEntry[],
): void {
  entries.forEach((entry, index) => {
    const y = 1.5 + index * 1.0;
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.72,
      y,
      w: 11.85,
      h: 0.86,
      fill: { color: index % 2 === 0 ? C.pale : C.white },
      line: { color: C.line, width: 0.6 },
    });
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.72,
      y,
      w: 0.08,
      h: 0.86,
      fill: { color: C.teal },
      line: { color: C.teal },
    });
    slide.addText(entry.section.toUpperCase(), {
      x: 0.98,
      y: y + 0.12,
      w: 1.35,
      h: 0.18,
      fontSize: 7.5,
      bold: true,
      charSpacing: 0.8,
      color: C.teal,
      margin: 0,
      fit: "shrink",
    });
    slide.addText(entry.text, {
      x: 2.45,
      y: y + 0.1,
      w: 6.15,
      h: 0.56,
      fontSize: 10.8,
      bold: true,
      color: C.ink,
      margin: 0,
      valign: "top",
      fit: "shrink",
    });
    slide.addText(entry.source, {
      x: 8.85,
      y: y + 0.1,
      w: 3.4,
      h: 0.25,
      fontSize: 10,
      bold: true,
      align: "right",
      color: C.navy,
      margin: 0,
      fit: "shrink",
    });
    if (entry.detail) {
      slide.addText(entry.detail, {
        x: 8.85,
        y: y + 0.42,
        w: 3.4,
        h: 0.24,
        fontSize: 8.5,
        align: "right",
        color: C.slate,
        margin: 0,
        fit: "shrink",
      });
    }
  });
  slide.addText(
    "Every selected context, plan source, and permitted output reference is represented.",
    {
      x: 0.75,
      y: 6.62,
      w: 11.7,
      h: 0.2,
      fontSize: 9.5,
      italic: true,
      align: "right",
      color: C.slate,
      margin: 0,
    },
  );
}

function confidenceLabel(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const percentage = value <= 1 ? value * 100 : value;
  return `${Math.round(percentage)}% confidence`;
}

function authorityLabel(value: string | null): string | null {
  if (!value?.trim()) return null;
  if (value === "client_approved") return "Client-approved";
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const trimmed = value.trim();
    const key = normalized(trimmed);
    if (!trimmed || seen.has(key)) return [];
    seen.add(key);
    return [trimmed];
  });
}

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isString(value: string | null | undefined): value is string {
  return Boolean(value?.trim());
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function addFooter(
  slide: Slide,
  snapshot: ExecutiveReportSnapshot,
  number: number,
): void {
  slide.addText(
    snapshot.options.audience === "client"
      ? "CONFIDENTIAL · CLIENT DISCUSSION DRAFT"
      : "CONFIDENTIAL · INTERNAL WORKING DRAFT",
    {
      x: 0.65,
      y: 7.13,
      w: 5.8,
      h: 0.18,
      fontSize: 7.5,
      bold: true,
      color: C.slate,
      margin: 0,
    },
  );
  slide.addText(`${clip(snapshot.client.name, 64)}  ·  ${number}`, {
    x: 8.2,
    y: 7.13,
    w: 4.42,
    h: 0.18,
    fontSize: 7.5,
    align: "right",
    color: C.slate,
    margin: 0,
    fit: "shrink",
  });
}

function sourceNote(
  snapshot: ExecutiveReportSnapshot,
  section?: string,
): string {
  const scope = section ? ` Section: ${section}.` : "";
  const provenance =
    snapshot.options.audience === "internal"
      ? ` Snapshot: ${snapshot.snapshotHash}. Version: ${snapshot.version.id ?? "not available"}.`
      : "";
  return `Source: Capiro current strategy plan.${scope} As of: ${snapshot.asOf}.${provenance} Values are rendered from the stored plan; no facts are inferred by the exporter.`;
}

function addLogo(
  pptx: PptxGenJS,
  slide: Slide,
  logo: ClientLogoAsset | null,
  clientName: string,
  box: { x: number; y: number; w: number; h: number },
  darkBackground: boolean,
): void {
  slide.addShape(pptx.ShapeType.rect, {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    fill: { color: C.white, transparency: darkBackground ? 2 : 0 },
    line: {
      color: darkBackground ? C.white : C.line,
      transparency: darkBackground ? 100 : 0,
    },
  });
  const size = logo?.dimensions ?? (logo ? readRasterSize(logo) : null);
  if (logo && size) {
    const placed = containBox(size, {
      x: box.x + 0.16,
      y: box.y + 0.12,
      w: box.w - 0.32,
      h: box.h - 0.24,
    });
    slide.addImage({
      data: `${logo.contentType};base64,${logo.bytes.toString("base64")}`,
      ...placed,
      altText: `${clientName} logo`,
    });
  } else {
    const fallbackName = clip(clientName, 42);
    slide.addText(fallbackName, {
      x: box.x + 0.2,
      y: box.y + 0.2,
      w: box.w - 0.4,
      h: box.h - 0.4,
      fontSize: fallbackName.length > 28 ? 13.5 : 17,
      bold: true,
      align: "center",
      valign: "middle",
      color: C.navy,
      margin: 0,
      fit: "shrink",
    });
  }
}

function addHealthCard(
  pptx: PptxGenJS,
  slide: Slide,
  snapshot: ExecutiveReportSnapshot,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  slide.addShape(pptx.ShapeType.rect, {
    x,
    y,
    w,
    h,
    fill: { color: C.navy },
    line: { color: C.navy },
  });
  slide.addText("PLAN HEALTH", {
    x: x + 0.3,
    y: y + 0.28,
    w: 2.2,
    h: 0.22,
    fontSize: 9,
    bold: true,
    charSpacing: 1.4,
    color: "7ED0CE",
    margin: 0,
  });
  slide.addText(String(snapshot.health.score), {
    x: x + 0.28,
    y: y + 0.67,
    w: 1.5,
    h: 0.86,
    fontSize: 41,
    bold: true,
    color: C.white,
    margin: 0,
  });
  slide.addText(snapshot.health.label, {
    x: x + 1.76,
    y: y + 0.87,
    w: 1.95,
    h: 0.34,
    fontSize: 17,
    bold: true,
    color: C.white,
    margin: 0,
  });
  slide.addText(
    `${snapshot.health.ownedNodes}/${snapshot.health.totalNodes} assigned · ${snapshot.health.overdueNodes} overdue`,
    {
      x: x + 0.3,
      y: y + 1.66,
      w: 3.4,
      h: 0.22,
      fontSize: 9.5,
      color: C.mist,
      margin: 0,
    },
  );
}

function addNodeCard(
  pptx: PptxGenJS,
  slide: Slide,
  snapshot: ExecutiveReportSnapshot,
  node: ReportNode,
  index: number,
): void {
  const column = index % 2;
  const row = Math.floor(index / 2);
  const x = 0.72 + column * 6.02;
  const y = 1.52 + row * 1.64;
  slide.addShape(pptx.ShapeType.rect, {
    x,
    y,
    w: 5.76,
    h: 1.38,
    fill: { color: row % 2 === 0 ? C.pale : C.white },
    line: { color: C.line, width: 1 },
  });
  slide.addShape(pptx.ShapeType.rect, {
    x,
    y,
    w: 0.1,
    h: 1.38,
    fill: {
      color:
        node.kind === "risk"
          ? C.red
          : node.kind === "decision"
            ? C.gold
            : C.teal,
    },
    line: {
      color:
        node.kind === "risk"
          ? C.red
          : node.kind === "decision"
            ? C.gold
            : C.teal,
    },
  });
  slide.addText(clip(node.title, 66), {
    x: x + 0.28,
    y: y + 0.15,
    w: 5.1,
    h: 0.48,
    fontSize: 14.5,
    bold: true,
    color: C.ink,
    margin: 0,
    valign: "top",
    fit: "shrink",
  });
  const note =
    snapshot.options.includeInternalNotes && node.note
      ? ` · ${clip(node.note.replace(/\s+/g, " "), 64)}`
      : "";
  slide.addText(
    `${kindLabel(node.kind)} · ${statusLabel(node.status)} · ${clip(node.ownerName, 32)} · ${dateRange(node)}${note}`,
    {
      x: x + 0.28,
      y: y + 0.76,
      w: 5.08,
      h: 0.4,
      fontSize: 10.5,
      color: C.slate,
      margin: 0,
      valign: "top",
      fit: "shrink",
    },
  );
}

/** Flowing verified prose inside a standard panel, with a compact sources line. */
function addProsePanel(
  pptx: PptxGenJS,
  slide: Slide,
  heading: string,
  paragraphs: readonly VerifiedNarrativeParagraph[],
  options: { x: number; y: number; w: number; h: number; accent: string },
): void {
  slide.addShape(pptx.ShapeType.rect, {
    x: options.x,
    y: options.y,
    w: options.w,
    h: options.h,
    fill: { color: C.pale },
    line: { color: C.line, width: 1 },
  });
  slide.addShape(pptx.ShapeType.rect, {
    x: options.x,
    y: options.y,
    w: options.w,
    h: 0.08,
    fill: { color: options.accent },
    line: { color: options.accent },
  });
  slide.addText(heading, {
    x: options.x + 0.28,
    y: options.y + 0.3,
    w: options.w - 0.56,
    h: 0.24,
    fontSize: 9,
    bold: true,
    charSpacing: 1.25,
    color: options.accent,
    margin: 0,
    fit: "shrink",
  });
  const shown = paragraphs.slice(0, 3);
  const totalChars = shown.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
  const fontSize =
    totalChars > 1_100 ? 11 : totalChars > 750 ? 12 : totalChars > 450 ? 13 : 14;
  slide.addText(
    shown.map((paragraph) => ({
      text: paragraph.text,
      options: { breakLine: true, paraSpaceAfter: 8 },
    })),
    {
      x: options.x + 0.3,
      y: options.y + 0.72,
      w: options.w - 0.6,
      h: options.h - 1.28,
      fontSize,
      color: C.ink,
      valign: "top",
      margin: 0,
      fit: "shrink",
    },
  );
  const sources = uniqueStrings(
    shown.flatMap((paragraph) => paragraph.sourceTitles),
  );
  if (sources.length > 0) {
    slide.addText(
      `Sources: ${sources.slice(0, 5).join(" · ")}${
        sources.length > 5 ? ` · +${sources.length - 5}` : ""
      }`,
      {
        x: options.x + 0.3,
        y: options.y + options.h - 0.46,
        w: options.w - 0.6,
        h: 0.3,
        fontSize: 8.5,
        italic: true,
        color: C.slate,
        margin: 0,
        fit: "shrink",
        valign: "bottom",
      },
    );
  }
}

/** Two-column prose spread for the executive narrative slide. */
function addProseColumns(
  pptx: PptxGenJS,
  slide: Slide,
  paragraphs: readonly VerifiedNarrativeParagraph[],
  options: { x: number; y: number; w: number; h: number; accent: string },
): void {
  const gap = 0.4;
  const columnWidth = (options.w - gap) / 2;
  const left = paragraphs.slice(0, Math.ceil(paragraphs.length / 2));
  const right = paragraphs.slice(left.length);
  [left, right].forEach((column, index) => {
    if (column.length === 0) return;
    addProsePanel(
      pptx,
      slide,
      index === 0 ? "EXECUTIVE NARRATIVE" : "CONTINUED",
      column,
      {
        x: options.x + index * (columnWidth + gap),
        y: options.y,
        w: columnWidth,
        h: options.h,
        accent: options.accent,
      },
    );
  });
}

const TIMELINE_LABEL_X = 0.7;
const TIMELINE_LABEL_W = 3.15;
const TIMELINE_CHART_X = 3.95;
const TIMELINE_CHART_W = 8.65;

/** Native-shape Gantt: month/quarter header, one bar or diamond per step, today + target markers. */
function addTimelineSlide(
  pptx: PptxGenJS,
  slide: Slide,
  snapshot: ExecutiveReportSnapshot,
  model: TimelineModel,
  rows: TimelineModel["rows"],
  caption: string | null,
): void {
  const headerY = 1.5;
  const headerH = 0.42;
  const chartTop = headerY + headerH + 0.08;
  const captionH = caption ? 0.78 : 0;
  const legendH = 0.32;
  const chartBottom = 6.95 - legendH - captionH;
  const rowH = Math.min(0.56, (chartBottom - chartTop) / Math.max(1, rows.length));
  const fractionX = (fraction: number) =>
    TIMELINE_CHART_X + TIMELINE_CHART_W * fraction;

  // Header band with period columns.
  slide.addShape(pptx.ShapeType.rect, {
    x: TIMELINE_LABEL_X,
    y: headerY,
    w: TIMELINE_LABEL_W + 0.1 + TIMELINE_CHART_W,
    h: headerH,
    fill: { color: C.navy },
    line: { color: C.navy },
  });
  slide.addText("PLAN STEP", {
    x: TIMELINE_LABEL_X + 0.16,
    y: headerY,
    w: TIMELINE_LABEL_W - 0.2,
    h: headerH,
    fontSize: 9,
    bold: true,
    charSpacing: 1.3,
    color: C.white,
    valign: "middle",
    margin: 0,
  });
  const columnW = TIMELINE_CHART_W / Math.max(1, model.columns.length);
  model.columns.forEach((column, index) => {
    const x = TIMELINE_CHART_X + index * columnW;
    if (column.isCurrent) {
      slide.addShape(pptx.ShapeType.rect, {
        x,
        y: headerY,
        w: columnW,
        h: headerH,
        fill: { color: C.teal },
        line: { color: C.teal },
      });
    }
    slide.addText(column.label, {
      x,
      y: headerY,
      w: columnW,
      h: headerH,
      fontSize: model.columns.length > 12 ? 8 : 9.5,
      bold: true,
      align: "center",
      valign: "middle",
      color: C.white,
      margin: 0,
      fit: "shrink",
    });
    // Column gridline.
    slide.addShape(pptx.ShapeType.line, {
      x,
      y: chartTop,
      w: 0,
      h: rowH * rows.length,
      line: { color: C.line, width: 0.5 },
    });
  });

  rows.forEach((row, index) => {
    const y = chartTop + index * rowH;
    if (index % 2 === 1) {
      slide.addShape(pptx.ShapeType.rect, {
        x: TIMELINE_LABEL_X,
        y,
        w: TIMELINE_LABEL_W + 0.1 + TIMELINE_CHART_W,
        h: rowH,
        fill: { color: C.pale },
        line: { color: C.pale },
      });
    }
    const tone = row.overdue ? C.red : TIMELINE_TONES[row.node.kind];
    // One line each: a wrapped title would collide with its detail line in
    // renderers that ignore shrink-to-fit, so clip to what fits the column.
    slide.addText(clip(row.node.title, 40), {
      x: TIMELINE_LABEL_X + 0.16,
      y: y + 0.05,
      w: TIMELINE_LABEL_W - 0.2,
      h: rowH * 0.5,
      fontSize: 9.5,
      bold: true,
      color: C.ink,
      valign: "top",
      margin: 0,
      fit: "shrink",
    });
    slide.addText(
      `${kindLabel(row.node.kind)} · ${clip(row.node.ownerName, 22)} · ${dateRange(row.node)}${
        row.overdue ? " · Overdue" : ""
      }`,
      {
        x: TIMELINE_LABEL_X + 0.16,
        y: y + rowH * 0.52,
        w: TIMELINE_LABEL_W - 0.2,
        h: rowH * 0.42,
        fontSize: 8,
        color: row.overdue ? C.red : C.slate,
        valign: "top",
        margin: 0,
        fit: "shrink",
      },
    );
    const barH = Math.min(0.24, rowH * 0.46);
    const barY = y + (rowH - barH) / 2;
    if (row.marker) {
      const size = Math.min(0.3, rowH * 0.6);
      slide.addShape(pptx.ShapeType.diamond, {
        x: fractionX(row.startFraction) - size / 2,
        y: y + (rowH - size) / 2,
        w: size,
        h: size,
        fill: { color: tone },
        line: { color: C.white, width: 0.75 },
      });
    } else {
      const startX = fractionX(row.startFraction);
      const endX = fractionX(row.endFraction);
      slide.addShape(pptx.ShapeType.roundRect, {
        x: startX,
        y: barY,
        w: Math.max(0.12, endX - startX),
        h: barH,
        fill: { color: tone },
        line: { color: tone },
        rectRadius: 0.06,
      });
      if (row.clippedEnd) {
        slide.addText("►", {
          x: TIMELINE_CHART_X + TIMELINE_CHART_W - 0.22,
          y: barY - 0.03,
          w: 0.24,
          h: barH + 0.06,
          fontSize: 9,
          color: tone,
          margin: 0,
          valign: "middle",
        });
      }
    }
  });

  // Today and target markers: the lines run through the rows; their labels sit
  // in the gap above the header band so they never collide with the legend or
  // the caption below the chart.
  const chartRight = TIMELINE_CHART_X + TIMELINE_CHART_W;
  const markerLabel = (
    text: string,
    lineX: number,
    color: string,
    preferLeft: boolean,
  ): void => {
    const w = 1.7;
    const fitsLeft = lineX - w - 0.04 >= TIMELINE_CHART_X;
    const fitsRight = lineX + w + 0.04 <= chartRight;
    const left = preferLeft ? fitsLeft || !fitsRight : !fitsRight;
    slide.addText(text, {
      x: left ? lineX - w - 0.04 : lineX + 0.04,
      y: headerY - 0.24,
      w,
      h: 0.2,
      fontSize: 8,
      bold: true,
      align: left ? "right" : "left",
      color,
      margin: 0,
    });
  };
  if (model.asOfFraction !== null) {
    const x = fractionX(model.asOfFraction);
    slide.addShape(pptx.ShapeType.line, {
      x,
      y: headerY - 0.04,
      w: 0,
      h: headerH + 0.12 + rowH * rows.length,
      line: { color: C.teal, width: 1.5, dashType: "dash" },
    });
    markerLabel(`Today · ${formatDate(snapshot.asOf)}`, x, C.teal, true);
  }
  if (model.targetFraction !== null && snapshot.strategy.targetDate) {
    const x = fractionX(model.targetFraction);
    slide.addShape(pptx.ShapeType.line, {
      x,
      y: headerY - 0.04,
      w: 0,
      h: headerH + 0.12 + rowH * rows.length,
      line: { color: C.gold, width: 1.5, dashType: "sysDot" },
    });
    markerLabel(
      `Target · ${formatDate(snapshot.strategy.targetDate)}`,
      x,
      C.gold,
      false,
    );
  }

  const legendY = 6.95 - legendH - captionH + 0.02;
  const legend: Array<[string, string]> = [
    ["Actions", C.teal],
    ["Decisions", C.blue],
    ["Gates & milestones", C.gold],
    ["Risks / overdue", C.red],
  ];
  legend.forEach(([label, color], index) => {
    const x = TIMELINE_LABEL_X + index * 2.15;
    slide.addShape(pptx.ShapeType.rect, {
      x,
      y: legendY + 0.08,
      w: 0.22,
      h: 0.14,
      fill: { color },
      line: { color },
    });
    slide.addText(label, {
      x: x + 0.3,
      y: legendY,
      w: 1.8,
      h: 0.3,
      fontSize: 9,
      color: C.slate,
      valign: "middle",
      margin: 0,
    });
  });
  const notes: string[] = [];
  if (model.omittedRows > 0)
    notes.push(`${model.omittedRows} later steps in the action register`);
  if (model.truncatedHorizon) notes.push("► continues past the drawn horizon");
  if (notes.length > 0) {
    slide.addText(notes.join(" · "), {
      x: 9.2,
      y: legendY,
      w: 3.4,
      h: 0.3,
      fontSize: 8.5,
      italic: true,
      align: "right",
      color: C.slate,
      valign: "middle",
      margin: 0,
      fit: "shrink",
    });
  }
  if (caption) {
    slide.addShape(pptx.ShapeType.rect, {
      x: TIMELINE_LABEL_X,
      y: 6.95 - captionH + 0.04,
      w: TIMELINE_LABEL_W + 0.1 + TIMELINE_CHART_W,
      h: captionH - 0.1,
      fill: { color: C.pale },
      line: { color: C.line, width: 1 },
    });
    slide.addText(clip(caption, 420), {
      x: TIMELINE_LABEL_X + 0.2,
      y: 6.95 - captionH + 0.1,
      w: TIMELINE_LABEL_W + TIMELINE_CHART_W - 0.3,
      h: captionH - 0.22,
      fontSize: 10.5,
      color: C.ink,
      valign: "middle",
      margin: 0,
      fit: "shrink",
    });
  }
}

/** Portrait card for one congressional office (three per slide). */
function addMemberCard(
  pptx: PptxGenJS,
  slide: Slide,
  snapshot: ExecutiveReportSnapshot,
  detail: ReportMemberDetail,
  photo: ReportRasterAsset | null,
  index: number,
): void {
  const gap = 0.3;
  const cardW = (11.9 - gap * (MEMBER_CARDS_PER_SLIDE - 1)) / MEMBER_CARDS_PER_SLIDE;
  const x = 0.7 + index * (cardW + gap);
  const y = 1.52;
  const h = 4.95;
  slide.addShape(pptx.ShapeType.rect, {
    x,
    y,
    w: cardW,
    h,
    fill: { color: C.pale },
    line: { color: C.line, width: 1 },
  });
  slide.addShape(pptx.ShapeType.rect, {
    x,
    y,
    w: cardW,
    h: 0.08,
    fill: { color: C.blue },
    line: { color: C.blue },
  });

  const portraitBox = { x: x + 0.3, y: y + 0.36, w: 1.35, h: 1.7 };
  const size = photo ? photo.dimensions ?? readRasterSize(photo) : null;
  if (photo && size) {
    slide.addImage({
      data: `${photo.contentType};base64,${photo.bytes.toString("base64")}`,
      ...containBox(size, portraitBox),
      altText: `${detail.name} portrait`,
    });
  } else {
    slide.addShape(pptx.ShapeType.ellipse, {
      x: portraitBox.x + 0.08,
      y: portraitBox.y + 0.22,
      w: 1.2,
      h: 1.2,
      fill: { color: C.mist },
      line: { color: C.line, width: 1 },
    });
    slide.addText(memberInitials(detail.name), {
      x: portraitBox.x + 0.08,
      y: portraitBox.y + 0.22,
      w: 1.2,
      h: 1.2,
      fontSize: 26,
      bold: true,
      align: "center",
      valign: "middle",
      color: C.blue,
      margin: 0,
    });
  }

  const textX = x + 1.85;
  const textW = cardW - 2.1;
  slide.addText(clip(detail.name, 40), {
    x: textX,
    y: y + 0.36,
    w: textW,
    h: 0.62,
    fontSize: 15,
    bold: true,
    color: C.navy,
    valign: "top",
    margin: 0,
    fit: "shrink",
  });
  const descriptor = [
    detail.party ? partyLabel(detail.party) : null,
    detail.state,
    detail.chamber,
    detail.district ? `District ${detail.district}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  slide.addText(descriptor || "Member office", {
    x: textX,
    y: y + 1.0,
    w: textW,
    h: 0.5,
    fontSize: 10,
    color: C.slate,
    valign: "top",
    margin: 0,
    fit: "shrink",
  });
  if (detail.committees.length > 0) {
    slide.addText(clip(detail.committees.join("; "), 90), {
      x: textX,
      y: y + 1.5,
      w: textW,
      h: 0.56,
      fontSize: 9.5,
      italic: true,
      color: C.ink,
      valign: "top",
      margin: 0,
      fit: "shrink",
    });
  }

  const officeY = y + 2.3;
  slide.addText("WASHINGTON OFFICE", {
    x: x + 0.3,
    y: officeY,
    w: cardW - 0.6,
    h: 0.22,
    fontSize: 8.5,
    bold: true,
    charSpacing: 1.2,
    color: C.teal,
    margin: 0,
  });
  const office = detail.washingtonOffice;
  const officeLines = office
    ? [
        office.address1,
        office.address2,
        [office.city, office.state].filter(Boolean).join(", ") +
          (office.zip ? ` ${office.zip}` : ""),
        office.phone ? `Phone ${office.phone}` : null,
      ].filter((line): line is string => Boolean(line && line.trim()))
    : [
        detail.resolved
          ? "No Washington office address is listed in the directory."
          : "Directory detail was not available at export time.",
      ];
  slide.addText(
    officeLines.map((line) => ({ text: line, options: { breakLine: true } })),
    {
      x: x + 0.3,
      y: officeY + 0.26,
      w: cardW - 0.6,
      h: 1.15,
      fontSize: office ? 11 : 10,
      italic: !office,
      color: office ? C.ink : C.slate,
      valign: "top",
      margin: 0,
      fit: "shrink",
    },
  );

  const steps =
    snapshot.members
      .find((member) => member.memberId === detail.memberId)
      ?.nodeIds.map((id) => snapshot.nodes.find((node) => node.id === id)?.title)
      .filter((title): title is string => Boolean(title)) ?? [];
  if (steps.length > 0) {
    slide.addText(steps.length === 1 ? "PLAN STEP" : "PLAN STEPS", {
      x: x + 0.3,
      y: y + 3.78,
      w: cardW - 0.6,
      h: 0.22,
      fontSize: 8.5,
      bold: true,
      charSpacing: 1.2,
      color: C.blue,
      margin: 0,
    });
    slide.addText(
      steps.slice(0, 3).map((title) => ({
        text: `• ${clip(title, 60)}`,
        options: { breakLine: true },
      })),
      {
        x: x + 0.3,
        y: y + 4.02,
        w: cardW - 0.6,
        h: 0.84,
        fontSize: 9.5,
        color: C.ink,
        valign: "top",
        margin: 0,
        fit: "shrink",
      },
    );
  }
}

function memberInitials(name: string): string {
  const letters = name
    .replace(/^(sen|rep|hon|dr|mr|ms|mrs)\.?\s+/i, "")
    .split(/[\s,]+/)
    .filter((part) => /^[a-z]/i.test(part))
    .map((part) => part[0]!.toUpperCase());
  return (letters.slice(0, 1).join("") + (letters.at(-1) ?? "")).slice(0, 2) || "—";
}

function partyLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "d" || normalized.startsWith("dem")) return "Democratic";
  if (normalized === "r" || normalized.startsWith("rep")) return "Republican";
  if (normalized === "i" || normalized.startsWith("ind")) return "Independent";
  return value.trim();
}

function addRoadmapSlide(
  pptx: PptxGenJS,
  slide: Slide,
  groups: ReturnType<typeof roadmap>,
): void {
  const gap = 0.24;
  const panelWidth =
    (11.9 - gap * (groups.length - 1)) / Math.max(1, groups.length);
  const maxItems = groups.length >= 3 ? 2 : 3;
  groups.forEach((group, index) => {
    const x = 0.7 + index * (panelWidth + gap);
    slide.addShape(pptx.ShapeType.rect, {
      x,
      y: 1.55,
      w: panelWidth,
      h: 4.9,
      fill: { color: index % 2 === 0 ? C.pale : C.white },
      line: { color: C.line, width: 1 },
    });
    slide.addShape(pptx.ShapeType.rect, {
      x,
      y: 1.55,
      w: panelWidth,
      h: 0.08,
      fill: { color: group.label.startsWith("Overdue") ? C.red : C.teal },
      line: { color: group.label.startsWith("Overdue") ? C.red : C.teal },
    });
    slide.addText(group.label, {
      x: x + 0.25,
      y: 1.86,
      w: panelWidth - 0.5,
      h: 0.52,
      fontSize: 18,
      bold: true,
      color: group.label.startsWith("Overdue") ? C.red : C.navy,
      margin: 0,
    });
    addBullets(
      slide,
      group.nodes
        .slice(0, maxItems)
        .map(
          (node) =>
            `${clip(node.title, 70)} — ${clip(node.ownerName, 24)}\n${formatDate(node.startsOn)}`,
        ),
      {
        x: x + 0.25,
        y: 2.55,
        w: panelWidth - 0.5,
        h: 3.28,
        fontSize: 16,
      },
    );
    if (group.nodes.length === 0) {
      slide.addText("No plan steps in this window.", {
        x: x + 0.25,
        y: 2.55,
        w: panelWidth - 0.5,
        h: 0.34,
        fontSize: 16,
        italic: true,
        color: C.slate,
        margin: 0,
      });
    } else if (group.nodes.length > maxItems) {
      slide.addText(`+${group.nodes.length - maxItems} more plan steps`, {
        x: x + 0.25,
        y: 6.0,
        w: panelWidth - 0.5,
        h: 0.24,
        fontSize: 11,
        italic: true,
        color: C.slate,
        margin: 0,
      });
    }
  });
}

function addListPanel(
  pptx: PptxGenJS,
  slide: Slide,
  heading: string,
  nodes: ReportNode[],
  snapshot: ExecutiveReportSnapshot,
  x: number,
  y: number,
  w: number,
  accent: string,
  showEvidence = false,
  remaining = 0,
): void {
  slide.addShape(pptx.ShapeType.rect, {
    x,
    y,
    w,
    h: 4.95,
    fill: { color: C.pale },
    line: { color: C.line, width: 1 },
  });
  slide.addShape(pptx.ShapeType.rect, {
    x,
    y,
    w,
    h: 0.08,
    fill: { color: accent },
    line: { color: accent },
  });
  const panelHeading =
    remaining > 0
      ? `${heading} · ${nodes.length} OF ${nodes.length + remaining}`
      : heading;
  slide.addText(panelHeading, {
    x: x + 0.28,
    y: y + 0.3,
    w: w - 0.56,
    h: 0.25,
    fontSize: 9,
    bold: true,
    charSpacing: 1.4,
    color: accent,
    margin: 0,
  });
  if (nodes.length === 0) {
    slide.addText("No items are currently recorded.", {
      x: x + 0.3,
      y: y + 0.88,
      w: w - 0.6,
      h: 0.35,
      fontSize: 14,
      italic: true,
      color: C.slate,
      margin: 0,
    });
    return;
  }

  // Fixed rows prevent one long item from consuming the panel and obscuring
  // subsequent items or the slide footer. Each row separately clips/fits its
  // title and supporting detail.
  const contentTop = y + 0.82;
  const contentHeight = 3.72;
  const gap = nodes.length > 4 ? 0.08 : 0.12;
  const rowHeight =
    (contentHeight - gap * Math.max(0, nodes.length - 1)) / nodes.length;
  nodes.forEach((node, index) => {
    const rowY = contentTop + index * (rowHeight + gap);
    const compactRows = nodes.length >= 5;
    const titleLimit = showEvidence ? 72 : compactRows ? 52 : 66;
    const titleHeight = compactRows ? 0.24 : 0.44;
    const sources = node.sources.map((source) => source.section).join(", ");
    const note =
      snapshot.options.includeInternalNotes && node.note
        ? ` · ${clip(node.note.replace(/\s+/g, " "), 42)}`
        : "";
    const detail = showEvidence
      ? clip(sources || "No named source", compactRows ? 70 : 100)
      : `${clip(node.ownerName, 28)} · ${dateRange(node)}${note}`;

    slide.addText("•", {
      x: x + 0.28,
      y: rowY,
      w: 0.16,
      h: 0.22,
      fontSize: compactRows ? 12 : 14,
      bold: true,
      color: accent,
      margin: 0,
    });
    slide.addText(clip(node.title, titleLimit), {
      x: x + 0.5,
      y: rowY,
      w: w - 0.82,
      h: titleHeight,
      fontSize: compactRows ? 11.5 : 13,
      bold: true,
      color: C.ink,
      margin: 0,
      valign: "top",
      fit: "shrink",
    });
    slide.addText(detail, {
      x: x + 0.5,
      y: rowY + titleHeight + 0.04,
      w: w - 0.82,
      h: Math.max(0.2, rowHeight - titleHeight - 0.06),
      fontSize: compactRows ? 10 : 11,
      color: C.slate,
      margin: 0,
      valign: "top",
      fit: "shrink",
    });
    if (index < nodes.length - 1) {
      slide.addShape(pptx.ShapeType.line, {
        x: x + 0.5,
        y: rowY + rowHeight + gap / 2,
        w: w - 0.82,
        h: 0,
        line: { color: C.line, width: 0.5 },
      });
    }
  });
}

function addBullets(
  slide: Slide,
  lines: string[],
  options: {
    x: number;
    y: number;
    w: number;
    h: number;
    fontSize: number;
    color?: string;
  },
): void {
  slide.addText(lines.map((line) => `•  ${line}`).join("\n\n"), {
    x: options.x,
    y: options.y,
    w: options.w,
    h: options.h,
    fontSize: options.fontSize,
    color: options.color ?? C.ink,
    margin: 0,
    breakLine: false,
    valign: "top",
    paraSpaceAfter: 7,
    fit: "shrink",
  });
}

function addColumns(
  slide: Slide,
  values: [string, string, string],
  y: number,
  color: string,
  bold: boolean,
): void {
  const columns = [
    { x: 0.92, w: 5.3 },
    { x: 6.35, w: 2.7 },
    { x: 9.2, w: 3.05 },
  ];
  values.forEach((value, index) => {
    slide.addText(value, {
      x: columns[index]!.x,
      y,
      w: columns[index]!.w,
      h: bold ? 0.28 : 0.44,
      fontSize: bold ? 10 : 12.5,
      bold,
      color,
      margin: 0,
      fit: "shrink",
      valign: "middle",
    });
  });
}

function healthColor(score: number): string {
  return score >= 80 ? C.green : score >= 60 ? C.gold : C.red;
}
