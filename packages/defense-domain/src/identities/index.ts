/**
 * Native defense-budget identities are not interchangeable. A Program Element,
 * procurement BLIN, O&M BLI, SAG, and MILCON project remain separately typed until
 * an evidence-bearing crosswalk explicitly links them.
 */
export type DefenseNativeIdentityKind =
  | 'program_element'
  | 'procurement_blin'
  | 'om_bli'
  | 'sag'
  | 'milcon_project';

declare const nativeIdentityBrand: unique symbol;

export type DefenseNativeIdentity<TKind extends DefenseNativeIdentityKind> = Readonly<{
  kind: TKind;
  value: string;
  namespace?: string;
  [nativeIdentityBrand]: TKind;
}>;

export type ProgramElementIdentity = DefenseNativeIdentity<'program_element'>;
export type ProcurementBlinIdentity = DefenseNativeIdentity<'procurement_blin'>;
export type OmBliIdentity = DefenseNativeIdentity<'om_bli'>;
export type SagIdentity = DefenseNativeIdentity<'sag'>;
export type MilconProjectIdentity = DefenseNativeIdentity<'milcon_project'>;

export function normalizeNativeIdentityValue(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ').toUpperCase();
  if (!normalized) throw new TypeError('Defense native identity cannot be empty');
  if (normalized.length > 128) {
    throw new RangeError('Defense native identity cannot exceed 128 characters');
  }
  return normalized;
}

export function createNativeIdentity<TKind extends DefenseNativeIdentityKind>(
  kind: TKind,
  value: string,
  namespace?: string,
): DefenseNativeIdentity<TKind> {
  const identity = {
    kind,
    value: normalizeNativeIdentityValue(value),
    namespace: namespace?.trim() || undefined,
  };
  return identity as DefenseNativeIdentity<TKind>;
}

export interface DefenseIdentityCrosswalk<
  TFrom extends DefenseNativeIdentityKind = DefenseNativeIdentityKind,
  TTo extends DefenseNativeIdentityKind = DefenseNativeIdentityKind,
> {
  readonly id: string;
  readonly from: DefenseNativeIdentity<TFrom>;
  readonly to: DefenseNativeIdentity<TTo>;
  readonly status: 'candidate' | 'accepted' | 'rejected' | 'superseded';
  readonly basis: string;
  readonly sourceDocumentIds: readonly string[];
  readonly confidence: number;
  readonly reviewedBy?: string;
  readonly reviewedAt?: string;
}

export class NativeIdentityCrosswalkRequiredError extends Error {
  constructor(
    readonly fromKind: DefenseNativeIdentityKind,
    readonly toKind: DefenseNativeIdentityKind,
  ) {
    super(
      `No implicit identity conversion is allowed from ${fromKind} to ${toKind}; ` +
        'an accepted, evidence-bearing crosswalk is required.',
    );
    this.name = 'NativeIdentityCrosswalkRequiredError';
  }
}

export function requireAcceptedCrosswalk<
  TFrom extends DefenseNativeIdentityKind,
  TTo extends DefenseNativeIdentityKind,
>(
  from: DefenseNativeIdentity<TFrom>,
  toKind: TTo,
  candidates: readonly DefenseIdentityCrosswalk<TFrom, TTo>[],
): DefenseNativeIdentity<TTo> {
  const match = candidates.find(
    (candidate) =>
      candidate.status === 'accepted' &&
      candidate.from.kind === from.kind &&
      candidate.from.value === from.value &&
      candidate.to.kind === toKind,
  );
  if (!match) throw new NativeIdentityCrosswalkRequiredError(from.kind, toKind);
  return match.to;
}
