"""capiro_defense_budget_parser — isolated Python parser runtime for defense budgets.

This runtime owns ONLY local parsing: page profiling, pdfplumber, Camelot,
Docling, and PaddleOCR. It must never:
- connect to Postgres
- access AWS credentials
- call LlamaParse
- write canonical data
- determine verification decisions
- select a winning parser result
- know tenant/client data
"""

__version__ = '0.1.0'
