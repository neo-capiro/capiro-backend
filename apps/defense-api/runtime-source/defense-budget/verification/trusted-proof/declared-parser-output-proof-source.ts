/**
 * R8.3 — central parser-run declaration binding.
 *
 * Adapters independently load and verify parser outputs. This wrapper is the
 * production trust boundary that binds the artifact's declared parser output
 * SHA to the exact independently loaded canonical parser-result SHA, including
 * custom/injected proof sources.
 */
import type {
  ParserOutputProofRequestV1,
  ParserOutputProofSource,
  ResolvedParserOutputProof,
} from './parser-output-proof-source.js';

export class DeclaredParserOutputProofSource implements ParserOutputProofSource {
  constructor(private readonly delegate: ParserOutputProofSource) {}

  async resolveParserOutput(
    input: ParserOutputProofRequestV1,
  ): Promise<ResolvedParserOutputProof | null> {
    const proof = await this.delegate.resolveParserOutput(input);
    if (!proof) return null;
    if (!proof.outputContentSha256) {
      throw new Error(
        `independently loaded parser output has no canonical content SHA ` +
          `(parserRunId=${input.parserRunId})`,
      );
    }
    if (proof.outputContentSha256 !== input.declaredOutputSha256) {
      throw new Error(
        `parser-run declaration ${input.declaredOutputSha256} does not match ` +
          `independently loaded parser output content SHA ${proof.outputContentSha256} ` +
          `(parserRunId=${input.parserRunId})`,
      );
    }
    return proof;
  }
}
