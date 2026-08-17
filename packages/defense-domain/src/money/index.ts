export type MoneyUnit = 'dollars' | 'thousands' | 'millions';

export interface NormalizedMoneyMillions {
  /** Canonical value in USD millions. Never rounded by this helper. */
  readonly valueM: number;
  readonly originalValue: number;
  readonly originalUnit: MoneyUnit;
  readonly conversion: 'identity' | 'dollars_to_millions' | 'thousands_to_millions';
}

/**
 * Compatibility helper matching the existing Capiro shared money semantics.
 * Parser-facing code should prefer normalizeExactMoneyToMillions below.
 */
export function normalizeMoneyToMillions(
  value: number,
  unit: MoneyUnit,
): NormalizedMoneyMillions {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Money value must be finite; received ${String(value)}`);
  }

  switch (unit) {
    case 'dollars':
      return {
        valueM: value / 1_000_000,
        originalValue: value,
        originalUnit: unit,
        conversion: 'dollars_to_millions',
      };
    case 'thousands':
      return {
        valueM: value / 1_000,
        originalValue: value,
        originalUnit: unit,
        conversion: 'thousands_to_millions',
      };
    case 'millions':
      return {
        valueM: value,
        originalValue: value,
        originalUnit: unit,
        conversion: 'identity',
      };
    default: {
      const unrecognized: never = unit;
      throw new TypeError(`Unsupported money unit: ${JSON.stringify(unrecognized)}`);
    }
  }
}

declare const exactDecimalBrand: unique symbol;
export type ExactDecimalString = string & { readonly [exactDecimalBrand]: true };

interface ParsedExactDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

function parseDecimal(value: string): ParsedExactDecimal {
  const trimmed = value.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new TypeError(`Expected an exact decimal string; received ${JSON.stringify(value)}`);

  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2]!;
  const fraction = match[3] ?? '';
  const coefficient = sign * BigInt(`${whole}${fraction}`);
  return { coefficient, scale: fraction.length };
}

function formatDecimal(input: ParsedExactDecimal): ExactDecimalString {
  let coefficient = input.coefficient;
  const negative = coefficient < 0n;
  if (negative) coefficient = -coefficient;

  let digits = coefficient.toString();
  if (input.scale > 0) {
    digits = digits.padStart(input.scale + 1, '0');
    const split = digits.length - input.scale;
    const whole = digits.slice(0, split);
    const fraction = digits.slice(split).replace(/0+$/, '');
    digits = fraction ? `${whole}.${fraction}` : whole;
  }
  digits = digits.replace(/^0+(?=\d)/, '');
  if (digits === '') digits = '0';
  if (digits === '0') return '0' as ExactDecimalString;
  return `${negative ? '-' : ''}${digits}` as ExactDecimalString;
}

export function exactDecimal(value: string): ExactDecimalString {
  return formatDecimal(parseDecimal(value));
}

export interface ExactMoneyMillions {
  readonly valueM: ExactDecimalString;
  readonly originalValue: ExactDecimalString;
  readonly originalUnit: MoneyUnit;
  readonly conversion: 'identity' | 'dollars_to_millions' | 'thousands_to_millions';
}

/**
 * Converts exact source text by changing decimal scale rather than using a float.
 */
export function normalizeExactMoneyToMillions(
  value: string,
  unit: MoneyUnit,
): ExactMoneyMillions {
  const parsed = parseDecimal(value);
  const originalValue = formatDecimal(parsed);
  const scaleIncrease = unit === 'dollars' ? 6 : unit === 'thousands' ? 3 : 0;
  const valueM = formatDecimal({
    coefficient: parsed.coefficient,
    scale: parsed.scale + scaleIncrease,
  });

  return {
    valueM,
    originalValue,
    originalUnit: unit,
    conversion:
      unit === 'dollars'
        ? 'dollars_to_millions'
        : unit === 'thousands'
          ? 'thousands_to_millions'
          : 'identity',
  };
}
