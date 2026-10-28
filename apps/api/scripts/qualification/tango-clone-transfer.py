"""Bounded public funding transfer; --help describes guards and exit codes.

Uses PostgreSQL COPY and temporary tables, not a dump/restore or a migration ledger.
Importing this module never connects, reads credentials, or starts a subprocess.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


TABLES = (
    "federal_grant", "sam_opportunity", "tango_opportunity_notice",
    "opportunity_attachment", "opportunity_document_text",
    "tango_resource_snapshot", "tango_resource_link", "context_embeddings",
)
PUBLIC_VECTORS = "tenant_id IS NULL AND client_id IS NULL AND owner_user_id IS NULL AND source_type IN ('funding_grant_chunk','funding_notice_chunk','funding_attachment_chunk')"
SCOPES = {
    "sam_opportunity": "raw_jsonb->'fixture' IS DISTINCT FROM 'true'::jsonb",
    "tango_resource_snapshot": "resource_type IN ('grant','notice','opportunity')",
    "tango_resource_link": "local_resource_type IN ('federal_grant','sam_opportunity') AND tango_resource_type IN ('grant','notice','opportunity') AND basis='exact_identifier' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_notes IS NULL",
    "context_embeddings": PUBLIC_VECTORS,
}
LOCKS = ("capiro:tango-funding", "capiro:funding-archive", "capiro:funding-embeddings")
HOSTS = {
    "source": "capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv.cluster-csryw28ai752.us-east-1.rds.amazonaws.com",
    "target": "capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com",
}
PROTECTED = ("clients", "client_funding_opportunity", "sam_opportunity_match", "opportunity_bookmarks", "client_grant_nexus", "opportunity_requirement", "opportunity_requirement_review", "funding_opportunity_stage_transition")
KINDS = {"grant": "federal_grant", "notice": "sam_opportunity", "attachment": "opportunity_attachment"}
IMMUTABLE = {"id", "created_at", "first_seen_at", "first_synced_at", "notice_id"}
ARCHIVE = {"status", "content_sha256", "archive_bucket", "archive_key", "archive_version_id", "observed_mime_type", "observed_size_bytes", "archived_at", "last_attempt_at", "failure_reason", "failure_detail"}
# Fixed keyset batch bound for the embedding publication only. The public embedding candidate is the
# largest set in the transfer and each row carries a vector, so one unbounded statement can outlive the
# release window. Walking it by id (the candidate's own unique index) in fixed batches bounds the
# duration of any single statement; it is a statement-duration bound, not a throughput claim.
VECTOR_BATCH = 20000
VECTOR_PHASE = "vector_publication"
VECTOR_FAILURE = "vector_publication_statement_failed"


class Refusal(Exception):
    """A fixed, nonsecret diagnostic suitable for the public receipt."""


def require(condition, code):
    if not condition:
        raise Refusal(code)


def ident(value):
    require(bool(re.fullmatch(r"[a-z_][a-z0-9_]*", value)), "invalid_sql_identifier")
    return '"' + value + '"'


def scalar(conn, sql, params=None):
    return conn.execute(sql, params).fetchone()[0]


def check_zero(conn, sql, code):
    require(scalar(conn, sql) == 0, code)


def guard_config(config, synthetic=False):
    """Validate all inputs before allocating a database connection."""
    require(set(config) == {"source", "target"}, "config_keys")
    for role in ("source", "target"):
        item = config[role]
        require(set(item) == {"host", "port", "dbname", "user", "password_env", "sslrootcert"}, "connection_keys")
        require(isinstance(item["host"], str) and "," not in item["host"], "single_exact_host_required")
        require(item["port"] == 5432 or (synthetic and isinstance(item["port"], int)), "port_guard")
        require(re.fullmatch(r"TANGO_TRANSFER_[A-Z_]+", item["password_env"]) is not None, "password_env_guard")
        require(bool(os.environ.get(item["password_env"])), "missing_password_environment")
        if synthetic:
            require(item["host"] in ("127.0.0.1", "localhost", "::1"), "synthetic_host_guard")
            require(item["dbname"] == "tango_transfer_" + role + "_test", "synthetic_database_guard")
        else:
            require(item["host"] == HOSTS[role], "exact_environment_host_guard")
            require(item["dbname"] == "capiro", "database_guard")
            require(Path(item["sslrootcert"]).is_file(), "missing_rds_ca")
    require((config["source"]["host"], config["source"]["port"], config["source"]["dbname"]) != (config["target"]["host"], config["target"]["port"], config["target"]["dbname"]), "same_database_guard")


def connect(psycopg, item, synthetic):
    connection = psycopg.connect(host=item["host"], port=item["port"], dbname=item["dbname"], user=item["user"],
        password=os.environ[item["password_env"]], sslmode="disable" if synthetic else "verify-full",
        **({} if synthetic else {"sslrootcert": item["sslrootcert"]}), connect_timeout=10,
        application_name="tango-public-clone-transfer", autocommit=True)
    require(connection.info.host == item["host"] and connection.info.dbname == item["dbname"], "connected_endpoint_mismatch")
    return connection


def columns(conn, table):
    return conn.execute("SELECT a.attname,format_type(a.atttypid,a.atttypmod) FROM pg_attribute a WHERE a.attrelid=%s::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", ("public." + table,)).fetchall()


def checksum(conn, query):
    digest = hashlib.sha256()
    with conn.cursor().copy("COPY (" + query + ") TO STDOUT") as stream:
        for block in stream:
            digest.update(block)
    return digest.hexdigest()


def stage(source, target, table):
    cols = columns(source, table)
    require(cols == columns(target, table), "schema_column_type_mismatch")
    names = ",".join(ident(name) for name, _ in cols)
    scope = SCOPES.get(table, "true")
    query = f"SELECT {names} FROM public.{ident(table)} WHERE {scope} ORDER BY id"
    target.execute(f"CREATE TEMP TABLE s_{table} AS SELECT * FROM public.{ident(table)} WITH NO DATA")
    digest = hashlib.sha256()
    # COPY streams protocol blocks; no catalog, vector set or PDF is accumulated in Python.
    with source.cursor().copy("COPY (" + query + ") TO STDOUT") as reader:
        with target.cursor().copy(f"COPY s_{table} ({names}) FROM STDIN") as writer:
            for block in reader:
                digest.update(block)
                writer.write(block)
    require(digest.hexdigest() == checksum(target, f"SELECT {names} FROM s_{table} ORDER BY id"), "copy_checksum_mismatch")
    target.execute(f"CREATE UNIQUE INDEX ON s_{table}(id)")
    target_scope = scope
    if table == "sam_opportunity":
        target_scope = "true"  # Preserve every existing target fixture and its references.
    elif table == "tango_resource_link":
        target_scope = "local_resource_type IN ('federal_grant','sam_opportunity') AND tango_resource_type IN ('grant','notice','opportunity')"
    target.execute(f"CREATE TEMP TABLE w_{table} AS SELECT * FROM public.{ident(table)} WHERE {target_scope}")
    target.execute(f"CREATE UNIQUE INDEX ON w_{table}(id)")
    target.execute(f"ANALYZE s_{table}")
    return cols, {"source_rows": scalar(target, f"SELECT count(*) FROM s_{table}"), "transport_sha256": digest.hexdigest()}


def natural_map(conn, table, predicate):
    conn.execute(f"CREATE TEMP TABLE m_{table} AS SELECT s.id AS old_id,coalesce(t.id,s.id) AS new_id,t.id IS NOT NULL AS matched FROM s_{table} s LEFT JOIN w_{table} t ON {predicate}")
    check_zero(conn, f"SELECT count(*) FROM (SELECT old_id FROM m_{table} GROUP BY old_id HAVING count(*)<>1 UNION ALL SELECT new_id FROM m_{table} GROUP BY new_id HAVING count(*)<>1) q", "ambiguous_natural_identity")
    check_zero(conn, f"SELECT count(*) FROM m_{table} m JOIN public.{table} t ON t.id=m.new_id LEFT JOIN w_{table} w ON w.id=t.id WHERE w.id IS NULL", "id_collision_outside_allowlist")
    check_zero(conn, f"SELECT count(*) FROM m_{table} m JOIN w_{table} t ON t.id=m.old_id WHERE m.old_id<>m.new_id", "cross_identity_primary_key_collision")
    check_zero(conn, f"SELECT count(*) FROM m_{table} m JOIN public.{table} t ON t.id=m.new_id WHERE NOT m.matched", "unmatched_primary_key_collision")
    conn.execute(f"CREATE UNIQUE INDEX ON m_{table}(old_id)")
    conn.execute(f"CREATE UNIQUE INDEX ON m_{table}(new_id)")


def normalized_url(expression):
    pattern = r"^https://sam[.]gov/api/prod/opps/v3/opportunities/resources/files/[a-fA-F0-9]{32}/download(\?&token=)?$"
    return f"CASE WHEN {expression} ~ '{pattern}' THEN regexp_replace({expression},'\\?&token=$','') ELSE {expression} END"


def remapped_view(conn, table, cols, replacements=None):
    replacements = dict(replacements or {}, id="m.new_id")
    selections = ",".join(f"{replacements.get(name, 's.' + ident(name))} AS {ident(name)}" for name, _ in cols)
    # crosswalk_matched carries the natural-map decision into the candidate INSERT: a candidate
    # that is still being appended to must never be re-scanned to answer a question the map
    # already answered (see merge_table).
    conn.execute(f"CREATE TEMP VIEW r_{table} AS SELECT {selections},m.matched AS crosswalk_matched FROM s_{table} s JOIN m_{table} m ON m.old_id=s.id")


def sam_ref(expression):
    return f"(SELECT new_id FROM m_sam_opportunity WHERE old_id={expression})"


def prepare_maps(conn, schemas):
    check_zero(conn,"SELECT count(*) FROM s_federal_grant WHERE id !~ '^[0-9]+$'","unverified_government_grant_identity")
    for prefix in ("s", "w"):
        check_zero(conn, f"SELECT count(*) FROM {prefix}_sam_opportunity WHERE ({SCOPES['sam_opportunity']}) AND lower(replace(notice_id,'-','')) !~ '^[0-9a-f]{{32}}$'", "unverified_government_notice_identity")
        check_zero(conn, f"SELECT count(*) FROM (SELECT lower(replace(notice_id,'-','')) FROM {prefix}_sam_opportunity WHERE {SCOPES['sam_opportunity']} GROUP BY 1 HAVING count(*)>1) q", "duplicate_government_notice_identity")
    # Natural-key indexes are essential: this is hundreds of thousands of catalog rows,
    # not per-row network queries or nested full-table scans.
    for ddl in (
        "CREATE INDEX ON w_sam_opportunity((lower(replace(notice_id,'-',''))))",
        "CREATE INDEX ON w_tango_opportunity_notice(tango_notice_id)",
        "CREATE INDEX ON w_opportunity_attachment(sam_opportunity_id,provider_attachment_id)",
        "CREATE INDEX ON w_opportunity_document_text(attachment_id,(coalesce(extraction_method,'')))",
        "CREATE INDEX ON w_tango_resource_snapshot(resource_type,external_id,content_sha256)",
        "CREATE INDEX ON w_tango_resource_link(local_resource_type,local_resource_id,tango_resource_type,tango_external_id)",
    ):
        conn.execute(ddl)
    conn.execute(f"CREATE INDEX ON w_opportunity_attachment((coalesce(sam_opportunity_id::text,'')),(coalesce(federal_grant_id,'')),(coalesce(tango_notice_id,'')),({normalized_url('source_url')}))")
    for table in TABLES[:-1]:
        conn.execute(f"ANALYZE w_{table}")
    natural_map(conn, "federal_grant", "s.id=t.id")
    natural_map(conn, "sam_opportunity", "t.raw_jsonb->'fixture' IS DISTINCT FROM 'true'::jsonb AND lower(replace(s.notice_id,'-',''))=lower(replace(t.notice_id,'-',''))")
    # Crosswalk local_resource_id is text; its correlated lookup must use the
    # same expression as this index rather than scan the UUID map per link.
    conn.execute("CREATE INDEX ON m_sam_opportunity((old_id::text))")
    natural_map(conn, "tango_opportunity_notice", "s.tango_notice_id=t.tango_notice_id")
    for table in ("tango_opportunity_notice", "opportunity_attachment"):
        check_zero(conn, f"SELECT count(*) FROM s_{table} s LEFT JOIN m_sam_opportunity m ON m.old_id=s.sam_opportunity_id WHERE s.sam_opportunity_id IS NOT NULL AND m.old_id IS NULL", "orphan_source_notice_reference")
    mapped_sam = sam_ref("s.sam_opportunity_id")
    parent = f"coalesce(t.sam_opportunity_id::text,'')=coalesce(({mapped_sam})::text,'') AND coalesce(t.federal_grant_id,'')=coalesce(s.federal_grant_id,'')"
    url = f"({parent} AND coalesce(t.tango_notice_id,'')=coalesce(s.tango_notice_id,'') AND {normalized_url('t.source_url')}={normalized_url('s.source_url')})"
    provider = f"(t.sam_opportunity_id={mapped_sam} AND coalesce(t.federal_grant_id,'')=coalesce(s.federal_grant_id,'') AND s.provider_attachment_id IS NOT NULL AND t.provider_attachment_id=s.provider_attachment_id)"
    natural_map(conn, "opportunity_attachment", f"{url} OR {provider}")
    natural_map(conn, "opportunity_document_text", "t.attachment_id=(SELECT new_id FROM m_opportunity_attachment WHERE old_id=s.attachment_id) AND coalesce(t.extraction_method,'')=coalesce(s.extraction_method,'')")
    natural_map(conn, "tango_resource_snapshot", "s.resource_type=t.resource_type AND s.external_id=t.external_id AND s.content_sha256=t.content_sha256")
    link_id = "CASE WHEN s.local_resource_type='sam_opportunity' THEN (SELECT new_id::text FROM m_sam_opportunity WHERE old_id::text=s.local_resource_id) ELSE s.local_resource_id END"
    natural_map(conn, "tango_resource_link", f"s.local_resource_type=t.local_resource_type AND t.local_resource_id=({link_id}) AND s.tango_resource_type=t.tango_resource_type AND s.tango_external_id=t.tango_external_id")
    for table in TABLES[:-1]:
        replacement = {}
        if table in ("tango_opportunity_notice", "opportunity_attachment"):
            replacement["sam_opportunity_id"] = mapped_sam
        if table == "opportunity_document_text":
            replacement["attachment_id"] = "(SELECT new_id FROM m_opportunity_attachment WHERE old_id=s.attachment_id)"
        if table == "tango_resource_link":
            replacement["local_resource_id"] = link_id
        remapped_view(conn, table, schemas[table], replacement)
    check_zero(conn, "SELECT count(*) FROM r_opportunity_document_text WHERE attachment_id IS NULL", "orphan_document_text")
    check_zero(conn, "SELECT count(*) FROM r_tango_resource_link WHERE local_resource_id IS NULL", "orphan_resource_link")
    check_zero(conn, "SELECT count(*) FROM (SELECT sam_opportunity_id,provider_attachment_id FROM r_opportunity_attachment WHERE sam_opportunity_id IS NOT NULL AND provider_attachment_id IS NOT NULL GROUP BY 1,2 HAVING count(*)>1) q", "duplicate_provider_attachment")
    check_zero(conn, f"SELECT count(*) FROM (SELECT sam_opportunity_id,tango_notice_id,federal_grant_id,{normalized_url('source_url')} FROM r_opportunity_attachment GROUP BY 1,2,3,4 HAVING count(*)>1) q", "duplicate_attachment_alias")


def clock(table, alias):
    clocks = {
        "federal_grant": "greatest(coalesce({a}.last_updated_at,{a}.detail_synced_at,{a}.synced_at),nullif({a}.raw#>>'{grantsGovDocument,lifecycle,observedAt}','')::timestamptz,nullif({a}.raw#>>'{grantsGovDocument,observedAt}','')::timestamptz)",
        "sam_opportunity": "coalesce(nullif({a}.raw_jsonb#>>'{tango,providerUpdatedAt}','')::timestamptz,{a}.last_synced_at)",
        "tango_opportunity_notice": "coalesce({a}.provider_updated_at,{a}.last_synced_at)",
        "opportunity_attachment": "coalesce({a}.provider_observed_at,{a}.updated_at)",
        "opportunity_document_text": "coalesce({a}.fetched_at,{a}.updated_at)",
        "tango_resource_snapshot": "coalesce({a}.source_updated_at,{a}.provider_fetched_at)",
        "tango_resource_link": "{a}.updated_at",
    }
    return clocks[table].replace("{a}", alias)


def value_merge(name, typ, newer):
    s, t = "s." + ident(name), "t." + ident(name)
    if name in IMMUTABLE:
        return t
    if name in ("embedded_content_hash", "embedded_at"):
        return t  # Recomputed from the actual final body and complete chunk sets below.
    if typ in ("jsonb", "json"):
        return f"pg_temp.funding_json_merge({t},{s},{newer})"
    if typ.endswith("[]"):
        return f"CASE WHEN coalesce(cardinality({t}),0)=0 OR ({newer} AND coalesce(cardinality({s}),0)>0) THEN {s} ELSE {t} END"
    if typ == "text" or typ.startswith("character varying"):
        return f"CASE WHEN nullif(btrim({s}),'') IS NULL THEN {t} WHEN nullif(btrim({t}),'') IS NULL OR {newer} THEN {s} ELSE {t} END"
    return f"CASE WHEN {s} IS NOT NULL AND ({t} IS NULL OR {newer}) THEN {s} ELSE {t} END"


def merge_table(conn, table, cols):
    newer = f"({clock(table, 's')}>{clock(table, 't')})"
    expressions = {name: value_merge(name, typ, newer) for name, typ in cols if name != "id"}
    if table == "opportunity_attachment":
        same_url = f"({normalized_url('s.source_url')}={normalized_url('t.source_url')})"
        source_archive = f"(({newer} AND NOT {same_url}) OR ({same_url} AND s.status='archived' AND (t.status<>'archived' OR {newer})))"
        for name in ARCHIVE:
            expressions[name] = f"CASE WHEN {source_archive} THEN s.{name} ELSE t.{name} END"
        expressions["provider_data"] = f"CASE WHEN {newer} AND NOT {same_url} THEN s.provider_data ELSE {expressions['provider_data']} END"
        expressions["provider_data"] += f"||CASE WHEN {same_url} AND length(t.provider_data->>'extracted_text')>10 AND coalesce(length(s.provider_data->>'extracted_text'),0)<=10 THEN jsonb_build_object('extracted_text',t.provider_data->'extracted_text','extraction_status',t.provider_data->'extraction_status') ELSE '{{}}'::jsonb END"
    elif table == "opportunity_document_text":
        # Extraction text, byte binding, state and provenance are one indivisible observation.
        use = "(s.attachment_content_sha256=a.content_sha256 AND (t.attachment_content_sha256 IS DISTINCT FROM a.content_sha256 OR (s.status='available' AND (t.status<>'available' OR (t.truncated AND NOT s.truncated))) OR (s.status=t.status AND s.truncated=t.truncated AND coalesce(length(s.text),0)>coalesce(length(t.text),0))))"
        for name in expressions:
            if name not in IMMUTABLE:
                expressions[name] = f"CASE WHEN {use} THEN s.{name} ELSE t.{name} END"
    elif table == "tango_resource_snapshot":
        # Same content is immutable. The active-head election happens after the union.
        expressions = {name: "t." + ident(name) for name in expressions}
    elif table == "tango_resource_link":
        # Never revive or overwrite target link decisions.
        expressions = {name: "t." + ident(name) for name in expressions}
    if table == "federal_grant":
        # Match the canonical writer: only an explicitly newer provider null clears a deadline.
        explicit = "(CASE WHEN s.status='forecasted' THEN s.raw#>'{tango,payload,important_dates,estimated_application_response_date}' ELSE s.raw#>'{tango,payload,important_dates,response_date}' END='null'::jsonb)"
        expressions["close_date"] = f"CASE WHEN {newer} AND s.last_updated_at IS NOT NULL AND s.close_date IS NULL AND {explicit} THEN NULL ELSE {expressions['close_date']} END"
    if table == "sam_opportunity":
        explicit = "s.raw_jsonb#>'{tango,payload,response_deadline}'='null'::jsonb"
        expressions["response_deadline"] = f"CASE WHEN {newer} AND s.raw_jsonb#>>'{{tango,providerUpdatedAt}}' IS NOT NULL AND s.response_deadline IS NULL AND {explicit} THEN NULL ELSE {expressions['response_deadline']} END"
    if table == "tango_opportunity_notice":
        explicit = "s.snapshot->'response_deadline'='null'::jsonb"
        expressions["response_deadline"] = f"CASE WHEN {newer} AND s.provider_updated_at IS NOT NULL AND s.response_deadline IS NULL AND {explicit} THEN NULL ELSE {expressions['response_deadline']} END"
        # This is a hash-bound observation, not an enrichment dictionary.
        expressions["snapshot"] = f"CASE WHEN {newer} THEN s.snapshot ELSE t.snapshot END"
    if table in ("federal_grant","sam_opportunity"):
        raw = "raw" if table == "federal_grant" else "raw_jsonb"
        expressions[raw] = f"CASE WHEN {newer} AND s.{raw}#>'{{tango,payload}}' IS NOT NULL THEN jsonb_set({expressions[raw]},'{{tango,payload}}',s.{raw}#>'{{tango,payload}}') ELSE {expressions[raw]} END"
    assignments = ",".join(f"{ident(name)}={expr}" for name, expr in expressions.items())
    extra = ",w_opportunity_attachment a" if table == "opportunity_document_text" else ""
    where = " AND a.id=s.attachment_id" if extra else ""
    conn.execute(f"UPDATE w_{table} t SET {assignments} FROM r_{table} s{extra} WHERE t.id=s.id{where}")
    names = ",".join(ident(name) for name, _ in cols)
    # natural_map already answered, per source row, whether a candidate row exists: new_id is the
    # candidate id when matched and the source id (checked absent from the target by
    # unmatched_primary_key_collision) when not.  Asking it again with NOT EXISTS makes PostgreSQL
    # re-scan the candidate table this statement is still appending to, once per inserted row,
    # which is quadratic in the number of rows staged.
    conn.execute(f"INSERT INTO w_{table} ({names}) SELECT {','.join('s.' + ident(name) for name, _ in cols)} FROM r_{table} s WHERE NOT s.crosswalk_matched")


def snapshots(conn):
    # Combine two local observation sequences. IDs/content stay immutable; versions become
    # one ordered sequence so the canonical writer's currentHead.version + 1 stays monotonic.
    conn.execute("""CREATE TEMP TABLE snapshot_heads AS SELECT id,first_value(id) OVER w AS winner,
        first_value(provider_fetched_at) OVER w AS superseded,
        (count(*) OVER(PARTITION BY resource_type,external_id)-row_number() OVER w+1)::integer AS merged_version FROM w_tango_resource_snapshot p
        WHERE EXISTS(SELECT 1 FROM s_tango_resource_snapshot s WHERE s.resource_type=p.resource_type AND s.external_id=p.external_id)
        WINDOW w AS (PARTITION BY resource_type,external_id ORDER BY coalesce(source_updated_at,provider_fetched_at) DESC,
        provider_fetched_at DESC, (id IN (SELECT id FROM public.tango_resource_snapshot)) DESC,id)""")
    conn.execute("UPDATE w_tango_resource_snapshot t SET active=(h.id=h.winner),version=h.merged_version,superseded_at=CASE WHEN h.id=h.winner THEN NULL ELSE coalesce(t.superseded_at,h.superseded) END FROM snapshot_heads h WHERE t.id=h.id")


def protected_digest(conn):
    # Hash in PostgreSQL: neither private rows nor their IDs leave the server.
    tables = set(PROTECTED)
    for (table,) in conn.execute("SELECT DISTINCT c.conrelid::regclass::text FROM pg_constraint c WHERE c.contype='f' AND c.confrelid IN ('public.sam_opportunity'::regclass,'public.federal_grant'::regclass)"):
        if table.removeprefix("public.") not in TABLES:
            tables.add(table.removeprefix("public."))
    result = {}
    for table in sorted(tables):
        require(table not in TABLES, "unexpected_catalog_foreign_key")
        require(scalar(conn, "SELECT to_regclass(%s) IS NOT NULL", ("public." + table,)), "missing_protected_table")
        result[table] = conn.execute(f"SELECT count(*),md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY id),'')) FROM public.{ident(table)} t").fetchone()
    result["private_vectors"] = conn.execute("SELECT count(*),md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY id),'')) FROM context_embeddings t WHERE tenant_id IS NOT NULL OR client_id IS NOT NULL OR owner_user_id IS NOT NULL").fetchone()
    result["excluded_resource_links"] = conn.execute("SELECT count(*),md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY id),'')) FROM tango_resource_link t WHERE NOT (" + SCOPES["tango_resource_link"] + ")").fetchone()
    result["fixture_notices"] = conn.execute("SELECT count(*),md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY id),'')) FROM sam_opportunity t WHERE raw_jsonb->'fixture'='true'::jsonb").fetchone()
    return result


def body_sql(kind, prefix, alias="p"):
    if kind == "grant":
        return f"concat_ws(E'\\n',{alias}.title,{alias}.agency,{alias}.description,{alias}.eligibility_text,array_to_string({alias}.eligibility,', '))"
    if kind == "notice":
        return f"concat_ws(E'\\n',{alias}.title,{alias}.agency,{alias}.description,{alias}.set_aside,{alias}.naics_code,{alias}.psc_code)"
    return f"CASE WHEN length({alias}.provider_data->>'extracted_text')>10 THEN concat_ws(E'\\n',{alias}.file_name,{alias}.provider_data->>'extracted_text') WHEN length(d.text)>10 THEN concat_ws(E'\\n',{alias}.file_name,d.text) ELSE '' END"


CANONICAL_HELPER = r"""
import readline from 'node:readline';
import { searchText, hash, stable } from './src/external/tango/funding-catalog.mapper.ts';
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await (const line of rl) {
  try {
    const x=JSON.parse(line),body=searchText(x.source.body),finalBody=searchText(x.final.body),documentHash=hash(body);
    const chunker=x.vectors[0]?.metadata.chunker ?? 'funding-v3-6000chars-6000bytes-400-unicode',model='amazon.titan-embed-text-v2:0';
    let covered=0;
    const valid=x.vectors.every((v,i)=>{
      const m=v.metadata;
      const expected={...x.source.metadata,parentId:x.source.id,documentHash,chunkIndex:i,start:m.start,end:m.end,offsetBasis:'plain_text_normalized_utf16',chunker};
      const ok=v.source_id===`${x.source.id}:${i}` && Number.isSafeInteger(m.start) && Number.isSafeInteger(m.end) && m.start>=0 && m.start<=covered && m.end>covered && m.end<=body.length && hash(body.slice(m.start,m.end))===v.content_hash && stable(m)===stable(expected);
      covered=m.end; return ok;
    }) && covered===body.length && x.marker===hash(stable({documentHash,metadata:x.source.metadata,model,chunker}));
    const usable=body===finalBody;
    const marker=valid ? hash(stable({documentHash,metadata:x.final.metadata,model,chunker})) : null;
    process.stdout.write(JSON.stringify({valid,usable,marker})+'\n');
  } catch { process.stdout.write('{"error":true}\n'); }
}
"""


def metadata(kind, row):
    result = {"sourceTable": KINDS[kind], "sourceUrl": row.get("url") if kind == "grant" else row.get("source_url")}
    if kind != "attachment":
        return dict(result, binding="government_record_id")
    local = len((row.get("provider_data") or {}).get("extracted_text") or "") <= 10
    provider = row.get("provider_data") or {}
    result.update(providerAttachmentId=row.get("provider_attachment_id"), binding="archived_content_sha256" if local else "provider_attachment_id",
        samOpportunityId=row.get("sam_opportunity_id"), federalGrantId=row.get("federal_grant_id"), extractionStatus="available" if local else provider.get("extraction_status"),
        extractionMethod="local_parser" if local else "provider")
    if local:
        result.update(attachmentContentSha256=row.get("content_sha256"), truncated=row.get("text_truncated") or False)
    result["documentRole"] = provider.get("doc_role")
    return result


def vector_groups(conn, prefix, kind):
    table = KINDS[kind]
    mapping = f"JOIN m_{table} m ON m.old_id=p.id" if prefix == "s" else f"JOIN m_{table} m ON m.new_id=p.id"
    target_id = "m.new_id" if prefix == "s" else "p.id"
    text_join = ""
    if kind == "attachment":
        text_join = f"LEFT JOIN {prefix}_opportunity_document_text d ON d.attachment_id=p.id AND d.attachment_content_sha256=p.content_sha256 AND d.extraction_method='local_parser' AND d.status='available' LEFT JOIN w_opportunity_document_text z ON z.attachment_id=f.id AND z.attachment_content_sha256=f.content_sha256 AND z.extraction_method='local_parser' AND z.status='available'"
    sql = f"""SELECT p.id::text,{target_id}::text,p.embedded_content_hash,greatest(p.embedded_at,{clock(table,'f')}),
        {body_sql(kind,prefix)}, {body_sql(kind,'w','f').replace('d.text','z.text')},
        to_jsonb(p){"||jsonb_build_object('text_truncated',d.truncated)" if kind == 'attachment' else ''},
        to_jsonb(f){"||jsonb_build_object('text_truncated',z.truncated)" if kind == 'attachment' else ''},
        coalesce(v.parts,'[]'::jsonb),coalesce(v.latest,p.embedded_at) FROM {prefix}_{table} p {mapping} JOIN w_{table} f ON f.id={target_id} {text_join}
        JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('source_id',e.source_id,'content_hash',e.content_hash,'metadata',e.metadata_jsonb) ORDER BY (e.metadata_jsonb->>'chunkIndex')::int) AS parts
            ,max(e.updated_at) AS latest
            FROM {prefix}_context_embeddings e WHERE e.source_type='funding_{kind}_chunk' AND e.model='amazon.titan-embed-text-v2:0' AND split_part(e.source_id,':',1)=p.id::text) v ON v.parts IS NOT NULL OR p.embedded_content_hash IS NOT NULL"""
    with conn.cursor(name=f"vectors_{prefix}_{kind}") as cursor:
        cursor.itersize = 10
        cursor.execute(sql)
        yield from cursor


def vectors(conn, api_dir, node):
    check_zero(conn, "SELECT count(*) FROM s_context_embeddings WHERE content_hash IS DISTINCT FROM encode(sha256(convert_to(content_text,'UTF8')),'hex') OR vector_dims(embedding) IS DISTINCT FROM 1024 OR model<>'amazon.titan-embed-text-v2:0' OR source_id IS DISTINCT FROM concat(metadata_jsonb->>'parentId',':',metadata_jsonb->>'chunkIndex') OR coalesce(metadata_jsonb->>'chunker','') !~ '^funding-v[123]-' OR coalesce(metadata_jsonb->>'chunkIndex','') !~ '^[0-9]+$'", "invalid_source_vector")
    for prefix in ("s", "w"):
        conn.execute(f"CREATE INDEX ON {prefix}_context_embeddings(source_type,(split_part(source_id,':',1)))")
        conn.execute(f"CREATE INDEX ON {prefix}_opportunity_document_text(attachment_id,extraction_method,attachment_content_sha256)")
        conn.execute(f"ANALYZE {prefix}_context_embeddings")
        conn.execute(f"ANALYZE {prefix}_opportunity_document_text")
    conn.execute("CREATE TEMP TABLE vector_accept(kind text,old_id text,new_id text,marker text,embedded_at timestamptz,source_prefix text,metadata jsonb,valid boolean,latest timestamptz,PRIMARY KEY(kind,new_id))")
    # Reuse the canonical worker's normalizer/chunker/marker; no Python approximation.
    proc = subprocess.Popen([node, "--import", "tsx", "--input-type=module", "-e", CANONICAL_HELPER], cwd=api_dir,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8", env={**os.environ, "EMBEDDING_PROVIDER": "bedrock"})
    accepted, deferred, unverified_empty = 0, 0, 0
    try:
        for prefix in ("w", "s"):
            for kind in KINDS:
                for old, new, marker, embedded_at, body, final_body, row, final_row, parts, latest in vector_groups(conn, prefix, kind):
                    # JSONB key order differs from JavaScript object insertion order; normalize before comparison in helper.
                    payload = {"source": {"id": old, "body": body, "metadata": metadata(kind,row)}, "final": {"id":new,"body":final_body,"metadata":metadata(kind,final_row)}, "marker":marker,"vectors":parts}
                    proc.stdin.write(json.dumps(payload, ensure_ascii=True) + "\n"); proc.stdin.flush()
                    answer = proc.stdout.readline()
                    require(bool(answer), "canonical_worker_unavailable")
                    result = json.loads(answer)
                    require(not result.get("error"), "canonical_plan_failure")
                    if not parts and not result["valid"]:
                        unverified_empty += 1
                        continue
                    if not result["usable"]:
                        deferred += 1
                        continue
                    old_metadata = parts[0]["metadata"] if parts else metadata(kind,row)
                    base = metadata(kind, final_row) if result["valid"] else {k:v for k,v in old_metadata.items() if k not in ("parentId","documentHash","chunkIndex","start","end","offsetBasis","chunker")}
                    if kind == "attachment" and not result["valid"]:
                        base["samOpportunityId"] = final_row.get("sam_opportunity_id")
                        base["federalGrantId"] = final_row.get("federal_grant_id")
                    result_cursor = conn.execute("INSERT INTO vector_accept VALUES(%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s) ON CONFLICT(kind,new_id) DO UPDATE SET old_id=EXCLUDED.old_id,marker=EXCLUDED.marker,embedded_at=EXCLUDED.embedded_at,source_prefix=EXCLUDED.source_prefix,metadata=EXCLUDED.metadata,valid=EXCLUDED.valid,latest=EXCLUDED.latest WHERE (EXCLUDED.valid AND NOT vector_accept.valid) OR (EXCLUDED.valid=vector_accept.valid AND EXCLUDED.latest>vector_accept.latest)", (kind,old,new,result["marker"],embedded_at if result["valid"] else None,prefix,json.dumps(base),result["valid"],latest))
                    accepted += result_cursor.rowcount
        proc.stdin.close(); proc.wait(timeout=30)
        require(proc.returncode == 0, "canonical_worker_failed")
    finally:
        if proc.poll() is None:
            proc.kill(); proc.wait()
        for stream in (proc.stdin, proc.stdout):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass  # A terminated helper may already have closed its input pipe.
    conn.execute("ANALYZE vector_accept")
    # Invalid or stale target chunk sets are removed only for transferred parents.
    conn.execute("CREATE TEMP TABLE final_vectors AS SELECT * FROM w_context_embeddings WITH NO DATA")
    affected = " OR ".join(f"(e.source_type='funding_{kind}_chunk' AND split_part(e.source_id,':',1) IN (SELECT new_id::text FROM m_{table}))" for kind,table in KINDS.items())
    conn.execute(f"INSERT INTO final_vectors SELECT * FROM w_context_embeddings e WHERE e.model<>'amazon.titan-embed-text-v2:0' OR NOT ({affected})")
    for prefix in ("w", "s"):
        conn.execute(f"""INSERT INTO final_vectors(id,tenant_id,client_id,owner_user_id,source_type,source_id,model,content_text,content_hash,embedding,metadata_jsonb,created_at,updated_at) SELECT coalesce(t.id,e.id),e.tenant_id,e.client_id,e.owner_user_id,e.source_type,
          a.new_id||':'||(e.metadata_jsonb->>'chunkIndex'),e.model,e.content_text,e.content_hash,e.embedding,
          a.metadata||jsonb_build_object('parentId',a.new_id,'documentHash',e.metadata_jsonb->'documentHash','chunkIndex',e.metadata_jsonb->'chunkIndex','start',e.metadata_jsonb->'start','end',e.metadata_jsonb->'end','offsetBasis',e.metadata_jsonb->'offsetBasis','chunker',e.metadata_jsonb->'chunker'),
          coalesce(t.created_at,e.created_at),e.updated_at FROM {prefix}_context_embeddings e
          JOIN vector_accept a ON a.source_prefix='{prefix}' AND e.source_type='funding_'||a.kind||'_chunk' AND e.model='amazon.titan-embed-text-v2:0' AND split_part(e.source_id,':',1)=a.old_id
          LEFT JOIN public.context_embeddings t ON t.tenant_id IS NULL AND t.client_id IS NULL AND t.owner_user_id IS NULL AND t.source_type=e.source_type AND t.source_id=a.new_id||':'||(e.metadata_jsonb->>'chunkIndex') AND t.model=e.model""")
    # Metadata beyond the local-ID rewrite must match the final plan. Incompatible enrichment defers re-embedding.
    conn.execute("DELETE FROM w_context_embeddings")
    conn.execute("INSERT INTO w_context_embeddings SELECT * FROM final_vectors")
    check_zero(conn,"SELECT count(*) FROM w_context_embeddings w JOIN public.context_embeddings e ON e.id=w.id OR (e.tenant_id IS NULL AND e.source_type=w.source_type AND e.source_id=w.source_id AND e.model=w.model) WHERE e.tenant_id IS NOT NULL OR e.client_id IS NOT NULL OR e.owner_user_id IS NOT NULL OR e.source_type NOT IN ('funding_grant_chunk','funding_notice_chunk','funding_attachment_chunk')","vector_identity_collision_outside_public_scope")
    check_zero(conn,"SELECT count(*) FROM (SELECT id FROM w_context_embeddings GROUP BY id HAVING count(*)>1) q","duplicate_final_vector_identity")
    for kind, table in KINDS.items():
        conn.execute(f"UPDATE w_{table} SET embedded_content_hash=NULL,embedded_at=NULL WHERE id IN (SELECT new_id FROM m_{table})")
        conn.execute(f"UPDATE w_{table} p SET embedded_content_hash=a.marker,embedded_at=a.embedded_at FROM vector_accept a WHERE a.kind=%s AND a.new_id=p.id::text", (kind,))
    return {"selected_documents":scalar(conn,"SELECT count(*) FROM vector_accept"),"current_verified_documents":scalar(conn,"SELECT count(*) FROM vector_accept WHERE valid"),"retained_stale_documents":scalar(conn,"SELECT count(*) FROM vector_accept WHERE NOT valid"), "source_body_conflicts": deferred,"unverified_empty_documents":unverified_empty}


def references(conn):
    for prefix in ("s", "w"):
        check_zero(conn, f"SELECT count(*) FROM {prefix}_opportunity_attachment a LEFT JOIN {prefix}_federal_grant g ON g.id=a.federal_grant_id WHERE a.federal_grant_id IS NOT NULL AND g.id IS NULL", "orphan_grant_attachment")
        check_zero(conn, f"SELECT count(*) FROM {prefix}_opportunity_document_text d LEFT JOIN {prefix}_opportunity_attachment a ON a.id=d.attachment_id WHERE a.id IS NULL", "orphan_extracted_text")
        for kind, table in KINDS.items():
            check_zero(conn, f"SELECT count(*) FROM {prefix}_context_embeddings e LEFT JOIN {prefix}_{table} p ON p.id::text=split_part(e.source_id,':',1) WHERE e.source_type='funding_{kind}_chunk' AND (p.id IS NULL OR e.metadata_jsonb->>'sourceTable' IS DISTINCT FROM '{table}')", "orphan_or_wrong_vector_parent")


def progress(entry):
    """Aggregate-only progress line: counts, phases and elapsed milliseconds. No ids, vectors,
    content, customer values or secrets are ever placed in a progress or failure line."""
    print(json.dumps(entry,sort_keys=True),file=sys.stderr,flush=True)


def publish_vectors(conn, names, updates, report=None):
    """Publish the embedding candidate in deterministic keyset batches inside the caller's transaction.

    Every batch uses the same per-row ``ON CONFLICT(id) DO UPDATE ... WHERE t IS DISTINCT FROM EXCLUDED``
    statement as the other tables, restricted to one id range, so no single statement spans the whole
    candidate set. Batches walk the candidate by id using its unique index; nothing is committed here,
    the caller's single final COMMIT still decides the whole publication.
    """
    notify = report or progress
    candidate = scalar(conn,"SELECT count(*) FROM w_context_embeddings")
    processed = changed = batches = 0
    last = None
    while True:
        # The first batch has no lower bound: `id > NULL` matches nothing, which would silently
        # publish an empty batch set. Later batches resume strictly above the previous batch's last id.
        if last is None:
            keys = [row[0] for row in conn.execute(
                "SELECT id FROM w_context_embeddings ORDER BY id LIMIT %s",(VECTOR_BATCH,)).fetchall()]
        else:
            keys = [row[0] for row in conn.execute(
                "SELECT id FROM w_context_embeddings WHERE id > %s ORDER BY id LIMIT %s",(last,VECTOR_BATCH)).fetchall()]
        if not keys:
            break
        batches += 1
        started = time.perf_counter()
        try:
            cursor = conn.execute(
                f"INSERT INTO public.context_embeddings AS t ({names}) SELECT {names} FROM w_context_embeddings "
                f"WHERE id BETWEEN %s AND %s ON CONFLICT(id) DO UPDATE SET {updates} WHERE t IS DISTINCT FROM EXCLUDED",
                (keys[0],keys[-1]))
            written = max(cursor.rowcount,0)
        except Refusal:
            raise
        except Exception:
            # Fixed, non-secret stage code: a database error may carry identifiers, parameters or bodies.
            notify({"phase":VECTOR_PHASE,"stage":"statement","code":VECTOR_FAILURE,"batch":batches,
                    "candidate":candidate,"processed":processed,"changed":changed,
                    "elapsed_ms":int((time.perf_counter()-started)*1000)})
            raise Refusal(VECTOR_FAILURE) from None
        processed += len(keys)
        changed += written
        last = keys[-1]
        notify({"phase":VECTOR_PHASE,"stage":"batch","batch":batches,"candidate":candidate,
                "processed":len(keys),"changed":written,
                "elapsed_ms":int((time.perf_counter()-started)*1000)})
        if len(keys) < VECTOR_BATCH:
            break
    notify({"phase":VECTOR_PHASE,"stage":"complete","batch":batches,"candidate":candidate,
            "processed":processed,"changed":changed})
    return changed


def publish(conn, schemas, report=None):
    # Keep every target ID. All writes occur after the complete candidate was validated.
    conn.execute("UPDATE tango_resource_snapshot t SET active=false,superseded_at=w.superseded_at FROM w_tango_resource_snapshot w WHERE t.id=w.id AND t.active AND NOT w.active")
    changes = {}
    for table in TABLES:
        cols = schemas[table]
        names = ",".join(ident(name) for name, _ in cols)
        if table == "context_embeddings":
            conn.execute(f"DELETE FROM context_embeddings t WHERE {PUBLIC_VECTORS} AND NOT EXISTS(SELECT 1 FROM w_context_embeddings w WHERE w.id=t.id)")
        updates = ",".join(f"{ident(name)}=EXCLUDED.{ident(name)}" for name, _ in cols if name != "id")
        if table == "context_embeddings":
            # Bounded keyset publication, embedding table only. The candidate can hold the whole public
            # vector baseline, so this table is published in fixed id-range batches inside the caller's
            # transaction, using the same per-row ON CONFLICT statement as the other tables. Every other
            # publication statement here is unchanged, and the postcondition below is unchanged.
            changes[table] = publish_vectors(conn,names,updates,report)
        else:
            cursor = conn.execute(f"INSERT INTO public.{table} AS t ({names}) SELECT {names} FROM w_{table} WHERE true ON CONFLICT(id) DO UPDATE SET {updates} WHERE t IS DISTINCT FROM EXCLUDED")
            changes[table] = cursor.rowcount
        check_zero(conn,f"SELECT count(*) FROM w_{table} w LEFT JOIN public.{table} t ON t.id=w.id WHERE ROW(t.*) IS DISTINCT FROM ROW(w.*)","published_candidate_mismatch")
    conn.execute("SET CONSTRAINTS ALL IMMEDIATE")
    return changes


def transfer(source, target, api_dir, node="node", commit=False):
    source.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    target.execute("BEGIN ISOLATION LEVEL REPEATABLE READ")
    for connection in (source, target):
        connection.execute("SET LOCAL statement_timeout='30min'")
        connection.execute("SET LOCAL lock_timeout='5s'")
        connection.execute("SET LOCAL idle_in_transaction_session_timeout='10min'")
        connection.execute("SET LOCAL app.bypass_rls='on'")
        require(scalar(connection,"SELECT rls_bypass()"), "database_role_cannot_verify_all_rows")
        connection.execute("SET LOCAL timezone='UTC'")
        connection.execute("SET LOCAL datestyle='ISO, YMD'")
        for name in LOCKS:
            require(scalar(connection,"SELECT pg_try_advisory_xact_lock(hashtext(%s))",(name,)), "writer_lock_busy")
    # Source snapshot + nonblocking advisory ownership; human pause covers legacy/uncooperative writers.
    target.execute("LOCK TABLE " + ",".join("public."+t for t in TABLES) + " IN SHARE ROW EXCLUSIVE MODE")
    target.execute("""CREATE FUNCTION pg_temp.funding_json_merge(t jsonb,s jsonb,newer boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE k text; v jsonb; out jsonb:=coalesce(t,'{}'::jsonb);
      BEGIN
        IF jsonb_typeof(s) IS DISTINCT FROM 'object' THEN RETURN CASE WHEN t IS NULL OR newer THEN coalesce(s,t) ELSE t END; END IF;
        FOR k,v IN SELECT * FROM jsonb_each(s) LOOP
          IF v IN ('null'::jsonb,'\"\"'::jsonb,'[]'::jsonb,'{}'::jsonb) THEN CONTINUE; END IF;
          IF jsonb_typeof(v)='object' AND jsonb_typeof(out->k)='object' THEN out:=jsonb_set(out,ARRAY[k],pg_temp.funding_json_merge(out->k,v,newer));
          ELSIF newer OR NOT out ? k OR out->k IN ('null'::jsonb,'\"\"'::jsonb,'[]'::jsonb,'{}'::jsonb) THEN out:=jsonb_set(out,ARRAY[k],v); END IF;
        END LOOP;
        RETURN out;
      END $$""")
    before = protected_digest(target)
    # Notice observations have a soft government-key reference, so detect this
    # excluded fixture dependency before it could enter the snapshot union.
    check_zero(source,"""SELECT count(*) FROM sam_opportunity s WHERE s.raw_jsonb->'fixture'='true'::jsonb AND (
        EXISTS(SELECT 1 FROM tango_resource_snapshot p WHERE p.resource_type='notice'
            AND lower(replace(p.external_id,'-',''))=lower(replace(s.notice_id,'-','')))
        OR EXISTS(SELECT 1 FROM tango_opportunity_notice n WHERE n.sam_opportunity_id IS NULL
            AND lower(replace(n.tango_notice_id,'-',''))=lower(replace(s.notice_id,'-',''))))""","source_fixture_observation_dependency")
    schemas, receipt = {}, {"mode":"commit" if commit else "dry_run", "tables":{}}
    for table in TABLES:
        schemas[table], receipt["tables"][table] = stage(source,target,table)
    # The complete, verified snapshot is now staged; remaining work is target-only.
    source.execute("ROLLBACK")
    references(target)
    prepare_maps(target,schemas)
    for table in TABLES[:-1]:
        merge_table(target,table,schemas[table])
    snapshots(target)
    receipt["vectors"] = vectors(target,api_dir,node)
    references(target)
    receipt["archive"] = dict(zip(("references","distinct_objects","bytes"), target.execute("SELECT count(*),count(DISTINCT (archive_bucket,archive_key,archive_version_id)),coalesce(sum(observed_size_bytes),0) FROM w_opportunity_attachment WHERE status='archived'").fetchone()))
    receipt["archive"]["manifest_sha256"] = checksum(target,"SELECT archive_bucket,archive_key,archive_version_id,content_sha256,observed_size_bytes FROM w_opportunity_attachment WHERE status='archived' ORDER BY archive_bucket,archive_key,archive_version_id,id")
    for table in TABLES:
        receipt["tables"][table]["candidate_rows"] = scalar(target,f"SELECT count(*) FROM w_{table}")
    if commit:
        receipt["published_changed_rows"] = publish(target,schemas)
    require(before == protected_digest(target), "protected_rows_changed")
    receipt["protected_rows_unchanged"] = True
    target.execute("COMMIT" if commit else "ROLLBACK")
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description="Dry-run by default. Streams public funding into TEMP staging and validates a candidate without modifying public tables. Requires the reserved release window even for dry-run. Exit 0: success; 2: input/safety refusal; 1: operational failure (details suppressed).")
    parser.add_argument("--config", type=Path, required=True, help="Owner-only JSON with exact source/target endpoints and password environment variable names; never contains passwords")
    parser.add_argument("--commit", action="store_true")
    parser.add_argument("--window-approved", action="store_true")
    parser.add_argument("--writers-paused", action="store_true")
    parser.add_argument("--snapshot-verified", action="store_true")
    parser.add_argument("--synthetic", action="store_true", help="Only loopback databases named tango_transfer_{source,target}_test")
    parser.add_argument("--node", default="node")
    args = parser.parse_args(argv)
    source = target = None
    try:
        require(args.window_approved and args.writers_paused and args.snapshot_verified, "release_window_pause_and_snapshot_required")
        config = json.loads(args.config.read_bytes())
        guard_config(config,args.synthetic)
        import psycopg  # Existing operator dependency; no application/runtime dependency added.
        source = connect(psycopg,config["source"],args.synthetic)
        target = connect(psycopg,config["target"],args.synthetic)
        result = transfer(source,target,Path(__file__).resolve().parents[2],args.node,args.commit)
        print(json.dumps(result,sort_keys=True))
        return 0
    except Refusal as error:
        print(json.dumps({"result":"refused","code":str(error)}))
        return 2
    except Exception:
        # Database/provider errors may contain SQL parameters, identifiers, credentials or bodies.
        print('{"result":"failed","code":"operator_failure_details_suppressed"}')
        return 1
    finally:
        for connection in (target,source):
            if connection is not None:
                try:
                    connection.close()  # Closing an uncommitted transaction rolls it back.
                except Exception:
                    pass


if __name__ == "__main__":
    sys.exit(main())
