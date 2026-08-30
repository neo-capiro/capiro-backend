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

AMOUNT = re.compile(r"^\$?\(?-?\d[\d,]*(?:\.\d{1,2})?\)?$")


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
    if profile != "auto":
        if profile not in PROFILES:
            raise SystemExit(f"unknown profile {profile}; choose from {list(PROFILES)+['auto']}")
        return _extract_with(path, profile)

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
    p.add_argument("--profile", choices=list(PROFILES) + ["auto"], required=True)
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
