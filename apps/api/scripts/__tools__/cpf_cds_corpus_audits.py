#!/usr/bin/env python3
"""Phases 9-12 CPF/CDS corpus audits against disposable Postgres.

Usage:
  DATABASE_URL=postgresql://capiro:capiro@127.0.0.1:54329/capiro?schema=public \
    python scripts/__tools__/cpf_cds_corpus_audits.py [--out report.json]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("psycopg2 required", file=sys.stderr)
    raise


def q(cur, sql, params=None):
    cur.execute(sql, params or ())
    cols = [d[0] for d in cur.description] if cur.description else []
    rows = cur.fetchall()
    return cols, rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL required", file=sys.stderr)
        return 2
    # psycopg2 wants plain postgresql:// without ?schema=
    dsn = url.split("?")[0]
    conn = psycopg2.connect(dsn)
    conn.set_session(readonly=True, autocommit=True)
    cur = conn.cursor()

    report: dict = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "phases": {},
    }

    # --- Phase 9: corpus result tables ---
    cur.execute("select count(*) from community_funding_request")
    n_req = cur.fetchone()[0]
    cur.execute("select count(*) from community_funding_request_source")
    n_src = cur.fetchone()[0]
    cur.execute("select count(*) from community_funding_ingest_run")
    n_run = cur.fetchone()[0]
    cur.execute("select count(*) from source_document")
    n_doc = cur.fetchone()[0]

    cur.execute(
        """
        select chamber, fiscal_year, count(*)
        from community_funding_request
        group by 1,2 order by 1,2
        """
    )
    by_fy = [{"chamber": r[0], "fy": r[1], "count": r[2]} for r in cur.fetchall()]

    cur.execute(
        """
        select chamber, count(*) from community_funding_request group by 1 order by 1
        """
    )
    by_chamber = {r[0]: r[1] for r in cur.fetchall()}

    # multi-provenance requests
    cur.execute(
        """
        select count(*) from (
          select request_id from community_funding_request_source
          group by request_id having count(*) > 1
        ) t
        """
    )
    multi_prov = cur.fetchone()[0]

    report["phases"]["p9_corpus"] = {
        "canonical_requests": n_req,
        "provenance_rows": n_src,
        "ingest_runs": n_run,
        "source_documents": n_doc,
        "cross_document_collapses_estimate": max(0, n_src - n_req),
        "multi_provenance_requests": multi_prov,
        "by_chamber": by_chamber,
        "by_chamber_fy": by_fy,
    }

    # --- Phase 10: identity collision audit ---
    # identity_hash is unique by constraint; collisions = same recipient+project different requesters etc.
    # Sample suspicious near-duplicates: same recipient_normalized + project_title + fy, different identity
    cur.execute(
        """
        select recipient_normalized, project_title, fiscal_year, chamber, count(*) as n,
               array_agg(id::text) as ids,
               array_agg(requester_name) as requesters
        from community_funding_request
        group by 1,2,3,4
        having count(*) > 1
        order by count(*) desc
        limit 40
        """
    )
    near = []
    for r in cur.fetchall():
        near.append(
            {
                "recipient": r[0],
                "project": r[1],
                "fy": r[2],
                "chamber": r[3],
                "n": r[4],
                "ids": list(r[5])[:5],
                "requesters": list(r[6])[:5],
            }
        )

    # empty/placeholder recipients
    cur.execute(
        """
        select count(*) from community_funding_request
        where recipient_normalized is null or length(trim(recipient_normalized)) < 2
           or recipient_normalized in ('unknown','n/a','na','none','tbd')
        """
    )
    bad_recip = cur.fetchone()[0]

    # identity_hash uniqueness already enforced — confirm no dup hashes
    cur.execute(
        """
        select count(*) from (
          select identity_hash from community_funding_request
          group by identity_hash having count(*) > 1
        ) t
        """
    )
    hash_collisions = cur.fetchone()[0]

    # sample 25 multi-provenance or near-dup rows for manual inspection
    samples = near[:25]
    if len(samples) < 25:
        cur.execute(
            """
            select r.id::text, r.chamber, r.fiscal_year, r.recipient_name, r.project_title,
                   r.requester_name, count(s.id) as n_src
            from community_funding_request r
            join community_funding_request_source s on s.request_id = r.id
            group by r.id
            having count(s.id) > 1
            order by count(s.id) desc
            limit %s
            """,
            (25 - len(samples),),
        )
        for r in cur.fetchall():
            samples.append(
                {
                    "id": r[0],
                    "chamber": r[1],
                    "fy": r[2],
                    "recipient": r[3],
                    "project": r[4],
                    "requester": r[5],
                    "n_src": r[6],
                    "kind": "multi_provenance",
                }
            )

    report["phases"]["p10_identity"] = {
        "identity_hash_collisions": hash_collisions,
        "near_duplicate_groups": len(near),
        "near_duplicate_sample": near[:25],
        "bad_recipient_count": bad_recip,
        "manual_samples": samples[:25],
        "sample_count": len(samples[:25]),
        "verdict": "PASS"
        if hash_collisions == 0 and bad_recip == 0
        else "REVIEW",
    }

    # --- Phase 11: provenance audit ---
    cur.execute(
        """
        select count(*) from community_funding_request r
        where not exists (
          select 1 from community_funding_request_source s where s.request_id = r.id
        )
        """
    )
    orphan_req = cur.fetchone()[0]
    cur.execute(
        """
        select count(*) from community_funding_request_source s
        where not exists (
          select 1 from community_funding_request r where r.id = s.request_id
        )
        """
    )
    orphan_src = cur.fetchone()[0]

    cur.execute(
        """
        select avg(n)::float, max(n), percentile_cont(0.5) within group (order by n)
        from (
          select count(*)::int as n from community_funding_request_source group by request_id
        ) t
        """
    )
    avg_n, max_n, med_n = cur.fetchone()

    cur.execute(
        """
        select count(distinct source_document_id) from community_funding_request_source
        """
    )
    distinct_src_docs = cur.fetchone()[0]

    report["phases"]["p11_provenance"] = {
        "requests_without_provenance": orphan_req,
        "provenance_without_request": orphan_src,
        "avg_sources_per_request": avg_n,
        "median_sources_per_request": med_n,
        "max_sources_per_request": max_n,
        "distinct_source_documents_in_provenance": distinct_src_docs,
        "verdict": "PASS" if orphan_req == 0 and orphan_src == 0 else "FAIL",
    }

    # --- Phase 12: amount/stage audit ---
    cur.execute(
        """
        select amount_stage_raw, count(*)
        from community_funding_request
        group by 1 order by 2 desc
        """
    )
    stages = {r[0]: r[1] for r in cur.fetchall()}

    cur.execute(
        """
        select count(*) from community_funding_request
        where requested_amount_usd < 0
           or (final_amount_usd is not null and final_amount_usd < 0)
        """
    )
    neg_amt = cur.fetchone()[0]

    cur.execute(
        """
        select count(*) from community_funding_request
        where final_amount_usd is not null
          and amount_stage_raw in ('amount_requested','senate_recommendation')
        """
    )
    final_with_early_stage = cur.fetchone()[0]

    cur.execute(
        """
        select count(*) from community_funding_request
        where final_amount_usd is null and amount_stage_raw = 'house_amount'
        """
    )
    house_without_final = cur.fetchone()[0]

    # stage vocabulary sanity
    known = {
        "amount_requested",
        "senate_recommendation",
        "house_amount",
        "final_amount",
        "enacted",
        "recommended",
        "requested",
    }
    unknown_stages = [s for s in stages if s and s not in known]

    report["phases"]["p12_amount_stage"] = {
        "stages": stages,
        "negative_amounts": neg_amt,
        "final_amount_with_early_stage_label": final_with_early_stage,
        "house_amount_without_final": house_without_final,
        "unknown_stages": unknown_stages,
        "verdict": "PASS" if neg_amt == 0 else "FAIL",
    }

    # overall
    verdicts = [
        report["phases"]["p10_identity"]["verdict"],
        report["phases"]["p11_provenance"]["verdict"],
        report["phases"]["p12_amount_stage"]["verdict"],
    ]
    report["overall"] = {
        "canonical": n_req,
        "provenance": n_src,
        "verdicts": verdicts,
        "status": "PASS" if all(v == "PASS" for v in verdicts) else "REVIEW",
    }

    text = json.dumps(report, indent=2, default=str)
    if args.out:
        open(args.out, "w", encoding="utf-8").write(text + "\n")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
