import type {
  AwardTransaction,
  PortfolioAcquisitionProjection,
  PortfolioAcquisitionProjectionInput,
} from './acquisition-continuity.types.js';

function parseDecimal(value: string): { minor: bigint; scale: number } {
  const trimmed = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new Error(`Invalid decimal amount: ${value}`);
  const fraction = match[3] ?? '';
  const magnitude = BigInt(`${match[2]}${fraction}`);
  return { minor: match[1] === '-' ? -magnitude : magnitude, scale: fraction.length };
}

function decimalString(value: bigint, scale: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  if (scale === 0) return `${negative ? '-' : ''}${magnitude}`;
  const digits = magnitude.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function sumDecimals(values: string[]): string {
  if (values.length === 0) return '0';
  const parsed = values.map(parseDecimal);
  const scale = Math.max(...parsed.map((value) => value.scale));
  const factor = (n: number) => 10n ** BigInt(n);
  const sum = parsed.reduce((total, value) => total + value.minor * factor(scale - value.scale), 0n);
  return decimalString(sum, scale);
}

function latestByIdentity(transactions: AwardTransaction[]): AwardTransaction[] {
  const latest = new Map<string, AwardTransaction>();
  for (const transaction of transactions) {
    if (!Number.isInteger(transaction.revision) || transaction.revision < 0) {
      throw new Error(`Invalid revision for transaction ${transaction.identityKey}`);
    }
    parseDecimal(transaction.signedDeltaUsd);
    const current = latest.get(transaction.identityKey);
    if (!current || transaction.revision > current.revision) {
      latest.set(transaction.identityKey, transaction);
    } else if (
      transaction.revision === current.revision &&
      (transaction.signedDeltaUsd !== current.signedDeltaUsd ||
        transaction.awardIdentityKey !== current.awardIdentityKey ||
        transaction.correctsIdentityKey !== current.correctsIdentityKey)
    ) {
      throw new Error(`Conflicting observations for transaction ${transaction.identityKey} revision ${transaction.revision}`);
    }
  }

  const superseded = new Set<string>();
  for (const transaction of latest.values()) {
    if (transaction.correctsIdentityKey) superseded.add(transaction.correctsIdentityKey);
  }
  return [...latest.values()].filter((transaction) => !superseded.has(transaction.identityKey));
}

/**
 * Project portfolio award reachability and signed action deltas. Awards and
 * actions dedupe by authoritative identities, regardless of how many program
 * paths reach them. Account totals remain a separate output and are never added.
 */
export function projectPortfolioAcquisition(
  input: PortfolioAcquisitionProjectionInput,
): PortfolioAcquisitionProjection {
  const awardIdentityKeys = [...new Set(input.awardPaths.map((path) => path.awardIdentityKey))].sort();
  const reachableAwards = new Set(awardIdentityKeys);
  const transactions = latestByIdentity(input.transactions).filter((transaction) =>
    reachableAwards.has(transaction.awardIdentityKey),
  );
  const accountTotals = input.accountTotals.map((total) => {
    parseDecimal(total.amountUsd);
    return { ...total };
  });
  return {
    awardIdentityKeys,
    awardCount: awardIdentityKeys.length,
    signedTransactionDeltaUsd: sumDecimals(transactions.map((transaction) => transaction.signedDeltaUsd)),
    transactionCount: transactions.length,
    accountTotals,
  };
}
