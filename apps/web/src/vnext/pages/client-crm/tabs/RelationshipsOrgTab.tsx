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
export function ClientCrmOrganizationProto({ client }: { client: Client }) {
  const model = useClientOrganizationModel(client.id);
  const [person, setPerson] = useState<ClientPerson | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [creating, setCreating] = useState(false);

  return (
    <div className="cap-pf-anim-rise" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
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

      <div className="cap-pf-grid-side-340">
        <OrgChartCard model={model} onOpenReal={setPerson} onAdd={() => setCreating(true)} />
        <HierarchySettingsCard model={model} onEdit={() => setConfiguring(true)} />
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
  const [hover, setHover] = useState(false);
  // An unplaced card drops the per-card eyebrow and the "Unplaced · No title
  // match" footer: its group header already says "Not placed", so repeating it
  // on every card turned a large unplaced roster into a wall of the same word.
  const placed = Boolean(person.hierarchyLevel);
  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: '0 0 auto',
        width: 196,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '14px 12px',
        borderRadius: 10,
        background: hover ? '#FAF9F6' : '#ffffff',
        border: person.reviewRequired
          ? '1px solid #FEDF89'
          : hover
            ? '1px solid #E0DCD4'
            : '1px solid #E8E5DF',
      }}
    >
      {person.hierarchyLevel ? <Eyebrow tight>{LEVEL_META[person.hierarchyLevel].label}</Eyebrow> : null}
      <span style={{ marginTop: 10, display: 'flex' }}>
        <Avatar initials={initialsFor(person.name)} size={32} />
      </span>
      <span style={{ display: 'block', marginTop: 10, maxWidth: '100%', fontSize: 14, fontWeight: 600, color: '#101828', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {person.name}
      </span>
      <span style={{ display: 'block', marginTop: 2, maxWidth: '100%', fontSize: 13, color: '#475467', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {person.title ?? 'Open role'}
      </span>
      {placed ? (
        <span style={{ display: 'block', marginTop: 8, maxWidth: '100%', fontSize: 12, color: '#667085', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {placementLabel(person)}
        </span>
      ) : null}
      {person.reviewRequired ? (
        <span style={{ marginTop: 8 }}>
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
    <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid #E8E5DF' }}>
      <Eyebrow>
        {title} · {people.length}
      </Eyebrow>
      <p style={{ margin: '4px 0 12px', fontSize: 13, color: '#667085', textWrap: 'pretty' }}>{hint}</p>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 14, flexWrap: 'wrap' }}>
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
}: {
  model: OrganizationModel;
  onOpenReal: (person: ClientPerson) => void;
  onAdd: () => void;
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
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '20px 24px 16px', flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 240 }}>
          <Eyebrow>Automatic title-based roster</Eyebrow>
          {model.isLoading ? (
            <span style={{ display: 'block', marginTop: 6, maxWidth: 260 }}>
              <PfSkeleton />
            </span>
          ) : (
            <span style={{ display: 'block', marginTop: 3, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>{sub}</span>
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

      <div style={{ padding: '8px 24px 20px' }}>
        {model.isError ? (
          <div style={{ padding: '28px 4px', textAlign: 'center' }}>
            <p style={{ margin: 0, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>
              {model.error instanceof Error ? model.error.message : 'Could not load the roster.'}
            </p>
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center' }}>
              <PfButton variant="secondary" onClick={model.retry}>
                Retry
              </PfButton>
            </div>
          </div>
        ) : !model.isLoading && model.people.length === 0 ? (
          <div style={{ padding: '28px 4px', textAlign: 'center' }}>
            <h4 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#101828' }}>No contacts yet</h4>
            <p style={{ margin: '6px 0 0', fontSize: 14, color: '#475467', textWrap: 'pretty' }}>
              Add a contact and it will be placed automatically from its title.
            </p>
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center' }}>
              <PfButton variant="primary" onClick={onAdd}>
                Add contact
              </PfButton>
            </div>
          </div>
        ) : loaded ? (
          /* Item 17: the real reporting tree, one centred row per depth. */
          <>
            {depthRows.map((row, li) => (
              <span key={li} style={{ display: 'block' }}>
                {li > 0 ? (
                  <span style={{ display: 'block', height: 18, width: 1, background: '#E8E5DF', margin: '0 auto' }} aria-hidden />
                ) : null}
                <span style={{ display: 'flex', justifyContent: 'center', gap: 14, flexWrap: 'wrap' }}>
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
            <span key={li} style={{ display: 'block' }}>
              {li > 0 ? (
                <span style={{ display: 'block', height: 18, width: 1, background: '#E8E5DF', margin: '0 auto' }} aria-hidden />
              ) : null}
              <span style={{ display: 'flex', justifyContent: 'center', gap: 14, flexWrap: 'wrap' }}>
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
    <span
      style={{
        flex: '0 0 auto',
        width: 196,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '14px 12px',
        borderRadius: 10,
        background: '#ffffff',
        border: '1px solid #E8E5DF',
      }}
    >
      <Eyebrow tight>{person.level}</Eyebrow>
      <span style={{ marginTop: 10, display: 'flex' }}>
        <Avatar initials={person.init} size={32} />
      </span>
      <span
        style={{
          display: 'block',
          marginTop: 10,
          maxWidth: '100%',
          fontSize: 14,
          fontWeight: 600,
          color: '#101828',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {person.name}
      </span>
      <span
        style={{
          display: 'block',
          marginTop: 2,
          maxWidth: '100%',
          fontSize: 13,
          color: '#475467',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {person.title}
      </span>
      <span
        style={{
          display: 'block',
          marginTop: 8,
          maxWidth: '100%',
          fontSize: 12,
          color: '#667085',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {person.meta}
      </span>
    </span>
  );
}

/** Open role — dashed feel via the #FAF9F6 fill; not clickable as a contact. */
function GhostPersonCard({ person }: { person: OrgPerson }) {
  return (
    <span
      style={{
        flex: '0 0 auto',
        width: 196,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '14px 12px',
        borderRadius: 10,
        background: '#FAF9F6',
        border: '1px solid #E8E5DF',
      }}
    >
      <Eyebrow tight>{person.level}</Eyebrow>
      <span
        aria-hidden
        style={{
          marginTop: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: '#F2F0EB',
          color: '#98A2B3',
          fontSize: 10,
          fontWeight: 600,
        }}
      >
        —
      </span>
      <span style={{ display: 'block', marginTop: 10, fontSize: 14, fontWeight: 600, color: '#667085' }}>{person.name}</span>
      <span style={{ display: 'block', marginTop: 2, fontSize: 13, color: '#475467' }}>{person.title}</span>
      <span style={{ display: 'block', marginTop: 8, fontSize: 12, color: '#667085' }}>{person.meta}</span>
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
      <div style={{ padding: '20px 24px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SettingField label="Mode" value="Automatic from titles" />
          {/* Item 16: there is exactly one rule set and it is built into the API
              (`client-hierarchy.helpers.ts`) with no table, route or write path,
              so it is named honestly as built-in rather than implying a
              selectable "v3" among others. */}
          <SettingField label="Rule set" value="Built-in title rules (not editable)" />
        </div>

        <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid #E8E5DF' }}>
          <Eyebrow>Visible levels</Eyebrow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {/* Real level metadata from the model — the LEVELS fixture this
                replaced was a byte-identical copy of it. */}
            {HIERARCHY_LEVELS.map((level) => (
              <span
                key={level}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 12,
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: '#FAF9F6',
                }}
              >
                <span style={{ flex: '0 0 auto', fontSize: 14, fontWeight: 500, color: '#101828' }}>
                  {LEVEL_META[level].label}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#667085', textAlign: 'right', textWrap: 'pretty' }}>
                  {LEVEL_META[level].examples}
                </span>
              </span>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <Eyebrow>Roster quality</Eyebrow>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {model.isLoading ? (
              <span style={{ display: 'block', width: 220 }}>
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
      <div style={{ marginTop: 3, fontSize: 14, color: '#101828' }}>{value}</div>
    </div>
  );
}
