export interface SqlCall {
  rail: string;
  sql: string;
  args: unknown[];
  transaction: number | null;
  tenantId?: string;
}
export interface ModelCall {
  operation: string;
  args: unknown[];
  transaction: number;
  tenantId: string;
}
export interface FindingWrite {
  transaction: number;
  runId: string;
  tenantId: string;
  clientId: string;
  kind: string;
  targetKey: string;
  source: string;
  factKind: string;
  currentValue: unknown;
  proposedValue: Record<string, unknown>;
  evidence: Record<string, unknown>[];
  confidence: number;
  status: string;
  contentHash: string;
}
export interface CursorWrite {
  transaction: number;
  tenantId: string;
  clientId: string;
  source: string;
  watermark: Record<string, unknown>;
}
export interface Options {
  clientName?: string | null;
  cursor?: Record<string, unknown>;
  ldaClientIds?: number[];
  globalRows?: Record<string, unknown[]>;
  tenantRows?: Record<string, unknown[]>;
  railErrors?: Record<string, Error>;
  confirmedKeys?: Record<string, string[]>;
  facilityStates?: Array<string | null>;
  insertResults?: Array<boolean | Error>;
  terminalResults?: boolean[];
  correlationRows?: Record<string, unknown[] | Error>;
  correlationError?: Error;
  schedule?: Record<string, unknown>;
  scope?: { tenantId: string; clientId: string; runId: string };
  authorized?: boolean;
}
export interface Captures {
  global: SqlCall[];
  tenant: SqlCall[];
  models: ModelCall[];
  findings: FindingWrite[];
  cursors: CursorWrite[];
  phases: string[];
  warnings: string[];
  correlations: unknown[][];
}
export interface IoState {
  options: Options;
  captures: Captures;
  nextTransaction: number;
  nextInsert: number;
  nextTerminal: number;
  scope: { tenantId: string; clientId: string; runId: string };
}

function classify(sql: string) {
  if (sql.includes('INSERT INTO client_profile_fill_source_cursor')) return 'cursorWrite';
  if (sql.includes('FROM client_profile_fill_source_cursor')) return 'cursor';
  if (sql.includes('FROM client_profile_fill_run')) return 'run';
  if (sql.includes('FROM lda_filing')) return 'lda';
  if (sql.includes('FROM fara_registration')) return 'fara';
  if (sql.includes('FROM federal_committee_hearing')) {
    return sql.includes('synced_at') ? 'testimonyScan' : 'testimonyConfirmed';
  }
  if (
    sql.includes('FROM community_funding_request_source s') &&
    !sql.includes('FROM community_funding_request r')
  )
    return 'communityProvenance';
  if (sql.includes('GROUP BY chamber, fiscal_year')) return 'communityCoverage';
  if (sql.includes('FROM community_funding_request r'))
    return sql.includes('ANY($1::uuid[])') ? 'communityConfirmed' : 'communityScan';
  if (sql.includes('FROM client_submission_history')) return 'submissions';
  if (sql.includes("kind = 'relationship_link'")) return 'privateEvidence';
  if (sql.includes('FROM client_advocacy_matter m')) return 'federalMatters';
  if (sql.includes('MIN(activity_date)')) return 'regulatoryAttribution';
  if (sql.includes('INSERT INTO client_profile_fill_finding')) return 'insert';
  if (sql.includes('UPDATE client_profile_fill_finding')) return 'retire';
  if (sql.includes("status IN ('accepted', 'rejected')")) return 'terminal';
  if (sql.includes('FROM client_profile_fill_schedule')) return 'schedule';
  throw new Error(`Unexpected history SQL: ${sql}`);
}

function defaultRows(state: IoState, rail: string, args: unknown[]) {
  if (rail === 'terminal')
    return state.options.terminalResults?.[state.nextTerminal++] ? [{ id: 'terminal' }] : [];
  if (rail === 'run') {
    const { runId, tenantId, clientId } = state.scope;
    return args[0] === runId && args[1] === tenantId && args[2] === clientId
      ? [{ selectedLdaIds: state.options.ldaClientIds ?? [42] }]
      : [];
  }
  if (rail === 'cursor') return [{ watermark: state.options.cursor ?? {} }];
  if (rail === 'schedule') return state.options.schedule ? [state.options.schedule] : [];
  if (rail === 'regulatoryAttribution')
    return [{ earliestActivityDate: new Date('2025-01-01T00:00:00.000Z') }];
  return [];
}

function findingWrite(transaction: number, args: unknown[]): FindingWrite {
  return {
    transaction,
    runId: args[0] as string,
    tenantId: args[1] as string,
    clientId: args[2] as string,
    kind: args[3] as string,
    targetKey: args[4] as string,
    source: args[5] as string,
    factKind: args[6] as string,
    currentValue: JSON.parse(args[7] as string),
    proposedValue: JSON.parse(args[8] as string),
    evidence: JSON.parse(args[9] as string),
    confidence: args[10] as number,
    status: args[11] as string,
    contentHash: args[12] as string,
  };
}

function rawMethods(state: IoState, transaction: number | null, tenantId?: string) {
  const capture = (sql: string, args: unknown[]) => {
    const rail = classify(sql);
    const call = { rail, sql, args, transaction, tenantId };
    (transaction === null ? state.captures.global : state.captures.tenant).push(call);
    state.captures.phases.push(`${transaction ?? 'global'}:${rail}`);
    if (state.options.railErrors?.[rail]) throw state.options.railErrors[rail];
    return rail;
  };
  return {
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      const rail = capture(sql, args);
      const rows = transaction === null ? state.options.globalRows : state.options.tenantRows;
      return rows?.[rail] ?? defaultRows(state, rail, args);
    }),
    $executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      const rail = capture(sql, args);
      if (rail === 'insert') {
        state.captures.findings.push(findingWrite(transaction!, args));
        const result = state.options.insertResults?.[state.nextInsert++];
        if (result instanceof Error) throw result;
        return result === false ? 0 : 1;
      }
      if (rail === 'cursorWrite')
        state.captures.cursors.push({
          transaction: transaction!,
          tenantId: args[0] as string,
          clientId: args[1] as string,
          source: args[2] as string,
          watermark: JSON.parse(args[3] as string),
        });
      return 1;
    }),
  };
}

function modelMethods(state: IoState, transaction: number, tenantId: string) {
  const capture = (operation: string, args: unknown[]) => {
    state.captures.models.push({ operation, args, transaction, tenantId });
    state.captures.phases.push(`${transaction}:${operation}`);
    if (state.options.railErrors?.[operation]) throw state.options.railErrors[operation];
  };
  return {
    client: {
      findFirst: jest.fn(async (input: { select: { name?: boolean } }) => {
        capture(input.select.name ? 'name' : 'authorize', [input]);
        if (!input.select.name)
          return state.options.authorized === false ? null : { id: state.scope.clientId };
        return state.options.clientName === null
          ? null
          : { id: state.scope.clientId, name: state.options.clientName ?? 'Acme Research' };
      }),
    },
    clientIntelMapping: {
      findMany: jest.fn(async (input: { where: { source: string } }) => {
        capture('mapping', [input]);
        return (state.options.confirmedKeys?.[input.where.source] ?? []).map((externalId) => ({
          externalId,
        }));
      }),
    },
    clientFacility: {
      findMany: jest.fn(async (input: unknown) => {
        capture('facilities', [input]);
        return (state.options.facilityStates ?? ['VA']).map((state) => ({ state }));
      }),
    },
  };
}

export function createPrisma(state: IoState) {
  const withScope = async (tenantId: string, callback: (tx: unknown) => Promise<unknown>) => {
    const transaction = ++state.nextTransaction;
    const tx = {
      scope: transaction,
      ...rawMethods(state, transaction, tenantId),
      ...modelMethods(state, transaction, tenantId),
    };
    state.captures.phases.push(`${transaction}:begin`);
    try {
      const result = await callback(tx);
      state.captures.phases.push(`${transaction}:commit`);
      return result;
    } catch (error) {
      state.captures.phases.push(`${transaction}:rollback`);
      throw error;
    }
  };
  return {
    ...rawMethods(state, null),
    withTenant: jest.fn(withScope),
    withTenantUser: jest.fn(
      async (tenantId: string, userId: string, callback: (tx: unknown) => Promise<unknown>) => {
        state.captures.phases.push(`authorize-scope:${tenantId}:${userId}`);
        return withScope(tenantId, callback);
      },
    ),
  };
}
