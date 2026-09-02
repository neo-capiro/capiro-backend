import {
  clip,
  criticalNodes,
  dateRange,
  formatDate,
  kindLabel,
  leadershipAgenda,
  roadmap,
  statusLabel,
  strategyTypeLabel,
} from "./report-content.js";
import type { ReportNarrativeEvidence } from "./report-narrative.types.js";
import { buildTimelineModel, timelineHorizonLabel } from "./report-timeline.js";
import type {
  ExecutiveReportSnapshot,
  ReportMemberDetail,
  ReportNode,
} from "./report.types.js";

/**
 * Build the evidence packet the narrative model may cite. Every entry is
 * verbatim, audience-safe material that already passed the snapshot's
 * redaction and readiness gates; the model sees nothing else about the
 * strategy. Dates are formatted exactly as the renderers format them so the
 * destination-side verifier can match prose back to evidence.
 */

const MAX_NODE_EVIDENCE = 60;
const MAX_EVIDENCE_TEXT = 1_200;
const MAX_PACKET_CHARS = 60_000;

export function buildNarrativeEvidence(
  snapshot: ExecutiveReportSnapshot,
  memberDetails: readonly ReportMemberDetail[] = [],
): ReportNarrativeEvidence[] {
  const evidence: ReportNarrativeEvidence[] = [];
  const push = (id: string, sourceTitle: string, text: string | null) => {
    const cleaned = text?.replace(/\s+/g, " ").trim();
    if (!cleaned) return;
    evidence.push({ id, sourceTitle, text: clip(cleaned, MAX_EVIDENCE_TEXT) });
  };

  const strategy = snapshot.strategy;
  push(
    "plan:strategy",
    "Strategy plan",
    [
      `Strategy title: ${strategy.title}.`,
      `Strategy type: ${strategyTypeLabel(strategy.type)}.`,
      `Client: ${snapshot.client.name}.`,
      `Plan as of: ${formatDate(snapshot.asOf)}.`,
      `Target date: ${formatDate(strategy.targetDate)}.`,
      `Accountable lead: ${strategy.ownerName}.`,
      strategy.goal ? `Objective: ${strategy.goal}` : null,
      strategy.summary ? `Working summary: ${strategy.summary}` : null,
    ]
      .filter(Boolean)
      .join(" "),
  );

  const profile = snapshot.client.profile;
  if (profile) {
    push(
      "client:profile",
      "Client profile",
      [
        profile.profileType ? `Client profile type: ${profile.profileType}.` : null,
        profile.sectorTag ? `Sector: ${profile.sectorTag}.` : null,
        profile.description ? `About the client: ${profile.description}` : null,
        profile.productDescription
          ? `Product or program context: ${profile.productDescription}`
          : null,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  const health = snapshot.health;
  push(
    "plan:health",
    "Delivery readiness",
    `Delivery readiness score ${health.score} of 100 (${health.label}). ` +
      `${health.ownedNodes} of ${health.totalNodes} steps assigned to an owner. ` +
      `${health.groundedGates} of ${health.totalGates} gates grounded in evidence. ` +
      `${health.overdueNodes} step${health.overdueNodes === 1 ? "" : "s"} overdue. ` +
      `Included plan steps: ${snapshot.counts.nodes} (${snapshot.counts.actions} actions, ${snapshot.counts.decisions} decisions, ${snapshot.counts.gates} gates, ${snapshot.counts.milestones} milestones, ${snapshot.counts.risks} risks).`,
  );

  const orderedNodes = criticalNodes(snapshot, snapshot.nodes.length);
  const shownNodes = orderedNodes.slice(0, MAX_NODE_EVIDENCE);
  for (const node of shownNodes) {
    push(`plan:node:${node.id}`, `Plan step: ${node.title}`, nodeEvidence(snapshot, node));
  }
  if (orderedNodes.length > shownNodes.length) {
    push(
      "plan:nodes:more",
      "Plan steps",
      `${orderedNodes.length - shownNodes.length} additional plan steps are included in the action register but not itemised here.`,
    );
  }

  const groups = roadmap(snapshot).filter((group) => group.nodes.length > 0);
  if (groups.length > 0) {
    push(
      "plan:roadmap",
      "Delivery roadmap",
      groups
        .map(
          (group) =>
            `${group.label}: ${group.nodes.length} step${group.nodes.length === 1 ? "" : "s"} (${group.nodes
              .slice(0, 6)
              .map((node) => `${node.title}, ${dateRange(node)}`)
              .join("; ")}${group.nodes.length > 6 ? "; and others" : ""}).`,
        )
        .join(" "),
    );
  }
  const timeline = buildTimelineModel(snapshot, snapshot.nodes);
  if (timeline) {
    push(
      "plan:timeline",
      "Delivery timeline",
      `Timeline horizon: ${timelineHorizonLabel(timeline)}. ` +
        `${timeline.rows.filter((row) => row.marker).length} dated milestones or gates and ${timeline.rows.filter((row) => !row.marker).length} multi-week workstreams are drawn on the timeline.`,
    );
  }

  const agenda = leadershipAgenda(snapshot);
  if (agenda.length > 0) {
    push(
      "plan:agenda",
      "Leadership agenda",
      agenda.map((item) => `${item.title} (${item.detail}).`).join(" "),
    );
  }

  snapshot.context.sections.forEach((section) => {
    section.items.forEach((item, index) => {
      push(
        `ctx:${section.key}:${index + 1}`,
        item.sourceTitle,
        `${item.label ? `${item.label}: ` : ""}${item.text}${
          item.asOf ? ` (as of ${formatDate(item.asOf)})` : ""
        }`,
      );
    });
  });

  for (const fact of snapshot.context.facts) {
    push(
      `fact:${fact.id}`,
      fact.documentTitle,
      `${fact.text}${fact.asOf ? ` (as of ${formatDate(fact.asOf)})` : ""}`,
    );
  }

  for (const member of memberDetails) {
    push(`member:${member.memberId}`, `Member office: ${member.name}`, memberEvidence(member, snapshot));
  }

  return capPacket(evidence);
}

function nodeEvidence(snapshot: ExecutiveReportSnapshot, node: ReportNode): string {
  const parts = [
    `Plan step: ${node.title}.`,
    `Type: ${kindLabel(node.kind)}.`,
    `Status: ${statusLabel(node.status)}.`,
    `Owner: ${node.ownerName}.`,
    `Timing: ${dateRange(node)}.`,
  ];
  if (node.targetLabel) parts.push(`Stakeholder target: ${node.targetLabel}.`);
  if (node.sources.length > 0) {
    parts.push(
      `Evidence sources: ${node.sources.map((source) => source.section).join("; ")}.`,
    );
  }
  if (snapshot.options.includeInternalNotes && node.note?.trim()) {
    parts.push(`Internal note: ${node.note.trim()}`);
  }
  return parts.join(" ");
}

function memberEvidence(
  member: ReportMemberDetail,
  snapshot: ExecutiveReportSnapshot,
): string {
  const steps = snapshot.members
    .find((profile) => profile.memberId === member.memberId)
    ?.nodeIds.map((id) => snapshot.nodes.find((node) => node.id === id)?.title)
    .filter((title): title is string => Boolean(title));
  const office = member.washingtonOffice;
  const parts = [
    `Member office: ${member.name}.`,
    member.party ? `Party: ${partyLabel(member.party)}.` : null,
    member.state ? `State: ${member.state}.` : null,
    member.chamber ? `Chamber: ${member.chamber}.` : null,
    member.district ? `District: ${member.district}.` : null,
    member.committees.length > 0
      ? `Committees: ${member.committees.join("; ")}.`
      : null,
    office
      ? `Washington office: ${[office.address1, office.address2].filter(Boolean).join(", ")}, ${[office.city, office.state].filter(Boolean).join(", ")} ${office.zip ?? ""}`.trim() + "."
      : null,
    office?.phone ? `Phone: ${office.phone}.` : null,
    steps && steps.length > 0 ? `Plan steps targeting this office: ${steps.join("; ")}.` : null,
  ];
  return parts.filter(Boolean).join(" ");
}

/** Expand the Directory's party codes so prose can name the party verbatim. */
export function partyLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "d" || normalized.startsWith("dem")) return "Democratic";
  if (normalized === "r" || normalized.startsWith("rep")) return "Republican";
  if (normalized === "i" || normalized.startsWith("ind")) return "Independent";
  return value.trim();
}

function capPacket(evidence: ReportNarrativeEvidence[]): ReportNarrativeEvidence[] {
  let total = 0;
  const kept: ReportNarrativeEvidence[] = [];
  for (const entry of evidence) {
    total += entry.text.length;
    if (total > MAX_PACKET_CHARS) break;
    kept.push(entry);
  }
  return kept;
}
