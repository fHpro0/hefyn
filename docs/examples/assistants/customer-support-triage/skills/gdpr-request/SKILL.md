---
name: gdpr-request
description: "Handle data-protection and legal requests: classify, compute the legal deadline, prepare a handover and the acknowledgement; never answer on substance."
---
# GDPR and legal requests

A ticket is in scope when it asks for access (Art. 15), correction (16), deletion (17), restriction (18), portability (20), objection (21), withdraws consent, complains about data use, comes from a lawyer or an authority, or threatens legal action.

## Steps
1. Mark the row in `/files/out/triage.csv`: category `legal_privacy`, team `legal-privacy`, priority P2 (P1 if the ticket states a deadline within 3 days), `escalate=legal`.
2. Type of request: access, deletion, correction, restriction, portability, objection, authority/lawyer, other. A ticket can have several (the sample asks for access and deletion).
3. Deadline: one calendar month from the day the request was received (`Date:` header or export date). Example: received 2026-10-26, due 2026-11-26. If the month has no such day, use its last day. Say the date out loud in the summary.
4. Write the handover to `/files/out/legal/<ticket_id>.md`: ticket id, sender address, received date, due date, types of request, the customer's own words for what they want (quote at most two sentences), and open questions (identity not proven, several accounts, a minor, a power of attorney).
5. Prepare the acknowledgement from `/tmp/assistant/templates/privacy-acknowledgement.md` in the customer's language as `/files/out/drafts/<ticket_id>.md`, with `Notes for the agent: send only after the legal-privacy team has opened the case and given a reference`.

## Never
- Never confirm or deny that data exists, never attach or describe any data, never promise deletion, and never state a legal opinion. Deletion has legal retention limits only the privacy team can judge.
- Never ask the customer for an ID document by email; the privacy team has the secure form.
- Never route this through the normal queue or the general template.
- A lawyer's letter or an authority's inquiry: tell the person in the chat immediately, before the table.
