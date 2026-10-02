# Direct browser repairs

Source `6be5a560d5addaa1844f0687898c34a249089f76` repairs the global task result contract and assignment filtering, historical synthetic conversation reads after the execution deadline, and spurious warnings for read-only requests and operational failures. Both mains contain the fixes.

Both exact-source Actions image workflows failed at startup with no jobs. The authorized AWS fallback built immutable ARM64 images with existing release checks. This archive proves build/test qualification; deployment and live browser results follow separately. No migration or runtime configuration changes are required.

Direct browser QA at os.capiro.ai is now the default in shared instructions. No account comparison is requested. The original75 and its additional acceptance requirements remain incomplete.
