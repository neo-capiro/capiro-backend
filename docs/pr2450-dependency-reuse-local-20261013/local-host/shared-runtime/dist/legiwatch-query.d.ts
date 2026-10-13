/** Deterministic bill-document queries. Raw imports are never normalized in storage.
 * The captured help does not establish mixed AND/OR precedence. Such imports
 * require parentheses or a separately reviewed Capiro interpretation.
 */
export declare const KEYWORD_PARSER_VERSION = "legiwatch-query-v1";
export declare const QUERY_LIMITS: {
    characters: number;
    tokens: number;
    depth: number;
    text: number;
};
export type KeywordAst = {
    kind: 'term';
    value: string;
    wildcard: 'none' | 'prefix' | 'suffix';
} | {
    kind: 'phrase';
    value: string;
} | {
    kind: 'not';
    child: KeywordAst;
} | {
    kind: 'and';
    children: KeywordAst[];
} | {
    kind: 'or';
    children: KeywordAst[];
};
export type QueryCompilation = {
    raw: string;
    parserVersion: string;
    status: 'supported' | 'unsupported' | 'empty';
    ast: KeywordAst | null;
    reasons: string[];
    interpretation: string | null;
};
export declare function compileKeywordQuery(raw: string): QueryCompilation;
export declare function explainKeywordAst(n: KeywordAst): string;
export type QueryEvidence = {
    start: number;
    end: number;
    quote: string;
    expression: string;
};
export type QueryEvaluation = {
    outcome: 'match' | 'no_match' | 'not_fully_evaluated';
    complete: boolean;
    evidence: QueryEvidence[];
};
/** Offsets always refer to the original UTF-16 string; normalization is per token.
 * Fixed lexical regex only: no query is executed as code, SQL or a regex.
 */
export declare function evaluateKeywordQuery(compiled: QueryCompilation, text: string | null, complete: boolean): QueryEvaluation;
export declare function evaluateKeywordDefinitions(definitions: Array<{
    id: string;
    compiled: QueryCompilation;
}>, text: string | null, complete: boolean, aggregation: 'any-v1' | 'all-v1' | 'unqualified'): {
    outcome: string;
    qualified: boolean;
    results: {
        outcome: "match" | "no_match" | "not_fully_evaluated";
        complete: boolean;
        evidence: QueryEvidence[];
        id: string;
    }[];
};
//# sourceMappingURL=legiwatch-query.d.ts.map