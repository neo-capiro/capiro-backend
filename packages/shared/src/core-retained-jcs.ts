import { types as nodeTypes } from 'node:util';

/**
 * RFC 8785 JSON Canonicalization Scheme for the server-only retained-read
 * codecs. Input must already be a JSON value: plain objects, arrays, strings,
 * finite numbers, booleans and null. Anything a JSON round trip would change or
 * drop (undefined, functions, symbols, bigint, non-plain objects, sparse
 * arrays, lone surrogates, cycles) is refused instead of silently coerced.
 *
 * Numbers use ECMAScript Number::toString through JSON.stringify, which is
 * what RFC 8785 §3.2.2.3 specifies; strings use JSON.stringify escaping
 * (§3.2.2.2); object members are sorted by UTF-16 code units (§3.2.3), which
 * is the default Array.prototype.sort order for strings.
 */
export class CoreRetainedJcsError extends Error {
  readonly code = 'CORE_RETAINED_JCS_INVALID';
  constructor(message: string) { super(message); this.name = 'CoreRetainedJcsError'; }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function canonicalizeCoreRetainedJson(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, stack: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CoreRetainedJcsError('Non-finite number');
      return JSON.stringify(value);
    case 'string':
      return string(value);
    case 'object':
      break;
    default:
      throw new CoreRetainedJcsError(`Unsupported ${typeof value} value`);
  }
  const object = value as object;
  if (nodeTypes.isProxy(object)) throw new CoreRetainedJcsError('Proxy value');
  if (stack.has(object)) throw new CoreRetainedJcsError('Cyclic value');
  stack.add(object);
  try {
    if (Array.isArray(object)) {
      if (Object.getPrototypeOf(object) !== Array.prototype) throw new CoreRetainedJcsError('Non-plain array');
      // JSON arrays have only their length and dense own data elements. Do not
      // invoke indexed getters or silently drop named/symbol properties.
      if (Reflect.ownKeys(object).length !== object.length + 1) throw new CoreRetainedJcsError('Non-JSON array member');
      const parts: string[] = [];
      for (let index = 0; index < object.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(object, index);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new CoreRetainedJcsError('Sparse, accessor or non-enumerable array member');
        }
        parts.push(serialize(descriptor.value, stack));
      }
      return `[${parts.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw new CoreRetainedJcsError('Non-plain object');
    const keys = Reflect.ownKeys(object);
    if (keys.some((key) => typeof key !== 'string')) throw new CoreRetainedJcsError('Symbol key');
    const members: string[] = [];
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new CoreRetainedJcsError('Accessor or non-enumerable member');
      }
      members.push(`${string(key)}:${serialize(descriptor.value, stack)}`);
    }
    return `{${members.join(',')}}`;
  } finally {
    stack.delete(object);
  }
}

function string(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new CoreRetainedJcsError('Lone surrogate');
  return JSON.stringify(value);
}
