/**
 * Pure, dependency-free helpers for Meri Deep Research.
 *
 * Everything in this file is a pure function so it can be unit-tested under the
 * repo's standard `src/**.spec.ts` jest matcher (jest does NOT scan `scripts/`).
 * The orchestrating service (`meri-research.service.ts`) imports these; keep all
 * I/O, Prisma, and HTTP out of here.
 *
 * The research flow has four phases, surfaced to the client as SSE `phase`
 * events:
 *   plan        -> model proposes a research plan + clarifying questions
 *   clarify     -> user answers the clarifying questions (no model call here)
 *   gather      -> agentic multi-round tool loop (all 22 internal tools + web)
 *   synthesize  -> long, cited report streamed as text + persisted artifact
 */

import {
  MERI_GROUNDING_INVARIANT,
  meriGroundingSurfaceBlock,
  meriGroundingDateBlock,
} from '@capiro/shared';

export type ResearchPhase = 'plan' | 'clarify' | 'gather' | 'synthesize' | 'done' | 'error';

export interface PlanProposal {
  /** Short title for the research session (<= 120 chars). */
  title: string;
  /** Ordered list of sub-questions / angles the report will cover. */
  plan: string[];
  /** Clarifying questions to ask the lobbyist before gathering. */
  clarifyingQuestions: string[];
}

/** Hard caps so a misbehaving model can't blow up the UI or the prompt budget. */
export const MAX_PLAN_ITEMS = 8;
export const MAX_CLARIFYING_QUESTIONS = 6;
export const MAX_TITLE_CHARS = 120;

/**
 * System prompt for the PLAN phase. The model returns STRICT JSON describing the
 * plan + clarifying questions. We deliberately ask for questions a senior GA
 * analyst would ask: scope (federal vs state), time horizon, the client's angle,
 * desired deliverable shape, and any specific bills/agencies/PEs to anchor on.
 */
export function buildPlanSystemPrompt(productName: string): string {
  return [
    `You are ${productName}, a senior federal government-affairs research analyst at a top-tier lobbying firm.`,
    'A lobbyist has asked you to produce a deep research report. Before you research, you plan.',
    '',
    'Return ONLY a single JSON object (no prose, no markdown fences) with this exact shape:',
    '{',
    '  "title": string,                  // <=120 chars, a precise title for this research',
    '  "plan": string[],                 // 4-8 concrete sub-questions / angles the report will answer',
    '  "clarifyingQuestions": string[]   // 3-6 questions to ask the lobbyist first',
    '}',
    '',
    'Good clarifying questions a senior analyst asks: scope (federal/state/both), time horizon,',
    'which client or interest this serves, the decision the report will inform, specific',
    'bills/agencies/program elements/companies to anchor on, and the deliverable format',
    '(memo, board brief, one-pager, talking points). Do NOT ask questions answerable from the topic alone.',
  ].join('\n');
}

export function buildPlanUserPrompt(topic: string, clientContext: string | null): string {
  const parts = [`Research topic from the lobbyist:\n${topic.trim()}`];
  if (clientContext && clientContext.trim()) {
    parts.push(
      `\nThis research is associated with the following client context:\n${clientContext.trim()}`,
    );
  }
  parts.push('\nProduce the plan JSON now.');
  return parts.join('\n');
}

/**
 * Parse the model's PLAN-phase JSON. Tolerant: strips markdown fences, finds the
 * first {...} block, and clamps every field. Never throws — returns a safe
 * fallback plan so the flow can continue even if the model misbehaves.
 */
export function parsePlanProposal(raw: string, topic: string): PlanProposal {
  const fallback: PlanProposal = {
    title: clampTitle(topic),
    plan: [
      'What is the current status and recent activity on this topic?',
      'Who are the key players (sponsors, agencies, committees, contractors)?',
      'What is the legislative / regulatory / budget landscape?',
      'What are the risks, opportunities, and likely trajectory?',
    ],
    clarifyingQuestions: [
      'Is this for a specific client, and if so which interest does it serve?',
      'What decision will this report inform, and by when?',
      'Should this focus on federal, state, or both?',
    ],
  };

  const json = extractFirstJsonObject(raw);
  if (!json) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object') return fallback;
  const obj = parsed as Record<string, unknown>;

  const title =
    typeof obj.title === 'string' && obj.title.trim() ? clampTitle(obj.title) : fallback.title;
  const plan = sanitizeStringList(obj.plan, MAX_PLAN_ITEMS);
  const clarifyingQuestions = sanitizeStringList(obj.clarifyingQuestions, MAX_CLARIFYING_QUESTIONS);

  return {
    title,
    plan: plan.length ? plan : fallback.plan,
    clarifyingQuestions: clarifyingQuestions.length
      ? clarifyingQuestions
      : fallback.clarifyingQuestions,
  };
}

/**
 * System prompt for the GATHER + SYNTHESIZE phases. The model runs an agentic
 * tool loop, then writes the report. We instruct it to prefer internal Capiro
 * data tools first and use the web only to supplement, to cite every claim, and
 * to produce a structured, decision-grade report.
 */
export function buildResearchSystemPrompt(productName: string): string {
  return [
    // Zero-trust grounding kernel (v3 plan Wave 1) FIRST — deep research is the
    // most dangerous surface (the report outlives the chat and was self-audited
    // against nothing), so it gets the closed-world rule, refusal protocol,
    // FORM-B citation grammar, GR domain semantics, numeric integrity,
    // uncertainty ladder, advice gate, and self-check up top, then the strict
    // research surface block.
    MERI_GROUNDING_INVARIANT,
    meriGroundingSurfaceBlock('research'),
    meriGroundingDateBlock(new Date().toISOString()),
    '',
    `You are ${productName}, a senior federal government-affairs research analyst.`,
    'You are producing a DEEP RESEARCH REPORT for a lobbyist. You have tools that query',
    "your firm's internal intelligence (lobbying disclosures, bills, hearings, rules, contracts,",
    'SEC/FARA filings, GAO/CRS reports, federal spending, grants, economic data, the client',
    'context) and tools that search and read the public web.',
    '',
    'METHOD:',
    '1. Work through the research plan systematically. For each angle, call the most relevant',
    '   tools. ALWAYS prefer internal data tools first; use web search/scrape only to',
    '   supplement or to cover what internal data cannot.',
    '2. Be efficient: a few targeted tool calls per angle is enough — do NOT keep searching',
    '   indefinitely. Once you have enough to support the sections, STOP calling tools.',
    '3. Then WRITE the full report as your final message (plain assistant text, no tool call).',
    '   You MUST end the run by producing the written report — never finish on a tool call.',
    '   When you must synthesize with no further tool calls, use ONLY facts already retrieved in',
    '   this run, each with its FORM-B token; if the evidence is thin, say so, name the gaps in the',
    '   "Not found in retrieval" section, and stop — a shorter grounded report beats a',
    '   complete-looking ungrounded one. Do NOT write a section from background knowledge.',
    '',
    'REPORT REQUIREMENTS:',
    '- Open with an Executive Summary (3-6 tight bullets a principal can act on); every summary',
    '  claim must also appear, with its token, in the body and may not upgrade certainty.',
    '- Use clear markdown section headers that follow the research plan.',
    '- Cite EVERY material claim with a FORM-B token [S:tool_name:record_id] as defined above.',
    '  Free-form labels like [LDA], [Congress.gov], [GAO] validate against nothing and are',
    '  forbidden. Never fabricate data or citations.',
    '- Distinguish facts (from tools) from your analysis; label inferences "Inference (not in data):".',
    '- Include a "Not found in retrieval" section listing every search that returned zero or unusable',
    '  results (tool, arguments, outcome) using the exact refusal phrase.',
    '- Close with "Recommended Actions" (concrete next steps, each tracing to cited facts) and',
    '  "Open Questions / Gaps" (every L3/L4 gap bearing on the strategy).',
    '- Be thorough. This is a long-form report, not a chat reply.',
  ].join('\n');
}

/**
 * Compose the GATHER-phase first user turn: the topic, the approved plan, and the
 * lobbyist's answers to the clarifying questions. This is the model's marching
 * orders for the agentic loop.
 */
export function buildResearchUserPrompt(input: {
  topic: string;
  plan: string[];
  clarifyingQuestions: string[];
  clarifyingAnswers: Record<string, string>;
  clientContext: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`RESEARCH TOPIC:\n${input.topic.trim()}`);

  if (input.clientContext && input.clientContext.trim()) {
    lines.push(`\nCLIENT CONTEXT:\n${input.clientContext.trim()}`);
  }

  if (input.plan.length) {
    lines.push('\nAPPROVED RESEARCH PLAN:');
    input.plan.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
  }

  const qa = formatClarifyingQa(input.clarifyingQuestions, input.clarifyingAnswers);
  if (qa) {
    lines.push('\nLOBBYIST CLARIFICATIONS:');
    lines.push(qa);
  }

  lines.push(
    '\nResearch this thoroughly using your tools, then write the full report. Begin by gathering evidence.',
  );
  return lines.join('\n');
}

/** Pair each clarifying question with its answer (skip unanswered ones). */
export function formatClarifyingQa(questions: string[], answers: Record<string, string>): string {
  const out: string[] = [];
  questions.forEach((q, i) => {
    const a = answers[String(i)] ?? answers[i as unknown as string];
    if (typeof a === 'string' && a.trim()) {
      out.push(`Q: ${q}\nA: ${a.trim()}`);
    }
  });
  return out.join('\n\n');
}

/**
 * Build the persisted artifact body from the streamed report text. Prepends a
 * provenance header (title, date, plan, sources) so the saved artifact is
 * self-contained and audit-friendly even when opened outside the chat.
 */
export function assembleReportArtifact(input: {
  title: string;
  topic: string;
  plan: string[];
  reportBody: string;
  sources: Array<{ label?: string; tool?: string; summary?: string; count?: number | null }>;
  generatedAt: Date;
}): string {
  const header: string[] = [];
  header.push(`# ${input.title}`);
  header.push('');
  header.push(`*Deep research report · generated ${input.generatedAt.toISOString().slice(0, 10)}*`);
  header.push('');
  header.push(`**Topic:** ${input.topic.trim()}`);
  header.push('');

  const body = input.reportBody.trim() || '_No report content was generated._';

  const sourceLines = dedupeSources(input.sources);
  const footer: string[] = [];
  if (sourceLines.length) {
    footer.push('');
    footer.push('---');
    footer.push('');
    footer.push('## Sources consulted');
    footer.push('');
    for (const s of sourceLines) footer.push(`- ${s}`);
  }

  return [...header, body, ...footer].join('\n');
}

/** Human-readable, de-duplicated list of the sources used during gathering. */
export function dedupeSources(
  sources: Array<{ label?: string; tool?: string; summary?: string; count?: number | null }>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sources) {
    const name = (s.label || s.tool || '').trim();
    if (!name) continue;
    const detail = (s.summary || '').trim();
    const line = detail ? `${name} — ${detail}` : name;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/**
 * Record-boundary-safe JSON summarizer for feeding tool results back to the
 * model. Mirrors the Meri drawer's `summarizeJsonForPrompt`: for arrays, drops
 * WHOLE elements from the end until it fits (never splits a record mid-token);
 * otherwise line-safe truncates. Kept here (pure) so it is unit-tested and
 * reused by the research service without coupling to meri.service.ts internals.
 */
export function summarizeJsonForPrompt(value: unknown, maxChars = 12_000): string {
  try {
    if (Array.isArray(value)) {
      const records = [...value];
      let dropped = 0;
      while (records.length > 0) {
        const text = JSON.stringify(records, null, 2);
        if (text && text.length <= maxChars) {
          return dropped > 0
            ? `${text}\n... [${dropped} more record(s) omitted to fit context budget]`
            : text;
        }
        records.pop();
        dropped += 1;
      }
      return truncateText(JSON.stringify(value, null, 2), maxChars);
    }
    const text = JSON.stringify(value, null, 2);
    if (!text) return '';
    return truncateText(text, maxChars);
  } catch {
    return '';
  }
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars);
  let cut = window.lastIndexOf('\n');
  if (cut < maxChars * 0.5) {
    const space = window.lastIndexOf(' ');
    if (space > cut) cut = space;
  }
  if (cut <= 0) cut = maxChars;
  const omitted = text.length - cut;
  return `${text.slice(0, cut)}\n... [truncated ${omitted} chars at a safe boundary]`;
}

/** Human-friendly action label for a tool name, shown in the research timeline. */
export function humanToolLabel(tool: string): string {
  const labels: Record<string, string> = {
    get_client_context: 'Loaded client context',
    search_research_sources: 'Searched workspace records',
    query_intelligence: 'Pulled federal lobbying intelligence',
    search_congress_bills: 'Searched congressional bills',
    search_lda_filings: 'Searched LDA lobbying filings',
    search_sec_filings: 'Searched SEC filings',
    search_fara_registrations: 'Searched FARA registrations',
    search_federal_grants: 'Searched federal grants',
    search_gao_reports: 'Searched GAO reports',
    search_state_bills: 'Searched state bills',
    get_state_bill_status: 'Looked up a state bill status',
    search_state_floor_votes: 'Searched state floor votes',
    get_state_legislator: 'Looked up a state legislator',
    search_intel_articles: 'Searched policy news',
    search_committee_hearings: 'Searched committee hearings',
    search_crs_reports: 'Searched CRS reports',
    query_economic_data: 'Queried economic data',
    search_public_web: 'Searched the public web',
    scrape_web_page: 'Read a web page',
    create_meeting_brief: 'Created a meeting brief',
    draft_policy_memo: 'Drafted a policy memo',
    save_note: 'Saved a note',
    send_email: 'Sent an email',
    list_emails: 'Listed email threads',
    search_emails: 'Searched emails',
    reply_email: 'Replied to an email thread',
  };
  return labels[tool] ?? tool.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Count + human detail from a tool result, for the research source timeline. */
export function summarizeToolResultForTrust(payload: unknown): {
  count: number | null;
  detail: string;
} {
  if (!payload || typeof payload !== 'object') return { count: null, detail: '' };
  const rec = payload as Record<string, unknown>;
  if (typeof rec.error === 'string') return { count: null, detail: rec.error };

  const rows = Array.isArray(rec.data)
    ? (rec.data as unknown[])
    : Array.isArray(rec.results)
      ? (rec.results as unknown[])
      : null;
  const total = typeof rec.total === 'number' ? rec.total : rows ? rows.length : null;

  if (rows && rows.length) {
    const sample = rows
      .slice(0, 3)
      .map((r) => {
        if (r && typeof r === 'object') {
          const o = r as Record<string, unknown>;
          const label =
            o.title ??
            o.name ??
            o.subject ??
            o.companyName ??
            o.registrantName ??
            o.identifier ??
            o.billNumber;
          if (typeof label === 'string')
            return label.length > 60 ? `${label.slice(0, 57)}…` : label;
        }
        return null;
      })
      .filter((x): x is string => Boolean(x));
    const head =
      total != null ? `${total} result${total === 1 ? '' : 's'}` : `${rows.length} result(s)`;
    return { count: total, detail: sample.length ? `${head}: ${sample.join('; ')}` : head };
  }

  if (typeof rec.data === 'string' && rec.data.trim()) {
    const text = rec.data.trim();
    return { count: null, detail: text.length > 100 ? `${text.slice(0, 97)}…` : text };
  }
  return { count: total, detail: total != null ? `${total} result(s)` : 'Completed' };
}

/* ── internal pure utilities ─────────────────────────────────────────────── */

/**
 * Render a markdown research report to a Microsoft Word–openable HTML document.
 *
 * We deliberately emit a Word-compatible HTML `.doc` (the classic MS Office HTML
 * format with the `urn:schemas-microsoft-com:office` namespace) rather than a
 * binary `.docx`. Word opens this natively with full heading/bold/list/link
 * formatting, and it needs ZERO new dependencies — important because adding a
 * docx library here would require a fresh install in a locked environment.
 * The bytes are served with a `.doc` filename + msword content type.
 */
export function renderReportToWordHtml(input: { title: string; markdown: string }): string {
  const body = markdownToHtml(input.markdown);
  const safeTitle = escapeHtml(input.title || 'Research report');
  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
  @page { size: 8.5in 11in; margin: 1in; }
  body { font-family: 'Calibri', 'Segoe UI', Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; }
  h1 { font-size: 22pt; color: #00236e; margin: 0 0 4pt; }
  h2 { font-size: 15pt; color: #00236e; margin: 18pt 0 6pt; border-bottom: 1px solid #d6dbe7; padding-bottom: 2pt; }
  h3 { font-size: 12.5pt; color: #1c2e4a; margin: 14pt 0 4pt; }
  p { margin: 0 0 8pt; }
  ul, ol { margin: 0 0 8pt 0; padding-left: 24pt; }
  li { margin: 0 0 3pt; }
  a { color: #1d4ed8; }
  hr { border: none; border-top: 1px solid #d6dbe7; margin: 14pt 0; }
  .doc-meta { color: #6b7280; font-size: 9.5pt; margin: 0 0 14pt; }
  code { font-family: 'Consolas', monospace; background: #f3f4f6; padding: 0 2pt; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 10.5pt; }
  th, td { border: 1px solid #b8c0d0; padding: 4pt 7pt; text-align: left; vertical-align: top; }
  th { background: #eef1f7; color: #00236e; font-weight: 700; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * Render a markdown research report to a clean, branded, printable HTML page for
 * "open in a new browser tab". Self-contained (inline CSS), no external assets.
 */
export function renderReportToBrowserHtml(input: { title: string; markdown: string }): string {
  const body = markdownToHtml(input.markdown);
  const safeTitle = escapeHtml(input.title || 'Research report');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
  :root { --navy:#00236e; --ink:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; }
  * { box-sizing: border-box; }
  body { margin:0; background:#f5f6f8; color:var(--ink); font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; line-height:1.62; }
  .wrap { max-width:820px; margin:0 auto; padding:48px 24px 96px; }
  .topbar { background:var(--navy); color:#fff; padding:14px 24px; font-weight:600; letter-spacing:.3px; position:sticky; top:0; }
  .topbar .kicker { opacity:.8; font-weight:500; font-size:13px; margin-left:8px; }
  .paper { background:#fff; border:1px solid var(--line); border-radius:14px; padding:48px 56px; box-shadow:0 1px 3px rgba(16,24,40,.06); }
  h1 { font-size:30px; color:var(--navy); margin:0 0 6px; line-height:1.2; }
  h2 { font-size:20px; color:var(--navy); margin:32px 0 10px; border-bottom:1px solid var(--line); padding-bottom:6px; }
  h3 { font-size:16px; color:#1c2e4a; margin:22px 0 6px; }
  p { margin:0 0 12px; }
  ul,ol { margin:0 0 12px; padding-left:26px; }
  li { margin:0 0 5px; }
  a { color:#1d4ed8; }
  hr { border:none; border-top:1px solid var(--line); margin:22px 0; }
  .doc-meta { color:var(--muted); font-size:13px; margin:0 0 22px; }
  code { font-family:Consolas,monospace; background:#f3f4f6; padding:1px 4px; border-radius:4px; font-size:.92em; }
  table { border-collapse:collapse; width:100%; margin:14px 0; font-size:14px; }
  th,td { border:1px solid var(--line); padding:8px 12px; text-align:left; vertical-align:top; }
  th { background:#eef1f7; color:var(--navy); font-weight:600; }
  tbody tr:nth-child(even) { background:#fafbfc; }
  @media print { .topbar{position:static} .paper{border:none;box-shadow:none;padding:0;border-radius:0} body{background:#fff} .wrap{padding:0} }
</style>
</head>
<body>
<div class="topbar">Meri<span class="kicker">Deep Research</span></div>
<div class="wrap"><article class="paper">${body}</article></div>
</body>
</html>`;
}

/**
 * Minimal, safe markdown → HTML converter (no dependency). Supports the subset
 * the report uses: #/##/### headings, **bold**, *italic*, `code`, bullet and
 * numbered lists, --- rules, [text](url) links, and paragraphs. All raw text is
 * HTML-escaped first so model output can never inject markup.
 */
export function markdownToHtml(markdown: string): string {
  const escaped = escapeHtml(markdown ?? '');
  const lines = escaped.split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inlineMd(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '');
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }
    // GFM table: a header row of pipes followed by a delimiter row like
    // | --- | :--: |. Detect and consume the whole block here so cells render as
    // a real <table> instead of raw pipes. All cell text goes through inlineMd
    // (which only runs on already-escaped text), so this stays injection-safe.
    if (isTableHeader(trimmed, lines[i + 1])) {
      flushParagraph();
      closeList();
      const consumed = renderTable(lines, i);
      out.push(consumed.html);
      i = consumed.nextIndex - 1; // loop's i++ advances to nextIndex
      continue;
    }
    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      flushParagraph();
      closeList();
      out.push('<hr />');
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(6, heading[1]!.length);
      out.push(`<h${level}>${inlineMd(heading[2]!)}</h${level}>`);
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${inlineMd(bullet[1]!)}</li>`);
      continue;
    }
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      flushParagraph();
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${inlineMd(numbered[1]!)}</li>`);
      continue;
    }
    // plain text — accumulate into the current paragraph
    closeList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  closeList();
  return out.join('\n');
}

/**
 * GFM table support. A table is a header row of `| a | b |` immediately
 * followed by a delimiter row of dashes/colons (`| --- | :--: |`). Returns the
 * rendered <table> HTML and the index of the first line AFTER the table.
 * Cell text is run through inlineMd (escaped-text-only), so it stays XSS-safe.
 */
function isTableHeader(headerLine: string, delimLine: string | undefined): boolean {
  if (delimLine === undefined) return false;
  if (!headerLine.includes('|')) return false;
  const d = delimLine.trim();
  // delimiter row: pipes, dashes, optional colons, spaces only; at least one dash
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(d) && d.includes('-');
}

function splitTableRow(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // split on unescaped pipes
  return s.split(/\s*(?<!\\)\|\s*/).map((c) => c.replace(/\\\|/g, '|').trim());
}

function renderTable(lines: string[], start: number): { html: string; nextIndex: number } {
  const headers = splitTableRow(lines[start]!);
  const cols = headers.length;
  let i = start + 2; // skip header + delimiter
  const bodyRows: string[][] = [];
  for (; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t || !t.includes('|')) break;
    const cells = splitTableRow(lines[i]!);
    while (cells.length < cols) cells.push('');
    bodyRows.push(cells.slice(0, cols));
  }
  const thead =
    '<thead><tr>' + headers.map((h) => `<th>${inlineMd(h)}</th>`).join('') + '</tr></thead>';
  const tbody =
    '<tbody>' +
    bodyRows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('') +
    '</tbody>';
  return { html: `<table>${thead}${tbody}</table>`, nextIndex: i };
}

/** Inline markdown: bold, italic, code, links. Operates on already-escaped text. */
function inlineMd(text: string): string {
  return (
    text
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      // [label](http...) — url already escaped; only allow http(s) to avoid javascript: injection
      .replace(
        /\[([^\]]+)\]\((https?:&#x2F;&#x2F;[^)]+|https?:\/\/[^)]+)\)/g,
        (_m, label: string, url: string) => {
          const cleanUrl = url.replace(/&#x2F;/g, '/');
          return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        },
      )
  );
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

export function clampTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_TITLE_CHARS) return clean || 'Research report';
  return `${clean.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}

/** Coerce an unknown value into a clean string[] capped at `max` items. */
export function sanitizeStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Extract the first balanced {...} JSON object from a string that may contain
 * markdown fences or leading/trailing prose. Returns null if none found.
 */
export function extractFirstJsonObject(raw: string): string | null {
  if (!raw) return null;
  const text = raw.replace(/```json/gi, '').replace(/```/g, '');
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
