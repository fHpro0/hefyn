# Example Assistants

Six complete Assistants for typical company workflows (the last two run looping processes, see below). Each is a folder in the hefyn layout (`assistant.json`, `instructions.md`, `skills.json`, `mcp.json`, `helpers.json`, `skills/<name>/SKILL.md`, plus data, policies, templates and small scripts). They are self-contained: no catalog skills and no MCP servers. The agent and all helpers are Claude Code (`claude-acp`); a helper can be switched to another installed agent in `helpers.json` (an agent that is not installed on the server makes the import drop that helper). The data in them is made up.

In a chat, the Assistant's own files (data, policies, templates, samples) are copied read-only to `/tmp/assistant/`, its skills (with their scripts) are installed in the agent's skills folder, and the person's files and all outputs live in `/files` (results go to `/files/out/`).

| Folder | What it does | Own skills | Helpers |
|---|---|---|---|
| `invoice-processing` | Accounts payable: reads invoice PDFs/images, 3-way matches them against `data/purchase-orders.csv` and `data/goods-receipts.csv`, flags mismatches and duplicates per `policies/approval-matrix.md`, writes a booking CSV (SKR03-like) and a run report | `extract-invoice`, `three-way-match` (`match.py`), `booking-export` (`export.py`) | `review` (read-only) |
| `customer-support-triage` | Classifies inbound tickets (pasted export or `inbox/*.eml`), detects language, sets priority from `policies/sla.md`, routes by `routing.yaml`, drafts replies from `templates/` and `kb/`, escalates GDPR and legal requests | `triage`, `draft-reply`, `gdpr-request` | `qa` (read-only) |
| `employee-onboarding` | HR: from the signed offer builds a 30/60/90 plan from `role-plans/`, a least-privilege access request from `access-matrix.csv`, a welcome email, a checklist and the first-day schedule | `onboarding-plan` (`schedule.py`), `access-request`, `welcome-pack` | none |
| `sales-rfp-response` | Answers a customer RFP or security questionnaire from `answers-library/` only, marks answers older than 12 months as stale, writes `needs SME` instead of inventing compliance claims, produces `out/rfp-response.csv` and a gap list | `answer-questionnaire` (`library.py`), `compliance-claims-guard` (`claims_check.py`) | `security-sme` (read-only), `writer` (may edit) |
| `internal-audit` | ISO/IEC 27001 internal audit: plan, evidence request, one control at a time with sampling per `methodology.md`, finding, peer review, consolidation, management response, QA review, final report and follow-up plan; a finding that peer review keeps rejecting goes to the audit lead without stopping the audit, other review loops escalate to the audit lead | `run-process` (`process.py`), `sampling` (`sample.py`), `write-finding` | `senior-auditor`, `quality-reviewer` (both read-only) |
| `scrum-sprint` | Scrum team over a docs and code change backlog: INVEST refinement, PO review, planning by capacity from `team.csv`, per story implement, code review and PO acceptance with limited loop-backs and carry-over, review, retrospective, then another sprint or release | `run-process` (`process.py`), `backlog` (`refine.py`, `plan.py`) | `developer` (may edit), `reviewer` (read-only) |

## Looping processes (process.json)
An optional extra file `process.json` describes a multi-stage process that can loop. hefyn only draws it as a diagram; the Assistant runs it with the skill `run-process` (`process.py`, Python 3 stdlib, the same file in both examples). Format: `{version: 1, title, start, stages: [{id, title, by, does?, each?, end?}], next: [{from, to, when?, max?, then?}]}`.
- `by` is `agent`, `person`, `helper:<role>` (a role in `helpers.json`) or `script:<skill>/<file>` (a file in that skill).
- An edge without `when` is the default way out of a stage (at most one); `when` texts are unique per stage. `max` limits how often a loop-back edge may be taken (per item inside an `each` loop); when it is used up the process goes to `then`. A stage with `each: <list>` starts a per-item loop; two edges `next item` and `all items done` from one stage after it walk the items.
- Every stage must be reachable from `start`, an end stage has no edges, every other stage has at least one, and an end stage must be reachable.
- The runner keeps the state in `/files/out/<title-slug>/state.json` (current stage, item queues, loop counters, history with timestamps). Commands, all printing JSON: `start [--items-<list> a,b,c]`, `status`, `advance --outcome "<when or done>" [--note ...] [--by-person] [--items-<list> ...]`, `history`; options `--root`, `--process`, `--state`, `--now`. A `person` stage is refused unless `--by-person` comes with the person's answer in `--note`. `python3 process.py --self-test` runs a simulated process.
- Safety net: leaving a loop for a stage from which its `each` stage can no longer be reached abandons the remaining items; the history records them as `abandoned_items`. A well-built process keeps escalations inside the loop (as `internal-audit` does with `escalate-finding`) so that never happens.

## Import
1. Zip the **contents** of one folder (select the files inside it, not the folder itself; a single top folder is also stripped).
2. In the Assistant editor choose Import, then zip, and pick the file.
3. Start a chat with the Assistant, attach the documents (invoices, tickets, a questionnaire) or paste the data, and follow its questions.

Each Assistant ships demo data (`samples/`, `inbox/`) so you can try it first. Replace the reference data (`data/`, `policies/`, `answers-library/`, ...) with your own before real use; the scripts print `self-test ok` with `--self-test` and need only `python3`.

The files are checked by `bun run test assistant-examples`.
