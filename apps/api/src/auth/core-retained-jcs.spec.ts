import { describe, expect, it } from '@jest/globals';
import { CoreRetainedJcsError, canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';

describe('RFC 8785 canonicalization for retained-read codecs', () => {
  // Built from code points so the vectors do not depend on source escape handling.
  const ch = (...codes: number[]) => String.fromCharCode(...codes);
  const BS = ch(92);
  const Q = ch(34);

  it('reproduces the RFC 8785 section 3.2.4 example output', () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27],
      string: ch(0x20ac) + '$' + ch(0x0f) + ch(0x0a) + "A'B" + Q + BS + BS + Q + '/',
      literals: [null, true, false],
    };
    const expectedString = Q + ch(0x20ac) + '$' + BS + 'u000f' + BS + 'n' + "A'B" + BS + Q + BS + BS + BS + BS + BS + Q + '/' + Q;
    expect(canonicalizeCoreRetainedJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":' + expectedString + '}',
    );
  });

  it('sorts members by UTF-16 code units (RFC 8785 section 3.2.3 example)', () => {
    const members: Array<[string, string]> = [
      [ch(0x0d), 'Carriage Return'],
      ['1', 'One'],
      [ch(0x80), 'Control'],
      [ch(0xf6), 'Latin Small Letter O With Diaeresis'],
      [ch(0x20ac), 'Euro Sign'],
      [ch(0xd83d, 0xde00), 'Emoji: Grinning Face'],
      [ch(0xfb33), 'Hebrew Letter Dalet With Dagesh'],
    ];
    const input = Object.fromEntries([...members].reverse());
    const expected = '{' + members.map(([key, value]) => JSON.stringify(key) + ':' + JSON.stringify(value)).join(',') + '}';
    expect(canonicalizeCoreRetainedJson(input)).toBe(expected);
  });

  it.each([
    [0, '0'], [-0, '0'], [1, '1'], [-1.5, '-1.5'], [1e21, '1e+21'], [1e-7, '1e-7'], [0.000001, '0.000001'],
    [9007199254740992, '9007199254740992'], [5e-324, '5e-324'], [1.7976931348623157e308, '1.7976931348623157e+308'],
    [333333333.33333329, '333333333.3333333'],
  ])('serializes number %p as %s (ECMAScript Number::toString)', (value, expected) => {
    expect(canonicalizeCoreRetainedJson(value)).toBe(expected);
  });

  it('nests deterministically regardless of insertion order', () => {
    const a = { b: [1, { y: true, x: null }], a: 'z' };
    const b = { a: 'z', b: [1, { x: null, y: true }] };
    expect(canonicalizeCoreRetainedJson(a)).toBe('{"a":"z","b":[1,{"x":null,"y":true}]}');
    expect(canonicalizeCoreRetainedJson(b)).toBe(canonicalizeCoreRetainedJson(a));
    expect(canonicalizeCoreRetainedJson(Object.assign(Object.create(null), { k: 1 }))).toBe('{"k":1}');
  });

  it.each([
    ['NaN', NaN], ['Infinity', Infinity], ['undefined', undefined], ['bigint', BigInt(1)], ['symbol', Symbol('s')],
    ['function', () => 1], ['Date', new Date(0)], ['Map', new Map()], ['Buffer', Buffer.from('x')],
    ['undefined member', { a: undefined }], ['sparse array', [1, , 2]], ['lone high surrogate', '\ud800'],
    ['lone low surrogate', 'a\udc00'], ['symbol key', { [Symbol('k')]: 1 }], ['proxy', new Proxy({}, {})],
    ['accessor', Object.defineProperty({}, 'a', { get: () => 1, enumerable: true })],
  ])('refuses %s instead of coercing it', (_label, value) => {
    expect(() => canonicalizeCoreRetainedJson(value)).toThrow(CoreRetainedJcsError);
  });

  it('refuses cycles but accepts repeated non-cyclic references', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeCoreRetainedJson(cyclic)).toThrow(CoreRetainedJcsError);
    const shared = { v: 1 };
    expect(canonicalizeCoreRetainedJson({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });

  it.each(['root', 'nested'])('refuses %s indexed accessors without invoking them', placement => {
    let calls = 0;
    const deferred = Object.defineProperty([], '0', { enumerable: true, get: () => { calls++; return 1; } });
    expect(() => canonicalizeCoreRetainedJson(placement === 'root' ? deferred : { rows: [deferred] })).toThrow(CoreRetainedJcsError);
    expect(calls).toBe(0);
  });

  it.each([
    ['named member', Object.assign([1], { extra: true })],
    ['symbol member', Object.assign([1], { [Symbol('extra')]: true })],
    ['hidden member', Object.defineProperty([1], 'extra', { value: true })],
    ['hidden element', Object.defineProperty([1], '0', { enumerable: false })],
    ['toJSON accessor', Object.defineProperty([1], 'toJSON', { get: () => { throw Error('must not execute'); } })],
    ['proxy array', new Proxy([1], { ownKeys: () => { throw Error('must not execute'); } })],
  ])('refuses arrays with %s', (_label, value) => {
    expect(() => canonicalizeCoreRetainedJson(value)).toThrow(CoreRetainedJcsError);
  });

  it('preserves ordinary, empty, frozen and repeated arrays without coercion', () => {
    const rows = Object.freeze([null, true, 'row', { n: 2 }]);
    expect(canonicalizeCoreRetainedJson([[], rows, rows])).toBe('[[],[null,true,"row",{"n":2}],[null,true,"row",{"n":2}]]');
  });
});
