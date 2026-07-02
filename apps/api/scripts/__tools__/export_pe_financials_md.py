#!/usr/bin/env python3
"""Export program element FINANCIAL data (dollar-bearing sources) to one Markdown file per source.

Covers:
  - Committee / conference markup artifacts: per-PE request + mark dollars.
  - Procurement (pdoc) books: per-line multi-year fyData (qty, request $K, unit cost).
"""
import json, os, glob, datetime

DATA = os.path.join(os.path.dirname(__file__), "..", "__data__")
OUT = os.path.join(DATA, "pe_md_export")
os.makedirs(OUT, exist_ok=True)


def esc(s):
    return "" if s is None else str(s).replace("\r", " ").replace("|", "\\|").strip()


def fmt_usd(n):
    if n is None:
        return ""
    try:
        return f"${n:,.0f}"
    except (TypeError, ValueError):
        return esc(n)


def write_committee(path, d):
    rows = d.get("rows", [])
    name = os.path.splitext(os.path.basename(path))[0]
    stage = d.get("chamber") or d.get("stage") or "?"
    total_req = sum((r.get("request") or 0) for r in rows)
    total_mark = sum((r.get("mark") or 0) for r in rows)
    L = []
    L.append(f"# {name} — Program Element Financials ({stage})")
    L.append("")
    L.append(f"- Source file: `{os.path.basename(path)}`")
    L.append(f"- Stage / chamber: {esc(stage)}")
    L.append(f"- Fiscal year: {esc(d.get('fy'))}")
    L.append(f"- Source: {esc(d.get('source'))}")
    L.append(f"- PE lines: {len(rows)}")
    L.append(f"- Total request: {fmt_usd(total_req)}  ({total_req/1e6:,.1f}M)")
    L.append(f"- Total mark: {fmt_usd(total_mark)}  ({total_mark/1e6:,.1f}M)")
    L.append(f"- Net mark vs request: {fmt_usd(total_mark - total_req)}")
    L.append(f"- Exported: {datetime.date.today().isoformat()}")
    L.append("")
    L.append("| PE Code | FY | Request | Mark | Delta | Description |")
    L.append("|---------|----|---------|------|-------|-------------|")
    for r in rows:
        req = r.get("request")
        mark = r.get("mark")
        delta = (mark or 0) - (req or 0)
        L.append(
            f"| {esc(r.get('peCode'))} | {esc(r.get('fy'))} | {fmt_usd(req)} | "
            f"{fmt_usd(mark)} | {fmt_usd(delta)} | {esc(r.get('explanation'))} |"
        )
    L.append("")
    return "\n".join(L)


def write_pdoc(path, d):
    pes = d.get("pes", [])
    name = os.path.splitext(os.path.basename(path))[0]
    L = []
    L.append(f"# {name} — Procurement Line Financials")
    L.append("")
    L.append(f"- Source file: `{os.path.basename(path)}`")
    L.append(f"- Service: {esc(d.get('service'))}")
    L.append(f"- Fiscal year: {esc(d.get('fy'))}")
    if d.get("sourceUrl"):
        L.append(f"- Source URL: {esc(d.get('sourceUrl'))}")
    L.append(f"- Lines: {len(pes)}")
    L.append(f"- Exported: {datetime.date.today().isoformat()}")
    L.append("")
    for pe in pes:
        L.append(f"## {esc(pe.get('peCode'))} — {esc(pe.get('title'))}")
        L.append("")
        L.append(f"- Budget Activity: {esc(pe.get('budgetActivity'))}")
        L.append(f"- Line Number: {esc(pe.get('lineNumber'))}")
        if pe.get("programOfRecord"):
            L.append(f"- Program of Record: {esc(pe.get('programOfRecord'))}")
        L.append("")
        fy = pe.get("fyData") or []
        if fy:
            L.append("| FY | Quantity | Request ($K) | Unit Cost ($) |")
            L.append("|----|----------|--------------|---------------|")
            for y in fy:
                L.append(
                    f"| {esc(y.get('fy'))} | {esc(y.get('quantity'))} | "
                    f"{fmt_usd(y.get('requestDollarsThousands'))} | "
                    f"{fmt_usd(y.get('unitCostDollars'))} |"
                )
            L.append("")
    return "\n".join(L)


def main():
    manifest = []
    committee = sorted(glob.glob(os.path.join(DATA, "armed_services_*.json")) +
                       glob.glob(os.path.join(DATA, "ndaa_*.json")))
    pdocs = sorted(glob.glob(os.path.join(DATA, "pdoc_*.json")))

    for path in committee:
        d = json.load(open(path, encoding="utf-8"))
        if "rows" not in d:
            print("SKIP (no rows):", os.path.basename(path)); continue
        md = write_committee(path, d)
        outname = os.path.splitext(os.path.basename(path))[0] + ".md"
        open(os.path.join(OUT, outname), "w", encoding="utf-8").write(md)
        manifest.append((outname, "committee-marks", len(d["rows"])))
        print(f"WROTE {outname}  [committee, {len(d['rows'])} PE lines]")

    for path in pdocs:
        d = json.load(open(path, encoding="utf-8"))
        if "pes" not in d:
            print("SKIP (no pes):", os.path.basename(path)); continue
        md = write_pdoc(path, d)
        outname = os.path.splitext(os.path.basename(path))[0] + ".md"
        open(os.path.join(OUT, outname), "w", encoding="utf-8").write(md)
        manifest.append((outname, "procurement", len(d["pes"])))
        print(f"WROTE {outname}  [pdoc, {len(d['pes'])} lines]")

    # financial index
    idx = ["# Program Element Financial Data — Export Index", "",
           f"Exported {datetime.date.today().isoformat()} from dollar-bearing budget sources.", "",
           "| Markdown File | Type | Lines |", "|---------------|------|-------|"]
    for n, k, c in manifest:
        idx.append(f"| {n} | {k} | {c} |")
    idx.append("")
    idx.append(f"**Total financial sources: {len(manifest)}**")
    open(os.path.join(OUT, "INDEX_FINANCIALS.md"), "w", encoding="utf-8").write("\n".join(idx))
    print(f"\nWROTE INDEX_FINANCIALS.md — {len(manifest)} financial sources")
    print("OUTPUT DIR:", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
