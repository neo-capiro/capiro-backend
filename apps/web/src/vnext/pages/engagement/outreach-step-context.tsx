/**
 * Builder step 6 — Context. "Choose the context Capiro may use."
 *
 * The prototype runs this step on six hard-coded source cards ("4 records",
 * "6 records", …) and a per-template knob table. Neither survives contact with
 * a real campaign, so three things are deliberately different here and each one
 * is visible in the UI rather than hidden:
 *
 *  1. **The sources are the campaign's own.** Cards are built from what the
 *     server actually returns — the unified context search plus the refs
 *     already on the spec — grouped by source. Every count is the real number
 *     of records in that group. Switching a card on issues ACCEPT_CONTEXT_REFS
 *     for that group's locators; switching it off issues EXCLUDE_CONTEXT_REFS
 *     for the refs it accepted. Nothing is a decorative checkbox.
 *  2. **Per-template options steer, they do not configure.** The Campaign Spec
 *     has no field for them, so the whole set is written as ONE campaign-scoped
 *     `writing_guidance` ref (`OUTREACH_TEMPLATE_OPTIONS_MARKER`), replacing the
 *     previous one in the same batch. That is real steering with no enforcement
 *     behind it, which is what `OUTREACH_UNWIRED_CONTROLS` says and what the
 *     step prints.
 *  3. **There is no upload.** `POST context/document` takes an already-stored
 *     document id; no route accepts a new file as campaign context. The
 *     prototype's drop zone still renders — it is part of the step's shape —
 *     but its input is disabled and a note says so. Pretending a picked file
 *     had been accepted would be a fabricated success state.
 *
 * The option catalogue below is the prototype's, verbatim, keyed to the repo's
 * real content-template ids (the six seeded update templates are the same six
 * letters). They are controls, not data: no server ever returns them.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, FileText, Lock, Plus, X } from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import {
  acceptContextCommand,
  excludeContextCommand,
} from '../../../pages/engagement/outreach/v3/commands.js';
import { contextSelectionForClass } from '../../../pages/engagement/outreach/v3/context-selection.js';
import {
  OUTREACH_V3_CONTEXT_MIN_QUERY,
  getOutreachV3ContextReview,
  listOutreachV3ContextDocuments,
  searchOutreachV3ContextAll,
} from '../../../pages/engagement/outreach/v3/outreach-v3-api.js';
import type {
  OutreachV3CampaignSpec,
  OutreachV3Command,
  OutreachV3ContextCandidate,
  OutreachV3ContextDocumentCandidate,
  OutreachV3ContextSelection,
  OutreachV3ResolvedContextRef,
  OutreachV3ResolvedTargetRef,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import type { CapabilityRecord } from '../../../pages/clients/client-profile-crm-model.js';
import type { ClientFacility } from '../../../pages/clients/facilities-api.js';
import { outreachCampaignTypeLabel } from './outreach-campaign-flow.js';
import {
  OUTREACH_TEMPLATE_MARKER,
  OUTREACH_TEMPLATE_OPTIONS_MARKER,
  OUTREACH_UNWIRED_CONTROLS,
  outreachCampaignNameFromSpec,
  outreachGuidanceRefsWithMarker,
  outreachGuidanceSelection,
  outreachSelectedTargets,
  type OutreachBuilderStepCommon,
} from './outreach-builder-model.js';
import {
  clientCapabilityContextSelection,
  clientFacilityContextSelection,
  clientRecordContextSelection,
  outreachTargetHasCareerBackgroundSource,
  targetCareerBackgroundContextSelection,
} from './outreach-v3-guided-workflow.js';
import {
  OUTREACH_CONTENT_TEMPLATES,
  type OutreachContentTemplateDefinition,
} from './outreach-v3-content-templates.js';
import './outreach-builder.css';
import './outreach-step-context.css';

/* ------------------------------------------------------------------ *
 * Verbatim prototype copy
 * ------------------------------------------------------------------ */

export const OUTREACH_CONTEXT_DOCUMENT_ISOLATION_COPY =
  'Upload a capability statement, one-pager, mark table or memo and Capiro treats it as context for this campaign only. Nothing you upload is written to firm memory, and the file itself is never attached to an outgoing email.';

export const OUTREACH_CONTEXT_DOCUMENTS_EMPTY_COPY =
  'No documents added. The letter runs on the sources above.';

const UPLOAD_UNWIRED_NOTE =
  OUTREACH_UNWIRED_CONTROLS.find((entry) => entry.control === 'Campaign document upload')
    ?.reality ?? '';

const OPTIONS_UNWIRED_NOTE =
  OUTREACH_UNWIRED_CONTROLS.find((entry) => entry.control === 'Per-template context options')
    ?.reality ?? '';

/* ------------------------------------------------------------------ *
 * Per-template options
 * ------------------------------------------------------------------ */

export type OutreachContextOptionValue = boolean | string | string[];

export type OutreachContextOption =
  | { kind: 'toggle'; key: string; label: string; description: string; def: boolean }
  | {
      kind: 'choice';
      key: string;
      label: string;
      description: string;
      choices: string[];
      def: string;
    }
  | {
      kind: 'multi';
      key: string;
      label: string;
      description: string;
      choices: string[];
      def: string[];
    };

export interface OutreachContextOptionSet {
  /** The letter's own promise about what it will never claim. */
  failsClosed: string;
  options: OutreachContextOption[];
}

/**
 * The prototype's knob sets, keyed by the repo's content-template ids.
 *
 * Every label, description and option string is the prototype's, character for
 * character — including `≤`, `↔`, the curly quotes and the em dashes. The
 * defaults are the prototype's `def` values, so a campaign that has never
 * touched this step reads the same as the prototype's first paint.
 */
export const OUTREACH_CONTEXT_OPTION_SETS: Record<string, OutreachContextOptionSet> = {
  hearings_week_ahead: {
    failsClosed:
      'Never claims a stream is recordable. Live capability reads direct stream, browser, pending or unavailable — nothing else.',
    options: [
      {
        kind: 'choice',
        key: 'scope',
        label: 'Scope',
        description:
          'Firm-wide covers every watched committee. Client scopes narrow the letter to the clients you name.',
        choices: ['Firm-wide', 'Client portfolio', 'Single client'],
        def: 'Client portfolio',
      },
      {
        kind: 'choice',
        key: 'window',
        label: 'Window',
        description: 'How far ahead the letter looks.',
        choices: ['7 days', '14 days'],
        def: '7 days',
      },
      {
        kind: 'multi',
        key: 'chambers',
        label: 'Chambers',
        description: 'Which chambers to include.',
        choices: ['House', 'Senate', 'Joint'],
        def: ['House', 'Senate'],
      },
      {
        kind: 'multi',
        key: 'types',
        label: 'Session types',
        description: 'Markups move money; nominations rarely matter to a portfolio.',
        choices: ['Hearing', 'Markup', 'Business meeting', 'Nomination'],
        def: ['Hearing', 'Markup'],
      },
      {
        kind: 'choice',
        key: 'relevance',
        label: 'What counts as implicated',
        description:
          'A hit needs a watched committee, an issue-tag overlap, a PE code, a bill on the kanban, or a district nexus.',
        choices: ['Watched only', 'Watched + issue overlap', 'All in committees'],
        def: 'Watched + issue overlap',
      },
      {
        kind: 'toggle',
        key: 'witnesses',
        label: 'Include witnesses',
        description: 'Shown only when the record actually posts them.',
        def: true,
      },
      {
        kind: 'toggle',
        key: 'live',
        label: 'Include live capability',
        description: 'Direct stream, browser, pending or unavailable — read from posted URLs.',
        def: true,
      },
      {
        kind: 'choice',
        key: 'prep',
        label: 'Prep hooks',
        description: 'What each row offers you to do next.',
        choices: ['Generate prep', 'Open packet', 'Both'],
        def: 'Both',
      },
      {
        kind: 'choice',
        key: 'tone',
        label: 'Tone',
        description: 'Client tone strips internal ownership notes.',
        choices: ['Internal ops', 'Client external'],
        def: 'Internal ops',
      },
      {
        kind: 'toggle',
        key: 'omit',
        label: 'Omit empty sections',
        description:
          'A chamber with nothing in the window disappears rather than printing a header.',
        def: true,
      },
    ],
  },
  funding_opportunity_digest: {
    failsClosed:
      'Never claims full-catalog coverage. If the SAM key is unhealthy the digest says so rather than reporting “no opportunities”.',
    options: [
      {
        kind: 'multi',
        key: 'sources',
        label: 'Sources',
        description: 'Active notices only — closed and award notices never enter a digest.',
        choices: ['SAM', 'Grants'],
        def: ['SAM', 'Grants'],
      },
      {
        kind: 'choice',
        key: 'floor',
        label: 'Relevance floor',
        description: 'The producer floor. Anything below it is browse-only and stays out.',
        choices: ['15', '25', '40'],
        def: '15',
      },
      {
        kind: 'choice',
        key: 'newSince',
        label: 'New since',
        description: 'The high-fit section window.',
        choices: ['7 days', '14 days'],
        def: '7 days',
      },
      {
        kind: 'multi',
        key: 'closing',
        label: 'Closing-soon buckets',
        description: 'Calendar days to the deadline.',
        choices: ['≤7 days', '≤14 days', '≤30 days'],
        def: ['≤7 days', '≤14 days', '≤30 days'],
      },
      {
        kind: 'toggle',
        key: 'reasons',
        label: 'Show why it matched',
        description:
          'Agency history, office history, NAICS, PSC, capability keyword, sector, funding category, known partner or text window. Never an invented reason.',
        def: true,
      },
      {
        kind: 'toggle',
        key: 'eligibility',
        label: 'Eligibility shown separately',
        description:
          'Eligibility is never folded into relevance; unresolved reads needs_review.',
        def: true,
      },
      {
        kind: 'choice',
        key: 'maxNew',
        label: 'Max new items',
        description: 'Cap on the high-fit section.',
        choices: ['5', '10'],
        def: '10',
      },
      {
        kind: 'choice',
        key: 'tone',
        label: 'Tone',
        description: 'Client tone drops internal pipeline notes.',
        choices: ['BD internal', 'Client shareable'],
        def: 'BD internal',
      },
    ],
  },
  federal_awards_rollup: {
    failsClosed:
      'Awards appear only for confirmed contractor-name mappings. No mapping means no row — never “no contracts”.',
    options: [
      {
        kind: 'multi',
        key: 'entities',
        label: 'Entity set',
        description: 'Confirmed mappings only. An unmapped name is a gap to fix, not a zero.',
        choices: ['Self', 'Primes', 'Competitors'],
        def: ['Self', 'Primes', 'Competitors'],
      },
      {
        kind: 'choice',
        key: 'lookback',
        label: 'Lookback',
        description: 'Weekly uses 14; biweekly uses 30.',
        choices: ['14 days', '30 days'],
        def: '14 days',
      },
      {
        kind: 'choice',
        key: 'minAmount',
        label: 'Minimum action',
        description: 'Filters small modifications out of the narrative.',
        choices: ['Any', '$1M', '$5M'],
        def: '$1M',
      },
      {
        kind: 'choice',
        key: 'groupBy',
        label: 'Group by',
        description: 'How rows are organised.',
        choices: ['Agency', 'Contracting office', 'NAICS', 'Place of performance'],
        def: 'Agency',
      },
      {
        kind: 'toggle',
        key: 'assistance',
        label: 'Include assistance awards',
        description: 'Grants and cooperative agreements alongside contracts.',
        def: false,
      },
      {
        kind: 'toggle',
        key: 'fec',
        label: 'Include PAC / FEC summary',
        description:
          'Only with a confirmed committee mapping, and only as summary counts — never donor detail in a client letter.',
        def: false,
      },
      {
        kind: 'choice',
        key: 'tone',
        label: 'Tone',
        description: 'Client tone strips mapping gaps and other-client names.',
        choices: ['Internal', 'Client external'],
        def: 'Internal',
      },
    ],
  },
  defense_toplines: {
    failsClosed:
      'Corpus only. No media wires, no summed authorization and appropriations, and no PE dollars that PE Watch has not promoted.',
    options: [
      {
        kind: 'multi',
        key: 'sources',
        label: 'Corpus sources',
        description:
          'Official record only. Third-party news wires are not available as a source.',
        choices: [
          'Committee budget docs',
          'Bill actions',
          'PE marks & language',
          'GAO reports',
          'CRS reports',
        ],
        def: ['Committee budget docs', 'Bill actions', 'PE marks & language', 'GAO reports'],
      },
      {
        kind: 'choice',
        key: 'peScope',
        label: 'PE scope',
        description: 'Which program elements the letter reads marks and language for.',
        choices: ['Firm watch', 'Client watch', 'Named PE codes'],
        def: 'Firm watch',
      },
      {
        kind: 'choice',
        key: 'maxBullets',
        label: 'Top-lines',
        description: 'Bullets before the appendix.',
        choices: ['6', '8', '12'],
        def: '8',
      },
      {
        kind: 'toggle',
        key: 'directives',
        label: 'Include language directives',
        description:
          '“Committee directs / briefing / report within N days” — oversight, not funding.',
        def: true,
      },
      {
        kind: 'toggle',
        key: 'overlay',
        label: 'Client overlay tags',
        description: 'Tags each top-line with the clients whose watch it touches.',
        def: true,
      },
      {
        kind: 'choice',
        key: 'severity',
        label: 'Severity floor',
        description: 'Materiality of the change, derived from the record.',
        choices: ['All', 'Notable and above', 'Critical only'],
        def: 'All',
      },
    ],
  },
  bill_pe_crosswalk: {
    failsClosed:
      'A link needs code extraction or a structured mention. Title similarity alone is never a link, and canonical PE dollars come only from PE Watch promotion.',
    options: [
      {
        kind: 'choice',
        key: 'peScope',
        label: 'PE scope',
        description: 'Which watches the crosswalk runs over.',
        choices: ['Watched by me', 'Watched by tenant', 'Client portfolio', 'Named PE codes'],
        def: 'Watched by tenant',
      },
      {
        kind: 'choice',
        key: 'billScope',
        label: 'Bill scope',
        description: 'Allowlist keeps it to NDAA and defense appropriations vehicles.',
        choices: ['Any mention', 'Active only', 'Allowlist vehicles'],
        def: 'Active only',
      },
      {
        kind: 'multi',
        key: 'evidence',
        label: 'Evidence sources',
        description: 'Both are structured. Neither is title similarity.',
        choices: ['Bill text extraction', 'Hearing and title mentions'],
        def: ['Bill text extraction', 'Hearing and title mentions'],
      },
      {
        kind: 'choice',
        key: 'window',
        label: 'New in window',
        description: 'Only links first seen inside the window.',
        choices: ['7 days', '14 days', 'All current'],
        def: '7 days',
      },
      {
        kind: 'toggle',
        key: 'funding',
        label: 'Include funding language',
        description:
          'Quoted only where bill text ties dollars to a PE, and only when canonical PE Watch agrees.',
        def: true,
      },
      {
        kind: 'choice',
        key: 'groupBy',
        label: 'Group by',
        description: 'How pairs are organised.',
        choices: ['Program element', 'Bill', 'Client'],
        def: 'Program element',
      },
      {
        kind: 'choice',
        key: 'maxPairs',
        label: 'Max pairs',
        description: 'Cap on listed links.',
        choices: ['10', '20'],
        def: '20',
      },
    ],
  },
  engagement_week_in_review: {
    failsClosed:
      'Never auto-sends. Drafts are labelled drafts, other clients are stripped, and raw email bodies never appear.',
    options: [
      {
        kind: 'choice',
        key: 'audience',
        label: 'Audience',
        description:
          'The client version strips internal owner notes and keeps commitments and schedule. The preview follows this choice.',
        choices: ['Internal AE', 'Client external'],
        def: 'Internal AE',
      },
      {
        kind: 'choice',
        key: 'window',
        label: 'Window',
        description: 'Meetings held, plus open loops.',
        choices: ['Last 7 days', 'Last 14 days'],
        def: 'Last 7 days',
      },
      {
        kind: 'multi',
        key: 'include',
        label: 'Sections',
        description: 'Cancelled meetings and untitled shells never appear.',
        choices: [
          'Held meetings',
          'Upcoming 7 days',
          'Prep status',
          'Debrief & Meri notes',
          'Commitments',
          'Outreach state',
          'Targets',
        ],
        def: [
          'Held meetings',
          'Upcoming 7 days',
          'Prep status',
          'Commitments',
          'Outreach state',
          'Targets',
        ],
      },
      {
        kind: 'choice',
        key: 'maxMeetings',
        label: 'Max meetings',
        description: 'Cap on listed meetings.',
        choices: ['10', '15'],
        def: '15',
      },
      {
        kind: 'toggle',
        key: 'redact',
        label: 'Redact internal material',
        description: 'Internal scoring, other-client names and raw email bodies are stripped.',
        def: true,
      },
    ],
  },
};

/** An emptied multi-select has to survive a round trip through the ref text. */
const NO_SELECTION_TOKEN = '(none)';

export function outreachContextOptionDefaults(
  set: OutreachContextOptionSet,
): Record<string, OutreachContextOptionValue> {
  const values: Record<string, OutreachContextOptionValue> = {};
  for (const option of set.options) {
    values[option.key] = option.kind === 'multi' ? [...option.def] : option.def;
  }
  return values;
}

function optionValueText(
  option: OutreachContextOption,
  value: OutreachContextOptionValue | undefined,
): string {
  if (option.kind === 'toggle') return value === true ? 'On' : 'Off';
  if (option.kind === 'choice') return typeof value === 'string' ? value : option.def;
  const selected = Array.isArray(value) ? value : option.def;
  return selected.length > 0 ? selected.join(', ') : NO_SELECTION_TOKEN;
}

/**
 * The single guidance ref the whole option set becomes.
 *
 * Written as `Label: value` lines so it is both legible to a human reading the
 * packet and parseable back into controls — the ref is the only store there is.
 */
export function outreachContextOptionsGuidanceText(
  set: OutreachContextOptionSet,
  values: Record<string, OutreachContextOptionValue>,
  templateTitle: string,
): string {
  return [
    `Apply these options when writing every destination in this campaign (${templateTitle}):`,
    ...set.options.map((option) => `${option.label}: ${optionValueText(option, values[option.key])}`),
  ].join('\n');
}

/** Reads back what `outreachContextOptionsGuidanceText` wrote; defaults fill any gap. */
export function outreachContextOptionsFromText(
  set: OutreachContextOptionSet,
  text: string,
): Record<string, OutreachContextOptionValue> {
  const values = outreachContextOptionDefaults(set);
  const byLabel = new Map(set.options.map((option) => [option.label, option]));
  for (const line of text.split('\n')) {
    const separator = line.indexOf(': ');
    if (separator < 0) continue;
    const option = byLabel.get(line.slice(0, separator).trim());
    if (!option) continue;
    const raw = line.slice(separator + 2).trim();
    if (option.kind === 'toggle') {
      values[option.key] = raw === 'On';
    } else if (option.kind === 'choice') {
      if (option.choices.includes(raw)) values[option.key] = raw;
    } else if (raw === NO_SELECTION_TOKEN) {
      values[option.key] = [];
    } else {
      values[option.key] = raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => option.choices.includes(entry));
    }
  }
  return values;
}

/* ------------------------------------------------------------------ *
 * Reading the spec
 * ------------------------------------------------------------------ */

/**
 * Which content template the campaign is written against.
 *
 * The spec has no template field. A legacy (skeleton-less) template reaches
 * generation as a `writing_guidance` ref titled `Update template — <title>`
 * (see `contentTemplateContextSelection`), which is the only durable record of
 * the choice — so the title is what this matches on. A skeleton template writes
 * no such ref and correctly resolves to null: it carries no options, exactly as
 * the prototype's meeting-request template carries no knobs.
 *
 * Imported from `outreach-builder-model` rather than declared here — it used
 * to be a second, independent copy of the same literal as
 * `outreach-step-template.tsx`'s writer, which is how a stale template
 * selection survived a campaign-type change: nothing outside these two files
 * could name the marker to supersede it. See
 * `outreachTypeChangeInvalidationCommands`.
 */
const UPDATE_TEMPLATE_MARKER = OUTREACH_TEMPLATE_MARKER;

export function outreachContextSelectedTemplate(
  session: OutreachV3SessionEnvelope | null,
): OutreachContentTemplateDefinition | null {
  const refs = outreachGuidanceRefsWithMarker(session, UPDATE_TEMPLATE_MARKER);
  for (let i = refs.length - 1; i >= 0; i -= 1) {
    const title = (refs[i]?.title ?? '').slice(UPDATE_TEMPLATE_MARKER.length).trim();
    const template = OUTREACH_CONTENT_TEMPLATES.find((entry) => entry.title === title);
    if (template) return template;
  }
  return null;
}

function soleSponsorClientId(session: OutreachV3SessionEnvelope | null): string | null {
  const sponsor = session?.spec.sponsor;
  if (!sponsor || sponsor.kind !== 'client' || sponsor.clientRefs.length !== 1) return null;
  return sponsor.clientRefs[0]?.clientId ?? null;
}

/**
 * What Capiro looks for context with.
 *
 * The campaign name is the subject line the recipient sees, which makes it the
 * most specific thing the campaign knows about itself; the objective and goal
 * back it up so a campaign named late still finds something.
 */
function contextSearchQuery(session: OutreachV3SessionEnvelope | null): string {
  const goal = session?.spec.goal;
  return (
    outreachCampaignNameFromSpec(session) ||
    goal?.objective?.trim() ||
    goal?.goal?.trim() ||
    ''
  );
}

function acceptedContextRefs(
  context: OutreachV3CampaignSpec['context'] | undefined,
): OutreachV3ResolvedContextRef[] {
  if (!context) return [];
  return [
    ...context.requiredPolicyRefs,
    ...context.writingGuidanceRefs,
    ...context.campaignFactRefs,
    ...context.targetSpecificRefs,
    ...context.groupSafeRefs,
  ];
}

function locatorId(locator: Record<string, unknown>): string {
  const value = locator['id'] ?? locator['memoryItemId'] ?? locator['documentId'];
  return typeof value === 'string' ? value : '';
}

function sameLocator(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return left['source'] === right['source'] && locatorId(left) === locatorId(right);
}

function humanize(value: string): string {
  const text = value.replaceAll('_', ' ').trim();
  if (!text) return 'Other';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Up to two real titles, then how many more there are. Never a summary nobody wrote. */
function describeTitles(titles: string[]): string {
  const shown = titles.slice(0, 2);
  const rest = titles.length - shown.length;
  return rest > 0 ? `${shown.join(' · ')} · +${rest} more` : shown.join(' · ');
}

function formatDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

/* ------------------------------------------------------------------ *
 * Source groups
 * ------------------------------------------------------------------ */

interface ContextSourceSeed {
  key: string;
  label: string;
  description: string;
  count: string;
  /** What ACCEPT sends when this card is switched back on. */
  selections: OutreachV3ContextSelection[];
}

interface ContextSourceGroup extends ContextSourceSeed {
  acceptedRefs: OutreachV3ResolvedContextRef[];
  recipientScoped: boolean;
  on: boolean;
}

const SOURCE_KIND_LABEL: Record<OutreachV3ContextCandidate['sourceKind'], string> = {
  memory: 'Institutional memory',
  government: 'Government record',
  document: 'Client document',
};

function candidateSubKind(candidate: OutreachV3ContextCandidate): string {
  if (candidate.sourceKind === 'memory') return candidate.memoryType;
  if (candidate.sourceKind === 'government') return candidate.category;
  return 'document';
}

function refGroupKey(ref: OutreachV3ResolvedContextRef): string {
  const locator = ref.locator as Record<string, unknown>;
  const source = typeof locator['source'] === 'string' ? locator['source'] : 'other';
  const sub =
    typeof locator['category'] === 'string'
      ? locator['category']
      : typeof locator['memoryType'] === 'string'
        ? locator['memoryType']
        : '';
  return sub ? `${source}:${sub}` : source;
}

function selectionFromRef(ref: OutreachV3ResolvedContextRef): OutreachV3ContextSelection {
  return { locator: ref.locator, contextClass: ref.contextClass, scope: ref.scope };
}

function isDocumentRef(ref: OutreachV3ResolvedContextRef): boolean {
  return (ref.locator as Record<string, unknown>)['source'] === 'document';
}

/**
 * The builder's own markers carry a `manual` locator: the subject line, the
 * email format, the template, this step's own options, and each recipient's
 * personal note. They are written by the step that owns them and have no
 * candidate to attribute them to, so without this they collect into one
 * unattributed card — and that card's single toggle would exclude ALL of them
 * at once, silently deleting the subject line and the format with one click on
 * a source the user never chose.
 */
function isBuilderGuidanceRef(ref: OutreachV3ResolvedContextRef): boolean {
  return (ref.locator as Record<string, unknown>)['source'] === 'manual';
}

/**
 * Cards for the campaign's real context, from two directions at once.
 *
 * Candidates the search found supply the groups; refs already accepted are
 * attributed to the group holding their locator, and any that match nothing the
 * search returned form their own group so an accepted source can never become
 * invisible (and therefore un-removable) just because a later search missed it.
 */
function buildContextSourceGroups(
  candidates: OutreachV3ContextCandidate[],
  accepted: OutreachV3ResolvedContextRef[],
): ContextSourceGroup[] {
  interface Bucket {
    key: string;
    label: string;
    noun: string;
    sourceLabel: string;
    titles: string[];
    selections: OutreachV3ContextSelection[];
    candidates: OutreachV3ContextCandidate[];
    acceptedRefs: OutreachV3ResolvedContextRef[];
  }
  const buckets = new Map<string, Bucket>();

  for (const candidate of candidates) {
    // Documents have their own card below; listing them twice would let one
    // toggle silently undo the other.
    if (candidate.sourceKind === 'document') continue;
    const key = `${candidate.sourceKind}:${candidateSubKind(candidate)}`;
    const bucket = buckets.get(key) ?? {
      key,
      label: humanize(candidateSubKind(candidate)),
      noun: candidate.sourceKind === 'memory' ? 'note' : 'record',
      sourceLabel: SOURCE_KIND_LABEL[candidate.sourceKind],
      titles: [],
      selections: [],
      candidates: [],
      acceptedRefs: [],
    };
    bucket.titles.push(candidate.title);
    // `campaign_fact` is the class the unified search probed with, so it is the
    // one the server has already agreed these rows are compatible with.
    bucket.selections.push(contextSelectionForClass(candidate, 'campaign_fact', null));
    bucket.candidates.push(candidate);
    buckets.set(key, bucket);
  }

  for (const ref of accepted) {
    if (isDocumentRef(ref) || isBuilderGuidanceRef(ref)) continue;
    const host = [...buckets.values()].find((bucket) =>
      bucket.candidates.some((candidate) =>
        sameLocator(
          candidate.selection.locator as Record<string, unknown>,
          ref.locator as Record<string, unknown>,
        ),
      ),
    );
    if (host) {
      host.acceptedRefs.push(ref);
      continue;
    }
    const key = refGroupKey(ref);
    const bucket = buckets.get(key) ?? {
      key,
      label: humanize(key.split(':').at(-1) ?? key),
      noun: 'record',
      sourceLabel: humanize(key.split(':').at(0) ?? key),
      titles: [],
      selections: [],
      candidates: [],
      acceptedRefs: [],
    };
    bucket.titles.push(ref.title);
    bucket.selections.push(selectionFromRef(ref));
    bucket.acceptedRefs.push(ref);
    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      description: [bucket.sourceLabel, describeTitles(bucket.titles)]
        .filter(Boolean)
        .join(' · '),
      count: countLabel(bucket.titles.length, bucket.noun),
      selections: bucket.selections,
      acceptedRefs: bucket.acceptedRefs,
      recipientScoped: bucket.acceptedRefs.some((ref) => ref.scope.kind === 'target'),
      on: bucket.acceptedRefs.length > 0,
    }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key));
}

/* ------------------------------------------------------------------ *
 * Attached documents
 * ------------------------------------------------------------------ */

interface AttachedDocument {
  contextKey: string;
  name: string;
  meta: string;
}

function attachedDocuments(
  accepted: OutreachV3ResolvedContextRef[],
  library: OutreachV3ContextDocumentCandidate[],
): AttachedDocument[] {
  return accepted.filter(isDocumentRef).map((ref) => {
    const match = library.find(
      (document) => document.attachmentId === locatorId(ref.locator as Record<string, unknown>),
    );
    const meta = match
      ? [match.clientName, formatDate(match.date)].filter(Boolean).join(' · ')
      : ref.summary.trim();
    return {
      contextKey: ref.contextKey,
      name: ref.title,
      // The prototype prints "240 KB · uploaded just now" from the File object
      // it never stored. A stored document has a client and a date instead;
      // when even those are missing the row says nothing rather than guessing.
      meta: meta || 'Stored document',
    };
  });
}

/* ------------------------------------------------------------------ *
 * The step
 * ------------------------------------------------------------------ */

export function OutreachContextStep(props: OutreachBuilderStepCommon): JSX.Element {
  const { session, sessionId, campaignType, busy, applyCommands, toast, onNext, primaryLabel } =
    props;
  const api = useApi();
  const idBase = useId();
  const [pending, setPending] = useState<string | null>(null);
  const [documentPick, setDocumentPick] = useState('');

  const template = outreachContextSelectedTemplate(session);
  const optionSet = template ? OUTREACH_CONTEXT_OPTION_SETS[template.id] ?? null : null;

  const clientId = soleSponsorClientId(session);
  const query = contextSearchQuery(session);
  const searchable = query.length >= OUTREACH_V3_CONTEXT_MIN_QUERY;

  // Same query keys the session hook uses, so opening this step reuses whatever
  // the shell has already fetched instead of asking again.
  const reviewQuery = useQuery({
    queryKey: ['outreach-v3', 'context-review', sessionId, session?.specHash],
    enabled: Boolean(sessionId && session),
    queryFn: () => getOutreachV3ContextReview(api, sessionId),
    retry: false,
  });
  const documentsQuery = useQuery({
    queryKey: ['outreach-v3', 'context-documents', clientId],
    enabled: Boolean(clientId),
    queryFn: () => listOutreachV3ContextDocuments(api, clientId ?? ''),
    staleTime: 60_000,
    retry: false,
  });
  const searchQuery = useQuery({
    queryKey: ['outreach-v3', 'context-search-all', sessionId, query, clientId],
    enabled: Boolean(sessionId) && searchable,
    queryFn: () => searchOutreachV3ContextAll(api, sessionId, { query, clientId }),
    staleTime: 60_000,
    retry: false,
  });

  // Request-a-meeting only: the sponsor's capabilities and locations, fetched
  // so each can become its own real Source below — never a bundled blob, so
  // excluding one wrong capability never takes the rest with it. Same plain
  // GET pattern already used for the same two endpoints in
  // `pages/clients/useClientProfileData.ts`.
  const isRequestMeeting = campaignType === 'request_meeting';
  const capabilitiesQuery = useQuery({
    queryKey: ['client-capabilities', clientId],
    enabled: isRequestMeeting && Boolean(clientId),
    queryFn: async () =>
      (await api.get<CapabilityRecord[]>(`/api/clients/${clientId}/capabilities`)).data,
    staleTime: 60_000,
    retry: false,
  });
  const facilitiesQuery = useQuery({
    queryKey: ['client-facilities', clientId],
    enabled: isRequestMeeting && Boolean(clientId),
    queryFn: async () => (await api.get<ClientFacility[]>(`/api/clients/${clientId}/facilities`)).data,
    staleTime: 60_000,
    retry: false,
  });

  const accepted = useMemo(
    () => acceptedContextRefs(reviewQuery.data?.accepted ?? session?.spec.context),
    [reviewQuery.data, session],
  );
  const candidates = useMemo(
    () => searchQuery.data?.candidates ?? [],
    [searchQuery.data],
  );
  const liveGroups = useMemo(
    () => buildContextSourceGroups(candidates, accepted),
    [candidates, accepted],
  );

  /**
   * Groups seen earlier in this visit.
   *
   * Switching a card off excludes its refs, which — for a source the current
   * search did not return — would otherwise delete the card mid-click and leave
   * no way back. The records are real either way; this only remembers how to
   * draw the card and what to re-accept.
   */
  const rememberedGroups = useRef(new Map<string, ContextSourceSeed>());
  useEffect(() => {
    for (const group of liveGroups) {
      rememberedGroups.current.set(group.key, {
        key: group.key,
        label: group.label,
        description: group.description,
        count: group.count,
        selections: group.selections,
      });
    }
  }, [liveGroups]);
  const groups = useMemo(() => {
    const live = new Set(liveGroups.map((group) => group.key));
    const forgotten: ContextSourceGroup[] = [];
    for (const [key, seed] of rememberedGroups.current) {
      if (live.has(key)) continue;
      forgotten.push({ ...seed, acceptedRefs: [], recipientScoped: false, on: false });
    }
    return [...liveGroups, ...forgotten].sort(
      (left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key),
    );
  }, [liveGroups]);

  const library = documentsQuery.data ?? [];
  const attached = useMemo(() => attachedDocuments(accepted, library), [accepted, library]);
  const attachedIds = new Set(
    accepted.filter(isDocumentRef).map((ref) => locatorId(ref.locator as Record<string, unknown>)),
  );
  const availableDocuments = library.filter(
    (document) => !attachedIds.has(document.attachmentId),
  );

  const locked = busy || pending !== null;

  /**
   * The shell owns command errors — it holds the mutation whose state renders
   * them — so a rejection is swallowed here rather than reported twice or left
   * as an unhandled rejection. The `false` return keeps a toast from claiming
   * something happened that did not.
   */
  const runCommands = useCallback(
    async (key: string, commands: OutreachV3Command[]): Promise<boolean> => {
      setPending(key);
      try {
        await applyCommands(commands);
        return true;
      } catch {
        return false;
      } finally {
        setPending(null);
      }
    },
    [applyCommands],
  );

  /* -- Request-a-meeting: auto-attach sponsor + target profile context --- */

  const targets = useMemo(() => outreachSelectedTargets(session), [session]);

  const hasCapiroRecordRef = (recordId: string) =>
    accepted.some(
      (ref) =>
        (ref.locator as Record<string, unknown>)['source'] === 'capiro_record' &&
        locatorId(ref.locator as Record<string, unknown>) === recordId,
    );
  const hasCareerBackgroundRef = (target: OutreachV3ResolvedTargetRef) =>
    accepted.some(
      (ref) =>
        ref.scope.kind === 'target' &&
        ref.scope.targetKey === target.targetKey &&
        (ref.locator as Record<string, unknown>)['factCode'] === 'career_background',
    );

  useEffect(() => {
    if (!isRequestMeeting || !clientId || pending !== null) return;
    // Each of the four pieces is checked independently — a slow/failed
    // capabilities or facilities fetch never blocks the other pieces from
    // attaching, and each is its own `capiro_record`/`target_profile_fact`
    // Source once accepted, never a `manual` marker the user can't see.
    const missing: OutreachV3ContextSelection[] = [];
    if (!hasCapiroRecordRef(clientId)) missing.push(clientRecordContextSelection(clientId));
    for (const capability of capabilitiesQuery.data ?? []) {
      if (!hasCapiroRecordRef(capability.id)) {
        missing.push(clientCapabilityContextSelection(clientId, capability.id));
      }
    }
    for (const facility of facilitiesQuery.data ?? []) {
      if (!hasCapiroRecordRef(facility.id)) {
        missing.push(clientFacilityContextSelection(clientId, facility.id));
      }
    }
    for (const target of targets) {
      if (outreachTargetHasCareerBackgroundSource(target) && !hasCareerBackgroundRef(target)) {
        missing.push(targetCareerBackgroundContextSelection(target));
      }
    }
    if (missing.length === 0) return;
    void runCommands('auto-request-meeting-context', [acceptContextCommand(missing)]);
    // `accepted` already reflects every locator currently on the spec, so it
    // (not `session` directly) is what tells this effect whether a prior
    // batch landed — applyCommands invalidates the session query on success,
    // which is what refreshes it.
  }, [
    isRequestMeeting,
    clientId,
    accepted,
    capabilitiesQuery.data,
    facilitiesQuery.data,
    targets,
    pending,
    runCommands,
  ]);

  /* -- per-template options -------------------------------------------- */

  const optionsRef = optionSet
    ? outreachGuidanceRefsWithMarker(session, OUTREACH_TEMPLATE_OPTIONS_MARKER).at(-1) ?? null
    : null;
  const persistedOptions = useMemo<Record<string, OutreachContextOptionValue>>(() => {
    if (!optionSet) return {};
    // The instruction text lives on the manual locator that
    // `outreachGuidanceSelection` built; `summary` is the server's echo of it
    // and stands in if a resolver ever drops the locator field.
    const locatorText = (optionsRef?.locator as Record<string, unknown> | undefined)?.['text'];
    const text =
      typeof locatorText === 'string' && locatorText
        ? locatorText
        : (optionsRef?.summary ?? '');
    return text
      ? outreachContextOptionsFromText(optionSet, text)
      : outreachContextOptionDefaults(optionSet);
  }, [optionSet, optionsRef]);
  // Local draft so a click paints immediately; the ref is still the store.
  const [optionDraft, setOptionDraft] = useState<Record<
    string,
    OutreachContextOptionValue
  > | null>(null);
  useEffect(() => setOptionDraft(null), [template?.id]);
  const optionValues = optionDraft ?? persistedOptions;

  const writeOptions = async (next: Record<string, OutreachContextOptionValue>) => {
    if (!optionSet || !template) return;
    setOptionDraft(next);
    const superseded = outreachGuidanceRefsWithMarker(session, OUTREACH_TEMPLATE_OPTIONS_MARKER);
    const commands: OutreachV3Command[] = [
      acceptContextCommand([
        outreachGuidanceSelection({
          // Namespaced by template title the same way the format marker is, so
          // the packet reads as one instruction with a stated subject.
          title: `${OUTREACH_TEMPLATE_OPTIONS_MARKER} · ${template.title}`,
          text: outreachContextOptionsGuidanceText(optionSet, next, template.title),
        }),
      ]),
    ];
    if (superseded.length > 0) {
      commands.push(
        excludeContextCommand(
          superseded.map((ref) => ({ contextKey: ref.contextKey, reason: 'superseded' as const })),
        ),
      );
    }
    const ok = await runCommands(`option:${template.id}`, commands);
    if (!ok) setOptionDraft(null);
  };

  const setOption = (option: OutreachContextOption, value: OutreachContextOptionValue) =>
    writeOptions({ ...optionValues, [option.key]: value });

  /* -- source cards ---------------------------------------------------- */

  const toggleGroup = async (group: ContextSourceGroup) => {
    if (group.on) {
      await runCommands(
        `group:${group.key}`,
        [
          excludeContextCommand(
            group.acceptedRefs.map((ref) => ({
              contextKey: ref.contextKey,
              reason: 'user_excluded' as const,
            })),
          ),
        ],
      );
      return;
    }
    if (group.selections.length === 0) return;
    await runCommands(`group:${group.key}`, [acceptContextCommand(group.selections)]);
  };

  /* -- documents ------------------------------------------------------- */

  const addDocument = async () => {
    const picked = availableDocuments.find(
      (candidate) => candidate.attachmentId === documentPick,
    );
    if (!picked) return;
    const ok = await runCommands(`document:${picked.attachmentId}`, [
      acceptContextCommand([
        contextSelectionForClass({ ...picked, sourceKind: 'document' }, 'campaign_fact', null),
      ]),
    ]);
    if (!ok) return;
    setDocumentPick('');
    // The prototype's own toast copy, for the one document that really landed.
    toast('1 document added to this campaign’s context');
  };

  const removeDocument = async (attachedDocument: AttachedDocument) => {
    await runCommands(`document:${attachedDocument.contextKey}`, [
      excludeContextCommand([
        { contextKey: attachedDocument.contextKey, reason: 'user_excluded' as const },
      ]),
    ]);
  };

  /* -- header ---------------------------------------------------------- */

  const onCount = groups.filter((group) => group.on).length;
  const workflowLabel = campaignType ? outreachCampaignTypeLabel(campaignType) : 'Send update';
  const summary = optionSet
    ? `${optionSet.options.length} option${optionSet.options.length === 1 ? '' : 's'} · ${
        template?.title ?? ''
      }`
    : `${onCount} ${onCount === 1 ? 'source on' : 'sources on'} · tailored to ${workflowLabel.toLowerCase()}`;

  const sourcesEmptyCopy = !searchable
    ? 'Capiro looks for context using the campaign name, and this campaign does not have one yet.'
    : searchQuery.isFetching
      ? 'Looking for context Capiro may use…'
      : 'No context sources are available for this campaign yet.';

  const documentsEmptyCopy = !clientId
    ? 'Stored documents become available once the campaign names a single client sponsor.'
    : documentsQuery.isFetching
      ? 'Looking for documents your firm has already stored…'
      : documentsQuery.error
        ? 'The stored-document library could not be read, so nothing is listed here.'
        : 'Your firm has no stored documents for this client.';

  const uploadNoteId = `${idBase}-upload`;
  const pickerId = `${idBase}-picker`;

  return (
    <div className="ocb-step ocs">
      <p className="ocb-eyebrow ocs__summary">{summary}</p>

      {optionSet ? (
        <div className="ocb-inset ocs-fail">
          <span className="ocs-fail__icon" aria-hidden="true">
            <Lock size={16} />
          </span>
          <span className="ocs-fail__text">
            <span className="ocs-fail__title">Fails closed</span>
            <span className="ocb-prose ocs-fail__body">{optionSet.failsClosed}</span>
          </span>
        </div>
      ) : null}

      {optionSet ? (
        <>
          <div className="ocb-kv ocs-options">
            {optionSet.options.map((option) => {
              const descriptionId = `${idBase}-${option.key}`;
              const value = optionValues[option.key];
              const switchedOn = value === true;
              return (
                <div className="ocs-options__row" key={option.key}>
                  <span className="ocs-options__label">
                    <span className="ocs-options__name">{option.label}</span>
                    <span className="ocb-prose ocs-options__desc" id={descriptionId}>
                      {option.description}
                    </span>
                  </span>
                  <span className="ocs-options__control">
                    {option.kind === 'toggle' ? (
                      <button
                        type="button"
                        role="switch"
                        // The visible word is the state; the switch is named for
                        // the option so two "On" rows are still distinguishable.
                        aria-label={option.label}
                        aria-checked={switchedOn}
                        aria-describedby={descriptionId}
                        className="ocs-switch"
                        disabled={locked}
                        onClick={() => void setOption(option, !switchedOn)}
                      >
                        <span
                          className="ocb-check"
                          data-on={switchedOn ? 'true' : 'false'}
                          aria-hidden="true"
                        >
                          <Check size={12} />
                        </span>
                        {switchedOn ? 'On' : 'Off'}
                      </button>
                    ) : (
                      <span
                        role="group"
                        aria-label={option.label}
                        aria-describedby={descriptionId}
                        className="ocs-pills"
                      >
                        {option.choices.map((choice) => {
                          const selected =
                            option.kind === 'multi'
                              ? (Array.isArray(value) ? value : option.def).includes(choice)
                              : (typeof value === 'string' ? value : option.def) === choice;
                          return (
                            <button
                              type="button"
                              key={choice}
                              className="ocs-pill"
                              data-shape={option.kind}
                              data-selected={selected ? 'true' : 'false'}
                              aria-pressed={selected}
                              disabled={locked}
                              onClick={() => {
                                if (option.kind === 'choice') {
                                  void setOption(option, choice);
                                  return;
                                }
                                const current = Array.isArray(value) ? value : option.def;
                                // Copy before changing: the previous value is
                                // still the rendered one until the write lands.
                                void setOption(
                                  option,
                                  current.includes(choice)
                                    ? current.filter((entry) => entry !== choice)
                                    : [...current, choice],
                                );
                              }}
                            >
                              {choice}
                            </button>
                          );
                        })}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          {OPTIONS_UNWIRED_NOTE ? (
            <p className="ocb-note ocb-note--muted ocs__note">{OPTIONS_UNWIRED_NOTE}</p>
          ) : null}
        </>
      ) : (
        <>
          <div className="ocs-sources">
            {groups.length === 0 ? (
              <p className="ocb-note ocs-sources__empty">{sourcesEmptyCopy}</p>
            ) : (
              groups.map((group) => (
                <button
                  type="button"
                  key={group.key}
                  className="ocb-option ocs-source"
                  data-selected={group.on ? 'true' : 'false'}
                  aria-pressed={group.on}
                  disabled={locked}
                  onClick={() => void toggleGroup(group)}
                >
                  <span className="ocb-check" data-on={group.on ? 'true' : 'false'} aria-hidden="true">
                    <Check size={12} />
                  </span>
                  <span className="ocb-option__body">
                    <span className="ocs-source__head">
                      <span className="ocs-source__label">{group.label}</span>
                      {group.recipientScoped ? (
                        <span className="ocs-pill-static">Recipient-scoped</span>
                      ) : null}
                    </span>
                    <span className="ocb-option__desc">{group.description}</span>
                    <span className="ocb-eyebrow ocb-eyebrow--tight ocs-source__count">
                      {group.count}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
          {(searchQuery.data?.failures ?? []).map((failure) => (
            <p className="ocb-note ocb-note--warn ocs__note" key={failure.source}>
              {`${humanize(failure.source)} context could not be read, so this list is not everything: ${failure.message}`}
            </p>
          ))}
        </>
      )}

      <section className="ocb-card ocs-docs">
        <div className="ocb-card-head ocs-docs__head">
          <FileText size={17} className="ocs-docs__icon" aria-hidden="true" />
          <span className="ocs-docs__title">Your own documents</span>
          <span className="ocb-eyebrow ocb-eyebrow--inline ocs-docs__flag">Optional</span>
        </div>
        <div className="ocs-docs__body">
          <p className="ocb-prose ocs-docs__privacy">{OUTREACH_CONTEXT_DOCUMENT_ISOLATION_COPY}</p>

          {/* The prototype's drop zone, kept for the step's shape. The input is
              disabled because no route accepts an uploaded file as campaign
              context — an enabled control here could only lie. */}
          <label className="ocs-drop" data-disabled="true">
            <span className="ocs-drop__tile" aria-hidden="true">
              <Plus size={18} />
            </span>
            <span className="ocs-drop__text">
              <span className="ocs-drop__title">Drop a file here or browse</span>
              <span className="ocs-drop__hint">PDF, DOCX, XLSX or TXT · up to 25 MB each</span>
            </span>
            <span className="ocs-drop__btn" aria-hidden="true">
              Browse files
            </span>
            <input
              type="file"
              multiple
              disabled
              className="ocs-drop__input"
              aria-describedby={uploadNoteId}
            />
          </label>
          {UPLOAD_UNWIRED_NOTE ? (
            <p className="ocb-note ocb-note--muted" id={uploadNoteId}>
              {UPLOAD_UNWIRED_NOTE}
            </p>
          ) : null}

          <div className="ocs-picker">
            <label className="ocb-field__label ocs-picker__label" htmlFor={pickerId}>
              Add a stored document
            </label>
            {availableDocuments.length === 0 ? (
              <span className="ocs-docs__empty">{documentsEmptyCopy}</span>
            ) : (
              <span className="ocb-row">
                <select
                  id={pickerId}
                  className="ocb-select ocs-picker__select"
                  value={documentPick}
                  disabled={locked}
                  onChange={(event) => setDocumentPick(event.target.value)}
                >
                  <option value="">Choose a document</option>
                  {availableDocuments.map((candidate) => (
                    <option key={candidate.attachmentId} value={candidate.attachmentId}>
                      {candidate.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="ocb-btn ocb-btn--secondary ocb-btn--sm"
                  disabled={locked || !documentPick}
                  onClick={() => void addDocument()}
                >
                  Add document
                </button>
              </span>
            )}
          </div>

          {attached.length === 0 ? (
            <span className="ocs-docs__empty">{OUTREACH_CONTEXT_DOCUMENTS_EMPTY_COPY}</span>
          ) : (
            attached.map((row) => (
              <div className="ocs-doc" key={row.contextKey}>
                <FileText size={16} className="ocs-doc__icon" aria-hidden="true" />
                <span className="ocs-doc__text">
                  <span className="ocs-doc__name">{row.name}</span>
                  {row.meta ? <span className="ocs-doc__meta">{row.meta}</span> : null}
                </span>
                <span className="ocs-pill-static ocs-doc__pill">Campaign only</span>
                {/* `title` is the prototype's only accessible name; the label
                    names the file so a screen reader can tell two rows apart. */}
                <button
                  type="button"
                  className="ocs-doc__remove"
                  title="Remove"
                  aria-label={`Remove ${row.name}`}
                  disabled={locked}
                  onClick={() => void removeDocument(row)}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Never gated: no source on, no option touched and no document is a
          legitimate campaign, and the Review step says so in its own copy. */}
      <button type="button" className="ocb-btn ocb-btn--primary ocs__next" disabled={busy} onClick={onNext}>
        {primaryLabel}
      </button>
    </div>
  );
}
