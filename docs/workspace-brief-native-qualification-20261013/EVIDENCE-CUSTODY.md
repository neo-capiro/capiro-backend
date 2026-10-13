# Evidence custody

This packet records an actual local native run at frozen product source `76f50b2667d06a121b2dd772abc9d64adb556c36`. Command receipts bind stdout/stderr bytes and hashes. Failed attempts remain separate from the final run. Query traces and generated-output inventories are deterministic gzip archives; decompression preserves the exact recorded JSON/JSONL bytes.

Whitespace-bearing raw text may be represented in a finite lossless base64 envelope. Each envelope binds its original path, raw checkpoint commit, exact byte length and SHA-256; decode the payload to reproduce the original bytes. No source or general evidence directory receives a hygiene exemption. The finite SHA index covers this packet, excluding the index itself and subsequent final hygiene receipts.

The output inventory correction was observed after compaction; its traceback was not persisted as a command file. `attempt0-output-inventory-failure.json` explicitly preserves the known observation and correction, without claiming unavailable raw traceback custody. The initial cleanup assertion's unpersisted mismatch values likewise remain an acknowledged evidence limit.

No private runtime configuration, credentials, generated native binary, customer data, provider request, or database dump is included. Catalog evidence contains local fixture role metadata only. The native owner-role run is not RLS acceptance. Owned fixture/database/config/output cleanup is recorded; source and borrowed caches were preserved.
