import { sha256Bytes } from '../contracts/canonical-json.js';
import type { ParserRunRecorderV1 } from './parser-artifact-store.js';

export interface ParserOutputByteReaderV1 {
  read(locator: string): Promise<{ bytes: Uint8Array }>;
}

/**
 * Re-read the exact persisted output locator before recording a parser run.
 * This prevents a provider-raw SHA from being attached to a normalized result
 * object, and makes DocumentParseJob metadata match the bytes Phase 2 reads.
 */
export class ProofBoundParserRunRecorder implements ParserRunRecorderV1 {
  constructor(
    private readonly delegate: ParserRunRecorderV1,
    private readonly outputReader: ParserOutputByteReaderV1,
  ) {}

  async record(
    input: Parameters<ParserRunRecorderV1['record']>[0],
  ): Promise<{ parseJobId: string }> {
    const located = await this.outputReader.read(input.outputLocator);
    const actualOutputByteSha256 = sha256Bytes(located.bytes);
    return this.delegate.record({
      ...input,
      outputByteSha256: actualOutputByteSha256,
      metadata: {
        ...(input.metadata ?? {}),
        ...(actualOutputByteSha256 !== input.outputByteSha256
          ? { providerDeclaredOutputByteSha256: input.outputByteSha256 }
          : {}),
        persistedOutputByteSha256: actualOutputByteSha256,
      },
    });
  }
}
