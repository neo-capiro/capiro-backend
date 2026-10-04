import { createHash } from 'node:crypto';

export function normalizeText(value) {
  if (typeof value !== 'string') {
    throw new TypeError('normalizeText requires a string');
  }
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+$/u, ''))
    .join('\n')
    .replace(/\n+$/u, '');
}

function canonicalValue(value) {
  if (typeof value === 'string') return normalizeText(value);
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Text(value) {
  return createHash('sha256').update(normalizeText(value), 'utf8').digest('hex');
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Stable(value) {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}
