import { createHash } from 'node:crypto';
import { hearingContentChunks } from './hearing-content-chunks.js';

describe('hearing UTF-16 fragment boundaries', () => {
  it('retains whole packets, original JSON hash and ordinary ASCII paging', () => {
    for (const payload of [{ text: 'Small 😀 packet' }, { text: 'x'.repeat(9000) }]) {
      const json = JSON.stringify(payload),
        result = hearingContentChunks(payload);
      expect(result.hash).toBe(createHash('sha256').update(json).digest('hex'));
      if (json.length <= 6500) expect(result.chunks).toEqual([payload]);
      else
        result.chunks.forEach((chunk, part) => {
          expect(chunk.characterStart).toBe(part * 2000);
          expect(chunk.characterEnd).toBe(Math.min((part + 1) * 2000, json.length));
          expect(chunk.text).toBe(json.slice(part * 2000, (part + 1) * 2000));
        });
    }
  });

  it.each(['', 'x'])(
    'keeps complete scalars and contiguous exact locations at parity %j',
    (prefix) => {
      const payload = { kind: 'hearing', text: prefix + '😀'.repeat(5000) + 'a'.repeat(3000) };
      const json = JSON.stringify(payload),
        result = hearingContentChunks(payload);
      let joined = '';
      expect(result.chunks).toHaveLength(Math.ceil(json.length / 2000));
      result.chunks.forEach((chunk, part) => {
        const text = chunk.text as string;
        expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
        expect(chunk.characterStart).toBe(joined.length);
        expect([part * 2000, part * 2000 - 1]).toContain(chunk.characterStart);
        joined += text;
        expect(chunk.characterEnd).toBe(joined.length);
        expect(text.length).toBeLessThanOrEqual(2001);
        expect(chunk.chunk).toBe(part + 1);
        expect(chunk.chunkCount).toBe(result.chunks.length);
        expect(chunk.contentHash).toBe(result.hash);
      });
      expect(joined).toBe(json);
      expect(result.hash).toBe(createHash('sha256').update(json).digest('hex'));
    },
  );

  it('does not create lone surrogates when clipping repeated title or kind metadata', () => {
    const payload = {
      kind: 'k'.repeat(79) + '😀',
      title: 't'.repeat(239) + '😀',
      text: 'x'.repeat(7000),
    };
    for (const chunk of hearingContentChunks(payload).chunks) {
      expect(chunk.originalKind).toBe('k'.repeat(79));
      expect(chunk.title).toBe('t'.repeat(239));
    }
  });
});
