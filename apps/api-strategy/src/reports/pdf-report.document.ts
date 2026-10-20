import {
  clip,
  contextItems,
  dateRange,
  decisionsAndRisks,
  evidenceItems,
  executiveSummary,
  formatDate,
  roadmap,
} from "./report-content.js";
import { kindLabel, statusLabel, strategyTypeLabel } from "./report-labels.js";
import { narrativeSection } from "./report-narrative.types.js";
import { pdfFontFaceCss } from "./pdf-fonts.js";
import {
  buildTimelineModel,
  timelineHorizonLabel,
  type TimelineModel,
} from "./report-timeline.js";
import type {
  ClientLogoAsset,
  ExecutiveReportSnapshot,
  ReportMemberDetail,
  ReportNode,
  ReportRenderExtras,
} from "./report.types.js";

/**
 * Builds the print HTML for the executive PDF. The layout mirrors the
 * reference client strategy brief one-for-one: masthead, meta grid, "In this
 * brief" band, page-broken numbered sections, stat cards, a Gantt drawn from
 * the shared timeline model, a phase-grouped plan table, risk cards, and an
 * evidence register. Content comes only from the snapshot and the verified
 * narrative; missing optional data degrades to the same deterministic fact
 * listings the DOCX renders.
 *
 * Audience redaction matches the DOCX exactly: `node.note` is internal-only
 * and renders solely when `includeInternalNotes` is on (which the policy
 * forces off for client audience); the roadmap/timeline section honors
 * `includeRoadmap`; change log and agent history render only for internal
 * audience when their flags are on. No internal surface can leak into a
 * client deliverable.
 */

const TIMELINE_MAX_ROWS = 18;

export interface PdfReportDocument {
  html: string;
  footerTemplate: string;
}

export function buildPdfReportDocument(
  snapshot: ExecutiveReportSnapshot,
  logo: ClientLogoAsset | null,
  extras: ReportRenderExtras = {},
): PdfReportDocument {
  const narrative = extras.narrative ?? null;
  const prose = (id: Parameters<typeof narrativeSection>[1]) =>
    narrativeSection(narrative, id);
  const options = snapshot.options;
  const hasEvidence = evidenceItems(snapshot).length > 0;

  const sections: string[] = [];
  const toc: Array<{ num: string; label: string }> = [];
  let sectionIndex = 0;
  // The reference brief forces a page break before every numbered section
  // heading (h2 break-before:page); each of the six sections starts a page.
  const beginSection = (label: string, title: string): string => {
    sectionIndex += 1;
    const num = String(sectionIndex).padStart(2, "0");
    toc.push({ num, label });
    return `<section class="section"><h2 class="section-label">${esc(
      `${num} · ${label}`,
    )}</h2><h3 class="section-title">${esc(title)}</h3>`;
  };

  // 01 · Recommendation — verified executive prose, else deterministic summary.
  // Starts on its own page (the cover/TOC block precedes it).
  {
    const exec = prose("executive_summary");
    const paras =
      exec.length > 0 ? exec.map((p) => p.text) : executiveSummary(snapshot);
    const cards = healthStatCards(snapshot);
    sections.push(
      beginSection("Recommendation", recommendationTitle(snapshot)) +
        paras.map((p) => `<p class="body">${esc(p)}</p>`).join("") +
        (cards.length > 0 ? statCardRow(cards) : "") +
        commitments(snapshot) +
        `</section>`,
    );
  }

  // 02 · Funding position — evidence facts with amounts, else key facts table.
  {
    const facts = evidenceItems(snapshot);
    const funded = facts.filter((f) => /\$\s?\d/.test(f.text));
    const rows = (funded.length > 0 ? funded : facts).slice(0, 12);
    sections.push(
      beginSection("Funding position", "Funding position and evidence base") +
        fundingProse(snapshot, prose("objectives_and_ask")) +
        (rows.length > 0
          ? fundingTable(rows)
          : `<p class="muted">No dated funding figures are recorded in the current evidence base.</p>`) +
        `</section>`,
    );
  }

  // Member-office profiles (includeMemberProfiles; public-record reference data).
  const memberCards = renderMemberProfiles(snapshot, extras);
  if (memberCards) {
    sections.push(
      beginSection("Stakeholder offices", "Member offices in the plan") +
        `<p class="muted">Congressional offices targeted by included plan steps. Portraits and Washington office details come from the public congressional directory.</p>` +
        memberCards +
        `</section>`,
    );
  }

  // 03 · Where the cycle stands — Gantt from the shared timeline model.
  if (options.includeRoadmap) {
    const timeline = buildTimelineModel(snapshot, snapshot.nodes, {
      maxRows: TIMELINE_MAX_ROWS,
    });
    sections.push(
      beginSection("Where the cycle stands", "Delivery timeline across the planning window") +
        (timeline
          ? `<p class="muted">${esc(
              timelineHorizonLabel(timeline),
            )} · bars follow each step's stored dates; markers mark single-day steps, gates and milestones.</p>` +
            gantt(timeline)
          : `<p class="muted">No dated plan steps are available to draw the cycle timeline.</p>`) +
        `</section>`,
    );
  }

  // 04 · Plan of action — phase-grouped step table (roadmap option).
  if (options.includeRoadmap) {
    const groups = roadmap(snapshot).filter((g) => g.nodes.length > 0);
    sections.push(
      beginSection("Plan of action", `${snapshot.counts.nodes} steps across the plan`) +
        (snapshot.nodes.length > 0
          ? planTable(snapshot, groups)
          : `<p class="muted">No plan steps are recorded.</p>`) +
        `</section>`,
    );
  }

  // 05 · Risks and decision gates — accent cards.
  {
    const items = decisionsAndRisks(snapshot);
    const gates = snapshot.nodes.filter((n) => n.kind === "gate");
    const decisionProse = prose("decisions_and_risks");
    sections.push(
      beginSection("Risks and decision gates", "Decisions, risks, and gates in the current cycle") +
        (decisionProse.length > 0
          ? decisionProse.map((p) => `<p class="body">${esc(p.text)}</p>`).join("")
          : "") +
        (items.length > 0 || gates.length > 0
          ? riskCards(snapshot, items, gates)
          : `<p class="muted">No decision points, risks, or gates are recorded in the current plan.</p>`) +
        `</section>`,
    );
  }

  // 06 · Sources and evidence — register; refs preserved as text.
  if (options.includeEvidenceAppendix) {
    const facts = evidenceItems(snapshot);
    sections.push(
      beginSection("Sources and evidence", "Sources and evidence") +
        (facts.length > 0
          ? evidenceTable(facts)
          : `<p class="muted">No source-linked evidence is available for this report.</p>`) +
        `</section>`,
    );
  }

  // Internal-only appendices: change log and agent history (audience-gated).
  if (options.audience === "internal" && options.includeChangeLog) {
    sections.push(changeLogSection(snapshot, beginSection));
  }
  if (options.audience === "internal" && options.includeAgentHistory) {
    sections.push(agentHistorySection(snapshot, beginSection));
  }

  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>${esc(`${snapshot.client.name} · ${snapshot.strategy.title}`)}</title>` +
    `<style>${pdfCss()}</style></head>` +
    `<body><div class="page">` +
    masthead(snapshot, logo) +
    `<h1 class="title">${esc(snapshot.strategy.title)}</h1>` +
    (snapshot.strategy.goal
      ? `<p class="subtitle">${esc(snapshot.strategy.goal)}</p>`
      : "") +
    metaGrid(snapshot) +
    tocBand(toc) +
    (hasEvidence ? provenanceNote() : "") +
    sections.join("") +
    closingNote(snapshot) +
    `</div></body></html>`;

  return { html, footerTemplate: footerTemplate(snapshot) };
}

/* ------------------------------------------------------------------ pieces */

function masthead(
  snapshot: ExecutiveReportSnapshot,
  logo: ClientLogoAsset | null,
): string {
  const brand = logo
    ? `<img class="logo" alt="${esc(snapshot.client.name)}" src="data:${logo.contentType};base64,${logo.bytes.toString("base64")}">`
    : `<span class="wordmark">CAPIRO</span>`;
  const tag =
    snapshot.options.audience === "internal"
      ? `Internal strategy brief · ${horizonLabel(snapshot)}`
      : `Client strategy brief · ${horizonLabel(snapshot)}`;
  return (
    `<div class="masthead">${brand}` +
    `<span class="masthead-tag">${esc(tag)}</span></div>`
  );
}

function metaGrid(snapshot: ExecutiveReportSnapshot): string {
  const cells: Array<[string, string]> = [
    ["Prepared for", snapshot.client.name],
    ["Engagement lead", snapshot.strategy.ownerName],
    ["Objective", strategyTypeLabel(snapshot.strategy.type)],
    ["Planning window", horizonLabel(snapshot)],
    ["Plan as of", formatDate(snapshot.asOf)],
    [
      "Revision",
      snapshot.version.createdAt
        ? `${formatDate(snapshot.version.createdAt)} · current`
        : "Current",
    ],
  ];
  return (
    `<div class="meta-grid">` +
    cells
      .map(
        ([label, value]) =>
          `<div class="meta-cell"><span class="meta-label">${esc(label)}</span>` +
          `<span class="meta-value">${esc(value)}</span></div>`,
      )
      .join("") +
    `</div>`
  );
}

function tocBand(toc: Array<{ num: string; label: string }>): string {
  return (
    `<div class="toc"><div class="toc-rail"><span class="toc-label">In this brief</span></div>` +
    `<div class="toc-grid">` +
    toc
      .map(
        (entry) =>
          `<span class="toc-item"><span class="toc-num">${entry.num}</span>${esc(
            entry.label,
          )}</span>`,
      )
      .join("") +
    `</div></div>`
  );
}

/** Rendered only when the register actually lists dated sources. */
function provenanceNote(): string {
  return `<p class="provenance">Figures in this brief are traced to the source documents listed in the evidence register; superseded values are excluded rather than averaged.</p>`;
}

function healthStatCards(
  snapshot: ExecutiveReportSnapshot,
): Array<{ label: string; value: string; sub: string; tone: string }> {
  const h = snapshot.health;
  const cards = [
    {
      label: "Delivery readiness",
      value: `${h.score}`,
      sub: h.label,
      tone: h.score >= 80 ? "ink" : h.score >= 60 ? "amber" : "red",
    },
    {
      label: "Plan coverage",
      value: `${h.coveragePct}%`,
      sub: `${h.ownedNodes} of ${h.totalNodes} steps owned`,
      tone: "ink",
    },
  ];
  if (h.groundingPct !== null) {
    cards.push({
      label: "Gate grounding",
      value: `${h.groundingPct}%`,
      sub: `${h.groundedGates} of ${h.totalGates} gates sourced`,
      tone: "ink",
    });
  }
  cards.push({
    label: "Plan steps",
    value: `${snapshot.counts.nodes}`,
    sub: `${snapshot.counts.gates} gates · ${snapshot.counts.risks} risks`,
    tone: "dark",
  });
  return cards.slice(0, 4);
}

function statCardRow(
  cards: Array<{ label: string; value: string; sub: string; tone: string }>,
): string {
  // Column count follows the card count so a 3-card row leaves no empty cell.
  return (
    `<div class="stat-row" style="grid-template-columns:repeat(${cards.length},1fr)">` +
    cards
      .map(
        (card) =>
          `<div class="stat stat--${card.tone}"><span class="stat-label">${esc(
            card.label,
          )}</span><span class="stat-value">${esc(card.value)}</span>` +
          `<span class="stat-sub">${esc(card.sub)}</span></div>`,
      )
      .join("") +
    `</div>`
  );
}

function commitments(snapshot: ExecutiveReportSnapshot): string {
  const items = contextItems(snapshot, ["outcomes", "ask"]).slice(0, 3);
  if (items.length === 0) return "";
  return (
    `<div class="commitments"><p class="commitments-title">Commitments for this cycle</p>` +
    items
      .map(
        (item, index) =>
          `<div class="commitment"><span class="commitment-num">${String(
            index + 1,
          ).padStart(2, "0")}</span><div class="commitment-body">` +
          (item.label ? `<strong>${esc(item.label)}.</strong> ` : "") +
          `${esc(clip(item.text, 320))}</div></div>`,
      )
      .join("") +
    `</div>`
  );
}

function fundingProse(
  snapshot: ExecutiveReportSnapshot,
  paragraphs: Array<{ text: string }>,
): string {
  if (paragraphs.length > 0) {
    return paragraphs.map((p) => `<p class="body">${esc(p.text)}</p>`).join("");
  }
  const items = contextItems(snapshot, ["situation", "timing"]).slice(0, 2);
  return items
    .map((i) => `<p class="body">${esc(clip(i.text, 500))}</p>`)
    .join("");
}

function fundingTable(
  rows: Array<{
    text: string;
    source: string;
    asOf: string | null;
    confidence: number | null;
    authority: string | null;
  }>,
): string {
  return (
    `<table class="table"><thead><tr><th>Figure</th><th class="col-source">Source</th>` +
    `<th class="col-date">As of</th></tr></thead><tbody>` +
    rows
      .map(
        (row) =>
          `<tr><td>${esc(clip(row.text, 220))}</td><td class="col-source">${esc(
            row.source,
          )}</td><td class="col-date">${esc(formatDate(row.asOf))}</td></tr>`,
      )
      .join("") +
    `</tbody></table>`
  );
}

function gantt(model: TimelineModel): string {
  const cols = model.columns;
  const head =
    `<div class="gantt"><div class="gantt-head" style="grid-template-columns:96px repeat(${cols.length},1fr)">` +
    `<span></span>` +
    cols.map((c) => `<span class="gantt-col">${esc(c.label)}</span>`).join("") +
    `</div>`;
  const rows = model.rows
    .map((row) => {
      const span = Math.max(1, row.lastColumn - row.firstColumn + 1);
      const barClass = row.marker
        ? "gantt-bar gantt-bar--marker"
        : `gantt-bar gantt-bar--${row.node.kind}`;
      return (
        `<div class="gantt-row" style="grid-template-columns:96px repeat(${cols.length},1fr)">` +
        `<span class="gantt-rowlabel">${esc(clip(row.node.title, 22))}</span>` +
        `<span class="${barClass}" style="grid-column:${row.firstColumn + 2} / span ${span}" title="${esc(
          row.node.title,
        )}">${esc(clip(row.node.title, 40))}</span></div>`
      );
    })
    .join("");
  const omitted =
    model.omittedRows > 0
      ? `<p class="muted">Showing ${model.rows.length} of ${
          model.rows.length + model.omittedRows
        } dated steps; every step appears in the plan of action.</p>`
      : "";
  return head + rows + `</div>` + omitted;
}

function planTable(
  snapshot: ExecutiveReportSnapshot,
  groups: Array<{ label: string; nodes: ReportNode[] }>,
): string {
  // Internal working notes render only when the option is on (forced off for
  // client audience by the report policy) — identical to the DOCX redaction.
  const showNotes = snapshot.options.includeInternalNotes;
  const body = groups
    .map((group) => {
      const rows = group.nodes
        .map((node) => {
          const detail =
            showNotes && node.note?.trim()
              ? `<div class="step-detail">${esc(clip(node.note, 280))}</div>`
              : "";
          return (
            `<tr><td class="col-step"><div class="step-title">${esc(
              node.title,
            )}</div>${detail}</td>` +
            `<td class="col-type">${esc(kindLabel(node.kind))}</td>` +
            `<td class="col-owner">${esc(node.ownerName)}</td>` +
            `<td class="col-window">${esc(dateRange(node))}</td>` +
            `<td class="col-status status--${esc(node.status)}">${esc(
              statusLabel(node.status),
            )}</td></tr>`
          );
        })
        .join("");
      return (
        `<tr class="phase-row"><td colspan="5">${esc(group.label)}</td></tr>` + rows
      );
    })
    .join("");
  return (
    `<table class="table table--plan"><thead><tr><th>Step</th>` +
    `<th class="col-type">Type</th><th class="col-owner">Owner</th>` +
    `<th class="col-window">Window</th><th class="col-status">Status</th></tr></thead>` +
    `<tbody>${body}</tbody></table>`
  );
}

function riskCards(
  snapshot: ExecutiveReportSnapshot,
  items: ReportNode[],
  gates: ReportNode[],
): string {
  const showNotes = snapshot.options.includeInternalNotes;
  const card = (node: ReportNode, severity: string, tone: string): string =>
    `<div class="risk risk--${tone}"><div class="risk-head"><span class="risk-title">${esc(
      node.title,
    )}</span><span class="risk-sev risk-sev--${tone}">${esc(severity)}</span></div>` +
    (showNotes && node.note?.trim()
      ? `<p class="risk-body">${esc(clip(node.note, 360))}</p>`
      : "") +
    `<p class="risk-meta">${esc(kindLabel(node.kind))} · ${esc(
      node.ownerName,
    )} · ${esc(dateRange(node))}</p></div>`;
  const risks = items
    .filter((n) => n.kind === "risk")
    .map((n) => card(n, "Risk", "high"));
  const decisions = items
    .filter((n) => n.kind === "decision")
    .map((n) => card(n, "Decision", "gate"));
  const gateCards = gates.map((n) => card(n, "Gate", "medium"));
  return [...decisions, ...risks, ...gateCards].join("");
}

function renderMemberProfiles(
  snapshot: ExecutiveReportSnapshot,
  extras: ReportRenderExtras,
): string {
  if (!snapshot.options.includeMemberProfiles) return "";
  const details = (extras.memberDetails ?? []).filter((detail) =>
    snapshot.members.some((member) => member.memberId === detail.memberId),
  );
  if (details.length === 0) return "";
  const cards = details.map((detail) => {
    const photo = extras.memberPhotos?.get(detail.memberId) ?? null;
    const office = detail.washingtonOffice;
    const officeLine = office
      ? [
          [office.address1, office.address2].filter(Boolean).join(" "),
          [office.city, office.state, office.zip].filter(Boolean).join(", "),
          office.phone,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;
    const portrait = photo
      ? `<img class="member-photo" alt="${esc(detail.name)}" src="data:${photo.contentType};base64,${photo.bytes.toString("base64")}">`
      : `<span class="member-initials">${esc(initials(detail.name))}</span>`;
    const role = [detail.party, detail.state, detail.chamber]
      .filter(Boolean)
      .join(" · ");
    return (
      `<div class="member">${portrait}<div class="member-body">` +
      `<span class="member-name">${esc(detail.name)}</span>` +
      (role ? `<span class="member-role">${esc(role)}</span>` : "") +
      (detail.committees.length > 0
        ? `<span class="member-committee">${esc(detail.committees.join(" · "))}</span>`
        : "") +
      (officeLine
        ? `<span class="member-office">${esc(officeLine)}</span>`
        : `<span class="member-office member-office--none">Directory detail was not available for this office.</span>`) +
      `</div></div>`
    );
  });
  return `<div class="member-grid">${cards.join("")}</div>`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

function evidenceTable(
  facts: Array<{
    text: string;
    source: string;
    asOf: string | null;
    confidence: number | null;
    authority: string | null;
  }>,
): string {
  return (
    `<table class="table table--evidence"><thead><tr><th class="col-num">#</th>` +
    `<th>Claim</th><th>Source document</th><th class="col-date">As of</th>` +
    `<th class="col-conf">Confidence</th><th class="col-auth">Status</th></tr></thead><tbody>` +
    facts
      .map(
        (fact, index) =>
          `<tr><td class="col-num">${index + 1}</td><td>${esc(
            clip(fact.text, 260),
          )}</td><td>${esc(fact.source)}</td>` +
          `<td class="col-date">${esc(formatDate(fact.asOf))}</td>` +
          `<td class="col-conf">${
            fact.confidence !== null
              ? esc(`${Math.round(fact.confidence * 100)}%`)
              : "—"
          }</td>` +
          `<td class="col-auth">${esc(authorityLabel(fact.authority))}</td></tr>`,
      )
      .join("") +
    `</tbody></table>`
  );
}

/** Honest provenance label: never present working material as approved. */
function authorityLabel(authority: string | null): string {
  const labels: Record<string, string> = {
    client_approved: "Client approved",
    firm_approved: "Firm approved",
    external_authoritative: "Authoritative",
    working_draft: "Working draft",
  };
  return authority ? (labels[authority] ?? titleCaseLabel(authority)) : "—";
}

function titleCaseLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function changeLogSection(
  snapshot: ExecutiveReportSnapshot,
  beginSection: (label: string, title: string) => string,
): string {
  const versions = snapshot.activity.versions;
  const rows = versions
    .map(
      (v) =>
        `<tr><td class="col-date">${esc(formatDate(v.createdAt))}</td>` +
        `<td>${esc(v.note || "—")}</td><td class="col-source">${esc(
          v.authorKind,
        )}</td></tr>`,
    )
    .join("");
  return (
    beginSection("Change log", "Version history") +
    (versions.length > 0
      ? `<table class="table"><thead><tr><th class="col-date">Date</th><th>Note</th>` +
        `<th class="col-source">Author</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="muted">No version history is recorded.</p>`) +
    `</section>`
  );
}

function agentHistorySection(
  snapshot: ExecutiveReportSnapshot,
  beginSection: (label: string, title: string) => string,
): string {
  const runs = snapshot.activity.agentRuns;
  const rows = runs
    .map(
      (run) =>
        `<tr><td class="col-date">${esc(formatDate(run.createdAt))}</td>` +
        `<td>${esc(run.trigger)}</td><td class="col-source">${esc(run.state)}</td>` +
        `<td class="col-source">${esc(run.waitingReason ?? "—")}</td></tr>`,
    )
    .join("");
  return (
    beginSection("Agent history", "Agent run history") +
    (runs.length > 0
      ? `<table class="table"><thead><tr><th class="col-date">Date</th><th>Trigger</th>` +
        `<th class="col-source">State</th><th class="col-source">Note</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="muted">No agent runs are recorded.</p>`) +
    `</section>`
  );
}

function closingNote(snapshot: ExecutiveReportSnapshot): string {
  return (
    `<p class="closing">Prepared by Capiro for ${esc(
      snapshot.client.name,
    )} · generated from the current strategy snapshot on ${esc(
      formatDate(snapshot.asOf),
    )}. Figures reflect the recorded evidence at the time of generation and may change through the cycle. Confidential and intended solely for the named client.</p>`
  );
}

function footerTemplate(snapshot: ExecutiveReportSnapshot): string {
  // Chromium header/footer template: pageNumber/totalPages are substituted by
  // the printer. Inline styles only — no stylesheet applies here.
  const left =
    snapshot.options.audience === "internal"
      ? `Capiro · Internal working copy · ${snapshot.client.name}`
      : `Capiro · Prepared for ${snapshot.client.name}`;
  const center =
    snapshot.options.audience === "internal"
      ? "Confidential · Internal working copy"
      : "Confidential · Client deliverable";
  const right = `Generated ${formatDate(snapshot.asOf)}`;
  return (
    `<div style="width:100%;display:flex;align-items:center;justify-content:space-between;` +
    `gap:16px;padding:6px 50px 0;border-top:1px solid #E4E7EC;font-family:Inter,sans-serif;` +
    `font-size:7.5px;letter-spacing:.04em;text-transform:uppercase;color:#98A2B3;">` +
    `<span style="font-weight:600;color:#475467;">${esc(left)}</span>` +
    `<span>${esc(center)} · <span class="pageNumber"></span>/<span class="totalPages"></span></span>` +
    `<span>${esc(right)}</span></div>`
  );
}

/* ------------------------------------------------------------------ labels */

function recommendationTitle(snapshot: ExecutiveReportSnapshot): string {
  // Render the full goal — the section title wraps and must not truncate a
  // sentence mid-clause ("...by November…").
  return snapshot.strategy.goal ?? snapshot.strategy.title;
}
function horizonLabel(snapshot: ExecutiveReportSnapshot): string {
  // The strategy's own target date is the planning window for every audience;
  // reference-window FY metadata is internal-only and must not shadow it.
  if (snapshot.strategy.targetDate) {
    return `Through ${formatDate(snapshot.strategy.targetDate)}`;
  }
  const window = snapshot.referenceWindows.find((w) => w.fy);
  if (window?.fy) return `FY${window.fy}`;
  return `As of ${formatDate(snapshot.asOf)}`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* --------------------------------------------------------------------- css */

function pdfCss(): string {
  return `${pdfFontFaceCss()}
*{margin:0;padding:0;box-sizing:border-box}
@page{size:letter;margin:0.7in}
body{font-family:Inter,system-ui,-apple-system,sans-serif;color:#344054;font-size:14px;line-height:1.62;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:100%}
.logo{display:block;height:22px;width:auto}
.wordmark{font-size:15px;font-weight:700;letter-spacing:.18em;color:#101828}
.masthead{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding-bottom:18px;border-bottom:2px solid #101828}
.masthead-tag{font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#667085}
.title{margin:36px 0 0;font-size:34px;line-height:1.12;letter-spacing:-.025em;font-weight:600;color:#101828}
.subtitle{margin:16px 0 0;max-width:34em;font-size:17px;line-height:1.5;color:#475467}
.meta-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;margin-top:36px;background:#E4E7EC;border:1px solid #E4E7EC;break-inside:avoid}
.meta-cell{background:#fff;padding:14px 16px}
.meta-label{display:block;font-size:9.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#98A2B3}
.meta-value{display:block;margin-top:5px;font-size:14px;font-weight:600;color:#101828}
.toc{display:flex;gap:28px;margin-top:32px;padding:22px 24px;background:#F9FAFB;border:1px solid #E4E7EC;break-inside:avoid}
.toc-rail{flex:none;width:150px}
.toc-label{display:block;font-size:9.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#667085}
.toc-grid{flex:1;min-width:0;display:grid;grid-template-columns:repeat(2,1fr);gap:8px 28px;font-size:13px;color:#344054}
.toc-item{display:flex;gap:10px}
.toc-num{color:#98A2B3;font-variant-numeric:tabular-nums}
.provenance{margin-top:24px;max-width:40em;font-size:12px;line-height:1.6;color:#667085}
.section{margin-top:34px}
.section{break-before:page}
.section-label{margin:0;padding-top:2px;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#294E68;break-after:avoid}
.section-title{margin:12px 0 0;font-size:24px;line-height:1.2;letter-spacing:-.02em;font-weight:600;color:#101828;break-after:avoid}
.body{margin:16px 0 0;max-width:38em}
.muted{margin:14px 0 0;max-width:46em;font-size:12px;line-height:1.6;color:#98A2B3}
.stat-row{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;margin-top:26px;background:#E4E7EC;border:1px solid #E4E7EC;break-inside:avoid}
.stat{background:#fff;padding:16px}
.stat--dark{background:#101828}
.stat--dark .stat-label,.stat--dark .stat-sub{color:#98A2B3}
.stat--dark .stat-value{color:#fff}
.stat-label{display:block;font-size:9.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#667085}
.stat-value{display:block;margin-top:8px;font-size:23px;font-weight:600;letter-spacing:-.02em;color:#101828;font-variant-numeric:tabular-nums}
.stat--red .stat-value{color:#B42318}
.stat--amber .stat-value{color:#B54708}
.stat-sub{display:block;margin-top:4px;font-size:11px;color:#98A2B3}
.commitments{margin-top:28px;break-inside:avoid}
.commitments-title{font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#294E68}
.commitment{display:flex;gap:16px;margin-top:12px;padding:16px 18px;background:#fff;border:1px solid #E4E7EC;break-inside:avoid}
.commitment-num{font-size:13px;font-weight:600;color:#98A2B3;font-variant-numeric:tabular-nums}
.commitment-body{font-size:13.5px;line-height:1.55;color:#344054}
.table{width:100%;margin-top:22px;border-collapse:collapse;font-size:13px}
.table th{text-align:left;padding:0 12px 8px 0;border-bottom:1px solid #101828;font-size:9.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#667085}
.table td{padding:11px 12px 11px 0;border-bottom:1px solid #E4E7EC;vertical-align:top;color:#344054}
.table thead{display:table-header-group}
.table tr{break-inside:avoid}
.col-source{color:#475467;width:30%}
.col-date{width:88px;white-space:nowrap;color:#475467}
.col-num{width:26px;color:#98A2B3;font-variant-numeric:tabular-nums}
.col-conf{width:84px;text-align:right;font-variant-numeric:tabular-nums;color:#067647}
.col-auth{width:110px;text-align:right;font-size:11px;color:#667085}
.col-type{width:74px}
.col-owner{width:104px}
.col-window{width:120px;white-space:nowrap}
.col-status{width:96px;font-weight:600}
.step-title{font-weight:600;color:#101828}
.step-detail{margin-top:3px;font-size:12px;color:#667085;line-height:1.5}
.phase-row td{padding:14px 0 6px;border-bottom:1px solid #101828;font-size:9.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#294E68}
.status--in_progress,.status--active{color:#294E68}
.status--completed{color:#067647}
.status--suggested,.status--draft,.status--internal_review{color:#667085}
.gantt{margin-top:18px;break-inside:avoid}
.gantt-head{display:grid;gap:0;padding:0 0 6px;border-bottom:1px solid #101828}
.gantt-col{font-size:9px;font-weight:600;letter-spacing:.04em;color:#98A2B3;text-align:center}
.gantt-row{display:grid;align-items:center;gap:5px 0;padding:10px 0 8px;border-bottom:1px solid #E4E7EC}
.gantt-rowlabel{grid-column:1;font-size:11px;font-weight:600;color:#475467;padding-right:8px}
.gantt-bar{height:22px;display:flex;align-items:center;padding:0 8px;margin-right:2px;background:#101828;color:#fff;font-size:9.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:2px}
.gantt-bar--action{background:#294E68}
.gantt-bar--decision{background:#101828}
.gantt-bar--gate,.gantt-bar--milestone{background:#B54708}
.gantt-bar--risk{background:#B42318}
.gantt-bar--marker{background:#EDF3F7;color:#294E68}
.member-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-top:18px}
.member{display:flex;gap:14px;padding:16px;background:#fff;border:1px solid #E4E7EC;break-inside:avoid}
.member-photo{flex:none;width:52px;height:64px;object-fit:cover;border-radius:3px;background:#EDF3F7}
.member-initials{flex:none;width:52px;height:64px;display:flex;align-items:center;justify-content:center;background:#EDF3F7;color:#294E68;font-size:16px;font-weight:600;border-radius:3px}
.member-body{display:flex;flex-direction:column;min-width:0}
.member-name{font-size:13.5px;font-weight:600;color:#101828}
.member-role{margin-top:2px;font-size:11px;color:#667085}
.member-committee{margin-top:3px;font-size:11px;color:#475467}
.member-office{margin-top:5px;font-size:10.5px;line-height:1.5;color:#98A2B3}
.member-office--none{font-style:italic}
.risk{margin-top:14px;padding:18px 20px;background:#fff;border:1px solid #E4E7EC;break-inside:avoid}
.risk--high{border-left:3px solid #F04438}
.risk--medium{border-left:3px solid #F79009}
.risk--gate{border-left:3px solid #101828}
.risk-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px}
.risk-title{font-size:14px;font-weight:600;color:#101828}
.risk-sev{font-size:9.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.risk-sev--high{color:#B42318}
.risk-sev--medium{color:#B54708}
.risk-sev--gate{color:#101828}
.risk-body{margin-top:8px;font-size:13px;line-height:1.55;color:#475467}
.risk-meta{margin-top:8px;font-size:11px;color:#98A2B3}
.closing{margin:26px 0 0;padding-top:16px;border-top:1px solid #E4E7EC;font-size:11.5px;line-height:1.6;color:#98A2B3;max-width:46em}
`;
}
