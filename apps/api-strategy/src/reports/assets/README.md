# Inter font subsets for the executive PDF report

`inter-latin-400.woff2`, `inter-latin-600.woff2`, `inter-latin-700.woff2` are the
Inter latin subsets (variable-font static instances) served by Google Fonts,
matching the typeface the reference client strategy brief loads.

- Project: Inter — https://github.com/rsms/inter
- License: SIL Open Font License 1.1 (OFL) — see `OFL.txt` in this directory.
- Copyright (c) 2016 The Inter Project Authors.

The OFL permits embedding these subsets in the rendered PDF. They are bundled
into `dist/reports/assets/` by the Nest build (nest-cli.json `assets`) and
embedded as data-URI `@font-face` so the export never fetches fonts at runtime.
