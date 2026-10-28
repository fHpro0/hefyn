---
name: extract-invoice
description: "Read a supplier invoice (PDF, image or text) into a fixed JSON record; use before any matching."
---
# Extract an invoice

Read the document itself (PDFs: `pdftotext -layout` if available, else read the file; images: look at them). Produce one entry per invoice in `/files/out/invoices.json`, a JSON list. One file can hold several invoices; one invoice can span several pages.

## Record
```json
{"file": "/files/x.pdf", "invoice_no": "INV-1", "supplier_id": "S100", "date": "2026-10-05", "currency": "EUR",
 "po_number": "PO-2026-0412", "iban": "DE...", "lines": [{"po_line": 1, "qty": 12, "unit_price": 289.00}],
 "net": 7958.00, "vat": 1512.02, "gross": 9470.02}
```
`/tmp/assistant/samples/invoices.json` shows real examples of the shape.

## Rules
- `supplier_id`: look the sender up in `/tmp/assistant/data/suppliers.csv` by name, VAT id or IBAN. Not found: use `"UNKNOWN"` and say so; never invent an id.
- `po_number`: the customer order reference printed on the invoice (also "Bestellnummer", "Ihre Referenz"). Normalise to `PO-YYYY-NNNN`. Not printed: `null`.
- `po_line`: the PO line the invoice line belongs to. Use the position or the description to find it in `/tmp/assistant/data/purchase-orders.csv`. If the invoice has no position numbers and the match is ambiguous, ask the person.
- Numbers: German formats (`1.234,56`) become `1234.56`. Use the invoiced `qty` and the net `unit_price`; if the invoice shows gross prices, say so and ask.
- `iban`: exactly as printed, without spaces. `null` if none printed.
- Unreadable value: `null` and a note in the chat. Do not guess.
- Do not copy the sender's bank details, prices or text anywhere but `/files/out/`.
