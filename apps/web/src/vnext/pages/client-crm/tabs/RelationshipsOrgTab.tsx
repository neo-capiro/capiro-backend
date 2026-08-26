import { useState } from 'react';
import {
  Avatar,
  Card,
  CardHead,
  Eyebrow,
  PfButton,
  PfSkeleton,
  Pill,
  TabPageHead,
} from '../portfolio-primitives.js';
import { ORG } from '../portfolio-fixtures.js';
import {
  HIERARCHY_LEVELS,
  LEVEL_META,
  placementLabel,
  useClientOrganizationModel,
  type ClientPerson,
  type OrgNode,
  type OrganizationModel,
} from '../../../adapters/legacy/useClientOrganizationModel.js';
import { ClientPersonDrawer } from '../ClientPersonDrawer.js';
import { ConfigureHierarchyModal } from '../ConfigureHierarchyModal.js';
import { initialsFor } from '../../../adapters/legacy/useClientCrmOverviewModel.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import './relationships-org-tab.css';

/**
 * Relationships / Organization sub-tab (spec §8.1).
 *
 * The chart renders the REAL reporting hierarchy whenever the client has a
 * roster (item 17); the design's four-level fixture renders only while the
 * roster is loading, errored, or genuinely empty. Strip counters, roster-quality
 * chips, the person drawer, "Add contact" (item 15) and the hierarchy modal all
 * bind to the real organization model. The segmented sub-tab bar is owned by
 * the parent page.
 *
 * Item 16 (custom rule sets) is NOT completable from the web: the placement
 * rules are a hardcoded `RULES` const in `apps/api/src/clients/
 * client-hierarchy.helpers.ts` with no table, no route and no write path
 * anywhere in the API. Placement writes — the half that does exist — already
 * work through `savePlacement`. The visible-levels list below now reads the
 * real `LEVEL_META` rather than a byte-identical fixture copy of it.
 */
export function ClientCrmOrganizationProto({ client, drawer = false }: { client: Client; drawer?: boolean }) {
  const model = useClientOrganizationModel(client.id);
  const [person, setPerson] = useState<ClientPerson | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [creating, setCreating] = useState(false);

  return (
    <div className={`cap-pf-anim-rise rel-org-root${drawer ? ' rel-org-root--drawer' : ''}`}>
      {drawer ? (
        <div className="rel-org-drawer__toolbar">
          <span>Reporting structure</span>
          <Pill tone="gray" size="sm" dotless>
            {model.placedCount} {model.placedCount === 1 ? 'person' : 'people'} placed
          </Pill>
          <Pill tone="gray" size="sm" dotless>
            {model.manualOverrides.length} manual placement{model.manualOverrides.length === 1 ? '' : 's'}
          </Pill>
          <button type="button" onClick={() => setCreating(true)}>Add contact</button>
          <button type="button" onClick={() => setConfiguring(true)}>Configure hierarchy</button>
        </div>
      ) : (
      <TabPageHead
        title="Client organization"
        sub="A configurable roster automatically structured from titles. Manual placement always wins."
        actions={
          <>
            <PfButton variant="secondary" onClick={() => setConfiguring(true)}>
              Configure hierarchy
            </PfButton>
            <PfButton variant="primary" onClick={() => setCreating(true)}>
              Add contact
            </PfButton>
          </>
        }
      />
      )}

      <div className={drawer ? 'rel-org-drawer__chart' : 'cap-pf-grid-side-340'}>
        <OrgChartCard model={model} onOpenReal={setPerson} onAdd={() => setCreating(true)} compact={drawer} />
        {drawer ? null : <HierarchySettingsCard model={model} onEdit={() => setConfiguring(true)} />}
      </div>

      {person ? (
        <ClientPersonDrawer
          clientId={client.id}
          person={person}
          people={model.people}
          onClose={() => setPerson(null)}
          onSave={(values) => model.savePerson.mutateAsync({ id: person.id, ...values })}
          onPlace={(values) => model.savePlacement.mutateAsync({ id: person.id, ...values })}
          onDelete={() => model.deletePerson.mutateAsync(person.id).then(() => setPerson(null))}
        />
      ) : null}

      {/* Item 15: the real create path — `savePerson` with no id POSTs a new
          person, and the server infers placement from the title. */}
      {creating ? (
        <ClientPersonDrawer
          clientId={client.id}
          person={null}
          people={model.people}
          onClose={() => setCreating(false)}
          onSave={(values) => model.savePerson.mutateAsync(values).then(() => setCreating(false))}
        />
      ) : null}

      {configuring ? <ConfigureHierarchyModal model={model} onClose={() => setConfiguring(false)} /> : null}
    </div>
  );
}

/**
 * The real reporting tree, flattened to one centred row per depth so the
 * design's stacked-rows-with-connectors geometry survives contact with data of
 * arbitrary shape. Depth comes from the model's own `OrgNode.depth`, so a
 * six-level roster renders six rows rather than being clipped to the fixture's
 * four.
 */
function rowsByDepth(roots: OrgNode[]): ClientPerson[][] {
  const rows: ClientPerson[][] = [];
  const walk = (nodes: OrgNode[], depth: number) => {
    if (nodes.length === 0) return;
    rows[depth] = [...(rows[depth] ?? []), ...nodes.map((n) => n.person)];
    for (const node of nodes) walk(node.children, depth + 1);
  };
  walk(roots, 0);
  return rows.filter((row) => row && row.length > 0);
}

function RealPersonCard({ person, onOpen }: { person: ClientPerson; onOpen: () => void }) {
  // An unplaced card drops the per-card eyebrow and the "Unplaced · No title
  // match" footer: its group header already says "Not placed", so repeating it
  // on every card turned a large unplaced roster into a wall of the same word.
  const placed = Boolean(person.hierarchyLevel);
  const cardClass = person.reviewRequired
    ? 'rel-org-person-card rel-org-person-card--review'
    : 'rel-org-person-card';
  return (
    <button type="button" onClick={onOpen} className={cardClass}>
      {person.hierarchyLevel ? <Eyebrow tight>{LEVEL_META[person.hierarchyLevel].label}</Eyebrow> : null}
      <span className="rel-org-person-avatar">
        <Avatar initials={initialsFor(person.name)} size={32} />
      </span>
      <span className="rel-org-person-name">{person.name}</span>
      <span className="rel-org-person-title">{person.title ?? 'Open role'}</span>
      {placed ? <span className="rel-org-person-meta">{placementLabel(person)}</span> : null}
      {person.reviewRequired ? (
        <span className="rel-org-person-pill">
          <Pill tone="warning">{placed ? 'Review' : 'Needs review'}</Pill>
        </span>
      ) : null}
    </button>
  );
}

/** People the rules could not place are shown, never hidden — an unplaced
 *  contact is still a contact someone has to call. */
function LoosePeopleGroup({
  title,
  hint,
  people,
  onOpen,
}: {
  title: string;
  hint: string;
  people: ClientPerson[];
  onOpen: (p: ClientPerson) => void;
}) {
  if (people.length === 0) return null;
  return (
    <div className="rel-org-loose-group">
      <Eyebrow>
        {title} · {people.length}
      </Eyebrow>
      <p className="rel-org-loose-hint">{hint}</p>
      <div className="rel-org-depth-people">
        {people.map((p) => (
          <RealPersonCard key={p.id} person={p} onOpen={() => onOpen(p)} />
        ))}
      </div>
    </div>
  );
}

/* ── Org chart card ───────────────────────────────────────────────────────── */

function OrgChartCard({
  model,
  onOpenReal,
  onAdd,
  compact = false,
}: {
  model: OrganizationModel;
  onOpenReal: (person: ClientPerson) => void;
  onAdd: () => void;
  compact?: boolean;
}) {
  // Strip counters always come from the real model — the fixture's
  // "7 contacts placed · 1 title needs review" / "92% mapped" copy must never
  // render for a real client. While the roster loads, a skeleton is the honest
  // state; the fixture chart below stays pixel-reviewable regardless.
  const loaded = model.people.length > 0;
  const sub = `${model.placedCount} contact${model.placedCount === 1 ? '' : 's'} placed${
    model.needsReview.length > 0
      ? ` · ${model.needsReview.length} title${model.needsReview.length === 1 ? '' : 's'} need${
          model.needsReview.length === 1 ? 's' : ''
        } review`
      : ''
  }`;
  const mappedPct = model.mappedShare == null ? null : Math.round(model.mappedShare * 100);
  const depthRows = loaded ? rowsByDepth(model.roots) : [];

  return (
    <Card>
      {/* strip */}
      {compact ? null : (
      <div className="rel-org-strip">
        <span className="rel-org-strip-label">
          <Eyebrow>Automatic title-based roster</Eyebrow>
          {model.isLoading ? (
            <span className="rel-org-strip-skeleton">
              <PfSkeleton />
            </span>
          ) : (
            <span className="rel-org-strip-sub">{sub}</span>
          )}
        </span>
        {/* Coverage, not a score: an empty or still-loading roster reports
            nothing, not 0% and never the fixture's 92%. */}
        {model.isLoading || mappedPct == null ? null : (
          <Pill tone="success" size="lg">
            {mappedPct}% mapped
          </Pill>
        )}
      </div>
      )}

      <div className="rel-org-chart-body">
        {model.isError ? (
          <div className="rel-org-state">
            <p className="rel-org-state-msg--standalone">
              {model.error instanceof Error ? model.error.message : 'Could not load the roster.'}
            </p>
            <div className="rel-org-state-action">
              <PfButton variant="secondary" onClick={model.retry}>
                Retry
              </PfButton>
            </div>
          </div>
        ) : !model.isLoading && model.people.length === 0 ? (
          <div className="rel-org-state">
            <h4 className="rel-org-state-title">No contacts yet</h4>
            <p className="rel-org-state-msg">Add a contact and it will be placed automatically from its title.</p>
            <div className="rel-org-state-action">
              <PfButton variant="primary" onClick={onAdd}>
                Add contact
              </PfButton>
            </div>
          </div>
        ) : loaded ? (
          /* Item 17: the real reporting tree, one centred row per depth. */
          <>
            {depthRows.map((row, li) => (
              <span key={li} className="rel-org-depth-row">
                {li > 0 ? <span className="rel-org-depth-connector" aria-hidden /> : null}
                <span className="rel-org-depth-people">
                  {row.map((p) => (
                    <RealPersonCard key={p.id} person={p} onOpen={() => onOpenReal(p)} />
                  ))}
                </span>
              </span>
            ))}
            <LoosePeopleGroup
              title="Not placed"
              hint="Open a contact to place it, or fix its title."
              people={model.unplaced}
              onOpen={onOpenReal}
            />
            <LoosePeopleGroup
              title="Manager missing"
              hint="Their manager was removed, so they are unattached."
              people={model.orphans}
              onOpen={onOpenReal}
            />
          </>
        ) : (
          /* Loading — the design's four fixture levels stay pixel-reviewable. */
          ORG.map((level, li) => (
            <span key={li} className="rel-org-depth-row">
              {li > 0 ? <span className="rel-org-depth-connector" aria-hidden /> : null}
              <span className="rel-org-depth-people">
                {level.map((p) =>
                  'ghost' in p && p.ghost ? (
                    <GhostPersonCard key={p.id} person={p} />
                  ) : (
                    <PersonCard key={p.id} person={p} />
                  ),
                )}
              </span>
            </span>
          ))
        )}
      </div>
    </Card>
  );
}

type OrgPerson = {
  id: string;
  level: string;
  init: string;
  name: string;
  title: string;
  meta: string;
  ghost?: boolean;
};

/** Fixture-only card, rendered while the roster loads. Non-interactive on
 *  purpose: a click used to try to resolve the fixture name against the real
 *  roster and silently no-op on a miss — a button that mostly did nothing. */
function PersonCard({ person }: { person: OrgPerson }) {
  return (
    <span className="rel-org-person-card">
      <Eyebrow tight>{person.level}</Eyebrow>
      <span className="rel-org-person-avatar">
        <Avatar initials={person.init} size={32} />
      </span>
      <span className="rel-org-person-name">{person.name}</span>
      <span className="rel-org-person-title">{person.title}</span>
      <span className="rel-org-person-meta">{person.meta}</span>
    </span>
  );
}

/** Open role — dashed feel via the subtle fill; not clickable as a contact. */
function GhostPersonCard({ person }: { person: OrgPerson }) {
  return (
    <span className="rel-org-ghost-card">
      <Eyebrow tight>{person.level}</Eyebrow>
      <span aria-hidden className="rel-org-ghost-avatar">
        —
      </span>
      <span className="rel-org-ghost-name">{person.name}</span>
      <span className="rel-org-ghost-title">{person.title}</span>
      <span className="rel-org-ghost-meta">{person.meta}</span>
    </span>
  );
}

/* ── Hierarchy settings card ──────────────────────────────────────────────── */

function HierarchySettingsCard({ model, onEdit }: { model: OrganizationModel; onEdit: () => void }) {
  // Always the real model — the old `overrides=2 / review=1` fixture fallback
  // rendered invented roster-quality numbers for every loading or empty client.
  const overrides = model.manualOverrides.length;
  const review = model.needsReview.length;

  return (
    <Card>
      <CardHead
        title="Hierarchy settings"
        action={
          <PfButton variant="link" onClick={onEdit}>
            Edit
          </PfButton>
        }
      />
      <div className="rel-org-settings-body">
        <div className="rel-org-settings-fields">
          <SettingField label="Mode" value="Automatic from titles" />
          {/* Item 16: there is exactly one rule set and it is built into the API
              (`client-hierarchy.helpers.ts`) with no table, route or write path,
              so it is named honestly as built-in rather than implying a
              selectable "v3" among others. */}
          <SettingField label="Rule set" value="Built-in title rules (not editable)" />
        </div>

        <div className="rel-org-settings-block">
          <Eyebrow>Visible levels</Eyebrow>
          <div className="rel-org-level-list">
            {/* Real level metadata from the model — the LEVELS fixture this
                replaced was a byte-identical copy of it. */}
            {HIERARCHY_LEVELS.map((level) => (
              <span key={level} className="rel-org-level-row">
                <span className="rel-org-level-label">{LEVEL_META[level].label}</span>
                <span className="rel-org-level-examples">{LEVEL_META[level].examples}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="rel-org-settings-block--tight">
          <Eyebrow>Roster quality</Eyebrow>
          <div className="rel-org-quality-row">
            {model.isLoading ? (
              <span className="rel-org-quality-skeleton">
                <PfSkeleton />
              </span>
            ) : (
              <>
                <Pill tone="gray" size="lg" dotless>
                  {overrides} manual override{overrides === 1 ? '' : 's'}
                </Pill>
                <Pill tone={review > 0 ? 'warning' : 'gray'} size="lg">
                  {review} title{review === 1 ? '' : 's'} to review
                </Pill>
              </>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function SettingField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div className="rel-org-field-value">{value}</div>
    </div>
  );
}
