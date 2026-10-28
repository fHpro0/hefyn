# Approval matrix for supplier invoices (Nordwerk GmbH, valid from 2026-01-01)

Amounts are the invoice gross total in EUR. `match.py` implements this table; if the table changes, change the script constants too.

| Gross amount | Approver role |
|---|---|
| up to 1,000.00 | AP clerk |
| up to 5,000.00 | Cost center manager |
| up to 25,000.00 | Head of department |
| up to 100,000.00 | CFO |
| above 100,000.00 | CFO and CEO |

## Always escalate to the AP lead (whatever the amount)
- No PO number, or a PO number that is not in the PO list.
- Duplicate: same supplier and invoice number, or same supplier, date and gross amount.
- IBAN on the invoice differs from the supplier master data (possible payment fraud: do not pay until the supplier is called back on the number in the master data).
- Invoiced quantity above received quantity, or no goods receipt at all.
- Unit price above the PO price by more than 2 %. A lower price is reported but not escalated.
- Totals that do not add up (lines vs net, net + VAT vs gross, tolerance 0.02).

## Other rules
- The PO's cost center is the cost center of the booking. Ask the cost center manager if it looks wrong, never change it.
- Assets (category `office_equipment`) with a net unit price above 800.00 are not booked by this process: list them under "Needs a person".
- Foreign currency invoices are not booked by this process: list them under "Needs a person".
- Credit notes (negative totals) are not handled: list them under "Needs a person".
