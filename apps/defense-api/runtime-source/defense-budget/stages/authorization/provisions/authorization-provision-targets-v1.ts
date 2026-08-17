/** Phase 6 Workstream F — pure target resolution and normalization helpers. */
import type { BudgetLineIdentityV1 } from '../../../contracts/extraction-artifact-v1.js';
import {
  type AuthorizationProvisionNativeIndexV1,
  type AuthorizationProvisionTargetV1,
  type ProvisionReferenceV1,
} from './authorization-provision-v1.js';

export function uniqueReferences(references: ProvisionReferenceV1[]): ProvisionReferenceV1[] {
  const map = new Map<string, ProvisionReferenceV1>();
  for (const reference of references) map.set(JSON.stringify(reference), reference);
  return [...map.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function exactTargets(
  reference: Exclude<ProvisionReferenceV1, { referenceKind: 'title_only' }>,
  index: AuthorizationProvisionNativeIndexV1,
): AuthorizationProvisionTargetV1[] {
  if (reference.referenceKind === 'rdte_project') {
    return index.projects
      .filter(
        (item) =>
          item.parentPeCode === reference.peCode && item.projectCode === reference.projectCode,
      )
      .map((item) => ({
        targetKind: 'rdte_project' as const,
        parentPeCode: item.parentPeCode,
        projectCode: item.projectCode,
      }));
  }
  const identities = index.budgetLines
    .map((item) => item.identity)
    .filter((identity) => identityMatchesReference(identity, reference));
  return identities.map((identity) => ({ targetKind: 'budget_line' as const, identity }));
}

export function identityMatchesReference(
  identity: BudgetLineIdentityV1,
  reference: Exclude<ProvisionReferenceV1, { referenceKind: 'title_only' | 'rdte_project' }>,
): boolean {
  if (reference.referenceKind === 'pe_code') {
    return identity.lineKind === 'RDTE_PE' && identity.peCode === reference.peCode;
  }
  if (reference.referenceKind === 'procurement_line') {
    return (
      identity.lineKind === 'PROCUREMENT_BLIN' &&
      identity.code === reference.code &&
      identity.account === reference.account &&
      identity.component === reference.component &&
      (reference.advanceProcurement == null ||
        identity.advanceProcurement === reference.advanceProcurement)
    );
  }
  if (reference.referenceKind === 'om_sag') {
    return (
      identity.lineKind === 'OM_SAG' &&
      identity.code === reference.code &&
      identity.account === reference.account &&
      identity.component === reference.component
    );
  }
  return (
    identity.lineKind === 'MILCON_PROJECT' &&
    identity.projectCode === reference.projectCode &&
    identity.component === reference.component &&
    (reference.location == null || identity.location === reference.location)
  );
}

export function titleTargets(
  title: string,
  index: AuthorizationProvisionNativeIndexV1,
): AuthorizationProvisionTargetV1[] {
  const normalized = normalize(title);
  const targets: AuthorizationProvisionTargetV1[] = [];
  for (const item of index.budgetLines) {
    if (item.title != null && normalize(item.title) === normalized) {
      targets.push({ targetKind: 'budget_line', identity: item.identity });
    }
  }
  for (const item of index.projects) {
    if (normalize(item.title) === normalized) {
      targets.push({
        targetKind: 'rdte_project',
        parentPeCode: item.parentPeCode,
        projectCode: item.projectCode,
      });
    }
  }
  return uniqueTargets(targets);
}

export function targetExists(
  target: AuthorizationProvisionTargetV1,
  index: AuthorizationProvisionNativeIndexV1,
): boolean {
  const key = targetKey(target);
  return [
    ...index.budgetLines.map((item) => ({
      targetKind: 'budget_line' as const,
      identity: item.identity,
    })),
    ...index.projects.map((item) => ({
      targetKind: 'rdte_project' as const,
      parentPeCode: item.parentPeCode,
      projectCode: item.projectCode,
    })),
  ].some((candidate) => targetKey(candidate) === key);
}

export function uniqueTargets(
  targets: AuthorizationProvisionTargetV1[],
): AuthorizationProvisionTargetV1[] {
  const map = new Map<string, AuthorizationProvisionTargetV1>();
  for (const target of targets) map.set(targetKey(target), target);
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, target]) => target);
}

export function targetKey(target: AuthorizationProvisionTargetV1): string {
  if (target.targetKind === 'rdte_project') {
    return `RDTE_PROJECT|${target.parentPeCode}|${target.projectCode}`;
  }
  const identity = target.identity;
  if (identity.lineKind === 'RDTE_PE') return `RDTE_PE|${identity.peCode}`;
  if (identity.lineKind === 'PROCUREMENT_BLIN') {
    return [
      identity.lineKind,
      identity.component,
      identity.account,
      identity.code,
      identity.advanceProcurement === true ? 'AP' : 'BASE',
    ].join('|');
  }
  if (identity.lineKind === 'OM_SAG') {
    return [identity.lineKind, identity.component, identity.account, identity.code].join('|');
  }
  if (identity.lineKind === 'MILCON_PROJECT') {
    return [
      identity.lineKind,
      identity.component,
      identity.projectCode,
      identity.location ?? '',
    ].join('|');
  }
  return `UNKNOWN|${identity.code}`;
}

export function containsPhrase(haystack: string, phrase: string): boolean {
  return ` ${haystack} `.includes(` ${phrase} `);
}

export function normalize(value: string): string {
  return value
    .toUpperCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
