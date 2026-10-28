---
name: three-way-match
description: "Match extracted invoices to POs and goods receipts with the bundled script and read the findings."
---
# Three-way match

`match.py` is in the folder this SKILL.md is in. Run it by that location (`<skill folder>` below):

```
python3 <skill folder>/match.py --self-test
python3 <skill folder>/match.py
```

The first line must print `self-test ok`; if it does not, stop and tell the person. The second reads `/files/out/invoices.json` and the reference data in `/tmp/assistant/data/` and writes `/files/out/match.json` (it prints a short list too). Never do the matching yourself and never edit `/files/out/match.json` by hand.

## Finding codes
| Code | Meaning | Usual cause |
|---|---|---|
| NO_PO / UNKNOWN_PO | no PO number, or not in the PO list | supplier forgot it; extraction error |
| LINE_NOT_ON_PO | PO has no such line | wrong `po_line` in extraction |
| SUPPLIER_MISMATCH / UNKNOWN_SUPPLIER | PO belongs to someone else, or supplier not in master data | wrong PO number; new supplier |
| PRICE_DIFF | unit price more than 2 % above the PO | price change not agreed |
| QTY_OVER_ORDERED / QTY_OVER_RECEIVED / NO_RECEIPT | billed more than ordered or received, or nothing received | partial delivery; billed too early |
| DUPLICATE | same invoice number or same date and amount from the same supplier | resent invoice, reminder |
| IBAN_MISMATCH | bank details differ from master data | supplier changed bank, or fraud |
| ARITHMETIC / MISSING_TOTALS | lines, net, VAT and gross do not add up, or a total is missing | extraction error |
| CURRENCY | not EUR | out of scope |

## After the run
- A finding that looks like an extraction error: re-read the document, fix `/files/out/invoices.json`, run again. Say what you changed.
- Anything else stays a finding. Report it as it is; do not explain it away.
- `status` is `OK` or `FLAG`; `approver` is the role from `/tmp/assistant/policies/approval-matrix.md` (`AP lead` for every flagged invoice), `approver_if_cleared` is the role once the flags are cleared.
