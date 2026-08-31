#!/usr/bin/env python3
"""Pull real corpus samples for multi-client Advocacy match QA."""
from __future__ import annotations

import json
import os
import sys

import psycopg2


def main() -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL required", file=sys.stderr)
        return 2
    conn = psycopg2.connect(url.split("?")[0])
    cur = conn.cursor()

    def fetch(sql: str):
        cur.execute(sql)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    exact = fetch(
        """
        select id::text, recipient_name, recipient_normalized, state, chamber,
               fiscal_year, project_title
        from community_funding_request
        where length(recipient_normalized) > 8 and state is not null
        order by length(recipient_normalized) desc
        limit 20
        """
    )
    shared = fetch(
        """
        select recipient_normalized, count(*) n, count(distinct state) states,
               array_agg(distinct state) st
        from community_funding_request
        where recipient_normalized is not null and length(recipient_normalized) > 5
        group by 1
        having count(distinct state) > 1 and count(*) > 5
        order by count(*) desc
        limit 10
        """
    )
    unique = fetch(
        """
        select recipient_normalized, state, count(*) n,
               min(id::text) as id, min(recipient_name) as recipient_name
        from community_funding_request
        where state is not null and length(recipient_normalized) > 10
        group by 1, 2
        having count(*) = 1
        order by length(recipient_normalized) desc
        limit 10
        """
    )
    multi_prov = fetch(
        """
        select r.id::text, r.recipient_name, r.recipient_normalized, r.state,
               r.chamber, r.fiscal_year, count(s.id) as n_src
        from community_funding_request r
        join community_funding_request_source s on s.request_id = r.id
        group by r.id
        having count(s.id) > 1
        order by count(s.id) desc
        limit 10
        """
    )
    out = {
        "exact": exact,
        "shared": shared,
        "unique": unique,
        "multi_prov": multi_prov,
    }
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/cpf-qa-samples.json"
    open(path, "w", encoding="utf-8").write(json.dumps(out, default=str, indent=2))
    print(json.dumps({"path": path, "exact": len(exact), "shared": len(shared), "unique": len(unique), "multi_prov": len(multi_prov)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
