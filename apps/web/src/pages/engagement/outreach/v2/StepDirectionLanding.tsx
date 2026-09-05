// Step 1, Direction — the wizard's informational landing page.
//
// "New Outreach" drops the user straight into the wizard, so this first step
// orients rather than interrogates: what an outreach campaign is, the three
// recipient types (Individual / List / Group), and a single CTA into Campaign
// Setup. Copy is verbatim (handover §9.4 — "Everything on Direction ... is
// verbatim from StepDirectionLanding.tsx"); only the presentation layer
// changed, from antd + step-direction-landing.css onto the Tailwind + React
// Aria components in ./ui per the real migration (handover §0, §6.4).
import './ui/tailwind.css';
import { Icon } from './ui/icons.js';
import { Button } from './ui/Button.js';
import { FeaturedIcon } from './ui/FeaturedIcon.js';

interface Props {
  /** Advances the wizard into Campaign Setup (same as the footer Continue). */
  onStart: () => void;
}

// Single source for the three recipient-type explainers: `card` is the short
// blurb on the right-column cards, `detail` the fuller copy in the bottom
// strip, `example` the italic use-case below it. Kept together so they can
// never drift apart.
const RECIPIENT_TYPES = [
  {
    key: 'individual',
    label: 'Individual',
    icon: Icon.User01,
    card: 'One personalized email per contact',
    detail:
      'One person, one email, personalized to them. Add congressional contacts, client contacts, or anyone manually. Send to as many individuals as you need in a single campaign.',
    example:
      'Send a policy update to a key staffer, with Capiro referencing your last meeting and their member’s committee priorities.',
  },
  {
    key: 'list',
    label: 'List',
    icon: Icon.LayoutAlt01,
    card: 'Saved contacts, each emailed individually',
    detail:
      'A saved group of contacts, each getting their own individual email. Build a list once and reuse it across campaigns.',
    example:
      'Send your quarterly legislative update to your full HASC staffers list. Every contact gets a personalized email in a single send.',
  },
  {
    key: 'group',
    label: 'Group',
    icon: Icon.Users01,
    card: 'All contacts receive one shared email',
    detail:
      'Multiple contacts on one shared email. Use when everyone needs to be on the same message. Send to as many groups as you need in a single campaign.',
    example:
      'Notify staffers across 10 congressional offices about an upcoming client visit, with each office receiving one coordinated email.',
  },
] as const;

export function StepDirectionLanding({ onStart }: Props) {
  return (
    <div className="ov2-tw-root">
      <div className="@container">
        <div className="grid grid-cols-1 gap-10 @[700px]:grid-cols-[minmax(360px,1fr)_minmax(280px,420px)]">
          <div className="flex flex-col items-start gap-5">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent-border bg-accent-tint px-3 py-1 text-xs font-medium text-accent-ink">
              <Icon.Link01 size={13} /> New outreach campaign
            </span>
            <h1 className="text-[36px] leading-[42px] font-bold tracking-[-0.025em] text-ink-primary text-pretty">
              Send the right email to the right people, automatically.
            </h1>
            <p className="max-w-[560px] text-[15px] leading-6 text-ink-secondary text-pretty">
              Capiro pulls context from your meeting history, connected inbox, and client portfolio
              to draft personalized outreach for every recipient. Add who you’re reaching, give it
              context, and it handles the rest.
            </p>
            <Button variant="primary" size="lg" onPress={onStart}>
              Create your outreach <Icon.ArrowRight size={18} />
            </Button>
            <p className="flex items-start gap-2 text-[13px] leading-[19px] text-ink-tertiary">
              <span className="mt-0.5 flex-none text-accent">
                <Icon.Stars02 size={14} />
              </span>
              <span>
                Capiro generates a draft for every recipient automatically, drawing from your
                connected inbox, past meeting debriefs, and client portfolio.{' '}
                <strong className="font-semibold text-ink-secondary">
                  You review, adjust, and send.
                </strong>
              </span>
            </p>
          </div>

          <div className="flex flex-col gap-3">
            {RECIPIENT_TYPES.map((type) => (
              <div
                key={type.key}
                className="flex items-center gap-3 rounded-lg border border-line-hairline bg-surface p-4 shadow-card"
              >
                <FeaturedIcon icon={type.icon} color="brand" size="lg" />
                <div className="min-w-0">
                  <div className="text-xl leading-6 font-semibold tracking-[-0.01em] text-ink-primary">
                    {type.label}
                  </div>
                  <div className="text-sm leading-5 text-ink-tertiary">{type.card}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-9 flex flex-col gap-6 border-t border-line-hairline pt-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-accent-tint px-3 py-1 text-[13px] font-semibold text-accent-ink">
              Individual
            </span>
            <span className="text-ink-quaternary">+</span>
            <span className="rounded-full bg-accent-tint px-3 py-1 text-[13px] font-semibold text-accent-ink">
              List
            </span>
            <span className="text-ink-quaternary">+</span>
            <span className="rounded-full bg-accent-tint px-3 py-1 text-[13px] font-semibold text-accent-ink">
              Group
            </span>
          </div>
          <p className="max-w-[640px] text-sm leading-5 text-ink-secondary text-pretty">
            <strong className="font-semibold text-ink-primary">Mix and match in a single campaign.</strong>{' '}
            Add individual contacts, apply a saved list, and create a group, all at once. Capiro
            generates a personalized draft for each.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {RECIPIENT_TYPES.map((type) => (
            <div
              key={type.key}
              className="flex flex-col gap-2.5 rounded-lg border border-line-hairline bg-surface p-4"
            >
              <div className="flex items-center gap-2">
                <FeaturedIcon icon={type.icon} color="brand" size="md" />
                <b className="text-[15px] leading-5 font-semibold text-ink-primary">{type.label}</b>
              </div>
              <p className="text-[13px] leading-5 text-ink-secondary">{type.detail}</p>
              <div className="rounded-[10px] bg-surface-subtle p-3 text-[13px] leading-5 text-ink-tertiary italic">
                {type.example}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
