---
name: answer-questionnaire
description: "Match each question of a customer questionnaire to approved library answers, mark stale ones, and write /files/out/rfp-response.csv."
---
# Answer a questionnaire

## 1. Index the library
`library.py` is in the folder this SKILL.md is in; run it by that location (`<skill folder>`). The library is read from `/tmp/assistant/answers-library/`.
```
python3 <skill folder>/library.py --self-test
python3 <skill folder>/library.py
```
The first line must print `self-test ok`. The second lists every answer with its owner, review date and `STALE` flag (older than 365 days). Use `--json` for the full index. Never judge staleness yourself.

## 2. Match
For every question, find the library answer whose `topic` and `tags` cover it, then read that answer's file. Decide:
- **answered**: the answer covers everything the question asks. Use its facts and wording; shorten or translate if needed, never extend.
- **partly**: the answer covers a part. Answer only that part, status `needs_sme`, and write in `notes` which part is missing (for example "RTO/RPO covered, service credits not").
- **needs_sme**: no answer covers it, or the question asks for something the library cannot give (a document, a figure, a name, a date, a contract term, a customer reference). Answer text: `Needs SME` and nothing else. `owner`: the owner of the closest library topic, else `Sales lead`; contract terms: `Legal`.
- Questions about the customer's own setup or that are not questions ("Please attach the report"): `needs_sme` with a note.
- If the matched answer is stale, status `stale` (not `answered`): keep the draft answer, put the owner's name and the review date in `notes`.

## 3. Write `/files/out/rfp-response.csv`
Columns, in this order: `id,section,question,answer,source_id,status,owner,reviewed,notes`
- `status` is one of `answered`, `stale`, `needs_sme`.
- `source_id`: the library id(s) the answer comes from, separated by `;`; empty for `needs_sme` without a draft.
- `owner` and `reviewed` come from the library entry of `source_id`.
- Quote every field that contains a comma or a line break. Keep the customer's question text unchanged in `question`.

## 4. Check
Count the rows: it must equal the number of questions. Then run the skill `compliance-claims-guard` before you show anything.

## Never
- Never fill an answer from general knowledge, the web, or another customer's questionnaire.
- Never raise a number or relax a statement to fit the question ("99.9 %" stays "99.9 % on the Enterprise plan").
- Never delete a question because it is awkward. A hard question stays and is `needs_sme`.
