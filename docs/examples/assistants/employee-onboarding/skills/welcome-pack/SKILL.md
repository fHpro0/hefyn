---
name: welcome-pack
description: "Write the welcome email and the onboarding checklist from the templates, in the new hire's language."
---
# Welcome pack

## Welcome email
1. Take `/tmp/assistant/templates/welcome-email.md` and use the section for the hire's `language` (`de` or `en`). Only these two exist; any other language: use English and tell the person.
2. Fill the placeholders from the offer and `/files/out/<lastname>-<firstname>/plan.md`:
   - `{{start_date_long}}`: weekday and date written out in the email's language ("Montag, 2. November 2026").
   - `{{location_line}}`: Hamburg or Munich address and reception hours from `/tmp/assistant/company.md`; for remote "per Video, der Link kommt vom Manager" (en: "by video, your manager sends the link").
   - `{{first_slot}}`: the first entry of the first-day schedule.
   - `{{buddy_line}}`: ", " plus the buddy's name and "(Buddy)" if a buddy is set, else empty.
   - `{{equipment_line}}`: for remote hires one line saying the laptop arrives the working day before; for office hires empty.
   - `{{manager_email}}`, `{{hrbp_name}}`: leave as visible placeholders `[[...]]`; the person fills them.
3. Save as `welcome-email.md`, with the `to` and `cc` front matter kept. The email stays unsent: the HRBP reads and sends it.

## Checklist
Fill `/tmp/assistant/templates/checklist.md` into `checklist.md` (next to `plan.md`): `{{request_id}}` from the access request, `{{equipment_deadline}}` from the script's `equipment_order_deadline`, buddy and manager names. For remote hires remove the Facilities block.

## Check before you finish
- The email contains no salary, no benefits promises, no system names with logins, no links.
- Every date in the email matches the script's output.
