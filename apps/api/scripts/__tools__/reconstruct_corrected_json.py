#!/usr/bin/env python3
"""Reconstruct load-ready JSON artifacts from the CORRECTED financial Markdown exports.

Reads the files named in INDEX_FINANCIALS.md and rebuilds the exact JSON shapes the
Aurora loaders consume:
  - armed_services_* -> {chamber, fy, source, rows:[{peCode,fy,request,mark,explanation}]}
  - ndaa_*           -> {fy, stage, source, rows:[{peCode,fy,request,mark,explanation}]}
  - pdoc_*           -> {service, fy, sourceUrl, pes:[{peCode,title,budgetActivity,
                          lineNumber,programOfRecord,fyData:[{fy,quantity,
                          requestDollarsThousands,unitCostDollars}]}]}

Every artifact is VERIFIED against the MD header (row/line counts + dollar totals) before
being written. Nonzero exit on any mismatch. Writes *_corrected.json next to the loaders'
data dir. Does NOT touch the database.
"""
import json, os, re, sys, glob

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "__data__"))
MD = os.path.join(DATA, "pe_md_export")
OUT = os.path.join(DATA, "corrected_json")
os.makedirs(OUT, exist_ok=True)

INDEX = os.path.join(MD, "INDEX_FINANCIALS.md")


def dollars(s):
    s = (s or "").strip()
    if s in ("", "-", "—", "n/a", "N/A"):
        return None
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    s = s.replace("$", "").replace(",", "").strip()
    if s == "":
        return None
    v = float(s) if "." in s else int(s)
    return -v if neg else v


def header_val(lines, label):
    for ln in lines:
        m = re.match(rf"\s*-\s*{re.escape(label)}\s*:\s*(.*)", ln)
        if m:
            return m.group(1).strip()
    return None


def header_int(lines, label):
    v = header_val(lines, label)
    if v is None:
        return None
    m = re.search(r"-?[\d,]+", v)
    return int(m.group(0).replace(",", "")) if m else None


def header_usd(lines, label):
    v = header_val(lines, label)
    if v is None:
        return None
    m = re.search(r"\$[\d,]+", v)
    return int(m.group(0).replace("$", "").replace(",", "")) if m else None


def parse_committee(path):
    text = open(path, encoding="utf-8").read()
    lines = text.splitlines()
    src_file = (header_val(lines, "Source file") or "").strip("`")
    stage = header_val(lines, "Stage / chamber")
    fy = header_int(lines, "Fiscal year")
    source = header_val(lines, "Source")
    exp_lines = header_int(lines, "PE lines")
    exp_req = header_usd(lines, "Total request")
    exp_mark = header_usd(lines, "Total mark")

    rows = []
    for ln in lines:
        if not ln.startswith("|"):
            continue
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        if len(cells) < 6:
            continue
        if cells[0] in ("PE Code", "") or set(cells[0]) <= set("-"):
            continue
        pe, fycell, req, mark, _delta, desc = cells[:6]
        if not re.match(r"^[0-9A-Za-z]", pe):
            continue
        rows.append({
            "peCode": pe,
            "fy": int(fycell) if fycell.isdigit() else fy,
            "request": dollars(req),
            "mark": dollars(mark),
            "explanation": desc,
        })

    got_req = sum((r["request"] or 0) for r in rows)
    got_mark = sum((r["mark"] or 0) for r in rows)
    problems = []
    if exp_lines is not None and len(rows) != exp_lines:
        problems.append(f"row count {len(rows)} != header PE lines {exp_lines}")
    if exp_req is not None and got_req != exp_req:
        problems.append(f"sum(request) {got_req} != header total {exp_req}")
    if exp_mark is not None and got_mark != exp_mark:
        problems.append(f"sum(mark) {got_mark} != header total {exp_mark}")

    base = os.path.basename(path)
    is_ndaa = base.startswith("ndaa")
    if is_ndaa:
        artifact = {"fy": fy, "stage": stage, "source": source, "rows": rows}
    else:
        artifact = {"chamber": stage, "fy": fy, "source": source, "rows": rows}
    return artifact, src_file, problems, {"rows": len(rows), "request": got_req, "mark": got_mark}


def parse_pdoc(path):
    text = open(path, encoding="utf-8").read()
    lines = text.splitlines()
    src_file = (header_val(lines, "Source file") or "").strip("`")
    service = header_val(lines, "Service")
    fy = header_int(lines, "Fiscal year")
    source_url = header_val(lines, "Source URL")
    exp_lines = header_int(lines, "Lines")

    pes = []
    cur = None
    for ln in lines:
        h = re.match(r"^##\s+(\S+)\s+—\s+(.*)$", ln)
        if h:
            if cur:
                pes.append(cur)
            cur = {"peCode": h.group(1), "title": h.group(2).strip(),
                   "budgetActivity": None, "lineNumber": None,
                   "programOfRecord": None, "fyData": []}
            continue
        if cur is None:
            continue
        ba = re.match(r"\s*-\s*Budget Activity:\s*(.*)", ln)
        if ba:
            cur["budgetActivity"] = ba.group(1).strip() or None
            continue
        lnum = re.match(r"\s*-\s*Line Number:\s*(.*)", ln)
        if lnum:
            cur["lineNumber"] = lnum.group(1).strip() or None
            continue
        por = re.match(r"\s*-\s*Program of Record:\s*(.*)", ln)
        if por:
            cur["programOfRecord"] = por.group(1).strip() or None
            continue
        if ln.startswith("|"):
            cells = [c.strip() for c in ln.strip().strip("|").split("|")]
            if len(cells) < 4 or cells[0] in ("FY", "") or set(cells[0]) <= set("-"):
                continue
            fycell, qty, req, unit = cells[:4]
            if not fycell.isdigit():
                continue
            cur["fyData"].append({
                "fy": int(fycell),
                "quantity": int(qty) if qty.lstrip("-").isdigit() else (dollars(qty) if qty else None),
                "requestDollarsThousands": dollars(req),
                "unitCostDollars": dollars(unit),
            })
    if cur:
        pes.append(cur)

    problems = []
    if exp_lines is not None and len(pes) != exp_lines:
        problems.append(f"pe count {len(pes)} != header Lines {exp_lines}")
    # FY-year line total cross-check if present
    m = re.search(r"FY(\d{4}) line-item total:\s*\$?([\d,]+)K", text)
    if m:
        yr, tot = int(m.group(1)), int(m.group(2).replace(",", ""))
        got = sum((y["requestDollarsThousands"] or 0) for pe in pes for y in pe["fyData"] if y["fy"] == yr)
        if got != tot:
            problems.append(f"FY{yr} line total {got}K != header {tot}K")

    artifact = {"service": service, "fy": fy, "sourceUrl": source_url, "pes": pes}
    return artifact, src_file, problems, {"pes": len(pes)}


def index_files():
    files = []
    for ln in open(INDEX, encoding="utf-8"):
        m = re.match(r"\|\s*(\S+\.md)\s*\|", ln)
        if m and not m.group(1).lower().startswith("markdown"):
            files.append(m.group(1))
    return files


def main():
    referenced = index_files()
    print(f"INDEX references {len(referenced)} files\n")
    all_ok = True
    summary = []
    for name in referenced:
        path = os.path.join(MD, name)
        if not os.path.exists(path):
            print(f"MISSING: {name}"); all_ok = False; continue
        if name.startswith("pdoc"):
            artifact, src_file, problems, stats = parse_pdoc(path)
        else:
            artifact, src_file, problems, stats = parse_committee(path)
        # output name mirrors the ORIGINAL loader artifact filename (src_file), so the
        # loaders can be pointed straight at it.
        out_name = src_file.replace(".json", "") + "_corrected.json" if src_file else name.replace(".md", ".json")
        out_path = os.path.join(OUT, out_name)
        status = "OK" if not problems else "FAIL"
        if problems:
            all_ok = False
        else:
            json.dump(artifact, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        summary.append((name, out_name, status, stats, problems))
        print(f"[{status}] {name}  ->  {out_name}  {stats}")
        for p in problems:
            print(f"        ! {p}")
    print("\n" + ("ALL ARTIFACTS VERIFIED & WRITTEN" if all_ok else "VERIFICATION FAILED — no bad artifact trusted"))
    print("OUTPUT DIR:", OUT)
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
