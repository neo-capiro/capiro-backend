export const RESEARCH_PLAN_VERSION = 1 as const;

export const RESEARCH_PLAN_LIMITS = {
  maxSerializedChars: 40_000,
  maxSteps: 8,
  maxDependenciesPerStep: 7,
  maxCapabilitiesPerStep: 12,
  maxEvidenceDomainsPerStep: 8,
  maxClarifyingQuestions: 6,
  maxTotalToolCalls: 48,
  maxTotalTokens: 120_000,
  maxStringChars: 600,
  maxTitleChars: 120,
  maxIdChars: 64,
  maxCapabilityNameChars: 160,
} as const;

export const RESEARCH_EVIDENCE_DOMAINS = [
  'client_context',
  'institutional_memory',
  'internal_records',
  'documents',
  'legislative',
  'regulatory',
  'budget',
  'federal_market',
  'public_web',
] as const;

export type ResearchEvidenceDomain = (typeof RESEARCH_EVIDENCE_DOMAINS)[number];
export type ResearchPlanEffect = 'read' | 'approval_required';

export interface ResearchPlanScopeV1 {
  sessionId: string;
  tenantId: string;
  actorId: string;
  clientId: string | null;
  conversationId: string | null;
}

export interface ResearchPlanBudgetV1 {
  toolCalls: number;
  tokens: number;
}

export interface ResearchPlanStepV1 {
  id: string;
  objective: string;
  dependsOn: string[];
  requiredEvidenceDomains: ResearchEvidenceDomain[];
  allowedCapabilities: string[];
  effect: ResearchPlanEffect;
  completionCondition: string;
  budget: ResearchPlanBudgetV1;
}

export interface ResearchPlanV1 {
  version: typeof RESEARCH_PLAN_VERSION;
  title: string;
  scope: ResearchPlanScopeV1;
  budget: ResearchPlanBudgetV1;
  steps: ResearchPlanStepV1[];
  clarifyingQuestions: string[];
}

export interface ResearchPlanCapability {
  name: string;
  sideEffecting: boolean;
}

export interface ResearchPlanAdmissionContext {
  scope: ResearchPlanScopeV1;
  capabilities: readonly ResearchPlanCapability[];
}

export class ResearchPlanValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Research plan validation failed: ${issues.join('; ')}`);
    this.name = 'ResearchPlanValidationError';
  }
}

const STEP_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const EXACT_PLAN_KEYS = ['version', 'title', 'scope', 'budget', 'steps', 'clarifyingQuestions'];
const EXACT_SCOPE_KEYS = ['sessionId', 'tenantId', 'actorId', 'clientId', 'conversationId'];
const EXACT_BUDGET_KEYS = ['toolCalls', 'tokens'];
const EXACT_STEP_KEYS = [
  'id',
  'objective',
  'dependsOn',
  'requiredEvidenceDomains',
  'allowedCapabilities',
  'effect',
  'completionCondition',
  'budget',
];

export function validateResearchPlan(
  raw: unknown,
  context: ResearchPlanAdmissionContext,
): ResearchPlanV1 {
  const issues: string[] = [];
  const parsed = parseStrictJson(raw, issues);
  if (!isRecord(parsed)) throw new ResearchPlanValidationError(uniqueIssues(issues));
  exactKeys(parsed, EXACT_PLAN_KEYS, 'plan', issues);

  const catalog = new Map<string, ResearchPlanCapability>();
  for (const capability of context.capabilities) {
    if (!capability.name || catalog.has(capability.name)) {
      issues.push(`capability_catalog_duplicate:${capability.name || '<blank>'}`);
      continue;
    }
    catalog.set(capability.name, capability);
  }

  if (parsed.version !== RESEARCH_PLAN_VERSION) issues.push('version_must_be_1');
  const title = requiredString(parsed.title, 'title', issues, RESEARCH_PLAN_LIMITS.maxTitleChars);
  const scope = parseScope(parsed.scope, context.scope, issues);
  const budget = parseBudget(parsed.budget, 'budget', issues);
  const clarifyingQuestions = stringArray(
    parsed.clarifyingQuestions,
    'clarifyingQuestions',
    issues,
    0,
    RESEARCH_PLAN_LIMITS.maxClarifyingQuestions,
  );

  const steps: ResearchPlanStepV1[] = [];
  if (!Array.isArray(parsed.steps)) {
    issues.push('steps_must_be_array');
  } else if (parsed.steps.length < 1 || parsed.steps.length > RESEARCH_PLAN_LIMITS.maxSteps) {
    issues.push(`steps_size_1_to_${RESEARCH_PLAN_LIMITS.maxSteps}`);
  } else {
    parsed.steps.forEach((candidate, index) => {
      const path = `steps[${index}]`;
      if (!isRecord(candidate)) {
        issues.push(`${path}_must_be_object`);
        return;
      }
      exactKeys(candidate, EXACT_STEP_KEYS, path, issues);
      const id = requiredString(candidate.id, `${path}.id`, issues, RESEARCH_PLAN_LIMITS.maxIdChars);
      if (id && !STEP_ID_RE.test(id)) issues.push(`${path}.id_invalid`);
      const objective = requiredString(candidate.objective, `${path}.objective`, issues);
      const dependsOn = stringArray(
        candidate.dependsOn,
        `${path}.dependsOn`,
        issues,
        0,
        RESEARCH_PLAN_LIMITS.maxDependenciesPerStep,
        RESEARCH_PLAN_LIMITS.maxIdChars,
      );
      const domains = enumArray(
        candidate.requiredEvidenceDomains,
        `${path}.requiredEvidenceDomains`,
        RESEARCH_EVIDENCE_DOMAINS,
        issues,
        1,
        RESEARCH_PLAN_LIMITS.maxEvidenceDomainsPerStep,
      );
      const allowedCapabilities = stringArray(
        candidate.allowedCapabilities,
        `${path}.allowedCapabilities`,
        issues,
        1,
        RESEARCH_PLAN_LIMITS.maxCapabilitiesPerStep,
        RESEARCH_PLAN_LIMITS.maxCapabilityNameChars,
      );
      const effect =
        candidate.effect === 'read' || candidate.effect === 'approval_required'
          ? candidate.effect
          : (issues.push(`${path}.effect_invalid`), 'read');
      const completionCondition = requiredString(
        candidate.completionCondition,
        `${path}.completionCondition`,
        issues,
      );
      const stepBudget = parseBudget(candidate.budget, `${path}.budget`, issues);

      for (const capabilityName of allowedCapabilities) {
        const capability = catalog.get(capabilityName);
        if (!capability) {
          issues.push(`${path}.capability_unavailable:${capabilityName}`);
        } else if (capability.sideEffecting && effect !== 'approval_required') {
          issues.push(`${path}.write_capability_requires_approval:${capabilityName}`);
        }
      }
      if (
        effect === 'approval_required' &&
        allowedCapabilities.length > 0 &&
        !allowedCapabilities.some((name) => catalog.get(name)?.sideEffecting)
      ) {
        issues.push(`${path}.approval_effect_requires_write_capability`);
      }

      steps.push({
        id,
        objective,
        dependsOn,
        requiredEvidenceDomains: domains,
        allowedCapabilities,
        effect,
        completionCondition,
        budget: stepBudget,
      });
    });
  }

  validateGraph(steps, issues);
  const allocatedToolCalls = steps.reduce((sum, step) => sum + step.budget.toolCalls, 0);
  const allocatedTokens = steps.reduce((sum, step) => sum + step.budget.tokens, 0);
  if (budget.toolCalls !== allocatedToolCalls) issues.push('budget_tool_calls_must_equal_step_allocations');
  if (budget.tokens !== allocatedTokens) issues.push('budget_tokens_must_equal_step_allocations');
  if (budget.toolCalls > RESEARCH_PLAN_LIMITS.maxTotalToolCalls)
    issues.push(`budget_tool_calls_exceeds_${RESEARCH_PLAN_LIMITS.maxTotalToolCalls}`);
  if (budget.tokens > RESEARCH_PLAN_LIMITS.maxTotalTokens)
    issues.push(`budget_tokens_exceeds_${RESEARCH_PLAN_LIMITS.maxTotalTokens}`);

  if (issues.length) throw new ResearchPlanValidationError(uniqueIssues(issues));
  return {
    version: RESEARCH_PLAN_VERSION,
    title,
    scope,
    budget,
    steps,
    clarifyingQuestions,
  };
}

export function researchPlanStringProjection(plan: ResearchPlanV1): string[] {
  return plan.steps.map((step) => step.objective);
}

export function buildResearchPlanSystemPrompt(
  productName: string,
  context: ResearchPlanAdmissionContext,
): string {
  const readCapabilities = context.capabilities
    .filter((capability) => !capability.sideEffecting)
    .map((capability) => capability.name);
  const approvalCapabilities = context.capabilities
    .filter((capability) => capability.sideEffecting)
    .map((capability) => capability.name);
  return [
    `You are ${productName}, planning a bounded deep-research run.`,
    'Return ONLY one JSON object. Prose, markdown fences, omitted fields, extra fields, and fallback strings are invalid.',
    `The exact contract version is ${RESEARCH_PLAN_VERSION}. Use 1-${RESEARCH_PLAN_LIMITS.maxSteps} steps.`,
    `Bind scope exactly to: ${JSON.stringify(context.scope)}. Never infer or change an identifier.`,
    `Allowed evidence domains: ${RESEARCH_EVIDENCE_DOMAINS.join(', ')}.`,
    `Currently available read capabilities: ${readCapabilities.join(', ') || '(none)'}.`,
    `Currently available approval-gated capabilities: ${approvalCapabilities.join(', ') || '(none)'}.`,
    'A read step has effect "read" and may name only read capabilities. A business-action step has effect "approval_required", must name an approval-gated capability, and is only a proposal: research will not execute it.',
    `Total allocations must equal the sum of step allocations and must not exceed ${RESEARCH_PLAN_LIMITS.maxTotalToolCalls} tool calls or ${RESEARCH_PLAN_LIMITS.maxTotalTokens} tokens. Every allocation is a positive integer.`,
    'Step IDs must be stable lowercase kebab-case and unique. dependsOn contains only step IDs in this plan and the graph must be acyclic.',
    `String limits: title at most ${RESEARCH_PLAN_LIMITS.maxTitleChars} characters; step IDs at most ${RESEARCH_PLAN_LIMITS.maxIdChars}; objective, completionCondition, and each clarifying question at most ${RESEARCH_PLAN_LIMITS.maxStringChars}. Write each objective and completionCondition as one or two short sentences.`,
    'Required shape:',
    '{"version":1,"title":"...","scope":{"sessionId":"...","tenantId":"...","actorId":"...","clientId":null,"conversationId":null},"budget":{"toolCalls":1,"tokens":1000},"steps":[{"id":"verify-status","objective":"...","dependsOn":[],"requiredEvidenceDomains":["legislative"],"allowedCapabilities":["canonical_tool_name"],"effect":"read","completionCondition":"...","budget":{"toolCalls":1,"tokens":1000}}],"clarifyingQuestions":[]}',
    'Ask at most six clarifying questions and only for material user decisions. Put retrievable gaps in the plan instead.',
  ].join('\n');
}

export function buildResearchPlanRepairPrompt(
  baseSystemPrompt: string,
  invalidOutput: string,
  error: ResearchPlanValidationError,
): { system: string; user: string } {
  return {
    system: [
      baseSystemPrompt,
      '',
      'This is the single allowed repair attempt. Correct every listed validation error. Return only the corrected complete JSON object.',
      'An error ending in _too_long_max_N names a string that must be rewritten in N characters or fewer.',
    ].join('\n'),
    user: [
      `Validation errors: ${error.issues.join('; ')}`,
      `Invalid output: ${invalidOutput.slice(0, 12_000)}`,
    ].join('\n\n'),
  };
}

function parseStrictJson(raw: unknown, issues: string[]): unknown {
  if (typeof raw !== 'string') {
    let serialized = '';
    try {
      serialized = JSON.stringify(raw);
    } catch {
      issues.push('plan_not_json_serializable');
      return null;
    }
    if (serialized.length > RESEARCH_PLAN_LIMITS.maxSerializedChars) {
      issues.push('plan_too_large');
      return null;
    }
    return raw;
  }
  if (raw.length > RESEARCH_PLAN_LIMITS.maxSerializedChars) {
    issues.push('plan_too_large');
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    for (const key of duplicateJsonObjectKeys(raw))
      issues.push(`duplicate_object_key:${JSON.stringify(key)}`);
    return parsed;
  } catch {
    issues.push('plan_must_be_strict_json');
    return null;
  }
}

type JsonScanFrame =
  | {
      kind: 'object';
      keys: Set<string>;
      state: 'keyOrEnd' | 'colon' | 'value' | 'commaOrEnd';
    }
  | { kind: 'array'; state: 'valueOrEnd' | 'commaOrEnd' };

/**
 * JSON.parse intentionally applies last-member-wins semantics. Walk the already
 * syntax-checked source so escaped-equivalent names are compared within each
 * object without mistaking object-like text inside strings for members.
 */
function duplicateJsonObjectKeys(raw: string): string[] {
  const duplicates: string[] = [];
  const frames: JsonScanFrame[] = [];
  let index = 0;
  let rootComplete = false;

  const skipWhitespace = () => {
    while (/\s/.test(raw[index] ?? '')) index += 1;
  };
  const readString = (): string => {
    const start = index;
    index += 1;
    while (index < raw.length) {
      if (raw[index] === '\\') {
        index += 2;
      } else if (raw[index] === '"') {
        index += 1;
        return JSON.parse(raw.slice(start, index)) as string;
      } else {
        index += 1;
      }
    }
    return '';
  };
  const completeValue = () => {
    const parent = frames.at(-1);
    if (!parent) {
      rootComplete = true;
    } else {
      parent.state = 'commaOrEnd';
    }
  };
  const readValue = () => {
    const token = raw[index];
    if (token === '{') {
      index += 1;
      frames.push({ kind: 'object', keys: new Set<string>(), state: 'keyOrEnd' });
    } else if (token === '[') {
      index += 1;
      frames.push({ kind: 'array', state: 'valueOrEnd' });
    } else if (token === '"') {
      readString();
      completeValue();
    } else {
      while (index < raw.length && !/[\s,\]}]/.test(raw[index] ?? '')) index += 1;
      completeValue();
    }
  };

  while (!rootComplete) {
    skipWhitespace();
    const frame = frames.at(-1);
    if (!frame) {
      readValue();
      continue;
    }
    if (frame.kind === 'object') {
      if (frame.state === 'keyOrEnd') {
        if (raw[index] === '}') {
          index += 1;
          frames.pop();
          completeValue();
        } else {
          const key = readString();
          if (frame.keys.has(key)) duplicates.push(key);
          frame.keys.add(key);
          frame.state = 'colon';
        }
      } else if (frame.state === 'colon') {
        index += 1;
        frame.state = 'value';
      } else if (frame.state === 'value') {
        readValue();
      } else if (raw[index] === ',') {
        index += 1;
        frame.state = 'keyOrEnd';
      } else {
        index += 1;
        frames.pop();
        completeValue();
      }
    } else if (frame.state === 'valueOrEnd') {
      if (raw[index] === ']') {
        index += 1;
        frames.pop();
        completeValue();
      } else {
        readValue();
      }
    } else if (raw[index] === ',') {
      index += 1;
      frame.state = 'valueOrEnd';
    } else {
      index += 1;
      frames.pop();
      completeValue();
    }
  }
  return duplicates;
}

function parseScope(raw: unknown, expected: ResearchPlanScopeV1, issues: string[]): ResearchPlanScopeV1 {
  if (!isRecord(raw)) {
    issues.push('scope_must_be_object');
    return { ...expected };
  }
  exactKeys(raw, EXACT_SCOPE_KEYS, 'scope', issues);
  for (const key of EXACT_SCOPE_KEYS) {
    if (raw[key] !== expected[key as keyof ResearchPlanScopeV1]) issues.push(`scope_mismatch:${key}`);
  }
  return { ...expected };
}

function parseBudget(raw: unknown, path: string, issues: string[]): ResearchPlanBudgetV1 {
  if (!isRecord(raw)) {
    issues.push(`${path}_must_be_object`);
    return { toolCalls: 0, tokens: 0 };
  }
  exactKeys(raw, EXACT_BUDGET_KEYS, path, issues);
  return {
    toolCalls: positiveInteger(raw.toolCalls, `${path}.toolCalls`, issues),
    tokens: positiveInteger(raw.tokens, `${path}.tokens`, issues),
  };
}

function validateGraph(steps: ResearchPlanStepV1[], issues: string[]) {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) issues.push(`duplicate_step_id:${step.id}`);
    ids.add(step.id);
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (dependency === step.id) issues.push(`self_dependency:${step.id}`);
      else if (!ids.has(dependency)) issues.push(`unknown_dependency:${step.id}:${dependency}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cyclic = (byId.get(id)?.dependsOn ?? []).some((dependency) => byId.has(dependency) && visit(dependency));
    visiting.delete(id);
    visited.add(id);
    return cyclic;
  };
  if (steps.some((step) => visit(step.id))) issues.push('dependency_cycle');
}

function requiredString(
  raw: unknown,
  path: string,
  issues: string[],
  max: number = RESEARCH_PLAN_LIMITS.maxStringChars,
): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    issues.push(`${path}_required`);
    return '';
  }
  const value = raw.trim();
  if (value.length > max) issues.push(`${path}_too_long_max_${max}`);
  return value;
}

function stringArray(
  raw: unknown,
  path: string,
  issues: string[],
  min: number,
  max: number,
  maxString: number = RESEARCH_PLAN_LIMITS.maxStringChars,
): string[] {
  if (!Array.isArray(raw)) {
    issues.push(`${path}_must_be_array`);
    return [];
  }
  if (raw.length < min || raw.length > max) issues.push(`${path}_size_${min}_to_${max}`);
  const values = raw.map((value, index) => requiredString(value, `${path}[${index}]`, issues, maxString));
  if (new Set(values).size !== values.length) issues.push(`${path}_duplicates`);
  return values;
}

function enumArray<T extends string>(
  raw: unknown,
  path: string,
  allowed: readonly T[],
  issues: string[],
  min: number,
  max: number,
): T[] {
  const values = stringArray(raw, path, issues, min, max) as T[];
  const allowedSet = new Set<string>(allowed);
  for (const value of values) if (!allowedSet.has(value)) issues.push(`${path}_unknown:${value}`);
  return values;
}

function positiveInteger(raw: unknown, path: string, issues: string[]): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
    issues.push(`${path}_must_be_positive_integer`);
    return 0;
  }
  return raw;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  issues: string[],
) {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${path}_unknown_field:${key}`);
  for (const key of expected) if (!(key in value)) issues.push(`${path}_missing_field:${key}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniqueIssues(issues: string[]): string[] {
  return [...new Set(issues.length ? issues : ['plan_must_be_object'])];
}
