# Planner continuous staffing timeline

Twenty-third release candidate. Full Asana Work parity remains open. This frontend change uses the existing Strategies capacity APIs and current project/allocation permissions. It requires no schema migration, API deployment or new Capiro integration.

Each allocation appears once as a continuous calendar bar, with exact inclusive dates, clipped visible-window edges and stable lanes for overlaps. Weeks, unequal months, leap dates and horizontal scrolling use calendar geometry; effort continues to use workdays. The start/end handles support pointer and keyboard resizing across columns. Whole-bar and selected-allocation moves preserve the grabbed calendar day and opening versions. Drops on row headers do not move work, and restricted/archived sources retain their existing protections.

Empty cells open an allocation review with the matching day/week/month interval and row subject. Weekend-only day cells stay inactive. Keyboard-accessible creation buttons remain available. Short bars retain editing and context-menu access, with crowded handles hidden at the narrowest widths.

Validation: 211 web checks in 29 files, production typecheck/build and synthetic browser qualification. Checks cover one-bar rendering, exact drag offsets, clipping, month lengths/leap days, stable overlap lanes, weekend cells and reviewed creation without implicit writes. Browser checks verify keyboard resizing, a two-day pointer resize, a two-day whole-bar move and overlap lanes in month view. Exact-source cloud build and authenticated live qualification remain pending.

Requirement: [Asana capacity planning](https://help.asana.com/s/article/capacity-planning). Custom profile/project-field filtering and grouping, cost/workload comparisons, hierarchy/import improvements and the final parity audit remain open.

Evidence is retained in ignored `artifacts/planner/capacity-timeline-*`. Record the immutable frontend image, release state, authenticated qualification, original-record preservation and recoverable cleanup before marking this candidate released.
