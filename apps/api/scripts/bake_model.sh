#!/bin/sh
# Phase 10B-23C2: bake one verified PaddleOCR model into the ingestion-drain image.
#
# Called by Dockerfile.defense-budget-ingestion-drain as:
#   bake_model.sh <url> <dest_dir> <archive_sha256> <pdiparams_sha256> <pdmodel_sha256>
#
# Fail-closed guarantees (Phase 10B-23C review):
# - the archive itself is SHA-256-verified BEFORE extraction;
# - every model file is discovered by EXACT filename match (never
#   `find -name | head -1`, which previously selected an AppleDouble
#   `._inference.pdmodel` metadata file and failed the checksum);
# - exactly one candidate per file kind must exist -- zero or 2+ is fatal;
# - extraction rejects absolute paths and parent traversal ("../");
# - no network fetch happens at runtime: once these files exist at
#   maybe_download()'s expected path, paddleocr skips its own download.
set -eux

url="$1"
dest="$2"
archive_sha="$3"
params_sha="$4"
model_sha="$5"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

curl -fsSL "$url" -o "$tmp_dir/model.tar"

# Archive-level integrity BEFORE any extraction.
echo "$archive_sha  $tmp_dir/model.tar" | sha256sum -c -

mkdir -p "$dest"

# Extract while refusing absolute paths and parent traversal: every member
# name must be relative and contain no ".." path component.
if tar -tf "$tmp_dir/model.tar" | grep -qE '(^|/|^)\.\.(/|$)|^/'; then
  echo "FATAL: archive member with parent-traversal or absolute path" >&2
  exit 3
fi

tar -xf "$tmp_dir/model.tar" -C "$tmp_dir"

# AppleDouble resource-fork metadata (macOS-created tars carry "._name"
# entries) must never be selected: match the EXACT target filenames only.
params_src="$(find "$tmp_dir" -type f -name 'inference.pdiparams' ! -name '._*' | head -n 2)"
model_src="$(find "$tmp_dir" -type f -name 'inference.pdmodel' ! -name '._*' | head -n 2)"
info_src="$(find "$tmp_dir" -type f -name 'inference.pdiparams.info' ! -name '._*' | head -n 2)"

params_count="$(printf '%s\n' "$params_src" | grep -c . || true)"
model_count="$(printf '%s\n' "$model_src" | grep -c . || true)"

# Exactly-one-or-fail: zero candidates = wrong/malicious archive; 2+ = an
# ambiguous archive we refuse to guess from.
if [ "$params_count" -ne 1 ] || [ "$model_count" -ne 1 ]; then
  echo "FATAL: expected exactly 1 inference.pdiparams and 1 inference.pdmodel, got $params_count / $model_count" >&2
  exit 4
fi

# head -n 2 collected at most 2; if 2 appeared the count above already failed,
# but assert single-line explicitly before use.
params_file="$(printf '%s\n' "$params_src" | head -n 1)"
model_file="$(printf '%s\n' "$model_src" | head -n 1)"

cp "$params_file" "$dest/inference.pdiparams"
cp "$model_file" "$dest/inference.pdmodel"
if [ -n "$info_src" ]; then
  cp "$info_src" "$dest/inference.pdiparams.info"
fi

echo "$params_sha  $dest/inference.pdiparams" | sha256sum -c -
echo "$model_sha  $dest/inference.pdmodel" | sha256sum -c -
