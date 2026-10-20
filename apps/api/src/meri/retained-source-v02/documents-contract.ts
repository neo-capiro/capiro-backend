import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import baseSchema from './mail-base.schema.json';
import commonSchema from './mail-common.schema.json';
import documentSchema from './client-documents.schema.json';
import { createClientDocumentsValidators } from './documents-contract-semantics.js';

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const schema of [baseSchema, commonSchema, documentSchema]) ajv.addSchema(schema);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
const fail = (): never => { throw new Error('Document result differs from pinned Meri 0.2 contract'); };
function validateShape(name: string, value: unknown): void {
  let check = validators.get(name);
  if (!check) {
    const schema = name === 'ResolvedSubject' ? commonSchema : documentSchema;
    check = ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });
    validators.set(name, check);
  }
  if (!check(value)) fail();
}
export const documentContractV02 = createClientDocumentsValidators({
  validateShape,
  canonicalSha256: (value) => createHash('sha256').update(canonicalizeCoreRetainedJson(value)).digest('hex'),
  assertSubject: (subject, binding) => {
    validateShape('ResolvedSubject', subject);
    if (new Set(subject.entityIds).size !== subject.entityIds.length ||
        subject.scopes.some((scope: Record<string, unknown>) =>
          scope.tenantId !== subject.tenantId || scope.policyRevision !== subject.policyRevision) ||
        subject.tenantId !== binding.tenantId || subject.actorId !== binding.actorId ||
        subject.kind !== 'client' || subject.entityType !== 'client' ||
        subject.entityIds.length !== 1 || subject.rosterVersionId !== null) fail();
  },
});
