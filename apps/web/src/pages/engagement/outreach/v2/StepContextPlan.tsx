// Step 4, Context Plan — the first half of what used to be the single "Build
// Context" step (StepContext.tsx). Two panels:
//   • Left  — the campaign-scoped "main idea": one free-text field everyone on
//             this campaign gets, new in this split.
//   • Right — "Personal Notes": selected items grouped into Shared (every
//             recipient sees it) and per-target sections (each individual /
//             list / group). This half is the OLD step's right pane, moved
//             here verbatim — same ContextCard, same ScopeSelect, same
//             mutators, via the shared useContextPlan hook. Presentation
//             rebuilt onto Tailwind + React Aria per the real migration
//             (handover §0, §6.7); nothing about the hook or its handlers
//             changed.
//
// The pool browser (the old step's LEFT pane) is now its own full-width step
// 5 — see StepContextBuilder.tsx. Both steps call useContextPlan with the
// SAME recipients/targets/selected/onChange the wizard already passes them,
// so toggling an item in step 5 is immediately visible here and vice versa.

import type { ReactNode } from 'react';
import {
  Select as RACSelect,
  Popover,
  ListBox,
  ListBoxSection,
  ListBoxItem,
  Header,
  Button as RACButton,
} from 'react-aria-components';
import type { OutreachRecipient } from '../../OutreachView.js';
import type { OutreachTarget } from './targets.js';
import type { ContextKind, SelectedContextItem } from './types.js';
import { useContextPlan, type ScopeOptions } from './useContextPlan.js';
import './ui/tailwind.css';
import { Icon } from './ui/icons.js';
import { Avatar } from './ui/Avatar.js';
import { FeaturedIcon } from './ui/FeaturedIcon.js';
import { TextArea } from './ui/Input.js';

const KIND_LABEL: Record<ContextKind, string> = {
  bill: 'Bill',
  stateBill: 'State bill',
  intel: 'Intel',
  email: 'Past email',
  // `meeting` kept for back-compat with saved drafts (Past meetings retired).
  meeting: 'Meeting',
  debrief: 'Debrief',
  note: 'Note',
  document: 'Doc/Note',
  prep: 'Prep',
  programElement: 'Program Element',
};

interface Props {
  recipients: OutreachRecipient[];
  targets: OutreachTarget[];
  selected: SelectedContextItem[];
  onChange: (next: SelectedContextItem[]) => void;
  mainIdea: string;
  onMainIdeaChange: (v: string) => void;
}

export function StepContextPlan({
  recipients,
  targets,
  selected,
  onChange,
  mainIdea,
  onMainIdeaChange,
}: Props) {
  const {
    scopeOptions,
    planSections,
    sharedItems,
    orphanItems,
    setNote,
    setNoteUse,
    setScope,
    remove,
    addNoteForScope,
  } = useContextPlan(recipients, targets, selected, onChange);

  const recipientScopedCount = selected.length - sharedItems.length;
  const withInstructionsCount = selected.filter((c) => (c.note ?? '').trim().length > 0).length;
  const wordCount = mainIdea.trim() ? mainIdea.trim().split(/\s+/).filter(Boolean).length : 0;

  return (
    <div className="ov2-tw-root">
      <h2 className="text-[22px] leading-7 font-bold tracking-[-0.02em] text-ink-primary">
        Review the context plan
      </h2>
      <div className="mt-1.5 mb-5 text-sm leading-5 text-ink-secondary">
        What Meri may use, and who each item reaches. Scope an item to one recipient or to
        everyone, and write the instruction you want it used under.
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-line-hairline bg-surface px-4 py-3">
        <Avatar initials="M" size={26} tone="navy" />
        <span className="text-[13.5px] font-semibold text-ink-primary">Context plan</span>
        <span className="rounded-full bg-accent-tint px-2.5 py-0.5 text-xs font-medium text-accent-ink">
          {recipientScopedCount} recipient note{recipientScopedCount === 1 ? '' : 's'}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-3 text-xs text-ink-tertiary">
          <span className={mainIdea.trim() ? 'font-semibold text-success' : 'italic'}>
            {mainIdea.trim() ? 'Main idea written' : 'No main idea yet'}
          </span>
          <span>{recipientScopedCount} recipient-specific</span>
          <span>{withInstructionsCount} with instructions</span>
        </span>
      </div>

      <div className="@container">
        <div className="grid grid-cols-1 gap-4 @[800px]:grid-cols-2">
          {/* ---------- LEFT: main idea ---------- */}
          <div className="flex flex-col rounded-lg border border-line-hairline bg-surface">
            <div className="flex items-start gap-2.5 border-b border-line-hairline p-4">
              <FeaturedIcon icon={Icon.Users01} color="brand" size="md" />
              <div className="min-w-0">
                <div className="text-[15px] leading-[21px] font-semibold text-ink-primary">
                  What is the main idea for your outreach? What do you want to write about?
                </div>
                <div className="mt-0.5 text-[12.5px] leading-[18px] text-ink-tertiary">
                  Everyone on this campaign gets this. Write it in your own words — Meri builds
                  every draft around it.
                </div>
              </div>
            </div>
            <div className="flex-1 bg-surface-subtle p-4">
              <TextArea
                value={mainIdea}
                onChange={onMainIdeaChange}
                rows={12}
                placeholder="e.g. Section 218 of H.R. 4021 adds an annual report on autonomous ground system test policy, 180 days after enactment. I want office to understand what the reporting requirement asks of them…"
                className="h-full min-h-[220px]"
              />
            </div>
            <div className="flex items-start justify-between gap-3 border-t border-line-hairline p-4">
              <span className="text-[12px] leading-[18px] text-ink-tertiary">
                Meri never invents facts from this. Anything checkable comes from the sources you
                add in the next step.
              </span>
              <span className="flex-none font-mono text-[11px] text-ink-tertiary">
                {wordCount} words
              </span>
            </div>
          </div>

          {/* ---------- RIGHT: Personal Notes ---------- */}
          <div className="flex flex-col rounded-lg border border-line-hairline bg-surface">
            <div className="flex items-center gap-2.5 rounded-t-lg border-b border-accent-border bg-accent-tint p-4">
              <FeaturedIcon icon={Icon.User01} color="brand" size="md" className="bg-surface" />
              <div className="min-w-0 flex-1">
                <div className="text-[15px] leading-[21px] font-semibold text-accent-ink">
                  Personal Notes
                </div>
                <div className="mt-0.5 text-[12.5px] leading-[18px] text-accent-muted">
                  Reaches that one person and nobody else.
                </div>
              </div>
              <span className="rounded-full bg-surface px-2 py-0.5 font-mono text-[11px] font-medium text-accent-ink">
                {selected.length}
              </span>
            </div>

            <div className="flex flex-col gap-4 p-4">
              {targets.length === 0 && (
                <div className="rounded-md border border-dashed border-line-control bg-surface-subtle p-4 text-[13px] leading-5 text-ink-tertiary">
                  <b className="mb-1 block font-semibold text-ink-primary">
                    Pick recipients first
                  </b>
                  Per-recipient routing needs a recipient list. Go back to step 3 to add one.
                </div>
              )}

              {/* Shared section */}
              <Section
                icon={Icon.Globe01}
                name="Shared"
                trailing="· every recipient sees this"
                count={sharedItems.length}
              >
                {sharedItems.length === 0 && <EmptyRow>No shared context yet</EmptyRow>}
                {sharedItems.map((c) => (
                  <ContextCard
                    key={c.id}
                    c={c}
                    scopeOptions={scopeOptions}
                    onNote={setNote}
                    onNoteUse={setNoteUse}
                    onScope={setScope}
                    onRemove={remove}
                  />
                ))}
                <AddNoteButton onClick={() => addNoteForScope('all')}>
                  + Add shared note
                </AddNoteButton>
              </Section>

              {/* Per-target sections: individuals, lists, groups */}
              {planSections.map((s) => (
                <Section
                  key={s.scope}
                  icon={s.kind === 'individual' ? Icon.User01 : s.kind === 'list' ? Icon.LayoutAlt01 : Icon.Users01}
                  name={s.name}
                  badge={s.kind}
                  count={s.items.length}
                >
                  {s.items.length === 0 && (
                    <EmptyRow>
                      {s.kind === 'group'
                        ? 'No group-specific context, uses shared only.'
                        : 'No personalized context, uses shared only.'}
                    </EmptyRow>
                  )}
                  {s.items.map((c) => (
                    <ContextCard
                      key={c.id}
                      c={c}
                      scopeOptions={scopeOptions}
                      onNote={setNote}
                      onNoteUse={setNoteUse}
                      onScope={setScope}
                      onRemove={remove}
                    />
                  ))}
                  <AddNoteButton onClick={() => addNoteForScope(s.scope)}>
                    + Add note for {s.name.split(' ').slice(0, 2).join(' ')}
                  </AddNoteButton>
                </Section>
              ))}

              {orphanItems.length > 0 && (
                <Section icon={Icon.User01} name="Other" badge="unrouted" count={orphanItems.length}>
                  <EmptyRow>
                    Scoped to a recipient no longer shown above — re-route with “Applies to”, or
                    remove.
                  </EmptyRow>
                  {orphanItems.map((c) => (
                    <ContextCard
                      key={c.id}
                      c={c}
                      scopeOptions={scopeOptions}
                      onNote={setNote}
                      onNoteUse={setNoteUse}
                      onScope={setScope}
                      onRemove={remove}
                    />
                  ))}
                </Section>
              )}
            </div>

            <div className="mt-auto flex items-center gap-1.5 rounded-b-lg border-t border-line-hairline bg-surface-subtle px-4 py-3 text-[11.5px] text-ink-tertiary">
              <span>
                <b className="font-semibold text-ink-primary">{selected.length}</b> items
              </span>
              <span>·</span>
              <span>
                <b className="font-semibold text-ink-primary">{sharedItems.length}</b> shared
              </span>
              <span>
                <b className="font-semibold text-ink-primary">
                  {selected.length - sharedItems.length}
                </b>{' '}
                scoped
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------- Small structural helpers (Personal Notes layout) ----------------

function Section({
  icon: IconCmp,
  name,
  badge,
  trailing,
  count,
  children,
}: {
  icon: typeof Icon.User01;
  name: string;
  badge?: 'individual' | 'list' | 'group' | 'unrouted';
  trailing?: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-line-hairline pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2 text-[11px] font-bold tracking-[0.02em] text-ink-tertiary uppercase">
        <span className="flex h-5 w-5 items-center justify-center rounded-[6px] bg-surface-subtle text-ink-secondary">
          <IconCmp size={12} />
        </span>
        <span className="text-ink-primary">{name}</span>
        {trailing && <span className="font-normal tracking-normal text-ink-tertiary normal-case">{trailing}</span>}
        {badge && (
          <span
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-normal normal-case ${
              badge === 'individual'
                ? 'bg-accent-tint text-accent-ink'
                : badge === 'list'
                  ? 'bg-success-bg text-success'
                  : badge === 'group'
                    ? 'bg-warning-bg text-warning-heading'
                    : 'bg-neutral-bg text-neutral-ink'
            }`}
          >
            {badge}
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] font-medium tracking-normal text-ink-tertiary normal-case">
          {count}
        </span>
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-line-control p-3 text-[12px] text-ink-tertiary italic">
      {children}
    </div>
  );
}

function AddNoteButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-fit rounded-sm border border-dashed border-accent px-2.5 py-1.5 text-xs font-semibold text-accent-ink hover:bg-accent-tint"
    >
      {children}
    </button>
  );
}

// ---------------- Applies-to scope dropdown ----------------

/** Resolve a scope value to its display icon + label for the trigger. */
function resolveScope(value: string, opts: ScopeOptions): { icon: ReactNode; label: string } {
  if (value === 'all') return { icon: <Icon.Globe01 size={14} />, label: 'All recipients (shared)' };
  if (value.startsWith('list:')) {
    const o = opts.lists.find((x) => x.value === value);
    return { icon: <Icon.LayoutAlt01 size={14} />, label: o?.label ?? 'List' };
  }
  if (value.startsWith('group:')) {
    const o = opts.groups.find((x) => x.value === value);
    return { icon: <Icon.Users01 size={14} />, label: o?.label ?? 'Group' };
  }
  const o = opts.individuals.find((x) => x.value === value);
  return { icon: <Icon.User01 size={14} />, label: o?.label ?? 'Recipient' };
}

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-[12.5px] text-ink-primary outline-none data-[focused]:bg-surface-subtle data-[selected]:bg-accent-tint data-[selected]:text-accent-ink';

function ScopeSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: ScopeOptions;
  onChange: (scope: string) => void;
}) {
  const current = resolveScope(value, options);

  return (
    <RACSelect
      aria-label="Applies to"
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
      className="relative"
    >
      <RACButton className="flex items-center gap-1.5 rounded-sm border border-line-control bg-surface px-2.5 py-1 text-[12.5px] text-ink-primary data-[pressed]:border-accent">
        <span className="flex-none text-ink-tertiary">{current.icon}</span>
        <span className="truncate">{current.label}</span>
        <Icon.ChevronDown size={11} className="flex-none text-ink-tertiary" />
      </RACButton>
      <Popover className="w-72 rounded-md border border-line-hairline bg-surface shadow-card">
        <ListBox className="max-h-72 overflow-auto p-1.5 outline-none">
          <ListBoxItem id="all" className={ITEM_CLASS}>
            <Icon.Globe01 size={14} className="flex-none" />
            <span className="flex-1 truncate">All recipients (shared)</span>
            <span className="flex-none rounded-full bg-accent-tint px-1.5 py-0.5 text-[10px] text-accent-ink">
              Shared
            </span>
          </ListBoxItem>

          {options.individuals.length > 0 && (
            <ListBoxSection>
              <Header className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-[0.04em] text-ink-quaternary uppercase">
                Individuals
              </Header>
              {options.individuals.map((o) => (
                <ListBoxItem key={o.value} id={o.value} className={ITEM_CLASS}>
                  <Icon.User01 size={14} className="flex-none" />
                  <span className="flex-1 min-w-0 truncate">{o.label}</span>
                </ListBoxItem>
              ))}
            </ListBoxSection>
          )}

          {options.lists.length > 0 && (
            <ListBoxSection>
              <Header className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-[0.04em] text-ink-quaternary uppercase">
                Lists
              </Header>
              {options.lists.map((o) => (
                <ListBoxItem key={o.value} id={o.value} className={ITEM_CLASS}>
                  <Icon.LayoutAlt01 size={14} className="flex-none" />
                  <span className="flex-1 min-w-0 truncate">{o.label}</span>
                </ListBoxItem>
              ))}
            </ListBoxSection>
          )}

          {options.groups.length > 0 && (
            <ListBoxSection>
              <Header className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-[0.04em] text-ink-quaternary uppercase">
                Groups
              </Header>
              {options.groups.map((o) => (
                <ListBoxItem key={o.value} id={o.value} className={ITEM_CLASS}>
                  <Icon.Users01 size={14} className="flex-none" />
                  <span className="flex-1 min-w-0 truncate">{o.label}</span>
                </ListBoxItem>
              ))}
            </ListBoxSection>
          )}
        </ListBox>
      </Popover>
    </RACSelect>
  );
}

// ---------------- Single card ----------------

interface CardProps {
  c: SelectedContextItem;
  scopeOptions: ScopeOptions;
  onNote: (id: string, note: string) => void;
  onScope: (id: string, scope: 'all' | string) => void;
  onRemove: (id: string) => void;
  onNoteUse: (id: string, use: 'fact' | 'instruction') => void;
}

function ContextCard({ c, scopeOptions, onNote, onScope, onRemove, onNoteUse }: CardProps) {
  const noteUse = c.noteUse === 'fact' ? 'fact' : 'instruction';
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line-hairline bg-surface p-3">
      <div className="flex items-start gap-2">
        <span className="flex-none rounded-[5px] bg-neutral-bg px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-[0.04em] text-neutral-ink uppercase">
          {KIND_LABEL[c.kind]}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-primary">
          {c.title}
        </span>
        <button
          onClick={() => onRemove(c.id)}
          title="Remove"
          aria-label="Remove context item"
          className="flex-none text-ink-tertiary hover:text-warning"
        >
          <Icon.XClose size={12} />
        </button>
      </div>

      {/* Phase 1 §3.d3 — why an auto-suggested thread is here, and from which
          mailbox. A suggestion the user cannot interrogate is one they cannot
          reasonably approve. (Suggestions are never pre-selected: an item only
          reaches this list once the user adds it.) */}
      {c.relevance ? (
        <div className="rounded-md border border-line-divider bg-surface-subtle p-2 text-[11px] text-ink-tertiary">
          <span className="font-semibold text-ink-secondary">{c.relevance} relevance</span>
          {c.mailboxScope ? <span className="ml-2">{c.mailboxScope}</span> : null}
          {c.relevanceReasons?.length ? (
            <ul className="mt-1 list-disc pl-4">
              {c.relevanceReasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Display-only preview. Under the gateway the SERVER rehydrates this
          source by id — whatever text is shown here never reaches the model. */}
      {c.body && (
        <div className="rounded-md bg-surface-subtle p-2 text-[12px] leading-[1.45] text-ink-secondary">
          {c.body}
        </div>
      )}
      <TextArea
        value={c.note}
        onChange={(v) => onNote(c.id, v)}
        rows={2}
        placeholder={
          c.kind === 'note'
            ? 'Write your note here…'
            : "+ Add a personalized instruction (optional), e.g. 'lead with this', 'omit the deadline language'…"
        }
        className="text-[12px] leading-[1.5]"
      />

      {/* Phase 1 §3.b2 — is this note something to DO, or something that is TRUE?
          Defaults to instruction: treating typed prose as an assertable fact is
          how "we spoke last week" becomes invented detail about the call. */}
      {c.kind === 'note' ? (
        <div role="radiogroup" aria-label="How to use this note" className="flex gap-1.5">
          <button
            type="button"
            role="radio"
            aria-checked={noteUse === 'instruction'}
            onClick={() => onNoteUse(c.id, 'instruction')}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
              noteUse === 'instruction'
                ? 'bg-accent-tint text-accent-ink'
                : 'bg-surface-subtle text-ink-tertiary'
            }`}
          >
            Instruction — how to write
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={noteUse === 'fact'}
            onClick={() => onNoteUse(c.id, 'fact')}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
              noteUse === 'fact' ? 'bg-accent-tint text-accent-ink' : 'bg-surface-subtle text-ink-tertiary'
            }`}
          >
            Fact — may be stated
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <span className="font-mono text-[10.5px] tracking-[0.04em] text-ink-tertiary uppercase">
          Applies to
        </span>
        <ScopeSelect value={c.scope} options={scopeOptions} onChange={(v) => onScope(c.id, v)} />
      </div>
    </div>
  );
}
