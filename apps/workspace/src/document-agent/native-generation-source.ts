import { createHash } from 'node:crypto';

/** IDs remain valid for existing phases. A selected saved snapshot carries both
 * its exact UTF-8 text and its digest; neither field grants source access. */
export type NativeGenerationSource = { id: string; kind: string } & (
  | { text?: never; sha256?: never }
  | { text: string; sha256: string }
);

export function nativeGenerationSourceSnapshot(id: string, kind: string, text: string) {
  const source = {
    id,
    kind,
    text,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
  nativeGenerationSourceWire(source);
  return source;
}

/** One closed projection for hashing, dispatch and exact-request readback. */
export function nativeGenerationSourceWire(source: NativeGenerationSource): NativeGenerationSource {
  const { id, kind, text, sha256 } = source;
  if (
    typeof id !== 'string' ||
    !id ||
    id.length > 256 ||
    typeof kind !== 'string' ||
    !kind ||
    kind.length > 64
  )
    throw new Error('Invalid native generation source');
  if (text === undefined && sha256 === undefined) return { id, kind };
  if (
    typeof text !== 'string' ||
    !text ||
    Buffer.byteLength(text, 'utf8') > 49152 ||
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    createHash('sha256').update(text, 'utf8').digest('hex') !== sha256
  )
    throw new Error('Invalid native generation source snapshot');
  return { id, kind, text, sha256 };
}
