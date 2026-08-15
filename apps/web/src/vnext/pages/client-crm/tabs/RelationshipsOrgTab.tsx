import { useState } from 'react';
import {
  Avatar,
  Card,
  CardHead,
  Eyebrow,
  PfButton,
  Pill,
  TabPageHead,
} from '../portfolio-primitives.js';
import { LEVELS, ORG } from '../portfolio-fixtures.js';
import {
  useClientOrganizationModel,
  type ClientPerson,
  type OrganizationModel,
} from '../../../adapters/legacy/useClientOrganizationModel.js';
import { ClientPersonDrawer } from '../ClientPersonDrawer.js';
import { ConfigureHierarchyModal } from '../ConfigureHierarchyModal.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

/**
 * Relationships / Organization sub-tab (spec §8.1).
 *
 * The chart renders the design's four-level fixture (pixel-perfect); the
 * strip counters, roster-quality chips, person drawer and hierarchy modal all
 * bind to the real organization model. Clicking a fixture person opens the
 * drawer for the real contact of the same name when the backend roster has
 * one. The segmented sub-tab bar is owned by the parent page.
 */
export function ClientCrmOrganizationProto({ client }: { client: Client }) {
  const model = useClientOrganizationModel(client.id);
  const [person, setPerson] = useState<ClientPerson | null>(null);
  const [configuring, setConfiguring] = useState(false);

  const openFixturePerson = (name: string) => {
    const real = model.people.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (real) setPerson(real);
  };

  return (
    <div className="cap-pf-anim-rise" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <TabPageHead
        title="Client organization"
        sub="A configurable roster automatically structured from titles. Manual placement always wins."
        actions={
          <PfButton variant="secondary" onClick={() => setConfiguring(true)}>
            Configure hierarchy
          </PfButton>
        }
      />

      <div className="cap-pf-grid-side-340">
        <OrgChartCard model={model} onOpen={openFixturePerson} />
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

      {configuring ? <ConfigureHierarchyModal model={model} onClose={() => setConfiguring(false)} /> : null}
    </div>
  );
}

/* ── Org chart card ───────────────────────────────────────────────────────── */

function OrgChartCard({
  model,
  onOpen,
}: {
  model: OrganizationModel;
  onOpen: (name: string) => void;
}) {
  // Real counters when the roster is loaded; the design's strip copy otherwise.
  const loaded = model.people.length > 0;
  const sub = loaded
    ? `${model.placedCount} contact${model.placedCount === 1 ? '' : 's'} placed${
        model.needsReview.length > 0
          ? ` · ${model.needsReview.length} title${model.needsReview.length === 1 ? '' : 's'} need${
              model.needsReview.length === 1 ? 's' : ''
            } review`
          : ''
      }`
    : '7 contacts placed · 1 title needs review';
  const mapped = model.mappedShare == null ? '92% mapped' : `${Math.round(model.mappedShare * 100)}% mapped`;

  return (
    <Card>
      {/* strip */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '20px 24px 16px', flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 240 }}>
          <Eyebrow>Automatic title-based roster</Eyebrow>
          <span style={{ display: 'block', marginTop: 3, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>{sub}</span>
        </span>
        <Pill tone="success" size="lg">
          {mapped}
        </Pill>
      </div>

      {/* chart body — four fixture levels, centred rows, 1px×18px connectors */}
      <div style={{ padding: '8px 24px 20px' }}>
        {ORG.map((level, li) => (
          <span key={li} style={{ display: 'block' }}>
            {li > 0 ? (
              <span style={{ display: 'block', height: 18, width: 1, background: '#EAECF0', margin: '0 auto' }} aria-hidden />
            ) : null}
            <span style={{ display: 'flex', justifyContent: 'center', gap: 14, flexWrap: 'wrap' }}>
              {level.map((p) =>
                'ghost' in p && p.ghost ? (
                  <GhostPersonCard key={p.id} person={p} />
                ) : (
                  <PersonCard key={p.id} person={p} onOpen={() => onOpen(p.name)} />
                ),
              )}
            </span>
          </span>
        ))}
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

function PersonCard({ person, onOpen }: { person: OrgPerson; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
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
        background: hover ? '#FCFCFD' : '#ffffff',
        boxShadow: hover ? 'inset 0 0 0 1px #D0D5DD' : 'inset 0 0 0 1px #EAECF0',
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
    </button>
  );
}

/** Open role — dashed feel via the #F9FAFB fill; not clickable as a contact. */
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
        background: '#F9FAFB',
        boxShadow: 'inset 0 0 0 1px #EAECF0',
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
          background: '#F2F4F7',
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
  const loaded = model.people.length > 0;
  const overrides = loaded ? model.manualOverrides.length : 2;
  const review = loaded ? model.needsReview.length : 1;

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
          <SettingField label="Rule set" value="Corporate standard v3" />
        </div>

        <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid #EAECF0' }}>
          <Eyebrow>Visible levels</Eyebrow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {LEVELS.map(([label, keywords]) => (
              <span
                key={label}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 12,
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: '#F9FAFB',
                }}
              >
                <span style={{ flex: '0 0 auto', fontSize: 14, fontWeight: 500, color: '#101828' }}>{label}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#667085', textAlign: 'right', textWrap: 'pretty' }}>
                  {keywords}
                </span>
              </span>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <Eyebrow>Roster quality</Eyebrow>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <Pill tone="gray" size="lg" dotless>
              {overrides} manual override{overrides === 1 ? '' : 's'}
            </Pill>
            <Pill tone="warning" size="lg">
              {review} title{review === 1 ? '' : 's'} to review
            </Pill>
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
