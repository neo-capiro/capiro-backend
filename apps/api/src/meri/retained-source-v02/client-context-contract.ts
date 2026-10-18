import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import profileSchema from './client-context-profile.schema.json';
import profileSchemaV03 from './client-context-profile-v03.schema.json';
import dataSearchSchema from './client-context-data-search.schema.json';

/**
 * Byte-exact schema mirrors from Meri PR158 (`052f9865879a983a348d5903b2b52c2675287a04`).
 * Profile SHA-256: 67ad0fd59fe7b995e5e9c73d60a82a12220c58d74a81672b485d9279458ba27d.
 * Data-search SHA-256: b390270625b4662df487f04b13df745f422d10a2a8aa90e79e90a7ce75219d60.
 * This is only shape validation; the client-context projection also applies
 * the pinned contract's cross-field and source-identity assertions.
 */
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(dataSearchSchema);
ajv.addSchema(profileSchema);
ajv.addSchema(profileSchemaV03);

const profileId = 'urn:meri:retrieval:client-knowledge-profile:0.2.0';
const output = ajv.compile({ $ref: `${profileId}#/$defs/ClientKnowledgeProfileOutput` });
const request = ajv.compile({ $ref: `${profileId}#/$defs/ClientKnowledgeProfileRequest` });
const input = ajv.compile({ $ref: `${profileId}#/$defs/ClientKnowledgeProfileInput` });
const context = ajv.compile({ $ref: `${profileId}#/$defs/ClientKnowledgeProfileContext` });

export const retainedClientContextShape = Object.freeze({
  output: (value: unknown): boolean => output(value) === true,
  request: (value: unknown): boolean => request(value) === true,
  input: (value: unknown): boolean => input(value) === true,
  context: (value: unknown): boolean => context(value) === true,
});

/**
 * Meri PR160 `0114f1a97ff9ca0f7b90ec281b557d0d24c1d225` 0.3.0 profile
 * schema, mirrored byte for byte as client-context-profile-v03.schema.json.
 * SHA-256: 7d422f92a4771b2d7e869e45371396c12b8a69934f9cb8ca50f5821ccab514a2.
 * This compiles the entire nested output, not a permissive wrapper subset.
 * Semantic coverage, cursor, scope, and source-window checks run separately.
 */
const profileV03Id = 'urn:meri:retrieval:client-knowledge-profile:0.3.0';
const outputV03 = ajv.compile({ $ref: `${profileV03Id}#/$defs/ClientKnowledgeProfileOutput` });
const requestV03 = ajv.compile({ $ref: `${profileV03Id}#/$defs/ClientKnowledgeProfileRequest` });
const inputV03 = ajv.compile({ $ref: `${profileV03Id}#/$defs/ClientKnowledgeProfileInput` });
const contextV03 = ajv.compile({ $ref: `${profileV03Id}#/$defs/ClientKnowledgeProfileContext` });
const rowDefinitionsV03 = {
  capabilities: ['ProfileClientCapability', 'ProfileCapabilitiesSummary'],
  people: ['ProfileClientPerson', 'ProfilePeopleSummary'],
  facilities: ['ProfileClientFacility', 'ProfileFacilitiesSummary'],
  submissionHistory: ['ProfileClientSubmissionHistory', 'ProfileSubmissionHistorySummary'],
  advocacyMatters: ['ProfileAdvocacyMatter', 'ProfileAdvocacyMattersSummary'],
  advocacyRecords: ['ProfileAdvocacyRecord', 'ProfileAdvocacyRecordsSummary'],
} as const;
const rowV03 = Object.fromEntries(Object.entries(rowDefinitionsV03).map(([section, definitions]) =>
  [section, definitions.map((definition) => ajv.compile({ $ref: `${profileV03Id}#/$defs/${definition}` }))],
)) as unknown as Record<keyof typeof rowDefinitionsV03, Array<(value: unknown) => boolean>>;

export const retainedClientContextShape03 = Object.freeze({
  output: (value: unknown): boolean => outputV03(value) === true,
  request: (value: unknown): boolean => requestV03(value) === true,
  input: (value: unknown): boolean => inputV03(value) === true,
  context: (value: unknown): boolean => contextV03(value) === true,
  row: (section: keyof typeof rowDefinitionsV03, representation: 'full' | 'summary', value: unknown): boolean =>
    rowV03[section][representation === 'full' ? 0 : 1]!(value) === true,
});
