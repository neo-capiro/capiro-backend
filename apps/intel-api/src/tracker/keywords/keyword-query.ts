/** Deterministic bill-document queries. Raw imports are never normalized in storage.
 * The captured help does not establish mixed AND/OR precedence. Such imports
 * require parentheses or a separately reviewed Capiro interpretation.
 */
export const KEYWORD_PARSER_VERSION = 'legiwatch-query-v1';
export const QUERY_LIMITS = { characters: 4096, tokens: 128, depth: 16, text: 2_000_000 };
export type KeywordAst =
  | { kind: 'term'; value: string; wildcard: 'none' | 'prefix' | 'suffix' }
  | { kind: 'phrase'; value: string }
  | { kind: 'not'; child: KeywordAst }
  | { kind: 'and'; children: KeywordAst[] }
  | { kind: 'or'; children: KeywordAst[] };
export type QueryCompilation = {
  raw: string;
  parserVersion: string;
  status: 'supported' | 'unsupported' | 'empty';
  ast: KeywordAst | null;
  reasons: string[];
  interpretation: string | null;
};
type Token = { type: 'term' | 'phrase' | 'AND' | 'OR' | 'NOT' | '(' | ')'; value: string };
const fold = (s: string) => s.normalize('NFC').toLowerCase();
const lexical = /^[\p{L}\p{N}\p{M}]+(?:[.'’\-][\p{L}\p{N}\p{M}]+)*$/u;
class QueryIssue extends Error {}

export function compileKeywordQuery(raw: string): QueryCompilation {
  const base = { raw, parserVersion: KEYWORD_PARSER_VERSION };
  if (!raw.trim())
    return { ...base, status: 'empty', ast: null, reasons: ['EMPTY_QUERY'], interpretation: null };
  try {
    if (raw.length > QUERY_LIMITS.characters) throw new QueryIssue('QUERY_TOO_LONG');
    const tokens: Token[] = [];
    let i = 0;
    while (i < raw.length) {
      if (/\s/u.test(raw[i]!)) {
        i++;
        continue;
      }
      const ch = raw[i]!;
      if (ch === '(' || ch === ')') {
        tokens.push({ type: ch, value: ch });
        i++;
      } else if (ch === '"') {
        const end = raw.indexOf('"', i + 1);
        if (end < 0) throw new QueryIssue('UNCLOSED_PHRASE');
        const value = raw.slice(i + 1, end);
        if (!value.trim()) throw new QueryIssue('EMPTY_PHRASE');
        if (
          !value
            .trim()
            .split(/\s+/u)
            .every((word) => lexical.test(word))
        )
          throw new QueryIssue('UNSUPPORTED_PHRASE_PUNCTUATION');
        tokens.push({ type: 'phrase', value });
        i = end + 1;
      } else {
        const start = i;
        while (i < raw.length && !/[\s()"']/u.test(raw[i]!)) i++;
        // Apostrophes inside a lexical term are literal, never string delimiters.
        if (raw[i] === "'") {
          while (i < raw.length && !/[\s()"]/u.test(raw[i]!)) i++;
        }
        if (i === start) throw new QueryIssue('UNSUPPORTED_SYNTAX');
        const value = raw.slice(start, i),
          upper = value.toUpperCase();
        tokens.push({
          type: ['AND', 'OR', 'NOT'].includes(upper) ? (upper as Token['type']) : 'term',
          value,
        });
      }
      if (tokens.length > QUERY_LIMITS.tokens) throw new QueryIssue('QUERY_TOO_COMPLEX');
    }
    if (tokens.some((t) => t.type === 'phrase') && raw.includes('*'))
      throw new QueryIssue('PHRASE_WITH_WILDCARD_UNSUPPORTED');
    let at = 0;
    function primary(depth: number): KeywordAst {
      if (depth > QUERY_LIMITS.depth) throw new QueryIssue('QUERY_TOO_DEEP');
      const t = tokens[at++];
      if (!t) throw new QueryIssue('MISSING_OPERAND');
      if (t.type === 'NOT') return { kind: 'not', child: primary(depth + 1) };
      if (t.type === '(') {
        const ast = group(depth + 1);
        if (tokens[at++]?.type !== ')') throw new QueryIssue('UNCLOSED_GROUP');
        return ast;
      }
      if (t.type === 'phrase') return { kind: 'phrase', value: t.value };
      if (t.type !== 'term') throw new QueryIssue('MISSING_OPERAND');
      let value = t.value,
        wildcard: 'none' | 'prefix' | 'suffix' = 'none';
      if (value.startsWith('*')) {
        wildcard = 'suffix';
        value = value.slice(1);
      } else if (value.endsWith('*')) {
        wildcard = 'prefix';
        value = value.slice(0, -1);
      }
      const check = wildcard === 'prefix' && /^\d+\.$/.test(value) ? value.slice(0, -1) : value;
      if (!lexical.test(check) || value.includes('*'))
        throw new QueryIssue('UNSUPPORTED_TERM_OR_WILDCARD');
      if (wildcard !== 'none' && check.length < 2) throw new QueryIssue('WILDCARD_ROOT_TOO_SHORT');
      return { kind: 'term', value, wildcard };
    }
    function group(depth: number): KeywordAst {
      const children = [primary(depth)],
        operators: string[] = [];
      while (at < tokens.length && tokens[at]!.type !== ')') {
        const next = tokens[at]!.type;
        if (next === 'AND' || next === 'OR') {
          operators.push(next);
          at++;
        } else operators.push('AND'); // Captured implicit conjunction, including "x NOT y".
        children.push(primary(depth));
      }
      if (new Set(operators).size > 1) throw new QueryIssue('MIXED_PRECEDENCE_REQUIRES_REVIEW');
      return children.length === 1
        ? children[0]!
        : { kind: operators[0] === 'OR' ? 'or' : 'and', children };
    }
    const ast = group(0);
    if (at !== tokens.length) throw new QueryIssue('UNEXPECTED_CLOSING_GROUP');
    const positive = (n: KeywordAst, negated = false): boolean =>
      n.kind === 'not'
        ? positive(n.child, !negated)
        : n.kind === 'and' || n.kind === 'or'
          ? n.children.some((c) => positive(c, negated))
          : !negated;
    if (!positive(ast)) throw new QueryIssue('POSITIVE_SEARCH_TERM_REQUIRED');
    return {
      ...base,
      status: 'supported',
      ast,
      reasons: [],
      interpretation: explainKeywordAst(ast),
    };
  } catch (e) {
    if (!(e instanceof QueryIssue)) throw e;
    return {
      ...base,
      status: 'unsupported',
      ast: null,
      reasons: [e.message],
      interpretation: null,
    };
  }
}

export function explainKeywordAst(n: KeywordAst): string {
  if (n.kind === 'term')
    return `${n.wildcard === 'suffix' ? '*' : ''}${n.value}${n.wildcard === 'prefix' ? '*' : ''}`;
  if (n.kind === 'phrase') return JSON.stringify(n.value);
  if (n.kind === 'not') return `NOT (${explainKeywordAst(n.child)})`;
  return `(${n.children.map(explainKeywordAst).join(n.kind === 'and' ? ' AND ' : ' OR ')})`;
}

export type QueryEvidence = { start: number; end: number; quote: string; expression: string };
export type QueryEvaluation = {
  outcome: 'match' | 'no_match' | 'not_fully_evaluated';
  complete: boolean;
  evidence: QueryEvidence[];
};
/** Offsets always refer to the original UTF-16 string; normalization is per token.
 * Fixed lexical regex only: no query is executed as code, SQL or a regex.
 */
export function evaluateKeywordQuery(
  compiled: QueryCompilation,
  text: string | null,
  complete: boolean,
): QueryEvaluation {
  if (!compiled.ast || text === null || text.length > QUERY_LIMITS.text)
    return { outcome: 'not_fully_evaluated', complete: false, evidence: [] };
  const words = Array.from(
    text.matchAll(/[\p{L}\p{N}\p{M}]+(?:[.'’\-][\p{L}\p{N}\p{M}]+)*/gu),
    (m) => ({ value: fold(m[0]), start: m.index!, end: m.index! + m[0].length }),
  );
  type Result = { truth: boolean | null; evidence: QueryEvidence[] };
  function evaluate(n: KeywordAst): Result {
    if (n.kind === 'not') {
      const r = evaluate(n.child);
      return { truth: r.truth === null ? null : !r.truth, evidence: [] };
    }
    if (n.kind === 'and' || n.kind === 'or') {
      const results = n.children.map(evaluate),
        values = results.map((r) => r.truth);
      const truth =
        n.kind === 'and'
          ? values.includes(false)
            ? false
            : values.includes(null)
              ? null
              : true
          : values.includes(true)
            ? true
            : values.includes(null)
              ? null
              : false;
      return {
        truth,
        evidence:
          truth === true
            ? results
                .filter((r) => r.truth === true)
                .flatMap((r) => r.evidence)
                .slice(0, 32)
            : [],
      };
    }
    const needle = fold(n.value),
      phrase = needle.trim().split(/\s+/u);
    const index = words.findIndex((w, i) => {
      if (n.kind === 'term')
        return n.wildcard === 'prefix'
          ? w.value.startsWith(needle)
          : n.wildcard === 'suffix'
            ? w.value.endsWith(needle)
            : w.value === needle;
      return phrase.every(
        (v, k) =>
          words[i + k]?.value === v &&
          (k === 0 || /^\s+$/u.test(text!.slice(words[i + k - 1]!.end, words[i + k]!.start))),
      );
    });
    if (index < 0) return { truth: complete ? false : null, evidence: [] };
    const start = words[index]!.start,
      end = words[index + (n.kind === 'phrase' ? phrase.length - 1 : 0)]!.end;
    return {
      truth: true,
      evidence: [{ start, end, quote: text!.slice(start, end), expression: explainKeywordAst(n) }],
    };
  }
  const r = evaluate(compiled.ast);
  return {
    outcome: r.truth === true ? 'match' : r.truth === false ? 'no_match' : 'not_fully_evaluated',
    complete,
    evidence: r.evidence,
  };
}

export function evaluateKeywordDefinitions(
  definitions: Array<{ id: string; compiled: QueryCompilation }>,
  text: string | null,
  complete: boolean,
  aggregation: 'any-v1' | 'all-v1' | 'unqualified',
) {
  const results = definitions.map((d) => ({
    id: d.id,
    ...evaluateKeywordQuery(d.compiled, text, complete),
  }));
  const qualified =
    aggregation !== 'unqualified' &&
    definitions.length > 0 &&
    definitions.every((d) => d.compiled.status === 'supported');
  const outcomes = results.map((r) => r.outcome);
  const outcome = !qualified
    ? 'not_fully_evaluated'
    : aggregation === 'any-v1'
      ? outcomes.includes('match')
        ? 'match'
        : outcomes.includes('not_fully_evaluated')
          ? 'not_fully_evaluated'
          : 'no_match'
      : outcomes.includes('no_match')
        ? 'no_match'
        : outcomes.includes('not_fully_evaluated')
          ? 'not_fully_evaluated'
          : 'match';
  return { outcome, qualified, results };
}
