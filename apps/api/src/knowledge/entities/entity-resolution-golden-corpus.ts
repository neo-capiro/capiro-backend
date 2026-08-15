import type { ResolveEntityInput } from './entity-resolution.types.js';

export type EntityResolutionGoldenCategory =
  | 'exact_identifier'
  | 'alias'
  | 'ambiguity'
  | 'corporate_structure'
  | 'person_identity'
  | 'privacy'
  | 'generic_mailbox'
  | 'rename';

export interface EntityResolutionGoldenExpectation {
  status: 'resolved' | 'ambiguous' | 'unresolved';
  selectedCanonicalName?: string | null;
  /** Names that must not be selected or exposed as candidates for this case. */
  forbiddenCanonicalNames?: readonly string[];
}

export interface EntityResolutionGoldenCase {
  id: string;
  description: string;
  category: EntityResolutionGoldenCategory;
  tenantFixture: 'tenant_a' | 'tenant_b';
  input: ResolveEntityInput;
  expected: EntityResolutionGoldenExpectation;
}

/**
 * Permanent Phase 5 precision-first corpus. The seeded test environment should
 * use these labels and identifiers exactly; the evaluator consumes observed
 * resolver results without depending on a particular database fixture loader.
 */
export const ENTITY_RESOLUTION_GOLDEN_CORPUS: readonly EntityResolutionGoldenCase[] = [
  {
    id: 'org_exact_uei_rtx',
    description: 'A unique exact UEI resolves RTX despite a historical legal-name change.',
    category: 'exact_identifier',
    tenantFixture: 'tenant_a',
    input: {
      query: 'Raytheon Technologies Corporation',
      entityTypeHint: 'organization',
      identifiers: [{ type: 'uei', value: 'ABCDEF123456' }],
    },
    expected: { status: 'resolved', selectedCanonicalName: 'RTX Corporation' },
  },
  {
    id: 'org_exact_cik_rtx',
    description: 'A unique SEC CIK resolves the public company deterministically.',
    category: 'exact_identifier',
    tenantFixture: 'tenant_a',
    input: {
      query: 'RTX',
      entityTypeHint: 'organization',
      identifiers: [{ type: 'cik', value: '0000101829' }],
    },
    expected: { status: 'resolved', selectedCanonicalName: 'RTX Corporation' },
  },
  {
    id: 'org_historical_alias',
    description: 'A verified historical legal-name alias resolves to the current entity.',
    category: 'rename',
    tenantFixture: 'tenant_a',
    input: {
      query: 'Raytheon Technologies',
      entityTypeHint: 'organization',
    },
    expected: { status: 'resolved', selectedCanonicalName: 'RTX Corporation' },
  },
  {
    id: 'org_ambiguous_kinetic',
    description: 'Two exact organization names remain ambiguous without an identifier.',
    category: 'ambiguity',
    tenantFixture: 'tenant_a',
    input: { query: 'Kinetic Industries', entityTypeHint: 'organization' },
    expected: { status: 'ambiguous' },
  },
  {
    id: 'person_ambiguous_jane_smith',
    description: 'Two people with the same name remain ambiguous without email or directory ID.',
    category: 'person_identity',
    tenantFixture: 'tenant_a',
    input: { query: 'Jane Smith', entityTypeHint: 'person' },
    expected: { status: 'ambiguous' },
  },
  {
    id: 'person_exact_email',
    description: 'A verified non-generic email resolves the intended private contact.',
    category: 'exact_identifier',
    tenantFixture: 'tenant_a',
    input: {
      query: 'Jane Smith',
      entityTypeHint: 'person',
      identifiers: [{ type: 'email', value: 'jane.smith@example.com' }],
    },
    expected: { status: 'resolved', selectedCanonicalName: 'Jane Smith — Example Defense' },
  },
  {
    id: 'generic_mailbox_not_person',
    description: 'A generic shared mailbox does not create or resolve a person identity.',
    category: 'generic_mailbox',
    tenantFixture: 'tenant_a',
    input: {
      query: 'info@example.com',
      entityTypeHint: 'person',
      identifiers: [{ type: 'email', value: 'info@example.com' }],
    },
    expected: { status: 'unresolved' },
  },
  {
    id: 'parent_subsidiary_conflict',
    description: 'Parent and subsidiary identifiers pointing to different entities fail ambiguous.',
    category: 'corporate_structure',
    tenantFixture: 'tenant_a',
    input: {
      query: 'Acme Defense',
      entityTypeHint: 'organization',
      identifiers: [
        { type: 'uei', value: 'PARENT123456' },
        { type: 'cage', value: 'SUB01' },
      ],
    },
    expected: { status: 'ambiguous' },
  },
  {
    id: 'acronym_collision',
    description: 'A shared acronym cannot auto-resolve without a deterministic identifier.',
    category: 'ambiguity',
    tenantFixture: 'tenant_a',
    input: { query: 'ATI', entityTypeHint: 'organization' },
    expected: { status: 'ambiguous' },
  },
  {
    id: 'tenant_private_alias_isolated',
    description: 'Tenant B cannot discover Tenant A private alias or private canonical entity.',
    category: 'privacy',
    tenantFixture: 'tenant_b',
    input: { query: 'Project Blue Lantern', entityTypeHint: 'organization' },
    expected: {
      status: 'unresolved',
      forbiddenCanonicalNames: ['Blue Lantern Holdings — Tenant A'],
    },
  },
  {
    id: 'tenant_private_email_isolated',
    description: 'Tenant B cannot resolve a private Tenant A contact by mailbox-derived email.',
    category: 'privacy',
    tenantFixture: 'tenant_b',
    input: {
      query: 'private.person@stealth.example',
      entityTypeHint: 'person',
      identifiers: [{ type: 'email', value: 'private.person@stealth.example' }],
    },
    expected: {
      status: 'unresolved',
      forbiddenCanonicalNames: ['Private Person — Tenant A'],
    },
  },
  {
    id: 'committee_exact_system_code',
    description: 'An exact congressional committee system code resolves deterministically.',
    category: 'exact_identifier',
    tenantFixture: 'tenant_a',
    input: {
      query: 'House Armed Services Committee',
      entityTypeHint: 'committee',
      identifiers: [{ type: 'committee_id', value: 'hsas00' }],
    },
    expected: {
      status: 'resolved',
      selectedCanonicalName: 'House Committee on Armed Services',
    },
  },
  {
    id: 'member_exact_bioguide',
    description: 'An exact Bioguide identifier resolves a member despite name formatting.',
    category: 'exact_identifier',
    tenantFixture: 'tenant_a',
    input: {
      query: 'Smith, Jane A.',
      entityTypeHint: 'person',
      identifiers: [{ type: 'bioguide_id', value: 'S000001' }],
    },
    expected: { status: 'resolved', selectedCanonicalName: 'Jane A. Smith' },
  },
  {
    id: 'program_element_exact_code',
    description: 'A PE code resolves the canonical Program Element without name inference.',
    category: 'exact_identifier',
    tenantFixture: 'tenant_a',
    input: {
      query: 'Ground Robotics',
      entityTypeHint: 'program_element',
      identifiers: [{ type: 'program_element_code', value: '0605053A' }],
    },
    expected: { status: 'resolved', selectedCanonicalName: 'Ground Robotics' },
  },
] as const;
