# SLA and priority policy (Lumio GmbH, valid from 2026-03-01)

Business hours: Monday to Friday 08:00-18:00 Europe/Berlin, except German public holidays. Times below count in business hours unless marked 24/7.

| Priority | When | First response | Resolution target |
|---|---|---|---|
| P1 | safety issue (smoke, overheating, shock); complete outage for a business customer; a legal deadline stated in the ticket within 3 days | 1 hour, 24/7 | 1 business day |
| P2 | device or app unusable for a paying customer with no workaround; money taken twice or wrongly; a parcel marked delivered but missing; a key account | 4 hours | 2 business days |
| P3 | partial problems with a workaround; billing questions; delivery delays; account problems | 1 business day | 5 business days |
| P4 | general questions, feedback, sales inquiries without a deadline | 2 business days | 10 business days |

## Raising and lowering
- Raise one level when the customer writes again about the same issue within 3 days, or states a deadline within 2 business days.
- Raise to P2 at least for key accounts (`/tmp/assistant/routing.yaml`).
- Never lower a priority because the customer is polite or the wording is mild; never lower safety or legal tickets.
- Automatic replies, newsletters, out-of-office messages and bounces are not tickets: list them as `not_a_ticket` and skip them.

## Legal and data-protection requests
- GDPR requests must be answered within one calendar month of receipt. The 30-day clock starts the day the request arrives, not the day support sees it. Put the due date in the table.
- The first response to the customer (acknowledgement) goes out within 2 business days; the legal-privacy team decides everything else.
