import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import profileSchema from './client-context-profile.schema.json';
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
