declare module 'word-extractor' {
  interface ExtractedWordDocument {
    getBody(options?: { filterUnicode?: boolean }): string;
  }

  export default class WordExtractor {
    extract(source: Buffer | string): Promise<ExtractedWordDocument>;
  }
}
