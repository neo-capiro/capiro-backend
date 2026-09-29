import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const QUALIFICATION_PREFIX = 'meri_memory_qualification_';
export const QUALIFICATION_SCHEMA = 'memory_qualification';

export const DDL_PROVENANCE = {
  minimalParentFixtures: ['tenants', 'users', 'clients'],
  canonicalRelations: ['client_memory_access', 'memory_items', 'context_embeddings'],
  sourceMigrations: [
    '20260501000000_init_identity_tenancy',
    '20260527021119_context_embeddings_v2',
    '20260625130000_institutional_memory',
    '20260712010000_memory_items_governance_fields',
    '20260712030000_memory_items_private_scope_rls',
    '20260713020000_memory_client_scope_ephemeral',
    '20260713030000_memory_items_expiry_rls',
    '20260719220000_client_memory_walls',
    '20260719221000_memory_wall_rls',
    '20260729010000_memory_governance_context_v2',
  ],
} as const;

type LocalCredentials = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

type QualificationEnvironment = Partial<
  Record<
    | 'MEMORY_POSTGRES_ADMIN_URL'
    | 'MEMORY_POSTGRES_CREDENTIALS_FILE'
    | 'MEMORY_POSTGRES_DB_FREE'
    | 'MEMORY_POSTGRES_OWNED_ENDPOINT_ACK'
    | 'MEMORY_POSTGRES_REQUIRE_VECTOR',
    string | undefined
  >
>;

export type QualificationDatabase = {
  admin: PrismaClient;
  appUrl: string;
  databaseName: string;
  appRole: string;
  ownerRole: string;
  vectorAvailable: boolean;
  dispose(): Promise<void>;
};

export function qualificationAdminUrl(
  environment: QualificationEnvironment = process.env,
): string | null {
  const requireVector = environment.MEMORY_POSTGRES_REQUIRE_VECTOR === '1';
  if (environment.MEMORY_POSTGRES_DB_FREE === '1') {
    if (requireVector) {
      throw new Error('MEMORY_POSTGRES_REQUIRE_VECTOR conflicts with MEMORY_POSTGRES_DB_FREE');
    }
    return null;
  }

  const endpointAck = environment.MEMORY_POSTGRES_OWNED_ENDPOINT_ACK?.trim();
  const explicit = environment.MEMORY_POSTGRES_ADMIN_URL?.trim();
  if (explicit) return assertDisposableLocalUrl(explicit, endpointAck).toString();

  const credentialsPath = environment.MEMORY_POSTGRES_CREDENTIALS_FILE?.trim();
  if (!credentialsPath) {
    if (requireVector) {
      throw new Error(
        'MEMORY_POSTGRES_REQUIRE_VECTOR requires MEMORY_POSTGRES_ADMIN_URL or MEMORY_POSTGRES_CREDENTIALS_FILE',
      );
    }
    return null;
  }
  if (!existsSync(credentialsPath)) {
    throw new Error('MEMORY_POSTGRES_CREDENTIALS_FILE does not exist');
  }
  const parsed = JSON.parse(readFileSync(credentialsPath, 'utf8')) as Partial<LocalCredentials>;
  if (
    typeof parsed.host !== 'string' ||
    parsed.host.trim() === '' ||
    typeof parsed.port !== 'number' ||
    !Number.isInteger(parsed.port) ||
    parsed.port < 1 ||
    parsed.port > 65_535 ||
    typeof parsed.user !== 'string' ||
    parsed.user.trim() === '' ||
    typeof parsed.password !== 'string' ||
    parsed.password === '' ||
    typeof parsed.database !== 'string' ||
    parsed.database.trim() === ''
  ) {
    throw new Error('MEMORY_POSTGRES_CREDENTIALS_FILE has an unsupported shape');
  }
  const url = new URL('postgresql://localhost');
  url.hostname = parsed.host;
  url.port = String(parsed.port);
  url.username = parsed.user;
  url.password = parsed.password;
  url.pathname = `/${parsed.database}`;
  return assertDisposableLocalUrl(url.toString(), endpointAck).toString();
}

export function assertDisposableLocalUrl(raw: string, endpointAck?: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('memory PostgreSQL qualification requires a valid postgres URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('memory PostgreSQL qualification requires a postgres URL');
  }
  if (url.hostname !== '127.0.0.1') {
    throw new Error('memory PostgreSQL qualification requires the IPv4 loopback host 127.0.0.1');
  }
  const authority = /^(?:postgres|postgresql):\/\/([^/?#]+)/i.exec(raw.trim())?.[1];
  const hostPort = authority?.slice(authority.lastIndexOf('@') + 1);
  const port = /^127\.0\.0\.1:(\d+)$/.exec(hostPort ?? '')?.[1];
  if (!port || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error('memory PostgreSQL qualification requires an explicit loopback port');
  }
  if (!url.username || !url.password) {
    throw new Error('memory PostgreSQL qualification requires explicit database credentials');
  }
  if (endpointAck !== `127.0.0.1:${port}`) {
    throw new Error(
      'MEMORY_POSTGRES_OWNED_ENDPOINT_ACK must match the explicitly owned qualification endpoint',
    );
  }
  if (!url.pathname || url.pathname === '/') {
    throw new Error('memory PostgreSQL qualification requires a maintenance database name');
  }
  url.searchParams.delete('schema');
  return url;
}

export async function createQualificationDatabase(
  adminUrl: string,
  requireVector: boolean,
  endpointAck = process.env.MEMORY_POSTGRES_OWNED_ENDPOINT_ACK?.trim(),
): Promise<QualificationDatabase> {
  const maintenanceUrl = assertDisposableLocalUrl(adminUrl, endpointAck);
  const suffix = randomBytes(6).toString('hex');
  const databaseName = `${QUALIFICATION_PREFIX}${suffix}`;
  const ownerRole = `${QUALIFICATION_PREFIX}owner_${suffix}`;
  const appRole = `${QUALIFICATION_PREFIX}app_${suffix}`;
  const appPassword = randomBytes(24).toString('hex');
  const maintenance = new PrismaClient({ datasources: { db: { url: maintenanceUrl.toString() } } });
  let databaseCreated = false;
  let admin: PrismaClient | undefined;

  const cleanup = async (): Promise<void> => {
    await admin?.$disconnect().catch(() => undefined);
    await maintenance.$connect().catch(() => undefined);
    if (databaseCreated) {
      await maintenance
        .$executeRawUnsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid()`,
        )
        .catch(() => undefined);
      await maintenance
        .$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}"`)
        .catch(() => undefined);
    }
    await maintenance.$executeRawUnsafe(`DROP ROLE IF EXISTS "${appRole}"`).catch(() => undefined);
    await maintenance
      .$executeRawUnsafe(`DROP ROLE IF EXISTS "${ownerRole}"`)
      .catch(() => undefined);
  };

  try {
    await maintenance.$connect();
    const capability = await maintenance.$queryRawUnsafe<
      Array<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>
    >('SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user');
    if (
      capability[0]?.rolsuper !== true &&
      !(capability[0]?.rolcreatedb === true && capability[0]?.rolcreaterole === true)
    ) {
      throw new Error(
        'qualification administrator must be local superuser or hold CREATEDB and CREATEROLE',
      );
    }

    await maintenance.$executeRawUnsafe(
      `CREATE ROLE "${ownerRole}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await maintenance.$executeRawUnsafe(
      `CREATE ROLE "${appRole}" LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await maintenance.$executeRawUnsafe(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
    databaseCreated = true;

    const databaseAdminUrl = new URL(maintenanceUrl);
    databaseAdminUrl.pathname = `/${databaseName}`;
    databaseAdminUrl.searchParams.set('schema', QUALIFICATION_SCHEMA);
    admin = new PrismaClient({ datasources: { db: { url: databaseAdminUrl.toString() } } });
    await admin.$connect();
    await admin.$executeRawUnsafe(
      `CREATE SCHEMA "${QUALIFICATION_SCHEMA}" AUTHORIZATION "${ownerRole}"`,
    );
    await admin.$executeRawUnsafe(
      `CREATE EXTENSION "uuid-ossp" WITH SCHEMA "${QUALIFICATION_SCHEMA}"`,
    );

    const extensions = await admin.$queryRawUnsafe<Array<{ available: boolean }>>(
      "SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS available",
    );
    const vectorAvailable = extensions[0]?.available === true;
    if (requireVector && !vectorAvailable) {
      throw new Error('required pgvector extension is unavailable');
    }
    if (vectorAvailable) {
      await admin.$executeRawUnsafe(
        `CREATE EXTENSION vector WITH SCHEMA "${QUALIFICATION_SCHEMA}"`,
      );
    }

    await installQualificationDdl(admin, ownerRole, appRole, vectorAvailable);

    const appUrl = new URL(databaseAdminUrl);
    appUrl.username = appRole;
    appUrl.password = appPassword;
    appUrl.searchParams.set('schema', QUALIFICATION_SCHEMA);

    await maintenance.$executeRawUnsafe(
      `GRANT CONNECT ON DATABASE "${databaseName}" TO "${appRole}"`,
    );

    let disposed = false;
    return {
      admin,
      appUrl: appUrl.toString(),
      databaseName,
      appRole,
      ownerRole,
      vectorAvailable,
      async dispose() {
        if (disposed) return;
        disposed = true;
        await cleanup();
        await maintenance.$disconnect().catch(() => undefined);
      },
    };
  } catch (error) {
    await cleanup();
    await maintenance.$disconnect().catch(() => undefined);
    throw error;
  }
}

async function installQualificationDdl(
  admin: PrismaClient,
  ownerRole: string,
  appRole: string,
  vectorAvailable: boolean,
): Promise<void> {
  await admin.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE "${ownerRole}"`);
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${QUALIFICATION_SCHEMA}"`);
    for (const statement of splitSqlStatements(BASE_DDL)) {
      await tx.$executeRawUnsafe(statement);
    }
    if (vectorAvailable) {
      for (const statement of splitSqlStatements(VECTOR_DDL)) {
        await tx.$executeRawUnsafe(statement);
      }
    }
  });

  const relations = ['tenants', 'users', 'clients', 'client_memory_access', 'memory_items'];
  if (vectorAvailable) relations.push('context_embeddings');
  await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${QUALIFICATION_SCHEMA}" TO "${appRole}"`);
  await admin.$executeRawUnsafe(
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "${QUALIFICATION_SCHEMA}" TO "${appRole}"`,
  );
  await admin.$executeRawUnsafe(
    `GRANT SELECT ON ${relations.map((relation) => `"${QUALIFICATION_SCHEMA}"."${relation}"`).join(', ')} TO "${appRole}"`,
  );
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let dollarTag: string | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    const character = sql[index];
    const next = sql[index + 1];
    if (singleQuoted) {
      if (character === "'" && next === "'") index += 1;
      else if (character === "'") singleQuoted = false;
      continue;
    }
    if (doubleQuoted) {
      if (character === '"' && next === '"') index += 1;
      else if (character === '"') doubleQuoted = false;
      continue;
    }
    if (character === "'") {
      singleQuoted = true;
      continue;
    }
    if (character === '"') {
      doubleQuoted = true;
      continue;
    }
    if (character === '$') {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index));
      if (match) {
        dollarTag = match[0];
        index += dollarTag.length - 1;
        continue;
      }
    }
    if (character === ';') {
      const statement = sql.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }
  const remainder = sql.slice(start).trim();
  if (remainder) statements.push(remainder);
  return statements;
}

const BASE_DDL = `
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
DECLARE
  v_raw TEXT := current_setting('app.current_tenant', true);
BEGIN
  IF v_raw IS NULL OR v_raw = '' THEN RETURN NULL; END IF;
  RETURN v_raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION current_user_id() RETURNS UUID AS $$
DECLARE
  v_raw TEXT := current_setting('app.current_user', true);
BEGIN
  IF v_raw IS NULL OR v_raw = '' THEN RETURN NULL; END IF;
  RETURN v_raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION rls_bypass() RETURNS BOOLEAN AS $$
BEGIN
  RETURN current_setting('app.bypass_rls', true) = 'on';
END;
$$ LANGUAGE plpgsql STABLE;

-- Minimal parent fixtures only. These are not represented as a full migration replay.
CREATE TABLE tenants (id uuid PRIMARY KEY);
CREATE TABLE users (id uuid PRIMARY KEY);
CREATE TABLE clients (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  memory_wall boolean NOT NULL DEFAULT false
);

CREATE TABLE client_memory_access (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  user_id uuid NOT NULL,
  granted_by uuid,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT client_memory_access_pkey PRIMARY KEY (id),
  CONSTRAINT client_memory_access_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT client_memory_access_client_fk FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT client_memory_access_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX client_memory_access_uniq ON client_memory_access (tenant_id, client_id, user_id);
CREATE INDEX client_memory_access_user_idx ON client_memory_access (tenant_id, user_id);

CREATE TABLE memory_items (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  client_id uuid,
  owner_user_id uuid,
  type varchar(32) NOT NULL,
  visibility varchar(16) NOT NULL DEFAULT 'tenant',
  entity_id uuid,
  slug text NOT NULL,
  title text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  source varchar(24) NOT NULL,
  source_ref text,
  provenance varchar(32) NOT NULL DEFAULT 'human',
  sections_jsonb jsonb NOT NULL DEFAULT '[]',
  schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  status varchar(16) NOT NULL DEFAULT 'active',
  last_confirmed_at timestamptz(6),
  review_cadence_days integer,
  supersedes_id uuid,
  contradicts_id uuid,
  sensitivity varchar(16) NOT NULL DEFAULT 'normal',
  retention_policy_jsonb jsonb,
  legal_hold boolean NOT NULL DEFAULT false,
  revoked_at timestamptz(6),
  revoked_by uuid,
  exportable boolean NOT NULL DEFAULT true,
  training_use varchar(16) NOT NULL DEFAULT 'excluded',
  confidence double precision,
  ingest_run_id uuid,
  ingested_at timestamptz(6),
  review_state varchar(16) NOT NULL DEFAULT 'auto',
  expires_at timestamptz(6),
  memory_class varchar(40) NOT NULL DEFAULT 'legacy_unclassified',
  memory_authority varchar(40) NOT NULL DEFAULT 'legacy_unclassified',
  memory_scope varchar(24) NOT NULL DEFAULT 'firm',
  governed_status varchar(24) NOT NULL DEFAULT 'pending_review',
  source_type varchar(40) NOT NULL DEFAULT 'unknown',
  source_id text,
  source_excerpt text,
  source_content_hash varchar(96),
  source_version varchar(160),
  asserted_by_user_id uuid,
  approved_by_user_id uuid,
  approved_at timestamptz,
  second_approved_by_user_id uuid,
  second_approved_at timestamptz,
  as_of timestamptz,
  effective_from timestamptz,
  valid_until timestamptz,
  review_due_at timestamptz,
  conflict_status varchar(24) NOT NULL DEFAULT 'none',
  conflict_group_id uuid,
  controlling_item_id uuid,
  origin_surface varchar(48),
  origin_trace_id varchar(160),
  origin_context_packet_id uuid,
  origin_model varchar(160),
  origin_prompt_version varchar(80),
  instructions_allowed boolean NOT NULL DEFAULT false,
  CONSTRAINT memory_items_pkey PRIMARY KEY (id),
  CONSTRAINT memory_items_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT memory_items_owner_visibility_chk CHECK (
    (visibility = 'user' AND owner_user_id IS NOT NULL) OR
    (visibility = 'tenant' AND owner_user_id IS NULL)
  ),
  CONSTRAINT memory_items_visibility_chk CHECK (visibility IN ('tenant', 'user')),
  CONSTRAINT memory_items_memory_class_check CHECK (memory_class IN (
    'institutional_authoritative','client_steering','user_preference','episodic_working','legacy_unclassified'
  )),
  CONSTRAINT memory_items_authority_check CHECK (memory_authority IN (
    'firm_approved','client_approved','external_authoritative','user_asserted',
    'analyst_verified','working_draft','model_inferred','legacy_unclassified'
  )),
  CONSTRAINT memory_items_scope_check CHECK (memory_scope IN ('firm','client','user_private')),
  CONSTRAINT memory_items_governed_status_check CHECK (governed_status IN (
    'suggested','pending_review','active','stale','conflicted','superseded','revoked','rejected','expired'
  )),
  CONSTRAINT memory_items_conflict_status_check CHECK (conflict_status IN ('none','open','resolved','controlling')),
  CONSTRAINT memory_items_source_excerpt_cap_check CHECK (source_excerpt IS NULL OR octet_length(source_excerpt) <= 8000),
  CONSTRAINT memory_items_confidence_range_check CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT memory_items_ephemeral_ttl_check CHECK (
    memory_class <> 'episodic_working' OR expires_at IS NOT NULL OR valid_until IS NOT NULL
  ),
  CONSTRAINT memory_items_instruction_authority_check CHECK (
    instructions_allowed = false OR (
      memory_class = 'institutional_authoritative' AND memory_authority = 'firm_approved'
      AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL
    )
  )
);
CREATE UNIQUE INDEX memory_items_tenant_type_slug_unique ON memory_items (tenant_id, type, slug);
CREATE INDEX memory_items_tenant_client_idx ON memory_items (tenant_id, client_id);
CREATE INDEX memory_items_tenant_visibility_owner_idx ON memory_items (tenant_id, visibility, owner_user_id);
CREATE INDEX memory_items_tenant_type_idx ON memory_items (tenant_id, type);
CREATE INDEX memory_items_entity_idx ON memory_items (entity_id);
CREATE INDEX memory_items_tenant_status_idx ON memory_items (tenant_id, status);
CREATE INDEX memory_items_governed_recall_idx
  ON memory_items (tenant_id, governed_status, memory_class, memory_scope, client_id);

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
CREATE POLICY clients_isolation ON clients
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE client_memory_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_memory_access FORCE ROW LEVEL SECURITY;
CREATE POLICY client_memory_access_isolation ON client_memory_access
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE memory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_items FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_items_isolation ON memory_items
  USING (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND (visibility = 'tenant' OR owner_user_id = current_user_id())
      AND (expires_at IS NULL OR expires_at > now())
      AND (
        client_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM clients c
          WHERE c.id = memory_items.client_id
            AND c.tenant_id = memory_items.tenant_id
            AND c.memory_wall
        )
        OR EXISTS (
          SELECT 1 FROM client_memory_access a
          WHERE a.tenant_id = memory_items.tenant_id
            AND a.client_id = memory_items.client_id
            AND a.user_id = current_user_id()
        )
      )
    )
  )
  WITH CHECK (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND (visibility = 'tenant' OR owner_user_id = current_user_id())
    )
  );
`;

const VECTOR_DDL = `
CREATE TABLE context_embeddings (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  tenant_id uuid NULL,
  client_id uuid NULL,
  owner_user_id uuid NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  model text NOT NULL,
  content_text text NOT NULL,
  content_hash text NOT NULL,
  embedding vector(1024) NOT NULL,
  metadata_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT context_embeddings_pkey PRIMARY KEY (id),
  CONSTRAINT context_embeddings_tenant_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT context_embeddings_client_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
  CONSTRAINT context_embeddings_unique UNIQUE NULLS NOT DISTINCT (tenant_id, source_type, source_id, model)
);
CREATE INDEX context_embeddings_tenant_client_idx ON context_embeddings (tenant_id, client_id);
CREATE INDEX context_embeddings_source_idx ON context_embeddings (source_type, source_id);
CREATE INDEX context_embeddings_embedding_hnsw
  ON context_embeddings USING hnsw (embedding vector_cosine_ops);
ALTER TABLE context_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY context_embeddings_isolation ON context_embeddings
  USING (
    rls_bypass() OR tenant_id IS NULL OR (
      tenant_id = current_tenant_id()
      AND (owner_user_id IS NULL OR owner_user_id = current_user_id())
      AND (
        client_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM clients c
          WHERE c.id = context_embeddings.client_id
            AND c.tenant_id = context_embeddings.tenant_id
            AND c.memory_wall
        )
        OR EXISTS (
          SELECT 1 FROM client_memory_access a
          WHERE a.tenant_id = context_embeddings.tenant_id
            AND a.client_id = context_embeddings.client_id
            AND a.user_id = current_user_id()
        )
      )
    )
  )
  WITH CHECK (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND (owner_user_id IS NULL OR owner_user_id = current_user_id())
    )
  );
`;
