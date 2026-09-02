#!/usr/bin/env python3
"""Offline positional extractor for official House CPF / Senate CDS tables.

Usage:
  python extract_cpf_cds_pdf.py --profile house|house_location|senate|auto input.pdf output.json

Profiles (y-midpoint bounds, high→low; words filtered to the table x-band):
  house            Agency|Account|Recipient|Project|Location|Amount|Requestor
                   (CJS-style recipient-first; verified on FY2026 CJS fixture + FY2027 tables)
  house_location   Agency|Account|Location|Recipient|Project|Amount|Requestor
                   (Agriculture-style location-before-recipient; FY2024–FY2026 posted tables)
  senate           Account|State|Project|Recipient|Amount|Requestor
                   (Senate CDS recommendation tables; verified FY2025–FY2026 AG/CJS)
  senate_joint     header-driven, dynamic column count (Agency?|Account?|Project|Recipient|
                   Location/State?|Amount|Requestor(s)|Origination House/Senate)
                   (Senate ENACTED joint appropriations tables — Phase 7/8 gap investigation,
                   FY22/FY24 zero-row documents. Header labels are read directly off page 1/2
                   text rather than hardcoded per-subcommittee pixel bounds, because the same
                   document family publishes ~8 different column orderings across
                   subcommittees. INVESTIGATIVE ONLY — NOT wired into `auto` and NOT invoked by
                   run-cpf-cds-campaign.ts. Real-data spot checks (FY22 Agriculture, FY24
                   MilCon-VA/Interior/FSGG) show it locates the right row boundaries and amount
                   column reliably, but wrapped multi-line cells frequently cross-contaminate
                   adjacent columns (Account text bleeding into Project, Agency losing its
                   continuation line) — accurate enough to prove these documents contain
                   material, non-duplicate canonical rows (Phase 7's classification question)
                   but NOT accurate enough to trust as canonical ingestion without further
                   column-boundary work. See community-funding.senate-joint.spec.ts for the
                   real-data findings and docs/runbooks/cpf-cds-production-ingestion.md Section
                   B for the residual gap this leaves. Also does NOT cover the LHHS-style
                   "Agency|Account|Project Description|Requestor(s)|Amount|Origination" layout
                   (no Recipient/Location/State columns at all) — a third, distinct layout.)

`--profile auto` scores each named profile by valid-amount row yield and writes the winner.
Coordinates, not newline guessing, prevent column shifting. Prefer pymupdf over pdfplumber
(rotated tables). OCR is intentionally unsupported.
"""
from __future__ import annotations
import argparse, json, re
from pathlib import Path
import pymupdf

# bounds: descending y cut-points defining N columns (len = N+1)
PROFILES = {
    # recipient-first (existing production profile)
    "house": {
        "bounds": [692, 666, 625, 510, 290, 235, 190, 145],
        "amount_idx": 5,
        "chamber": "house",
        "layout": "recipient_first",
        "x_band": (185, 535),
    },
    # location-before-recipient (House AG/THUD-style posted tables FY24–26)
    "house_location": {
        "bounds": [700, 600, 520, 450, 360, 250, 200, 145],
        "amount_idx": 5,
        "chamber": "house",
        "layout": "location_first",
        "x_band": (160, 520),
    },
    # Senate CDS recommendation (existing)
    "senate": {
        "bounds": [692, 530, 505, 375, 245, 195, 145],
        "amount_idx": 4,
        "chamber": "senate",
        "layout": "senate_cds",
        "x_band": (185, 535),
    },
}

SENATE_JOINT_HEADER_LABELS = [
    'Agency', 'Account', 'Project', 'Recipient', 'Location', 'State',
    'Amount', 'Amount Provided', 'Requestor(s)', 'Origination', 'House', 'Senate',
]
SENATE_JOINT_AMOUNT_RE = re.compile(r'^\$?\(?-?\d[\d,]*(?:\.\d{1,2})?\)?$')

AMOUNT = re.compile(r"^\$?\(?-?\d[\d,]*(?:\.\d{1,2})?\)?$")


def _detect_senate_joint_header(page) -> dict[str, float] | None:
    """Locate the joint-table header row's TEXT on this page and return
    {label: y_mid}. Header labels are always present verbatim on the page
    that starts a subcommittee section; different subcommittees use
    different subsets/orders, so this reads the actual words rather than
    assuming fixed pixel bounds."""
    words = page.get_text("words")
    found: dict[str, float] = {}
    for w in words:
        label = w[4]
        if label == "Amount" and any(
            ww[4] == "Provided" for ww in words if abs(ww[0] - w[0]) < 2 and ww[1] < w[1]
        ):
            label = "Amount Provided"
        if label in SENATE_JOINT_HEADER_LABELS and w[0] < 200:
            y_mid = (w[1] + w[3]) / 2
            found.setdefault(label, y_mid)
    if "Amount" not in found and "Amount Provided" not in found:
        return None
    if "Recipient" not in found and "Project" not in found:
        return None
    return found


def _extract_senate_joint(path: Path) -> dict:
    """Header-driven extractor for the Senate ENACTED joint (House+Senate
    origination) appropriations tables. See module docstring for the
    documents this targets and the layout it explicitly does not cover.
    """
    with pymupdf.open(path) as doc:
        page_count = len(doc)
        header = None
        for page in doc[:2]:
            header = _detect_senate_joint_header(page)
            if header:
                break
        if not header:
            return {
                "schemaVersion": 1,
                "profile": "senate_joint",
                "sourceFile": path.name,
                "pageCount": page_count,
                "rows": [],
                "warnings": [{"page": 1, "row": 0, "reason": "no recognizable joint-table header found", "columns": []}],
                "extraction": {"library": "pymupdf", "method": "positioned-words-header-driven-v1"},
            }

        amount_label = "Amount Provided" if "Amount Provided" in header else "Amount"
        ordered = sorted(header.items(), key=lambda kv: -kv[1])
        labels = [k for k, _ in ordered]
        bounds = [y + 20 for _, y in ordered] + [ordered[-1][1] - 20]
        amount_col_idx = labels.index(amount_label)

        rows, warnings = [], []
        for page_no, page in enumerate(doc, 1):
            words = [w for w in page.get_text("words") if w[0] > 195]
            xs = sorted(set(round(w[0], 1) for w in words))
            starts = []
            lo, hi = bounds[amount_col_idx + 1], bounds[amount_col_idx]
            for x in xs:
                line = [w for w in words if abs(w[0] - x) < 0.35]
                if any(
                    lo < (w[1] + w[3]) / 2 <= hi and SENATE_JOINT_AMOUNT_RE.match(w[4].lstrip("$"))
                    for w in line
                ):
                    starts.append(x)
            starts = sorted(set(starts))
            for idx, start in enumerate(starts):
                end = starts[idx + 1] if idx + 1 < len(starts) else 700
                segment = [w for w in words if start - 0.8 <= w[0] < end - 0.8]
                cols = []
                for i in range(len(labels)):
                    clo, chi = bounds[i + 1], bounds[i]
                    cell_words = [w for w in segment if clo < (w[1] + w[3]) / 2 <= chi]
                    ordered_words = sorted(cell_words, key=lambda w: (round(w[0], 1), -w[1]))
                    text = " ".join(w[4] for w in ordered_words)
                    text = re.sub(r"-\s+(?=[a-z])", "", text)
                    text = re.sub(r"\s+", " ", text).strip()
                    cols.append(text)
                amt = cols[amount_col_idx].lstrip("$").strip()
                if not SENATE_JOINT_AMOUNT_RE.match(amt):
                    warnings.append({"page": page_no, "row": idx + 1, "reason": "no valid amount", "columns": cols})
                    continue
                rows.append({"page": page_no, "row": idx + 1, "columns": cols, "labels": labels})
        return {
            "schemaVersion": 1,
            "profile": "senate_joint",
            "headerLabels": labels,
            "sourceFile": path.name,
            "pageCount": page_count,
            "rows": rows,
            "warnings": warnings,
            "extraction": {"library": "pymupdf", "method": "positioned-words-header-driven-v1"},
        }


def join_words(words):
    # Rotated tables advance down the page on x; within each visual line they
    # advance right-to-left on y. Preserve both dimensions for wrapped cells.
    text = " ".join(w[4] for w in sorted(words, key=lambda w: (round(w[0], 1), -w[1])))
    text = re.sub(r"-\s+(?=[a-z])", "", text)  # join printed line-wrap hyphenation
    text = re.sub(r"\.{2,}", "", text)         # remove table dot leaders
    return re.sub(r"\s+", " ", text).strip()


def _extract_with(path: Path, profile_name: str) -> dict:
    cfg = PROFILES[profile_name]
    bounds = cfg["bounds"]
    amount_idx = cfg["amount_idx"]
    x0, x1 = cfg["x_band"]
    rows, warnings = [], []
    with pymupdf.open(path) as doc:
        page_count = len(doc)
        for page_no, page in enumerate(doc, 1):
            words = [w for w in page.get_text("words") if x0 <= w[0] <= x1]
            starts = []
            # A canonical row starts where the leftmost account/agency column and
            # the state/account neighbor both have words at the same rotated x.
            xs = sorted(set(round(w[0], 1) for w in words))
            for x in xs:
                line = [w for w in words if abs(w[0] - x) < 0.35]
                occupied = []
                for i in range(len(bounds) - 1):
                    occupied.append(any(bounds[i + 1] < (w[1] + w[3]) / 2 <= bounds[i] for w in line))
                if occupied[0] and occupied[1]:
                    starts.append(x)
            starts = sorted(set(starts))
            for idx, start in enumerate(starts):
                end = starts[idx + 1] if idx + 1 < len(starts) else x1
                segment = [w for w in words if start - 0.8 <= w[0] < end - 0.8]
                cols = []
                for i in range(len(bounds) - 1):
                    cols.append(
                        join_words(
                            [w for w in segment if bounds[i + 1] < (w[1] + w[3]) / 2 <= bounds[i]]
                        )
                    )
                # Long Senate surnames can cross the printed amount/requestor
                # boundary. The amount grammar gives us a safe split.
                spill = re.match(r"^(\$?\(?-?\d[\d,]*(?:\.\d{1,2})?\)?)\s+(.+)$", cols[amount_idx])
                if cfg["chamber"] == "senate" and spill:
                    cols[amount_idx] = spill.group(1)
                    cols[5] = f"{spill.group(2)} {cols[5]}".strip()
                if not any(cols):
                    continue
                if not AMOUNT.match(cols[amount_idx]):
                    warnings.append(
                        {
                            "page": page_no,
                            "row": idx + 1,
                            "reason": "positional segment has no valid amount",
                            "columns": cols,
                        }
                    )
                    continue
                # Normalize house_location → recipient_first column order expected by Nest parser.
                if cfg["layout"] == "location_first":
                    # Agency, Account, Location, Recipient, Project, Amount, Requestor
                    # → Agency, Account, Recipient, Project, Location, Amount, Requestor
                    agency, account, location, recipient, project, amount, requestor = cols
                    cols = [agency, account, recipient, project, location, amount, requestor]
                rows.append({"page": page_no, "row": idx + 1, "columns": cols})
    return {
        "schemaVersion": 1,
        "profile": profile_name if cfg["layout"] != "location_first" else "house",
        "profileSelected": profile_name,
        "layout": cfg["layout"],
        "chamberHint": cfg["chamber"],
        "sourceFile": path.name,
        "pageCount": page_count,
        "rows": rows,
        "warnings": warnings,
        "extraction": {
            "library": "pymupdf",
            "method": "positioned-words-v1",
            "profileBounds": bounds,
        },
    }


_STATE = re.compile(r"\b[A-Z]{2}\b")
_LOC_CITY_STATE = re.compile(
    r".+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?$"
)


def _quality(art: dict) -> float:
    """Structural quality in [0,1] used to break pure row-count ties in auto mode."""
    rows = art.get("rows") or []
    if not rows:
        return 0.0
    layout = art.get("layout")
    chamber = art.get("chamberHint")
    good = 0
    for r in rows[: min(80, len(rows))]:
        cols = r["columns"]
        if chamber == "house" and len(cols) == 7:
            location = cols[4]
            recipient = cols[2]
            # location should look like City, ST; recipient should not be a bare state code
            if _LOC_CITY_STATE.match(location or "") and recipient and not re.fullmatch(r"[A-Z]{2}", recipient):
                good += 1
            elif location and recipient:
                good += 0.25
        elif chamber == "senate" and len(cols) == 6:
            state = cols[1]
            if re.fullmatch(r"[A-Z]{2}", (state or "").strip()):
                good += 1
            elif state:
                good += 0.2
    return good / min(80, len(rows))


def extract(path: Path, profile: str) -> dict:
    if profile == "senate_joint":
        return _extract_senate_joint(path)
    if profile != "auto":
        if profile not in PROFILES:
            raise SystemExit(f"unknown profile {profile}; choose from {list(PROFILES)+['auto', 'senate_joint']}")
        return _extract_with(path, profile)

    # NOTE: `auto` intentionally does NOT fall back to senate_joint. The
    # header-driven joint-table extractor is investigative/POC only (Phase
    # 7/8 gap analysis) — real-data spot checks show column cross-talk on
    # wrapped multi-line cells (e.g. Account text bleeding into Project,
    # Agency text losing its "Animal and " / "Service" wrap segments). That
    # is not clean enough to trust as canonical ingestion; wiring it into
    # `auto` would let campaign runs silently write corrupted canonical rows.
    # Invoke `--profile senate_joint` explicitly for investigation only,
    # never from run-cpf-cds-campaign.ts. See docs/runbooks/
    # cpf-cds-production-ingestion.md Section B for the residual gap this
    # leaves and community-funding.senate-joint.spec.ts for the accuracy
    # findings that justified keeping this out of the automated path.
    scored = []
    for name in PROFILES:
        art = _extract_with(path, name)
        rows = len(art["rows"])
        warns = len(art["warnings"])
        q = _quality(art)
        # Weight by structural quality so a wrong layout cannot win on raw
        # row count alone (e.g. house_location on a recipient-first table).
        # Floor of 0.15 keeps a zero-quality profile from total exclusion
        # when it is the only one emitting rows.
        weighted = rows * (0.15 + 0.85 * q)
        score = int(weighted * 1000) - warns
        scored.append((score, rows, warns, q, name, art))
    scored.sort(key=lambda t: t[0], reverse=True)
    best = scored[0][5]
    best["autoCandidates"] = [
        {
            "profile": name,
            "rows": rows,
            "warnings": warns,
            "quality": round(q, 3),
            "score": score,
        }
        for score, rows, warns, q, name, _ in scored
    ]
    return best


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--profile", choices=list(PROFILES) + ["auto", "senate_joint"], required=True)
    p.add_argument("input", type=Path)
    p.add_argument("output", type=Path)
    args = p.parse_args()
    artifact = extract(args.input, args.profile)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(artifact, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "rows": len(artifact["rows"]),
                "warnings": len(artifact["warnings"]),
                "pages": artifact["pageCount"],
                "profile": artifact.get("profileSelected", artifact["profile"]),
                "layout": artifact.get("layout"),
            }
        )
    )


if __name__ == "__main__":
    main()
