---
name: access-request
description: "Derive the least-privilege IT access request for a role from the access matrix, with approvers; extras only with a manager's justification."
---
# IT access request

## Steps
1. Read `/tmp/assistant/access-matrix.csv`. Select the rows where `role` is `all` or the new hire's role. If the role has no rows, stop and ask the person.
2. Split the rows:
   - `standard=yes`: requested for day one.
   - `standard=no`: not requested now. List them under "Later, with approval" with their `note` (for example "after 30 days"). They are requested separately when the condition is met.
3. Rows whose `access_level` is `none`, or whose note says "never", are never requested; list them under "Not available through this process" only if the manager asked for such access.
4. Extra systems the manager or the offer asks for that are not in the matrix: do not add them. List them under "Requires justification from manager" with what is needed (system, level, reason, duration).
5. Write `/files/out/<lastname>-<firstname>/access-request.csv` with columns `request_id,name,role,start_date,system,access_level,approver,note`. `request_id` is `ACC-<start_date as YYYYMMDD>-<lastname upper>`.
6. Write `access-request.md` for IT: who, when, which systems and levels in a table, the approvers who must sign off (one line each), the "Later" and "Requires justification" lists, and the reminder: accounts are created disabled until the start date; credentials are handed over in person, never emailed.

## Never
- No admin, owner, production or financial-release rights in a day-one request, whatever the manager asks. Say so and point to the matrix.
- Do not copy another person's access ("same as Maria"). Always derive it from the role.
- Do not put personal data beyond name, role and start date in the request.
