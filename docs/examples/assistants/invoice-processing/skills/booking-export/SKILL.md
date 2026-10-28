---
name: booking-export
description: "Write the booking CSV (SKR03-like chart of accounts) for matched invoices; flagged ones only when the person released them."
---
# Booking export

Run after `three-way-match`. `export.py` is in the folder this SKILL.md is in; run it by that location (`<skill folder>`):

```
python3 <skill folder>/export.py --self-test
python3 <skill folder>/export.py --release INV-1,INV-2
```

`--release` lists invoice numbers the person explicitly cleared (leave it out if there are none). The script books invoices with status `OK` and the released ones, and prints which were held back. Duplicates are never booked, even if released.

## Output `/files/out/booking.csv`
Columns: `booking_date, doc_no, debit_account, credit_account, amount, tax_code, text, cost_center`. Per invoice one row per expense account and cost center (net), one row on the input VAT account (1576 for 19 %, 1571 for 7 %), credited to the supplier's creditor account from `/tmp/assistant/data/suppliers.csv`. The expense account comes from the PO line's `category` in `/tmp/assistant/data/chart-of-accounts.csv`.

## Before you hand over
- Sum of debit rows per invoice must equal its gross. Check one invoice by hand.
- An error such as a missing category or creditor means master data is incomplete: tell the person which row is missing; do not add accounts yourself.
- Items the policy excludes (assets above 800.00 net per unit, foreign currency, credit notes) must not be in the file. Remove them from `/files/out/invoices.json` for this run and list them under "Needs a person".
