---
name: triage
description: "Classify one inbound ticket: language, category, priority, team and SLA due time; write the row to /files/out/triage.csv."
---
# Triage one ticket

## Steps
1. Ticket id: the `.eml` file name without extension, else the id in the export, else `T001`, `T002` in order.
2. Language: the language the customer wrote in (ISO code: `de`, `en`, `fr`, ...), judged from the body, not the subject or the domain. Mixed: the language of the question.
3. Category and team: read `/tmp/assistant/routing.yaml`. Match keywords against subject and body, case-insensitive. `safety` and `legal_privacy` always win. Otherwise take the category with the most keyword hits; on a tie the one listed first. No hits: judge by meaning; none fits: `other`. Never route by the customer's tone.
4. Priority: apply `/tmp/assistant/policies/sla.md` in the order P1 down to P4, then the raising rules. Write one short reason ("double charge, money taken: P2").
5. Due time: from the ticket's received time and the priority's first-response time. P1 counts around the clock. Others count business hours Europe/Berlin (08:00-18:00, Mon-Fri, German holidays skipped). Show the due time with date, time and zone. When the received time is missing, say so and use "due: needs received time".
6. Key accounts: if the sender's domain is in `key_accounts` of `/tmp/assistant/routing.yaml`, ask the person before you finish.

## Output
Append to `/files/out/triage.csv` (create it with this header if missing):
`ticket_id,received,from,language,category,priority,reason,team,queue,first_response_due,escalate,needs_agent,kb_article,draft_file`

- `escalate`: `legal`, `safety` or empty.
- `needs_agent`: `yes` if the reply needs data you do not have (order status, account lookup) or a decision (refund, goodwill).
- Never put the ticket body into the CSV. Keep `reason` under 100 characters.
