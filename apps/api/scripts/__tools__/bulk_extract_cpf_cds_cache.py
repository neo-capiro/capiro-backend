#!/usr/bin/env python3
"""Offline bulk-extract for a CPF/CDS campaign work-dir.

ONE python process — avoids Windows STATUS_DLL_INIT_FAILED from rapid
sequential python.exe + pymupdf spawns.

  python bulk_extract_cpf_cds_cache.py <work-dir> [--force] [--limit N]
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_extractor():
    path = HERE / "extract_cpf_cds_pdf.py"
    spec = importlib.util.spec_from_file_location("extract_cpf_cds_pdf", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("work_dir")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    root = Path(args.work_dir)
    if not root.is_dir():
        print(json.dumps({"error": f"work_dir not found: {root}"}))
        return 2

    mod = load_extractor()
    pdfs = sorted(root.rglob("source.pdf"))
    print(json.dumps({"event": "start", "pdfs": len(pdfs), "force": args.force}), flush=True)

    ok = skip = fail = 0
    t0 = time.time()
    for i, pdf in enumerate(pdfs):
        if args.limit and i >= args.limit:
            break
        out = pdf.with_name("rows.json")
        # Infer chamber from cache path: .../house/fyYYYY/... or .../senate/fyYYYY/...
        parts = {p.lower() for p in pdf.parts}
        if "senate" in parts:
            preferred = "senate"
        elif "house" in parts:
            preferred = "auto"  # house_location vs house resolved by quality-weighted auto
        else:
            preferred = "auto"
        # If cached rows exist but were extracted under the wrong chamber profile, redo.
        force_this = args.force
        if out.exists() and out.stat().st_size > 50 and not force_this:
            try:
                cached = json.loads(out.read_text(encoding="utf-8"))
                prof = str(cached.get("profileSelected") or cached.get("profile") or "")
                if preferred == "senate" and not prof.startswith("senate"):
                    force_this = True
                elif preferred != "senate" and prof.startswith("senate") and "house" in parts:
                    force_this = True
            except Exception:
                force_this = True
        if out.exists() and out.stat().st_size > 50 and not force_this:
            skip += 1
            if i % 25 == 0:
                print(json.dumps({"event": "skip", "i": i, "path": str(pdf)}), flush=True)
            continue
        try:
            # extract() expects pathlib.Path (uses path.name in _extract_with)
            art = mod.extract(pdf, preferred)
            # Senate chamber path must not keep a house* profile winner.
            if preferred == "senate":
                prof = str(art.get("profileSelected") or art.get("profile") or "")
                if not prof.startswith("senate"):
                    art = mod.extract(pdf, "senate")
            out.write_text(json.dumps(art, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            ok += 1
            print(
                json.dumps(
                    {
                        "event": "ok",
                        "i": i,
                        "path": str(pdf),
                        "rows": len(art.get("rows") or []),
                        "warnings": len(art.get("warnings") or []),
                        "pages": art.get("pageCount"),
                        "profile": art.get("profileSelected", art.get("profile")),
                        "preferred": preferred,
                    }
                ),
                flush=True,
            )
        except Exception as e:
            fail += 1
            print(
                json.dumps(
                    {
                        "event": "fail",
                        "i": i,
                        "path": str(pdf),
                        "error": str(e),
                        "tb": traceback.format_exc()[-400:],
                    }
                ),
                flush=True,
            )

    print(
        json.dumps(
            {
                "event": "done",
                "ok": ok,
                "skip": skip,
                "fail": fail,
                "seconds": round(time.time() - t0, 1),
            }
        ),
        flush=True,
    )
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
