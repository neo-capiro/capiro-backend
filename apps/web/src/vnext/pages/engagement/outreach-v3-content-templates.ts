import type { OutreachV3ContextSelection } from '../../../pages/engagement/outreach/v3/contracts.js';
import type { OutreachWorkflowTemplateId } from './outreach-v3-guided-workflow.js';

/**
 * A recurring-update or meeting-request content template. The sample text
 * below is a STRUCTURE AND TONE reference only. `contentTemplateContextSelection`
 * explicitly instructs generation not to copy any of the sample's specific
 * facts (names, dates, dollar figures, the placeholder client name) — only
 * the campaign's own selected context ever supplies real facts.
 */
export interface OutreachContentTemplateDefinition {
  id: string;
  workflowId: OutreachWorkflowTemplateId;
  eyebrow: string;
  title: string;
  description: string;
  sampleSubject: string;
  sampleBody: string;
}

const MEETING_REQUEST_TEMPLATE: OutreachContentTemplateDefinition = {
  id: 'meeting_request_standard',
  workflowId: 'request_meeting',
  eyebrow: 'Meeting request',
  title: 'Briefing meeting request',
  description:
    'A concise, personalized request for a short meeting, citing one concrete, real reason tied to the recipient’s committee, district, or prior interest — never an invented connection.',
  sampleSubject: 'Meeting request: [Topic] briefing',
  sampleBody: `Dear [Staff name / Representative name],

I'm writing on behalf of [Sponsor client] to request a brief meeting to discuss [topic] and its relevance to [Member]'s work on [committee or issue].

Why this matters to your office
[One or two sentences citing a specific, real connection — committee assignment, prior legislative interest, district or state impact, or a program element — drawn only from this campaign's own selected context. Never invent a connection that isn't supported by the record.]

What we'd cover
A focused 15–20 minute conversation on [topic], with the option to follow up with additional materials afterward.

Availability
We're glad to work around your schedule — mornings or early afternoons the week of [date range] would work well on our end, but we'll follow your team's lead.

Thank you for considering this request. Please let us know a few times that would work, or point us to whoever handles scheduling for [Member].

Best regards,
[Sender name]
[Sponsor client]`,
};

const SEND_UPDATE_TEMPLATES: OutreachContentTemplateDefinition[] = [
  {
    id: 'hearings_week_ahead',
    workflowId: 'send_update',
    eyebrow: 'Weekly digest',
    title: 'Hearings & markup week-ahead',
    description:
      'Committee hearings and markups in the coming week that touch the sponsor’s watched committees, program elements, bills, or issue tags — split by chamber, with a Monday-refresh rule for only what changed.',
    sampleSubject: 'Week ahead — hearings & markups (Aug 25–29) · 6 on your watch',
    sampleBody: `Bottom line
Six sessions in the next seven days touch watched defense and intel equities. Two are markups. Three map to a watched program element or bill. No assumption that streams are recordable unless marked below.

HOUSE
Mon Aug 25 · 10:00 ET · HASC Tactical Air & Land
Hearing: FY2027 aviation sustainment and munitions industrial base
Why it matters: Touches watched program elements; issue tags munitions, industrial base.
Witnesses (as posted): OSD AT&L, Army PEO, industry panel TBD.
Live: browser page only · Packet: Open hearing packet · Prep: Generate meeting prep

Tue Aug 26 · 14:00 ET · HAC-D
Markup: FY2027 Defense Appropriations — procurement subtitle
Why it matters: Appropriations track only (not NDAA authorization). Watched lines with open marks may move.
Live: unavailable · Packet · Prep

SENATE
Wed Aug 27 · 09:30 ET · SASC
Hearing: Shipbuilding and submarine industrial base
Why it matters: Overlaps a tracked topic; no program-element hit yet.
Witnesses: NAVSEA, shipyard names if posted.
Live: direct stream URL on file · Packet · Prep

Thu Aug 28 · 10:00 ET · SSCI (closed / open portion TBD)
Hearing: Intelligence authorization matters
Why it matters: Committee on firm allowlist; treat the open portion as public record.
Live: pending — no unattended capture claimed

Also on calendar (no client hit — firm committee watch only)
Fri Aug 29 · House Armed Services full — organizational / pending notice — monitor, no prep queued.

Monday refresh rule
Only new notices, time changes, witness drops, or new links since Friday are repeated Monday. Unchanged rows stay out of the refresh.

Actions
1) Open packets for the sessions above
2) Generate prep ahead of the earliest hit
3) Flag the markup for same-day mark watch

—
Not a media clip service; capability labels reflect posted URLs only.`,
  },
  {
    id: 'funding_opportunity_digest',
    workflowId: 'send_update',
    eyebrow: 'Weekly digest',
    title: 'Funding opportunity match digest',
    description:
      'Active SAM.gov and Grants.gov opportunities matched to the sponsor’s profile above a relevance floor, split into new high-fit matches and items closing soon — pursuable-active only, never a full-catalog dump.',
    sampleSubject: '[Sponsor] FO matches · 4 new · 3 closing ≤14d',
    sampleBody: `Data health
SAM active rail: OK · Grants active rail: OK · Profile: NAICS + agency history present
This list is pursuable-active matches above your relevance floor — not the full government catalog.

NEW HIGH-FIT (since last digest)
1) SAM · [Notice ID] · [Title] — [Office], [Agency]
   Due: [date] · Set-aside: [if any] · Relevance: [score]
   Why matched: NAICS overlap · agency history · capability keyword
   Eligibility: needs_review (vehicle/access not confirmed)
   Open in Capiro · Save · Mark pursuing

2) Grants · [FOA number] · [Title]
   Close: [date] · Relevance: [score]
   Why matched: capability keyword + sector overlap

CLOSING SOON
≤7 days: [item] · due [date] · already Saved
≤14 days: [item], [item]
≤30 days: N more in product — open the full closing-soon view

ALREADY IN WORKFLOW (pinned)
[item] · status Pursuing · owner [name] · next gate [proposal outline]

SKIPPED ON PURPOSE
Closed, award, special notice, and below-floor browse hits are not listed.

Actions
1) Clear eligibility on the top new match before pursuit
2) Bid/no-bid on the closest-deadline Saved item
3) If profile NAICS codes are thin, complete them to improve future matches

—
Matching uses the client profile and active lifecycle rails. Empty does not mean nothing exists government-wide.`,
  },
  {
    id: 'federal_awards_rollup',
    workflowId: 'send_update',
    eyebrow: 'Intelligence roll-up',
    title: 'Federal awards & primes roll-up',
    description:
      'New or modified federal awards for the sponsor and its confirmed prime/competitor mappings over the lookback window, grouped by agency mix — confirmed contractor-name mappings only, never a guessed roll-up.',
    sampleSubject: '[Sponsor] awards pulse · 14 days · self + primes + competitors',
    sampleBody: `As-of: [date] · Source: USAspending federal award data via confirmed contractor-name mappings
Mappings: client names confirmed · primes confirmed · competitors confirmed

SELF — new / modified actions
[amount] · [agency] · [award ID] · [description] · action [date] · place of performance [state, inferred district]
Agency mix (window): [agency A] majority · [agency B] · [agency C] — note any concentration shift vs. the prior window

PRIMES (confirmed maps only)
[Prime name] — [count] actions ≥$1M · top agency · largest award [amount, short title]
[Prime name] — [count] actions

COMPETITORS
[Competitor] — [count] actions · overlap on [NAICS/sector] with your pursuits
[Competitor] — [count] actions · no overlap in window

INTERNAL ONLY (strip for client version)
Any unmapped alias shows zero awards — confirm the contracting roll-up before treating that as a real gap.

Actions
1) Compare agency-mix concentration against the open pipeline narrative
2) Compare competitor overlap to open funding-opportunity pursuits
3) Resolve any unmapped prime/competitor alias before the next send

—
Awards appear only for confirmed contractor-name mappings. No mapping means no row, not “no contracts.”`,
  },
  {
    id: 'defense_toplines',
    workflowId: 'send_update',
    eyebrow: 'Official record',
    title: 'Curated defense top-lines',
    description:
      'What moved in the official legislative record this week on watched defense committees, bills, and program elements — authorization and appropriations tracks kept separate, sourced only to Congress, committee documents, and GAO/CRS — never third-party news.',
    sampleSubject: 'Official record · defense · week of [date range]',
    sampleBody: `What moved in the official record this week — not a news roundup.

AUTHORIZATION
[Committee] [action] on [vehicle] · latest action: [text] · [date]
Program-element crosswalk: [count] watched mentions in this drop

APPROPRIATIONS (separate track)
[Subcommittee] released [mark / report title] · [date]
Watched program-element marks in this drop: [request] vs. [mark] — canonical figures only once promoted

COMMITTEE LANGUAGE / DIRECTIVES
[Report] directs [agency] to brief [topic] within [N] days — an oversight action, not a funding line

DOCUMENT DROPS
[Document name] ingested [date] — status: detected / extract in progress. Dollar figures are not emailed until promoted from the extraction pipeline.

OVERSIGHT & RESEARCH
GAO: [title] · [date] · [N] recommendations, open
CRS: [title] · [date] · open

What we did not include
Media explainers, op-eds, unconfirmed mark leaks, and any figure not yet promoted to canonical status.

Actions
1) Review the program-element divergence noted above
2) Add the authorization action to the relevant client report where tagged
3) Queue the GAO/CRS items into strategy context if active

—
Sourced to Congress actions, committee documents, and GAO/CRS search, as of [timestamp].`,
  },
  {
    id: 'bill_pe_crosswalk',
    workflowId: 'send_update',
    eyebrow: 'Legislative tracking',
    title: 'Bill ↔ program element crosswalk letter',
    description:
      'New links this week between watched program elements and bill text, committee reports, or hearing titles — evidence-gated: a row only appears with an actual code extraction or structured mention, never title similarity alone.',
    sampleSubject: 'Bill ↔ program element crosswalk · 7 days · new links on your watch',
    sampleBody: `Window: [date range] · Watched program elements: [count] · New bill/hearing links: [count]

BY PROGRAM ELEMENT
[PE code] — [short title] · FY[year] request [amount, if canonical]
Bill: [bill number] · [authorization or appropriations] track · latest action [text]
Evidence: program-element code found in bill section [citation]
Open program element · Open bill

Hearing: [Committee] hearing title mentions this program element · [date]
Open hearing packet

HEARING-ONLY MENTIONS (no bill text yet)
[PE code] · [Committee] hearing title · [date] — treat as an oversight signal until bill text lands

NO MOVEMENT (omitted detail)
[N] watched program elements had no new bill or hearing link this window.

Actions
1) Add new links to the relevant client's weekly brief
2) On program elements with a bill panel, check for a mark-versus-request divergence
3) Decide watch-or-ignore on hearing-only rows before next week

—
Links require a real code extraction or structured mention. Authorization and appropriations are always labeled separately. Dollar figures come only from the canonical program-element record, never from bill prose.`,
  },
  {
    id: 'engagement_week_in_review',
    workflowId: 'send_update',
    eyebrow: 'Relationship update',
    title: 'Relationship / meeting week-in-review',
    description:
      'A record of held and upcoming meetings, prep status, and outreach state for the sponsor over the last week — available in an internal version (full detail) or a client-facing version (commitments and schedule only, nothing sent implied unless it actually was).',
    sampleSubject: '[Sponsor] engagement week · held meetings · open loops · drafts in review',
    sampleBody: `INTERNAL VERSION

HELD
[Day, time] · [Meeting with] — Prep: generated · Notes: on file · Debrief: draft
  Commitments: [what was promised, and by when]
[Day, time] · [Meeting with] — Prep: n/a · Follow-up: [next step]

UPCOMING (next 7 days)
[Day, time] · [Meeting] — Prep: missing — Generate prep
[Day, time] · [Meeting] — Prep: stale — regenerate before the meeting

OUTREACH (governed)
In review: [count] drafts (no send) · Approved not sent: [count] · Sent: [count, or "external send not enabled"]
Nothing in this section was auto-sent from this digest.

OPEN LOOPS
1) [Commitment] — due [date] — owner [name]
2) [Commitment] — due [date] — owner [name]

RISKS
Confirm meeting notes are saved before sharing anything client-facing. Do not forward internal draft outreach to a client version.

———

CLIENT-FACING VERSION

[Client contact name] —

Here is a concise record of engagement on your behalf last week and what is teed up next.

Completed
[One sentence per held meeting: who, topic, and the one commitment made — no internal scoring or other-client names.]

Coming up
[One line per upcoming meeting relevant to this client.]

Open items we own
1) [Commitment] ([day])
2) [Commitment] ([day])

Items we need from you
[Only if something is actually needed — omit this section otherwise.]

Nothing in this note was sent externally beyond the meetings described above. Outreach copy remains in internal review until you approve it.

— [Sender name], [Firm]`,
  },
];

export const OUTREACH_CONTENT_TEMPLATES: OutreachContentTemplateDefinition[] = [
  MEETING_REQUEST_TEMPLATE,
  ...SEND_UPDATE_TEMPLATES,
];

export function contentTemplatesForWorkflow(
  workflowId: OutreachWorkflowTemplateId | null,
): OutreachContentTemplateDefinition[] {
  if (!workflowId) return [];
  return OUTREACH_CONTENT_TEMPLATES.filter((template) => template.workflowId === workflowId);
}

export function contentTemplateById(id: string | null): OutreachContentTemplateDefinition | null {
  if (!id) return null;
  return OUTREACH_CONTENT_TEMPLATES.find((template) => template.id === id) ?? null;
}

/**
 * Feeds the chosen template into generation as a STRUCTURE/TONE reference
 * only. The instruction explicitly forbids copying the sample's specific
 * facts — every sample above uses a placeholder sponsor name and
 * illustrative figures, never real client data, and generation must draw
 * every actual fact from the campaign's own selected context instead.
 */
export function contentTemplateContextSelection(
  template: OutreachContentTemplateDefinition,
): OutreachV3ContextSelection {
  return {
    locator: {
      source: 'manual',
      id: crypto.randomUUID(),
      title: `Update template — ${template.title}`,
      text: [
        `Use this template as the structural and tonal reference for every destination in this campaign: ${template.title}.`,
        template.description,
        'Reference sample below is for STRUCTURE AND TONE ONLY. Do not copy any name, date, dollar figure, agency, bill number, or other specific fact from this sample — it uses a placeholder sponsor and illustrative figures, not real data. Use only real facts drawn from this campaign’s own selected context. If the context does not support a section the sample shows, omit that section rather than inventing content for it.',
        `Sample subject: ${template.sampleSubject}`,
        '',
        template.sampleBody,
      ].join('\n\n'),
      sourceLabel: 'outreach_review_packet',
    },
    contextClass: 'writing_guidance',
    scope: { kind: 'campaign' },
  };
}

export type OutreachFormatId = 'standard' | 'structured_digest' | 'narrative_brief' | 'data_forward';

export interface OutreachFormatDefinition {
  id: OutreachFormatId;
  title: string;
  description: string;
}

/**
 * A plain-text writing style, not an HTML template — the draft pipeline
 * has no HTML body support today. See the guided workflow's own note near
 * where this is applied for why real HTML formatting is a separate project.
 */
export const OUTREACH_FORMAT_OPTIONS: OutreachFormatDefinition[] = [
  {
    id: 'standard',
    title: 'Standard email',
    description: 'A direct, plain-paragraph email with no special structure.',
  },
  {
    id: 'structured_digest',
    title: 'Structured digest',
    description: 'Short bolded section headers with scannable bullet points, like a weekly digest.',
  },
  {
    id: 'narrative_brief',
    title: 'Narrative brief',
    description: 'Flowing paragraphs in an executive-memo tone, with minimal bullets.',
  },
  {
    id: 'data_forward',
    title: 'Data-forward',
    description: 'Leads with structured facts and figures — dates, dollar amounts, names — grouped clearly.',
  },
];

export function formatOptionById(id: string | null): OutreachFormatDefinition | null {
  if (!id) return null;
  return OUTREACH_FORMAT_OPTIONS.find((format) => format.id === id) ?? null;
}

export function formatContextSelection(format: OutreachFormatDefinition): OutreachV3ContextSelection {
  return {
    locator: {
      source: 'manual',
      id: crypto.randomUUID(),
      title: 'Campaign format guidance',
      text: `Write every destination in this exact format: ${format.title} — ${format.description}`,
      sourceLabel: 'outreach_review_packet',
    },
    contextClass: 'writing_guidance',
    scope: { kind: 'campaign' },
  };
}
