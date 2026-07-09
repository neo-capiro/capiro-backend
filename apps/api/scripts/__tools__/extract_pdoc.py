#!/usr/bin/env python
"""
Offline DoD P-Doc (Procurement budget justification) extractor — Step 27.

Deterministic pdfplumber extraction — same pattern as the R-2 J-book / committee
tools. Turns a Service procurement book PDF (Aircraft/Missile/Weapons/Other
Procurement, Shipbuilding, etc.) into a JSON artifact consumed by
scripts/parse-pdoc-<service>.ts. NO Firecrawl/LLM in the path — the deterministic
pass is the trustworthy one for procurement quantities + dollars.

Usage:
  python extract_pdoc.py BOOK.pdf --service ARMY --fy 2026 \
      --source-url "https://.../Aircraft_Procurement_Army.pdf" \
      --out ../__data__/pdoc_army_aircraft_fy2026.json

Output schema:
  { "service": "ARMY", "fy": 2026, "sourceUrl": "...",
    "pes": [ { peCode, title, budgetActivity, lineNumber, programOfRecord,
               fyData:[{fy,quantity,requestDollarsThousands,unitCostDollars}],
               lineItems:[{description,fy,quantity,dollars}] } ] }

PROCUREMENT-BOOK LAYOUT (what this parses)
==========================================
Procurement justification books are NOT organized by 7-digit + service-letter
RDT&E PE codes. They are organized by *weapon-system line items* identified by a
**P-1 Line Item Number / Budget Line Item Number (BLIN)** — a ~10-character code
such as ``9670A00005`` (MQ-1 UAV) or ``6771AA0005`` (UH-60 Blackhawk). The book
contains, per line item, one **Exhibit P-40 (Budget Line Item Justification)**:

  Exhibit P-40, Budget Line Item Justification: PB 2026 Army  Date: June 2025
  Appropriation / Budget Activity / Budget Sub Activity:   P-1 Line Item Number / Title:
  2031A: Aircraft Procurement, Army / BA 01: Aircraft ...   9670A00005 / MQ-1 UAV
  ...
  Resource Summary            Prior  FY2024  FY2025  FY26 Base  OOC  FY26 Total  FY27 ... Total
  Procurement Quantity ...      322      0       8        -      -        -      ...
  Net Procurement (P-1) ($ in Millions)  4,211.987  -  240.000  ...
  Gross/Weapon System Unit Cost ($ in Thousands)  13,080.705 - 30,000.000 ...
  ...
  LI 9670A00005 - MQ-1 UAV                                      (page footer)

This extractor keys each P-40 exhibit by its BLIN (-> ``peCode``), uses the item
title as ``title``, and reads the labelled Resource Summary rows for the
requested FY (and neighbouring fiscal years) to build ``fyData``:
  - quantity                <- "Procurement Quantity (Units in Each)"
  - requestDollarsThousands <- "Net Procurement (P-1) ($ in Millions)" * 1000
                               (the loader's thousandsToMillions divides by 1000,
                                so we re-express the P-40 millions as thousands to
                                round-trip to the canonical MILLIONS unit)
  - unitCostDollars         <- "Gross/Weapon System Unit Cost ($ in Thousands)"
                               * 1000  (thousands -> dollars)

Child sub-rows (``lineItems``) are taken from the P-40 "Secondary Distribution"
block (per-recipient quantity + obligation authority) when present.

DOLLAR UNITS: P-40 Resource Summary dollar rows are denominated in MILLIONS;
quantities are units; unit cost is in THOUSANDS. We convert to the units the
loader's parser expects (requestDollarsThousands == thousands; unitCostDollars ==
full dollars) so the downstream thousandsToMillions normalisation yields correct
millions. P-1 detail pages (the cross-line summary table) are in THOUSANDS and are
used only as a fallback when no P-40 quantity/dollar is present.

Robust/general across Service procurement books (Aircraft/Missile/Weapons/Other
Procurement, Shipbuilding). BLINs are matched generically (4 digits + 1-2 service
letters + digits), so the same tool handles every Service's P-40 book.
"""
import argparse
import json
import re
import sys

# --- BLIN / P-1 Line Item Number -----------------------------------------
# Army aircraft examples: 9670A00005, 6771AA0005, 3632AZ3504. General DoD form:
# 4 leading digits, a 1-2 char service/sub designator, then digits — 10 chars
# total. Kept permissive (1-2 letters) to cover every Service's procurement book.
BLIN_RE = re.compile(r"^[0-9]{4}[A-Z]{1,2}[0-9A-Z]{4,5}$")
# Footer anchor on every P-40 page: "LI <BLIN> - <Title>"
LI_FOOTER_RE = re.compile(r"\bLI\s+([0-9][0-9A-Z]{8,11})\s*-\s*(.+)$")
# Header line carrying the authoritative "<BLIN> / <Title>" pair.
HEADER_CODE_RE = re.compile(r"\b([0-9]{4}[A-Z]{1,2}[0-9A-Z]{4,5})\s*/\s*(.+)$")

# --- Navy/short-form P-1 line numbers -------------------------------------
# Navy (and Marine Corps) books key P-40s by a SHORT line number within an
# appropriation: footer reads "LI 0145 - FA-18E/F" and the header block carries
# "1506N: Aircraft Procurement, Navy / BA 01: ...". The canonical prod keyspace
# concatenates them (pe_code = <appropriation><line> -> "1506N0145"), so this
# fallback synthesizes exactly that when no long-form BLIN is present.
SHORT_LI_FOOTER_RE = re.compile(r"\bLI\s+(\d{4})\s*-\s*(.+)$")
# Appropriation code, contiguous digits+letters immediately followed by a colon
# ("1506N: Aircraft Procurement, Navy"). Contiguity keeps "PB 2027 Navy Date:"
# and "BA 01:" from matching.
APPROP_RE = re.compile(r"\b(\d{4}[A-Z]{1,2}):")

AMOUNT = r"\(?-?\$?[\d,]+(?:\.\d+)?\)?"
AMOUNT_RE = re.compile(AMOUNT)


def parse_num(token):
    if token is None:
        return None
    t = str(token).strip()
    if not t or t == "-":
        return None
    neg = t.startswith("(") and t.endswith(")")
    cleaned = re.sub(r"[(),$\s]", "", t)
    if cleaned in ("", "-"):
        return None
    try:
        n = float(cleaned)
    except ValueError:
        return None
    n = -n if neg else n
    return int(n) if n == int(n) else n


def _is_p40_page(text):
    return "Exhibit P-40" in text and "Budget Line Item Justification" in text


def _fy_header_columns(words):
    """Map the Resource Summary header columns to {label: x_center}.

    ANCHORED to the actual header row (the one carrying 'Years' + the request-year
    'Base'/'Total' split) so stray 'FY 20xx' tokens in the narrative or on the
    BLIN's other exhibit pages are ignored. Labels:
      ('FY', '2025')           plain fiscal-year columns (prior actuals + FYDP)
      ('BASE',)/('OOC',)/('TOTAL',)  the request-year split; ('TOTAL',) is the
                               FIRST 'Total' (request-year total = Base+OOC),
                               distinct from the rightmost grand total.
      ('PRIOR',)/('COMPLETE',)/('GRANDTOTAL',)  cumulative columns (not emitted).
    """
    def xc(w):
        return (w["x0"] + w["x1"]) / 2.0

    hdr = None
    for r in _group_rows(words):
        s = {w["text"] for w in r}
        if "Years" in s and "Base" in s and "Total" in s:
            hdr = r
            break
    if hdr is None:
        return {}

    cols = {}
    seen_total = 0
    for w in sorted(hdr, key=lambda w: w["x0"]):
        t = w["text"]
        if re.fullmatch(r"20[0-9]{2}", t):
            cols.setdefault(("FY", t), xc(w))
        elif t == "Years":
            cols.setdefault(("PRIOR",), xc(w))
        elif t == "Base":
            cols.setdefault(("BASE",), xc(w))
        elif t == "OOC":
            cols.setdefault(("OOC",), xc(w))
        elif t == "Complete":
            cols.setdefault(("COMPLETE",), xc(w))
        elif t == "Total":
            seen_total += 1
            cols.setdefault(("TOTAL",) if seen_total == 1 else ("GRANDTOTAL",), xc(w))
    return cols


def _row_words(words, top, tol=3.0):
    return sorted((w for w in words if abs(w["top"] - top) <= tol), key=lambda w: w["x0"])


def _group_rows(words, tol=2.5):
    rows = {}
    for w in words:
        key = None
        for k in rows:
            if abs(k - w["top"]) <= tol:
                key = k
                break
        rows.setdefault(key if key is not None else w["top"], []).append(w)
    return [sorted(v, key=lambda x: x["x0"]) for _, v in sorted(rows.items())]


def _nearest_value(num_words, x_center, max_dist=22.0):
    """Pick the numeric token whose right-aligned position is closest to a column
    centre. Budget tables right-align numbers, so compare to the token's x1."""
    best, best_d = None, max_dist
    for w in num_words:
        # right-aligned: column centre roughly tracks the token's right edge minus
        # half its width; comparing to the token centre is close enough at our tol.
        d = abs(((w["x0"] + w["x1"]) / 2.0) - x_center)
        if d < best_d:
            best, best_d = w, d
    return best


def _parse_p40(words, fy):
    """Parse one P-40 exhibit page's word list into (blin, title, fyData rows,
    lineItems). Resource Summary rows are read by FY column geometry."""
    rows = _group_rows(words)

    # --- BLIN + title from the header "<BLIN> / <Title>" (fallback to footer) ---
    blin = title = None
    for r in rows:
        line = " ".join(w["text"] for w in r)
        m = HEADER_CODE_RE.search(line)
        if m and BLIN_RE.match(m.group(1)):
            blin, title = m.group(1), m.group(2).strip()
            break
    if blin is None:
        for r in rows:
            line = " ".join(w["text"] for w in r)
            m = LI_FOOTER_RE.search(line)
            if m:
                blin, title = m.group(1), m.group(2).strip()
                break
    if blin is None or not BLIN_RE.match(blin):
        # Navy/short-form fallback: synthesize <appropriation><line> from the
        # "NNNNX:" appropriation header + the short "LI NNNN - Title" footer.
        approp = short_line = short_title = None
        for r in rows:
            line = " ".join(w["text"] for w in r)
            if approp is None:
                am = APPROP_RE.search(line)
                if am:
                    approp = am.group(1)
            if short_line is None:
                sm = SHORT_LI_FOOTER_RE.search(line)
                if sm:
                    short_line, short_title = sm.group(1), sm.group(2).strip()
            if approp and short_line:
                break
        if approp and short_line:
            blin, title = f"{approp}{short_line}", short_title
        else:
            return None
    # The footer row often carries the page classification marker on the same
    # visual line ("LI 0145 - FA-18E/F   UNCLASSIFIED") — strip it from titles.
    if title:
        title = re.sub(r"\s*UNCLASSIFIED\s*$", "", title).strip()

    # --- locate the FY column x-centres from the Resource Summary header ---
    # The header row reads: ... FY 2024  FY 2025  Base OOC Total  FY 2027 ...
    # Years 2024+ each get a column; the request FY (== fy or fy+0) splits into
    # Base/OOC/Total. We map: request quantity/dollars come from the request-FY
    # "Total" column, prior years from their own year columns.
    # Plain year columns (prior actuals + FYDP out-years) come from ('FY','YYYY').
    # The request/budget year (fy) has NO plain year column — it is the Base/OOC/
    # Total split, so key it off the request-year TOTAL column (Base+OOC). Fall
    # back to a plain year column for books using the older single-column format.
    fycols = _fy_header_columns(words)
    emit_years = {}  # fy_int -> x_center used for quantity/dollars
    for key, xc in fycols.items():
        if key[0] == "FY":
            emit_years[int(key[1])] = xc
    total_x = fycols.get(("TOTAL",))
    request_x = total_x if total_x is not None else fycols.get(("FY", str(fy)))
    if request_x is not None:
        emit_years[fy] = request_x

    if not emit_years:
        return None

    # --- read the labelled Resource Summary rows by geometry ---
    def find_row(label_predicate):
        for r in rows:
            line = " ".join(w["text"] for w in r)
            if label_predicate(line):
                return r
        return None

    def row_numbers(r):
        return [w for w in r if AMOUNT_RE.fullmatch(w["text"]) or w["text"] == "-"]

    qty_row = find_row(lambda s: s.startswith("Procurement Quantity"))
    # Net Procurement (P-1) is the authoritative request dollars (in Millions).
    dol_row = find_row(lambda s: s.startswith("Net Procurement (P-1)"))
    if dol_row is None:
        dol_row = find_row(lambda s: s.startswith("Total Obligation Authority"))
    unit_row = find_row(lambda s: s.startswith("Gross/Weapon System Unit Cost"))

    def val_at(r, x_center):
        if r is None or x_center is None:
            return None
        w = _nearest_value(row_numbers(r), x_center)
        return parse_num(w["text"]) if w is not None else None

    fy_data = []
    for y in sorted(emit_years):
        xc = emit_years[y]
        qty = val_at(qty_row, xc)
        dol_millions = val_at(dol_row, xc)
        unit_thousands = val_at(unit_row, xc)
        # Skip empty out-years (no quantity AND no dollars) — keeps the artifact
        # to fiscal years that actually carry a request/actual.
        if qty is None and dol_millions is None:
            continue
        fy_data.append(
            {
                "fy": y,
                "quantity": qty,
                # Net Procurement is in MILLIONS; loader divides by 1000 -> millions.
                "requestDollarsThousands": None if dol_millions is None else round(dol_millions * 1000, 3),
                # Gross/Weapon System Unit Cost is in THOUSANDS -> express in dollars.
                "unitCostDollars": None if unit_thousands is None else round(unit_thousands * 1000, 3),
            }
        )

    # --- child line items: Secondary Distribution recipients ---------------
    line_items = _parse_secondary_distribution(rows, words, fy)

    return blin, title, fy_data, line_items


def _parse_secondary_distribution(rows, words, fy):
    """The 'Secondary Distribution' block lists per-recipient quantity +
    obligation authority for the request FY. Each named recipient row (e.g.
    'ANG Quantity ...' / 'Army Quantity ...') becomes a child line item.

    Request-year column resolution mirrors the parent Resource Summary parser
    (_fy_header_columns): the request/budget year (fy) has NO bare 'YYYY' token —
    it is the unlabelled Base/OOC/Total split, and its value lives in the FIRST
    'Total' column (Base+OOC), distinct from the rightmost grand total. The old
    SD code looked only for a bare request-year token, so it never resolved the
    request column and dropped every per-recipient quantity/dollar.

    The SD block has its OWN header row with a different column layout than the
    page's Resource Summary table (the request-FY label often sits on a separate
    line above, and the columns read 'FY25 FY26 Base OOC Total FY28 ...'). So we
    resolve the request-year column from the BLOCK's own header (primary), and
    only fall back to the page-level anchored FY header if the block has none.
    Crucially the header columns frequently share the same row as the
    'Secondary Distribution' label, so we parse columns off that row too.
    """
    def parse_header_cols(r):
        """Map a header row's columns -> (cols{key:x_center}, ordered[keys]).
        First 'Total' is the request-year (Base+OOC); subsequent 'Total' is grand.
        `ordered` is the left-to-right sequence of VALUE columns the data rows
        align to: [YYYY..., 'BASE','OOC','TOTAL', YYYY..., 'GRANDTOTAL'?]. Lets us
        pick the request column by POSITION (robust to header/value x-drift, which
        breaks pure nearest-x matching for short quantity tokens)."""
        cols = {}
        ordered = []
        seen_total = 0
        for w in sorted(r, key=lambda w: w["x0"]):
            t = w["text"]
            xc = (w["x0"] + w["x1"]) / 2.0
            if re.fullmatch(r"20[0-9]{2}", t):
                cols.setdefault(int(t), xc); ordered.append(int(t))
            elif t == "Base":
                cols.setdefault(("BASE",), xc); ordered.append(("BASE",))
            elif t == "OOC":
                cols.setdefault(("OOC",), xc); ordered.append(("OOC",))
            elif t == "Total":
                seen_total += 1
                key = ("TOTAL",) if seen_total == 1 else ("GRANDTOTAL",)
                cols.setdefault(key, xc); ordered.append(key)
        return cols, ordered

    # Page-level anchored header (fallback only).
    fycols = _fy_header_columns(words)
    page_request_x = fycols.get(("TOTAL",)) or fycols.get(("FY", str(fy)))

    items = []
    in_block = False
    sd_cols = {}       # the block's OWN header columns (x-centers)
    sd_order = []      # ordered value-column keys from the block header
    for r in rows:
        line = " ".join(w["text"] for w in r).strip()
        low = line.lower()
        if low.startswith("secondary distribution"):
            in_block = True
            # The 'Secondary Distribution' label row usually CARRIES the column
            # headers (Base/OOC/Total + neighbouring FY tokens). Parse them here.
            if not sd_cols and any(w["text"] in ("Base", "Total") for w in r):
                sd_cols, sd_order = parse_header_cols(r)
            continue
        if not in_block:
            continue
        if low.startswith("justification") or low.startswith("description"):
            break
        # A standalone header row inside the block (when the label row didn't
        # carry the columns): "... FY 2025 FY 2026 Base OOC Total FY 2028 ...".
        if not sd_cols and any(w["text"] in ("Base", "Total") for w in r) \
                and not re.match(r"^.*\bQuantity\b", line) \
                and not low.startswith("total obligation"):
            sd_cols, sd_order = parse_header_cols(r)
            continue
        # Request-year column x-center (geometry fallback): block first-Total,
        # then the page-anchored header, then a bare request-FY column.
        def _request_x():
            return sd_cols.get(("TOTAL",)) or page_request_x or sd_cols.get(fy)

        # Index of the request-year Total among the ordered value columns. Data
        # rows align 1:1 with these columns, so picking by INDEX is robust to the
        # x-drift between a header label and its right-aligned values.
        request_idx = sd_order.index(("TOTAL",)) if ("TOTAL",) in sd_order else None

        def pick_value(num_words):
            """Request-year value from a recipient/dollar row's number tokens.
            Prefer positional index (aligns with the header column order); fall
            back to nearest-x if the token count doesn't match the header."""
            if not num_words:
                return None
            if request_idx is not None and len(num_words) > request_idx:
                # Heuristic guard: the data row should have at least as many value
                # tokens as the header has value columns (it usually has exactly
                # that many, sometimes +1 trailing grand total). If far fewer, the
                # row is malformed → fall back to geometry.
                if len(num_words) >= len(sd_order):
                    return parse_num(num_words[request_idx]["text"])
            xc = _request_x()
            if xc is None:
                return None
            w = _nearest_value(num_words, xc)
            return parse_num(w["text"]) if w else None

        def pick_series(num_words):
            """Map a recipient/dollar row's number tokens to {fy: value} across
            ALL fiscal-year columns (prior actuals + request-year Total + FYDP
            out-years), not just the request year. Positional: data tokens align
            1:1 with sd_order columns. Bare-year columns map to that year; the
            request-year split's first 'Total' (Base+OOC) maps to `fy`; Base/OOC
            and the cumulative grand total are skipped. Multi-FY series is what
            lets quantity_change / unit_cost_change deltas compute downstream."""
            series = {}
            if not num_words or not sd_order:
                return series
            if len(num_words) < len(sd_order):
                return series  # malformed row → skip rather than misalign
            for idx, key in enumerate(sd_order):
                if idx >= len(num_words):
                    break
                if isinstance(key, int):
                    year = key
                elif key == ("TOTAL",):
                    year = fy
                else:
                    continue  # BASE / OOC / GRANDTOTAL — not a standalone FY column
                val = parse_num(num_words[idx]["text"])
                if val is not None:
                    series[year] = val
            return series

        # Recipient rows: "<Recipient> Quantity <nums>" then "Total Obligation
        # Authority <nums>". We pair them by the recipient label preceding Quantity.
        m = re.match(r"^(.*?)\s+Quantity\b", line)
        if m and "total:" not in low:
            recipient = m.group(1).strip()
            if recipient and recipient.lower() not in ("total",):
                nums = [w for w in r if AMOUNT_RE.fullmatch(w["text"]) or w["text"] == "-"]
                qty_req = pick_value(nums)        # request-year (back-compat)
                qty_series = pick_series(nums)    # full FY series
                items.append(
                    {
                        "_recipient": recipient,
                        "quantity": qty_req,
                        "dollars": None,
                        "_qtySeries": qty_series,
                        "_dolSeries": {},
                    }
                )
        elif low.startswith("total obligation authority") and items:
            nums = [w for w in r if AMOUNT_RE.fullmatch(w["text"]) or w["text"] == "-"]
            d_req = pick_value(nums)
            d_series = pick_series(nums)
            # attach to the most recent recipient lacking dollars
            for it in reversed(items):
                if it["dollars"] is None and not it["_dolSeries"]:
                    # Secondary Distribution dollars are in MILLIONS -> express full dollars.
                    it["dollars"] = None if d_req is None else round(d_req * 1_000_000, 2)
                    it["_dolSeries"] = {
                        y: round(v * 1_000_000, 2) for y, v in d_series.items()
                    }
                    break

    out = []
    for it in items:
        # Emit ONE line item per (recipient, fy) across the union of years seen in
        # the quantity and dollar series — so the SD panel shows multi-year trends
        # and the delta engine can diff consecutive FYs. The request-year row keeps
        # carrying the scalar quantity/dollars for back-compat readers.
        years = sorted(set(it["_qtySeries"]) | set(it["_dolSeries"]))
        if not years:
            # No series resolved (e.g. malformed) — fall back to the request-year row.
            out.append(
                {
                    "description": it["_recipient"],
                    "fy": fy,
                    "quantity": it["quantity"],
                    "dollars": it["dollars"],
                }
            )
            continue
        for y in years:
            out.append(
                {
                    "description": it["_recipient"],
                    "fy": y,
                    "quantity": it["_qtySeries"].get(y),
                    "dollars": it["_dolSeries"].get(y),
                }
            )
    return out


def extract(pdf_path, service, fy, source_url):
    import pdfplumber

    # Accumulate per-BLIN: a BLIN's P-40 may span several pages; merge fyData
    # (request page wins) and union line items.
    by_blin = {}
    order = []

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            if not _is_p40_page(text):
                continue
            words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
            parsed = _parse_p40(words, fy)
            if parsed is None:
                continue
            blin, title, fy_data, line_items = parsed

            if blin not in by_blin:
                # Derive budget activity from the appropriation header if present.
                ba = None
                m = re.search(r"\bBA\s*([0-9]{1,2})\b", text)
                if m:
                    ba = f"BA {m.group(1)}"
                by_blin[blin] = {
                    "peCode": blin,
                    "title": title,
                    "budgetActivity": ba,
                    "lineNumber": blin,
                    "programOfRecord": None,
                    "fyData": [],
                    "lineItems": [],
                    "_fy_seen": set(),
                }
                order.append(blin)

            entry = by_blin[blin]
            if not entry["title"] and title:
                entry["title"] = title
            # Merge fyData: first non-empty row per FY wins (the request page is
            # encountered first and carries the canonical figures).
            for row in fy_data:
                if row["fy"] not in entry["_fy_seen"]:
                    entry["fyData"].append(row)
                    entry["_fy_seen"].add(row["fy"])
            # Union line items by (description, fy).
            seen_li = {(li["description"], li["fy"]) for li in entry["lineItems"]}
            for li in line_items:
                key = (li["description"], li["fy"])
                if key not in seen_li and li["description"]:
                    entry["lineItems"].append(li)
                    seen_li.add(key)

    pes = []
    for blin in order:
        e = by_blin[blin]
        e.pop("_fy_seen", None)
        # keep only entries that resolved to a usable title
        pes.append(e)

    return {"service": service, "fy": fy, "sourceUrl": source_url, "pes": pes}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--service", required=True, choices=["ARMY", "NAVY", "AF", "SF", "USMC", "DW", "DARPA"])
    ap.add_argument("--fy", type=int, required=True)
    ap.add_argument("--source-url", default="")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    result = extract(args.pdf, args.service, args.fy, args.source_url)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    print(f"extracted {len(result['pes'])} procurement line items (BLINs) -> {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
