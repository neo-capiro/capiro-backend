import type { OutreachTemplateContentSkeleton } from './outreach-template.contract.js';

/**
 * Starter content skeletons.
 *
 * These replace the six hardcoded frontend samples that used to live in
 * `apps/web/src/vnext/pages/engagement/outreach-v3-content-templates.ts`. That
 * array was checked-in source: a user could preview a sample but never edit one,
 * and the sample reached generation as low-authority "structure and tone"
 * guidance the model was free to ignore.
 *
 * Converting them to skeletons changes what they ARE. The literal prose here is
 * now the actual email structure — the server renders it verbatim and only the
 * `{{slot}}` regions are model-written. So the text below is no longer
 * illustrative filler; every word outside a token ships to a recipient.
 *
 * Two rules followed throughout, both learned from the samples they replace:
 *
 *   1. **No specimen facts.** The old samples contained invented dates, dollar
 *      figures, agency names and bill numbers as illustration, and the prompt had
 *      to work hard to tell the model not to copy them. A skeleton cannot contain
 *      a specimen fact at all — it would be literal output. Every fact is a slot.
 *   2. **Optional where evidence may be thin.** A section whose content depends
 *      on evidence that may not exist is `required: false`, so it drops out
 *      instead of being filled with invented content. This is what makes one
 *      skeleton serve recipients with different evidence coverage.
 *
 * These are seeded as `firm`-scope templates so a whole tenant gets them and any
 * member can duplicate one into a private edit. They are ordinary rows after
 * seeding — editable and deletable like any user-authored template.
 */
export interface StarterContentTemplate {
  /** Stable id, also the idempotency key for seeding. */
  key: string;
  /** Matches the guided workflow that offers it. */
  workflow: 'request_meeting' | 'send_update';
  name: string;
  description: string;
  skeleton: OutreachTemplateContentSkeleton;
}

const MEETING_REQUEST: StarterContentTemplate = {
  key: 'starter_meeting_request_standard',
  workflow: 'request_meeting',
  name: 'Briefing meeting request',
  description:
    'A concise, personalized request for a short meeting, citing one concrete connection drawn from the campaign’s own evidence.',
  skeleton: {
    subject: 'Meeting request: {{topic_line}}',
    body: [
      'Dear {{salutation}},',
      '',
      '{{opening}}',
      '',
      'Why this matters to your office',
      '{{why_it_matters}}',
      '',
      'What we’d cover',
      '{{what_wed_cover}}',
      '',
      'Availability',
      '{{availability}}',
      '',
      '{{closing_line}}',
    ].join('\n'),
    slots: [
      {
        key: 'topic_line',
        label: 'Subject topic',
        instruction:
          'The campaign topic as it should read in a subject line. A short noun phrase, no trailing punctuation.',
        required: true,
      },
      {
        key: 'salutation',
        label: 'Salutation',
        instruction:
          'How to address the recipient, using the server-resolved recipient identity — e.g. "Ms. Reyes" or "Senator Lankford". Name and honorific only, no greeting word (the template supplies "Dear").',
        required: true,
      },
      {
        key: 'opening',
        label: 'Opening',
        instruction:
          'One or two sentences: who is writing, on whose behalf, and that they are requesting a short meeting about the topic. No factual claims beyond the sponsor relationship.',
        required: true,
      },
      {
        key: 'why_it_matters',
        label: 'Why this matters to their office',
        instruction:
          'One or two sentences citing ONE specific, supported connection to this recipient — a committee assignment, prior legislative interest, district or state impact, or a program element. Use only claims the Message Plan supports, and state the as-of date for any legislative or funding claim. If the plan supports no such connection, return an empty string.',
        required: false,
      },
      {
        key: 'what_wed_cover',
        label: 'What we’d cover',
        instruction:
          'One or two sentences describing the proposed agenda and the meeting length. Do not invent attendees or commitments.',
        required: true,
      },
      {
        key: 'availability',
        label: 'Availability',
        instruction:
          'The scheduling ask, deferring to their team’s preference. Include a proposed window only if the plan’s ask specifies one; otherwise ask them to propose times. Return an empty string if the plan makes no scheduling ask.',
        required: false,
      },
      {
        key: 'closing_line',
        label: 'Closing line',
        instruction:
          'One short courteous closing sentence, e.g. thanking them for considering the request and noting who to contact about scheduling. No signature block or sign-off.',
        required: true,
      },
    ],
  },
};

const HEARINGS_WEEK_AHEAD: StarterContentTemplate = {
  key: 'starter_hearings_week_ahead',
  workflow: 'send_update',
  name: 'Hearings & markup week-ahead',
  description:
    'Committee hearings and markups in the coming week that touch the sponsor’s watched committees, program elements, bills, or issue tags.',
  skeleton: {
    subject: 'Week ahead — hearings & markups: {{window_label}}',
    body: [
      'Bottom line',
      '{{bottom_line}}',
      '',
      'House',
      '{{house_items}}',
      '',
      'Senate',
      '{{senate_items}}',
      '',
      'Also on calendar',
      '{{also_on_calendar}}',
      '',
      'Suggested actions',
      '{{actions}}',
    ].join('\n'),
    slots: [
      {
        key: 'window_label',
        label: 'Date window',
        instruction:
          'The date range this digest covers, e.g. "Aug 25–29". Use only a window the plan supports.',
        required: true,
      },
      {
        key: 'bottom_line',
        label: 'Bottom line',
        instruction:
          'Two or three sentences: how many sessions touch watched equities, how many are markups, and what the reader should take away. Every count must come from the plan’s supported claims.',
        required: true,
      },
      {
        key: 'house_items',
        label: 'House sessions',
        instruction:
          'One block per House session: date, time, committee, whether it is a hearing or a markup, its title, and one line on why it matters to this sponsor. Use "-" list items. Return an empty string if the plan supports no House sessions.',
        required: false,
      },
      {
        key: 'senate_items',
        label: 'Senate sessions',
        instruction:
          'Same shape as the House section, for Senate sessions. Return an empty string if the plan supports none.',
        required: false,
      },
      {
        key: 'also_on_calendar',
        label: 'Also on calendar',
        instruction:
          'Sessions on the firm’s committee watch with no direct client hit, one line each. Return an empty string if there are none.',
        required: false,
      },
      {
        key: 'actions',
        label: 'Suggested actions',
        instruction:
          'Two or three numbered next steps the reader can take. Actions only — no new factual claims.',
        required: true,
      },
    ],
  },
};

const FUNDING_OPPORTUNITY_DIGEST: StarterContentTemplate = {
  key: 'starter_funding_opportunity_digest',
  workflow: 'send_update',
  name: 'Funding opportunity match digest',
  description:
    'Active opportunities matched to the sponsor’s profile above a relevance floor, split into new high-fit matches and items closing soon.',
  skeleton: {
    subject: 'Funding opportunity matches: {{window_label}}',
    body: [
      'Scope of this list',
      '{{scope_note}}',
      '',
      'New high-fit matches',
      '{{new_matches}}',
      '',
      'Closing soon',
      '{{closing_soon}}',
      '',
      'Already in workflow',
      '{{in_workflow}}',
      '',
      'Suggested actions',
      '{{actions}}',
    ].join('\n'),
    slots: [
      {
        key: 'window_label',
        label: 'Window',
        instruction: 'The period or as-of date this digest covers.',
        required: true,
      },
      {
        key: 'scope_note',
        label: 'Scope note',
        instruction:
          'One or two sentences stating that this covers pursuable-active matches above the sponsor’s relevance floor, not the full government catalogue — so an empty section never reads as "nothing exists".',
        required: true,
      },
      {
        key: 'new_matches',
        label: 'New high-fit matches',
        instruction:
          'One numbered entry per new match: identifier, title, agency or office, due or close date, and why it matched. Only opportunities the plan supports. Return an empty string if there are no new matches.',
        required: false,
      },
      {
        key: 'closing_soon',
        label: 'Closing soon',
        instruction:
          'Opportunities closing soonest with their dates, grouped by urgency. Return an empty string if none are closing in the window.',
        required: false,
      },
      {
        key: 'in_workflow',
        label: 'Already in workflow',
        instruction:
          'Opportunities already being pursued, with status and owner. Return an empty string if none.',
        required: false,
      },
      {
        key: 'actions',
        label: 'Suggested actions',
        instruction: 'Two or three numbered next steps. No new factual claims.',
        required: true,
      },
    ],
  },
};

const FEDERAL_AWARDS_ROLLUP: StarterContentTemplate = {
  key: 'starter_federal_awards_rollup',
  workflow: 'send_update',
  name: 'Federal awards & primes roll-up',
  description:
    'New or modified federal awards for the sponsor and its confirmed prime and competitor mappings over the lookback window.',
  skeleton: {
    subject: 'Awards pulse: {{window_label}}',
    body: [
      'Basis for this roll-up',
      '{{basis_note}}',
      '',
      'Sponsor awards',
      '{{self_awards}}',
      '',
      'Primes',
      '{{prime_awards}}',
      '',
      'Competitors',
      '{{competitor_awards}}',
      '',
      'Suggested actions',
      '{{actions}}',
    ].join('\n'),
    slots: [
      {
        key: 'window_label',
        label: 'Window',
        instruction: 'The lookback window and as-of date for this roll-up.',
        required: true,
      },
      {
        key: 'basis_note',
        label: 'Basis note',
        instruction:
          'One or two sentences stating that awards appear only for confirmed contractor-name mappings, so an absent row means no confirmed mapping rather than no contracts. This caveat is required — do not omit it.',
        required: true,
      },
      {
        key: 'self_awards',
        label: 'Sponsor awards',
        instruction:
          'New or modified award actions for the sponsor: amount, agency, award identifier, short description, action date. Only awards the plan supports. Return an empty string if there were none in the window.',
        required: false,
      },
      {
        key: 'prime_awards',
        label: 'Prime awards',
        instruction:
          'Confirmed prime mappings only, one line each with action count and top agency. Return an empty string if there are no confirmed primes with activity.',
        required: false,
      },
      {
        key: 'competitor_awards',
        label: 'Competitor awards',
        instruction:
          'Confirmed competitor mappings, with any overlap against the sponsor’s pursuits. Return an empty string if none.',
        required: false,
      },
      {
        key: 'actions',
        label: 'Suggested actions',
        instruction: 'Two or three numbered next steps. No new factual claims.',
        required: true,
      },
    ],
  },
};

const DEFENSE_TOPLINES: StarterContentTemplate = {
  key: 'starter_defense_toplines',
  workflow: 'send_update',
  name: 'Curated defense top-lines',
  description:
    'What moved in the official legislative record this week on watched committees, bills, and program elements — authorization and appropriations kept separate.',
  skeleton: {
    subject: 'Official record — defense: {{window_label}}',
    body: [
      '{{framing_note}}',
      '',
      'Authorization',
      '{{authorization}}',
      '',
      'Appropriations',
      '{{appropriations}}',
      '',
      'Committee language & directives',
      '{{committee_language}}',
      '',
      'Oversight & research',
      '{{oversight}}',
      '',
      'What is not included',
      '{{exclusions}}',
    ].join('\n'),
    slots: [
      {
        key: 'window_label',
        label: 'Window',
        instruction: 'The week or date range this covers.',
        required: true,
      },
      {
        key: 'framing_note',
        label: 'Framing note',
        instruction:
          'One sentence stating this is the official record, not a news roundup, and naming its sources at a high level.',
        required: true,
      },
      {
        key: 'authorization',
        label: 'Authorization track',
        instruction:
          'Authorization-track actions only: committee, action, vehicle, latest action and date. Never mix appropriations items in here. Return an empty string if nothing moved.',
        required: false,
      },
      {
        key: 'appropriations',
        label: 'Appropriations track',
        instruction:
          'Appropriations-track actions only, kept strictly separate from authorization. Include dollar figures ONLY where the plan supports a canonical figure. Return an empty string if nothing moved.',
        required: false,
      },
      {
        key: 'committee_language',
        label: 'Committee language & directives',
        instruction:
          'Report language or directives, framed as oversight actions rather than funding decisions. Return an empty string if none.',
        required: false,
      },
      {
        key: 'oversight',
        label: 'Oversight & research',
        instruction:
          'Relevant oversight or research publications with dates. Return an empty string if none.',
        required: false,
      },
      {
        key: 'exclusions',
        label: 'What is not included',
        instruction:
          'One or two sentences naming what was deliberately excluded — media commentary, unconfirmed figures, anything not yet canonical. Required, because it is what makes the rest trustworthy.',
        required: true,
      },
    ],
  },
};

const BILL_PE_CROSSWALK: StarterContentTemplate = {
  key: 'starter_bill_pe_crosswalk',
  workflow: 'send_update',
  name: 'Bill ↔ program element crosswalk',
  description:
    'New links between watched program elements and bill text, committee reports, or hearing titles — evidence-gated, never title similarity alone.',
  skeleton: {
    subject: 'Bill ↔ program element crosswalk: {{window_label}}',
    body: [
      'Scope',
      '{{scope_note}}',
      '',
      'New links by program element',
      '{{links_by_pe}}',
      '',
      'Hearing-only mentions',
      '{{hearing_only}}',
      '',
      'No movement',
      '{{no_movement}}',
      '',
      'Suggested actions',
      '{{actions}}',
    ].join('\n'),
    slots: [
      {
        key: 'window_label',
        label: 'Window',
        instruction: 'The date range this crosswalk covers.',
        required: true,
      },
      {
        key: 'scope_note',
        label: 'Scope note',
        instruction:
          'One or two sentences: how many program elements are watched, how many new links appeared, and that a link requires a real code extraction or structured mention rather than title similarity.',
        required: true,
      },
      {
        key: 'links_by_pe',
        label: 'New links by program element',
        instruction:
          'One block per program element with a new link: the element, the bill or report, which track it belongs to, and the evidence for the link. Return an empty string if there were no new links.',
        required: false,
      },
      {
        key: 'hearing_only',
        label: 'Hearing-only mentions',
        instruction:
          'Program elements mentioned in a hearing title with no bill text yet, framed as oversight signals. Return an empty string if none.',
        required: false,
      },
      {
        key: 'no_movement',
        label: 'No movement',
        instruction:
          'One line stating how many watched program elements had no new link this window. Return an empty string if every watched element moved.',
        required: false,
      },
      {
        key: 'actions',
        label: 'Suggested actions',
        instruction: 'Two or three numbered next steps. No new factual claims.',
        required: true,
      },
    ],
  },
};

const ENGAGEMENT_WEEK_IN_REVIEW: StarterContentTemplate = {
  key: 'starter_engagement_week_in_review',
  workflow: 'send_update',
  name: 'Relationship week-in-review',
  description:
    'Held and upcoming meetings, prep status, and open commitments for the sponsor over the last week.',
  skeleton: {
    subject: 'Engagement week in review: {{window_label}}',
    body: [
      '{{opening}}',
      '',
      'Completed',
      '{{completed}}',
      '',
      'Coming up',
      '{{coming_up}}',
      '',
      'Open items we own',
      '{{open_items}}',
      '',
      'Items we need from you',
      '{{needed_from_you}}',
      '',
      '{{closing_note}}',
    ].join('\n'),
    slots: [
      {
        key: 'window_label',
        label: 'Window',
        instruction: 'The week this covers.',
        required: true,
      },
      {
        key: 'opening',
        label: 'Opening',
        instruction:
          'One or two sentences introducing the record of engagement on the recipient’s behalf.',
        required: true,
      },
      {
        key: 'completed',
        label: 'Completed',
        instruction:
          'One line per held meeting: who, topic, and the one commitment made. Do not include internal scoring or any other client’s name. Return an empty string if no meetings were held.',
        required: false,
      },
      {
        key: 'coming_up',
        label: 'Coming up',
        instruction:
          'One line per upcoming meeting relevant to this recipient. Return an empty string if none are scheduled.',
        required: false,
      },
      {
        key: 'open_items',
        label: 'Open items we own',
        instruction:
          'Numbered commitments the firm owns, with due dates where the plan supports them. Return an empty string if there are none.',
        required: false,
      },
      {
        key: 'needed_from_you',
        label: 'Items needed from the recipient',
        instruction:
          'Only if something is genuinely needed from the recipient. Return an empty string otherwise — never pad this section.',
        required: false,
      },
      {
        key: 'closing_note',
        label: 'Closing note',
        instruction:
          'One short closing sentence. If outreach copy is still in internal review, say so plainly rather than implying anything was sent.',
        required: true,
      },
    ],
  },
};

export const STARTER_CONTENT_TEMPLATES: StarterContentTemplate[] = [
  MEETING_REQUEST,
  HEARINGS_WEEK_AHEAD,
  FUNDING_OPPORTUNITY_DIGEST,
  FEDERAL_AWARDS_ROLLUP,
  DEFENSE_TOPLINES,
  BILL_PE_CROSSWALK,
  ENGAGEMENT_WEEK_IN_REVIEW,
];

export function starterContentTemplatesForWorkflow(
  workflow: StarterContentTemplate['workflow'],
): StarterContentTemplate[] {
  return STARTER_CONTENT_TEMPLATES.filter((template) => template.workflow === workflow);
}
