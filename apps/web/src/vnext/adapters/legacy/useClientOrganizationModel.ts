/**
 * Relationships / Organization — roster + hierarchy (Figma `906:2790`).
 *
 * The hierarchy is a real feature backed by real columns on `client_people`
 * (migration `20261120010000_client_person_hierarchy`), not decorative boxes.
 * This adapter turns the flat roster into the tree the screen draws and reports
 * roster quality honestly: unplaced people are unplaced, not level "team".
 */
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';

export const HIERARCHY_LEVELS = [
  'executive',
  'c_suite',
  'senior_leadership',
  'leadership',
  'management',
  'team',
] as const;
export type HierarchyLevel = (typeof HIERARCHY_LEVELS)[number];

/** Labels and the example titles the rule set matches, per the design. */
export const LEVEL_META: Record<HierarchyLevel, { label: string; examples: string }> = {
  executive: { label: 'Executive', examples: 'CEO · President · Founder' },
  c_suite: { label: 'C-suite', examples: 'COO · CFO · CTO · CGAO' },
  senior_leadership: { label: 'Senior leadership', examples: 'EVP · SVP' },
  leadership: { label: 'Leadership', examples: 'VP · Director' },
  management: { label: 'Management', examples: 'Manager · Senior Manager' },
  team: { label: 'Team', examples: 'Associate · Analyst · Coordinator' },
};

export interface ClientPerson {
  id: string;
  clientId: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  role: string | null;
  lastContact: string | null;
  notes: string | null;
  hierarchyLevel: HierarchyLevel | null;
  reportsToPersonId: string | null;
  placementSource: 'auto_title' | 'manual';
  placementConfidence: number | string | null;
  reviewRequired: boolean;
  createdAt: string;
}

export interface OrgNode {
  person: ClientPerson;
  children: OrgNode[];
  depth: number;
}

export interface OrganizationModel {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  retry: () => void;
  people: ClientPerson[];
  /** Roots of the reporting tree — people with no (resolvable) manager. */
  roots: OrgNode[];
  /** Placed people who could not be attached because their manager is gone. */
  orphans: ClientPerson[];
  /** People with no level at all: the explicit "unplaced" state. */
  unplaced: ClientPerson[];
  needsReview: ClientPerson[];
  manualOverrides: ClientPerson[];
  placedCount: number;
  /** Share of the roster that carries a level, or null for an empty roster. */
  mappedShare: number | null;
  savePlacement: ReturnType<typeof useHierarchyMutation>;
  savePerson: ReturnType<typeof usePersonMutation>;
  deletePerson: ReturnType<typeof useDeleteMutation>;
}

function useHierarchyMutation(clientId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: {
      id: string;
      hierarchyLevel?: HierarchyLevel | null;
      reportsToPersonId?: string | null;
      resetToAutomatic?: boolean;
    }) => (await api.patch<ClientPerson>(`/api/clients/${clientId}/people/${id}/hierarchy`, body)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['client-people', clientId] });
    },
  });
}

function usePersonMutation(clientId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id?: string } & Record<string, unknown>) =>
      id
        ? (await api.patch<ClientPerson>(`/api/clients/${clientId}/people/${id}`, body)).data
        : (await api.post<ClientPerson>(`/api/clients/${clientId}/people`, body)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['client-people', clientId] });
    },
  });
}

function useDeleteMutation(clientId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/clients/${clientId}/people/${id}`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['client-people', clientId] });
    },
  });
}

export function useClientOrganizationModel(clientId: string): OrganizationModel {
  const api = useApi();

  const query = useQuery<ClientPerson[]>({
    // Same key as the canonical profile, so people CRUD invalidates both.
    queryKey: ['client-people', clientId],
    queryFn: async () => (await api.get<ClientPerson[]>(`/api/clients/${clientId}/people`)).data,
  });

  const savePlacement = useHierarchyMutation(clientId);
  const savePerson = usePersonMutation(clientId);
  const deletePerson = useDeleteMutation(clientId);

  const derived = useMemo(() => {
    const people = query.data ?? [];
    const byId = new Map(people.map((person) => [person.id, person]));

    const unplaced = people.filter((person) => !person.hierarchyLevel);
    const placed = people.filter((person) => person.hierarchyLevel);

    const nodes = new Map<string, OrgNode>(
      placed.map((person) => [person.id, { person, children: [], depth: 0 }]),
    );

    const roots: OrgNode[] = [];
    const orphans: ClientPerson[] = [];

    for (const person of placed) {
      const node = nodes.get(person.id)!;
      const managerId = person.reportsToPersonId;
      if (!managerId) {
        roots.push(node);
        continue;
      }
      const parent = nodes.get(managerId);
      if (!parent) {
        // Manager was deleted, or is themselves unplaced. Either way this
        // person is shown, not dropped — a broken link must not hide a contact.
        orphans.push(person);
        if (!byId.has(managerId)) continue;
      }
      if (parent) parent.children.push(node);
    }

    // Depth, with a visited set so a cycle that predates the constraint cannot
    // hang the render.
    const seen = new Set<string>();
    const walk = (node: OrgNode, depth: number) => {
      if (seen.has(node.person.id)) return;
      seen.add(node.person.id);
      node.depth = depth;
      node.children.sort((a, b) => rank(a.person) - rank(b.person) || a.person.name.localeCompare(b.person.name));
      node.children.forEach((child) => walk(child, depth + 1));
    };
    roots.sort((a, b) => rank(a.person) - rank(b.person) || a.person.name.localeCompare(b.person.name));
    roots.forEach((root) => walk(root, 0));

    // Anything the walk never reached (a pre-existing cycle) still gets shown.
    for (const person of placed) {
      if (!seen.has(person.id) && !orphans.includes(person)) orphans.push(person);
    }

    return {
      people,
      roots,
      orphans,
      unplaced,
      needsReview: people.filter((person) => person.reviewRequired),
      manualOverrides: people.filter((person) => person.placementSource === 'manual'),
      placedCount: placed.length,
      mappedShare: people.length === 0 ? null : placed.length / people.length,
    };
  }, [query.data]);

  return {
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    retry: () => void query.refetch(),
    ...derived,
    savePlacement,
    savePerson,
    deletePerson,
  };
}

function rank(person: ClientPerson): number {
  const index = person.hierarchyLevel ? HIERARCHY_LEVELS.indexOf(person.hierarchyLevel) : 99;
  return index < 0 ? 99 : index;
}

/** "Leadership · Auto-placed" / "Executive · Confirmed" / "Needs review". */
export function placementLabel(person: ClientPerson): string {
  const level = person.hierarchyLevel ? LEVEL_META[person.hierarchyLevel].label : 'Unplaced';
  if (person.reviewRequired) return `${level} · Needs review`;
  if (person.placementSource === 'manual') return `${level} · Confirmed`;
  return person.hierarchyLevel ? `${level} · Auto-placed` : 'Unplaced · No title match';
}
