import { useState } from 'react';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import {
  HIERARCHY_LEVELS,
  LEVEL_META,
  placementLabel,
  useClientOrganizationModel,
  type ClientPerson,
  type OrgNode,
  type OrganizationModel,
} from '../../adapters/legacy/useClientOrganizationModel.js';
import { ClientPersonDrawer } from './ClientPersonDrawer.js';
import { ConfigureHierarchyModal } from './ConfigureHierarchyModal.js';
import { initialsFor } from '../../adapters/legacy/useClientCrmOverviewModel.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Relationships / Organization — Figma `906:2790`.
 *
 * Canvas 972px + 20px gutter + settings 328px = the 1320px content width.
 */
export function ClientCrmOrganization({ client }: { client: Client }) {
  const model = useClientOrganizationModel(client.id);
  const [person, setPerson] = useState<ClientPerson | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [creating, setCreating] = useState(false);

  return (
    <div className="capiro-crm__body">
      <div className="capiro-crm__page-head">
        <div>
          <h2 className="capiro-crm__page-title">Client organization</h2>
          <p className="capiro-crm__page-sub">
            A configurable roster automatically structured from titles. Manual placement always
            wins.
          </p>
        </div>
        <span className="capiro-crm__page-head-spacer" />
        <CapiroButton variant="secondary" size="compact" onClick={() => setCreating(true)}>
          Add contact
        </CapiroButton>
      </div>

      <div className="capiro-crm__grid capiro-crm__grid--org">
        <HierarchyCanvas model={model} onOpen={setPerson} />
        <HierarchySettings model={model} onConfigure={() => setConfiguring(true)} />
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

      {creating ? (
        <ClientPersonDrawer
          clientId={client.id}
          person={null}
          people={model.people}
          onClose={() => setCreating(false)}
          onSave={(values) => model.savePerson.mutateAsync(values).then(() => setCreating(false))}
        />
      ) : null}

      {configuring ? (
        <ConfigureHierarchyModal model={model} onClose={() => setConfiguring(false)} />
      ) : null}
    </div>
  );
}

/* ─────────────────────── hierarchy canvas (972×600) ──────────────────────── */

function HierarchyCanvas({
  model,
  onOpen,
}: {
  model: OrganizationModel;
  onOpen: (person: ClientPerson) => void;
}) {
  const mapped =
    model.mappedShare == null ? null : `${Math.round(model.mappedShare * 100)}% mapped`;

  return (
    <section className="capiro-crm__card capiro-elevation-widget" aria-labelledby="crm-org-title">
      <div className="capiro-crm__card-head">
        <div style={{ minWidth: 0 }}>
          <h3 className="capiro-crm__card-title" id="crm-org-title">
            Automatic title-based roster
          </h3>
          <p className="capiro-crm__meta" style={{ textTransform: 'none' }}>
            {model.placedCount} contact{model.placedCount === 1 ? '' : 's'} placed
            {model.needsReview.length > 0
              ? ` · ${model.needsReview.length} title${model.needsReview.length === 1 ? '' : 's'} need review`
              : ''}
          </p>
        </div>
        <span className="capiro-crm__page-head-spacer" />
        {/* Coverage, not a score: an empty roster reports nothing, not 0%. */}
        {mapped ? <span className="capiro-crm__pill capiro-crm__pill--filled">{mapped}</span> : null}
      </div>

      {model.isLoading ? (
        <div className="capiro-crm__skeleton" style={{ height: 420 }} aria-hidden />
      ) : model.isError ? (
        <div className="capiro-crm__state capiro-crm__state--error" role="status">
          <span>
            {model.error instanceof Error ? model.error.message : 'Could not load the roster'}
          </span>
          <CapiroButton variant="quiet" size="compact" onClick={model.retry}>
            Retry
          </CapiroButton>
        </div>
      ) : model.people.length === 0 ? (
        <div className="capiro-crm__state" role="status">
          No contacts yet. Add one and Meri will place it from its title.
        </div>
      ) : (
        <div className="capiro-crm__org-scroll">
          {model.roots.length > 0 ? (
            <ul className="capiro-crm__org-tree">
              {model.roots.map((node) => (
                <OrgBranch key={node.person.id} node={node} onOpen={onOpen} />
              ))}
            </ul>
          ) : null}

          {/* Unplaced and orphaned people are shown, never hidden — a person the
              rules could not place is still a contact someone has to call. */}
          <UnplacedGroup
            title="Not placed"
            hint="No title match yet — open a contact to place it."
            people={model.unplaced}
            onOpen={onOpen}
          />
          <UnplacedGroup
            title="Manager missing"
            hint="Their manager was removed, so they are unattached."
            people={model.orphans}
            onOpen={onOpen}
          />
        </div>
      )}
    </section>
  );
}

function OrgBranch({ node, onOpen }: { node: OrgNode; onOpen: (person: ClientPerson) => void }) {
  return (
    <li className="capiro-crm__org-node">
      <PersonCard person={node.person} onOpen={onOpen} />
      {node.children.length > 0 ? (
        <ul className="capiro-crm__org-children">
          {node.children.map((child) => (
            <OrgBranch key={child.person.id} node={child} onOpen={onOpen} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function PersonCard({
  person,
  onOpen,
}: {
  person: ClientPerson;
  onOpen: (person: ClientPerson) => void;
}) {
  return (
    <button type="button" className="capiro-crm__person" onClick={() => onOpen(person)}>
      <span className="capiro-crm__person-avatar" aria-hidden>
        {initialsFor(person.name)}
      </span>
      <span className="capiro-crm__person-body">
        {person.hierarchyLevel ? (
          <span className="capiro-crm__meta">{LEVEL_META[person.hierarchyLevel].label}</span>
        ) : (
          <span className="capiro-crm__meta">Unplaced</span>
        )}
        <span className="capiro-crm__person-name">{person.name}</span>
        <span className="capiro-crm__person-title">{person.title ?? 'Open role'}</span>
        <span className="capiro-crm__meta" style={{ textTransform: 'none' }}>
          {placementLabel(person)}
        </span>
      </span>
      {person.reviewRequired ? <CapiroBadge tone="warning">REVIEW</CapiroBadge> : null}
    </button>
  );
}

function UnplacedGroup({
  title,
  hint,
  people,
  onOpen,
}: {
  title: string;
  hint: string;
  people: ClientPerson[];
  onOpen: (person: ClientPerson) => void;
}) {
  if (people.length === 0) return null;
  return (
    <div className="capiro-crm__org-loose">
      <p className="capiro-crm__meta">
        {title} · {people.length}
      </p>
      <p className="capiro-crm__foot">{hint}</p>
      <div className="capiro-crm__org-loose-list">
        {people.map((person) => (
          <PersonCard key={person.id} person={person} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

/* ───────────────────── hierarchy settings (328×600) ──────────────────────── */

function HierarchySettings({
  model,
  onConfigure,
}: {
  model: OrganizationModel;
  onConfigure: () => void;
}) {
  return (
    <section className="capiro-crm__card capiro-elevation-widget" aria-labelledby="crm-hier-title">
      <div className="capiro-crm__card-head">
        <h3 className="capiro-crm__card-title" id="crm-hier-title">
          Hierarchy settings
        </h3>
        <button type="button" className="capiro-crm__card-action" onClick={onConfigure}>
          Edit
        </button>
      </div>

      <div className="capiro-crm__setting">
        <p className="capiro-crm__meta">Mode</p>
        <p className="capiro-crm__field-value">Automatic from titles</p>
      </div>
      <div className="capiro-crm__setting">
        <p className="capiro-crm__meta">Rule set</p>
        <p className="capiro-crm__field-value">Corporate standard v3</p>
      </div>

      <p className="capiro-crm__meta capiro-crm__setting-head">Visible levels</p>
      <ul className="capiro-crm__levels">
        {HIERARCHY_LEVELS.map((level) => {
          const count = model.people.filter((person) => person.hierarchyLevel === level).length;
          return (
            <li key={level} className="capiro-crm__level">
              <span className="capiro-crm__level-label">{LEVEL_META[level].label}</span>
              <span className="capiro-crm__meta capiro-crm__level-examples">
                {LEVEL_META[level].examples}
              </span>
              <span className="capiro-crm__meta">{count}</span>
            </li>
          );
        })}
      </ul>

      <p className="capiro-crm__meta capiro-crm__setting-head">Roster quality</p>
      <div className="capiro-crm__chips">
        <span className="capiro-crm__pill">
          {model.manualOverrides.length} manual override
          {model.manualOverrides.length === 1 ? '' : 's'}
        </span>
        <span
          className={`capiro-crm__pill${model.needsReview.length > 0 ? ' capiro-crm__pill--filled' : ''}`}
        >
          {model.needsReview.length} title{model.needsReview.length === 1 ? '' : 's'} to review
        </span>
        {model.unplaced.length > 0 ? (
          <span className="capiro-crm__pill">{model.unplaced.length} unplaced</span>
        ) : null}
      </div>
    </section>
  );
}
