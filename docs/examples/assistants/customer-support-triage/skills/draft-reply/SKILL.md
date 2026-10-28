---
name: draft-reply
description: "Write a reply draft in the customer's language from the templates and kb articles, without promises the policies do not allow."
---
# Draft a reply

## Steps
1. Pick the template in `/tmp/assistant/templates/`: `safety` for safety tickets, `billing-double-charge` for double or wrong charges, `general` otherwise. Each file has an `## en` and a `## de` section.
2. Language: write in the ticket's language. Templates exist for `en` and `de`. For other languages translate the `en` section faithfully (same meaning, same promises, nothing added) and keep the tone polite and plain. If you cannot write the language well, draft in English and write that in the notes.
3. Find the help article in `/tmp/assistant/kb/` (match by topic; the front matter has the id). Use only what the article says. Put the article id in `kb_article` in the CSV and in the notes. If no article fits, say what happens next ("our team will look into this and reply by <due date>") and set `needs_agent=yes`.
4. Fill the placeholders: `{{first_name}}` from the signature (else the From name, else "customer"); `{{subject}}` the original subject; `{{order_no}}` only if the customer wrote one; `{{answer}}` and `{{next_step}}` in 1-4 short sentences, steps as a numbered list when there are more than two. `{{agent_name}}`: leave as `[[agent name]]`.
5. Unknown facts become visible placeholders in double square brackets, never invented values.

## Draft file
`/files/out/drafts/<ticket_id>.md`:
```
To: <sender address>
Language: <code>
Template: <name> · KB: <id or none>
Notes for the agent: <what to check before sending; one line each>
---
<the reply>
```

## Never
- No refund, replacement, voucher, delivery date or fault diagnosis unless the template or article says exactly that.
- No "we are sorry for the inconvenience caused" boilerplate chains; one honest sentence is enough.
- No content from other tickets. No links except ones in the kb article.
