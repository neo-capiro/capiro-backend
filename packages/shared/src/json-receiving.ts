/** Internal JSON receiving owner shared by browser-safe domain projections. Not a public subpath. */
export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}
export type ReceiveResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: 'invalid_json' | 'invalid_shape' | 'limit_exceeded' | 'identity_mismatch';
        path: string;
      };
    };
/** Resource syntax/binding is not evidence of actor, tenant, approval or ID-family authority. */
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
// Workspace's current HillDay source/document owner admits versions 1–8. Core stays 1–5.
const WORKSPACE_UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
/**
 * Wire-snapshot budgets, independent of request normalization. String capacity includes large
 * image URLs, rendered HTML and a 100-document list; these are explicit receiving limits.
 * Design collections additionally use the current Workspace 500-block/6-level limits.
 */
export const JSON_RECEIVE_LIMITS = Object.freeze({
  jsonDepth: 64,
  jsonNodes: 2_000_000,
  objectKeys: 10_000,
  arrayLength: 100_000,
  stringLength: 200_000_000,
  totalStringLength: 1_000_000_000,
});
type Failure = Exclude<ReceiveResult<never>, { ok: true }>['error'];
const failures = new WeakMap<object, Failure>();
export function refuse(path: string, code: Failure['code'] = 'invalid_shape'): never {
  const token = {};
  failures.set(token, { code, path });
  throw token;
}
function plain(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype) return true;
  // Permit another realm's ordinary Object.prototype without invoking its methods.
  if (Object.getPrototypeOf(proto) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(proto, 'constructor');
  if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function')
    return false;
  const prototype = Object.getOwnPropertyDescriptor(constructor.value, 'prototype');
  return Boolean(prototype && 'value' in prototype && prototype.value === proto);
}
export function snapshot(input: unknown, documentCount = 1): Json {
  let nodes = 0;
  let characters = 0;
  const active = new Set<object>();
  const visit = (value: unknown, path: string, depth: number): Json => {
    if (
      ++nodes > JSON_RECEIVE_LIMITS.jsonNodes * documentCount ||
      depth > JSON_RECEIVE_LIMITS.jsonDepth
    )
      refuse(path, 'limit_exceeded');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) refuse(path, 'invalid_json');
      return value;
    }
    if (typeof value === 'string') {
      characters += value.length;
      if (
        value.length > JSON_RECEIVE_LIMITS.stringLength ||
        characters > JSON_RECEIVE_LIMITS.totalStringLength
      )
        refuse(path, 'limit_exceeded');
      return value;
    }
    if (typeof value !== 'object') refuse(path, 'invalid_json');
    if (active.has(value)) refuse(path, 'invalid_json');
    const isArray = Array.isArray(value);
    if (!isArray && !plain(value)) refuse(path, 'invalid_json');
    const lengthDescriptor = isArray ? Object.getOwnPropertyDescriptor(value, 'length') : undefined;
    const length =
      lengthDescriptor && 'value' in lengthDescriptor ? (lengthDescriptor.value as number) : 0;
    if (
      isArray &&
      (!Number.isSafeInteger(length) || length < 0 || length > JSON_RECEIVE_LIMITS.arrayLength)
    )
      refuse(path, 'limit_exceeded');
    const keys = Reflect.ownKeys(value);
    if (keys.length > (isArray ? length + 1 : JSON_RECEIVE_LIMITS.objectKeys))
      refuse(path, isArray ? 'invalid_json' : 'limit_exceeded');
    if (isArray && keys.length !== length + 1) refuse(path, 'invalid_json');
    active.add(value);
    const copy: Json[] | JsonObject = isArray ? [] : {};
    for (const key of keys) {
      if (isArray && key === 'length') continue;
      if (typeof key !== 'string') refuse(path, 'invalid_json');
      characters += key.length;
      if (
        key.length > JSON_RECEIVE_LIMITS.stringLength ||
        characters > JSON_RECEIVE_LIMITS.totalStringLength
      )
        refuse(path, 'limit_exceeded');
      if (isArray && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))
        refuse(path, 'invalid_json');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        refuse(`${path}.${key}`, 'invalid_json');
      // defineProperty preserves JSON keys including __proto__ as inert own data, never setters.
      Object.defineProperty(copy, key, {
        value: visit(descriptor.value, `${path}.${key}`, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    active.delete(value);
    return copy;
  };
  return visit(input, '$', 0);
}
export type Rule = (value: Json, path: string) => void;
export const text: Rule = (value, path) => {
  if (typeof value !== 'string') refuse(path);
};
export const bool: Rule = (value, path) => {
  if (typeof value !== 'boolean') refuse(path);
};
export const number: Rule = (value, path) => {
  if (typeof value !== 'number') refuse(path);
};
export const revision: Rule = (value, path) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) refuse(path);
};
export const uuid: Rule = (value, path) => {
  if (typeof value !== 'string' || !UUID.test(value)) refuse(path);
};
export const workspaceUuid: Rule = (value, path) => {
  if (typeof value !== 'string' || !WORKSPACE_UUID.test(value)) refuse(path);
};
export const timestamp: Rule = (value, path) => {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    refuse(path);
};
export const literal =
  (...values: (string | number)[]): Rule =>
  (value, path) => {
    if (!values.includes(value as string | number)) refuse(path);
  };
export const vocabulary =
  (values: () => readonly string[]): Rule =>
  (value, path) => {
    if (typeof value !== 'string' || !values().includes(value)) refuse(path);
  };
export const nullable =
  (rule: Rule): Rule =>
  (value, path) => {
    if (value !== null) rule(value, path);
  };
export const array =
  (rule: Rule, max = 100_000): Rule =>
  (value, path) => {
    if (!Array.isArray(value)) refuse(path);
    if (value.length > max) refuse(path, 'limit_exceeded');
    value.forEach((item, index) => rule(item, `${path}.${index}`));
  };
export function row(value: Json, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(path);
  return value;
}
export function object(required: Record<string, Rule>, optional: Record<string, Rule> = {}): Rule {
  return (value, path) => {
    const record = row(value, path);
    for (const [key, rule] of Object.entries(required)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) refuse(`${path}.${key}`);
      rule(record[key]!, `${path}.${key}`);
    }
    for (const [key, rule] of Object.entries(optional))
      if (Object.prototype.hasOwnProperty.call(record, key)) rule(record[key]!, `${path}.${key}`);
  };
}
export function receive<T>(
  input: unknown,
  rule: Rule,
  inspect?: (value: Json) => void,
  documentCount = 1,
): ReceiveResult<T> {
  try {
    const value = snapshot(input, documentCount);
    rule(value, '$');
    inspect?.(value);
    // Every known nested field has been structurally validated; extra JSON is preserved, not cast unchecked.
    return { ok: true, value: value as T };
  } catch (error) {
    const failure =
      error && (typeof error === 'object' || typeof error === 'function')
        ? failures.get(error)
        : undefined;
    return { ok: false, error: failure ?? { code: 'invalid_json', path: '$' } };
  }
}
