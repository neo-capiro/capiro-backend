# Artifact inventory guard correction

The independently reviewed sealed native run at ec6b used both complete five-artifact client inventories; its six native results remain unchanged. The earlier verifier iterated whatever entries were supplied and accepted omitted clients or artifact arrays. The correction is a separate source-only guard qualification. Original ee9499/ec6b source, metadata and physical native stdout/stderr remain in their immutable ancestor commits.

The guard now requires exactly the fixed Core and Workspace roots, their expected source-schema paths and version5.22.0, and exactly package.json/index.js/runtime/library.js/schema.prisma/the pinned Debian engine path for each. Duplicate/extra/omitted/outside entries and malformed hashes/counts refuse. Both inventories are validated before opening any artifact or current schema file. The manifest itself must be read to validate its contents. Cached schema equality is recomputed from current bound repository bytes; the stored schemaByteEquality flag is not authority. No additional native execution is necessary for these inventory refusals.

The pure tests use inert byte maps and the actual guard functions. Guarded --plan may read and hash the already existing artifact and schema files; it constructs no client and opens no database connection. Native replay is not authorized by this correction.

Timing clarification: canonical PrismaService.withTenantUser executes its two existing transaction-local tenant/user GUC statements before invoking the test callback. The callback then verifies the connection identity before its SET LOCAL ROLE and any owner-table operation. The guard does not precede all SQL/GUC statements. Native-pg fixture guards remain before fixture DDL. No source behavior, transaction helper, permission or provider policy changes here.

This guard proves declared-inventory completeness and pinned-file byte checks. It is not general OS isolation, immutable filesystem custody, arbitrary module graph verification, production role hardening or a new native result. Full committed whitespace remains OPEN; original physical raw receipts are preserved.
