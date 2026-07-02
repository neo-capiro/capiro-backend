#!/usr/bin/env python3
"""Export program element (jbook R-1/R-2) budget data to one Markdown file per source."""
import json, os, glob, datetime

DATA = os.path.join(os.path.dirname(__file__), "..", "__data__")
OUT = os.path.join(os.path.dirname(__file__), "..", "__data__", "pe_md_export")
os.makedirs(OUT, exist_ok=True)


def esc(s):
    if s is None:
        return ""
    return str(s).replace("\r", " ").strip()


def write_r1(path, d):
    rows = d.get("rows", [])
    name = os.path.splitext(os.path.basename(path))[0]
    lines = []
    lines.append(f"# {name} — R-1 Program Element Line List")
    lines.append("")
    lines.append(f"- Source file: `{os.path.basename(path)}`")
    lines.append(f"- Exhibit type: {esc(d.get('docType'))} (R-1)")
    lines.append(f"- Page count: {esc(d.get('pageCount'))}")
    lines.append(f"- Program element rows: {len(rows)}")
    lines.append(f"- Exported: {datetime.date.today().isoformat()}")
    lines.append("")
    lines.append("| Line | PE Code | Title | Budget Activity | Page |")
    lines.append("|------|---------|-------|-----------------|------|")
    for r in rows:
        lines.append(
            f"| {esc(r.get('lineNumber'))} | {esc(r.get('peCode'))} | "
            f"{esc(r.get('title'))} | {esc(r.get('budgetActivity'))} | {esc(r.get('page'))} |"
        )
    lines.append("")
    return "\n".join(lines)


def write_r2(path, d):
    pes = d.get("programElements", [])
    name = os.path.splitext(os.path.basename(path))[0]
    stats = d.get("stats", {}) or {}
    lines = []
    lines.append(f"# {name} — R-2 Program Element Justification")
    lines.append("")
    lines.append(f"- Source file: `{os.path.basename(path)}`")
    lines.append(f"- Exhibit type: {esc(d.get('exhibitType'))}")
    lines.append(f"- Fiscal year: {esc(d.get('fy'))}")
    lines.append(f"- Volume id: {esc(d.get('volumeId'))}")
    if d.get("sourceUrl"):
        lines.append(f"- Source URL: {esc(d.get('sourceUrl'))}")
    lines.append(f"- Page count: {esc(d.get('pageCount'))}")
    lines.append(
        f"- Program elements: {stats.get('program_elements', len(pes))} | "
        f"projects: {stats.get('projects', '?')} | "
        f"pages with exhibits: {stats.get('pages_with_exhibits', '?')}"
    )
    lines.append(f"- Exported: {datetime.date.today().isoformat()}")
    lines.append("")
    lines.append("## Program Element Index")
    lines.append("")
    lines.append("| PE Code | Name | BA | Appropriation | Pages | Projects |")
    lines.append("|---------|------|----|--------------|-------|----------|")
    for pe in pes:
        pages = f"{esc(pe.get('pageStart'))}-{esc(pe.get('pageEnd'))}"
        lines.append(
            f"| {esc(pe.get('peCode'))} | {esc(pe.get('peName'))} | "
            f"{esc(pe.get('budgetActivity'))} | {esc(pe.get('appropriation'))} | "
            f"{pages} | {len(pe.get('projects') or [])} |"
        )
    lines.append("")
    lines.append("## Program Element Detail")
    lines.append("")
    for pe in pes:
        lines.append(f"### {esc(pe.get('peCode'))} — {esc(pe.get('peName'))}")
        lines.append("")
        lines.append(f"- Budget Activity: {esc(pe.get('budgetActivity'))}")
        lines.append(f"- Appropriation: {esc(pe.get('appropriation'))}")
        lines.append(f"- Pages: {esc(pe.get('pageStart'))}-{esc(pe.get('pageEnd'))}")
        lines.append("")
        if pe.get("mission"):
            lines.append("**Mission / Description:**")
            lines.append("")
            lines.append(esc(pe.get("mission")))
            lines.append("")
        projects = pe.get("projects") or []
        if projects:
            lines.append(f"**Projects ({len(projects)}):**")
            lines.append("")
            for pr in projects:
                lines.append(f"#### Project {esc(pr.get('projectCode'))} — {esc(pr.get('title'))}")
                lines.append("")
                if pr.get("page"):
                    lines.append(f"- Page: {esc(pr.get('page'))}")
                    lines.append("")
                if pr.get("mission"):
                    lines.append(esc(pr.get("mission")))
                    lines.append("")
        lines.append("---")
        lines.append("")
    return "\n".join(lines)


def main():
    manifest = []
    files = sorted(glob.glob(os.path.join(DATA, "jbook_r1_*.json")) +
                   glob.glob(os.path.join(DATA, "jbook_r2_*.json")))
    for path in files:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        exhibit = d.get("exhibitType") or d.get("docType")
        if "programElements" in d:
            md = write_r2(path, d)
            kind = "R-2"
            count = len(d.get("programElements", []))
        elif "rows" in d:
            md = write_r1(path, d)
            kind = "R-1"
            count = len(d.get("rows", []))
        else:
            print("SKIP (unknown schema):", os.path.basename(path))
            continue
        outname = os.path.splitext(os.path.basename(path))[0] + ".md"
        outpath = os.path.join(OUT, outname)
        with open(outpath, "w", encoding="utf-8") as f:
            f.write(md)
        manifest.append((outname, kind, count))
        print(f"WROTE {outname}  [{kind}, {count} PEs/rows]")

    # index file
    idx = ["# Program Element Budget Data — Export Index", "",
           f"Exported {datetime.date.today().isoformat()} from jbook R-1/R-2 sources.", "",
           "| Markdown File | Exhibit | PE Count / Rows |",
           "|---------------|---------|-----------------|"]
    for n, k, c in manifest:
        idx.append(f"| {n} | {k} | {c} |")
    idx.append("")
    idx.append(f"**Total sources: {len(manifest)}**")
    with open(os.path.join(OUT, "INDEX.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(idx))
    print(f"\nWROTE INDEX.md — {len(manifest)} sources total")
    print("OUTPUT DIR:", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
