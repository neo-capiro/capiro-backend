#!/usr/bin/env python3
"""Offline positional extractor for official House CPF / Senate CDS tables.

Usage: python extract_cpf_cds_pdf.py --profile house|senate input.pdf output.json
The PDFs are landscape tables encoded as rotated text. pymupdf preserves natural
glyph order; coordinates, rather than newline guessing, prevent column shifting.
"""
from __future__ import annotations
import argparse, json, re
from pathlib import Path
import pymupdf

PROFILES = {
    "house": [692, 666, 625, 510, 290, 235, 190, 145],
    "senate": [692, 530, 505, 375, 245, 195, 145],
}
AMOUNT = re.compile(r"^\$?\(?-?\d[\d,]*(?:\.\d{1,2})?\)?$")

def join_words(words):
    # Rotated tables advance down the page on x; within each visual line they
    # advance right-to-left on y. Preserve both dimensions for wrapped cells.
    text = " ".join(w[4] for w in sorted(words, key=lambda w: (round(w[0], 1), -w[1])))
    text = re.sub(r"-\s+(?=[a-z])", "", text)  # join printed line-wrap hyphenation
    text = re.sub(r"\.{2,}", "", text)         # remove table dot leaders
    return re.sub(r"\s+", " ", text).strip()

def extract(path: Path, profile: str):
    bounds = PROFILES[profile]
    rows, warnings = [], []
    with pymupdf.open(path) as doc:
        for page_no, page in enumerate(doc, 1):
            words = [w for w in page.get_text("words") if 185 <= w[0] <= 535]
            starts = []
            # A canonical row starts where the leftmost account/agency column and
            # the state/account neighbor both have words at the same rotated x.
            xs = sorted(set(round(w[0], 1) for w in words))
            for x in xs:
                line = [w for w in words if abs(w[0] - x) < 0.35]
                occupied = []
                for i in range(len(bounds)-1):
                    occupied.append(any(bounds[i+1] < (w[1]+w[3])/2 <= bounds[i] for w in line))
                if occupied[0] and occupied[1]: starts.append(x)
            starts = sorted(set(starts))
            for idx, start in enumerate(starts):
                end = starts[idx+1] if idx+1 < len(starts) else 535
                segment = [w for w in words if start - .8 <= w[0] < end - .8]
                cols = []
                for i in range(len(bounds)-1):
                    cols.append(join_words([w for w in segment if bounds[i+1] < (w[1]+w[3])/2 <= bounds[i]]))
                amount_idx = 5 if profile == "house" else 4
                # Long Senate surnames can cross the printed amount/requestor
                # boundary. The amount grammar gives us a safe split; guessing
                # based on word count would risk a silent column shift.
                spill = re.match(r"^(\$?\(?-?\d[\d,]*(?:\.\d{1,2})?\)?)\s+(.+)$", cols[amount_idx])
                if profile == "senate" and spill:
                    cols[amount_idx] = spill.group(1)
                    cols[5] = f"{spill.group(2)} {cols[5]}".strip()
                if not any(cols):
                    continue
                if not AMOUNT.match(cols[amount_idx]):
                    warnings.append({"page": page_no, "row": idx+1, "reason": "positional segment has no valid amount", "columns": cols})
                    continue
                rows.append({"page": page_no, "row": idx+1, "columns": cols})
    return {"schemaVersion": 1, "profile": profile, "sourceFile": path.name,
            "pageCount": len(pymupdf.open(path)), "rows": rows, "warnings": warnings,
            "extraction": {"library": "pymupdf", "method": "positioned-words-v1"}}

def main():
    p = argparse.ArgumentParser(); p.add_argument("--profile", choices=PROFILES, required=True)
    p.add_argument("input", type=Path); p.add_argument("output", type=Path); args = p.parse_args()
    artifact = extract(args.input, args.profile)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(artifact, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"rows": len(artifact["rows"]), "warnings": len(artifact["warnings"]), "pages": artifact["pageCount"]}))
if __name__ == "__main__": main()
