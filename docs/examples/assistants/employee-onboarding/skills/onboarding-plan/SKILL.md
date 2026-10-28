---
name: onboarding-plan
description: "Build the 30/60/90-day plan and first-day schedule from the role plan, with dates from the bundled script."
---
# Onboarding plan

## Steps
1. Dates (never by hand). `schedule.py` is in the folder this SKILL.md is in; run it by that location (`<skill folder>`):
   ```
   python3 <skill folder>/schedule.py --self-test
   python3 <skill folder>/schedule.py --start <start_date> --location <Hamburg|Munich|remote> --probation-months <n>
   ```
   The first line must print `self-test ok`. The second prints JSON with `review_30/60/90`, `probation_end`, `security_training_due`, `equipment_order_deadline` and the `first_day` schedule. A weekend start is an error: ask the person.
2. If a date the script printed is a German public holiday (or a company day off the person names), say so and propose the next working day. Do not change the script's result silently.
3. Read `/tmp/assistant/role-plans/<role>.md`. Copy its goals; do not add goals that are not in it. Adapt only names: the manager, the buddy, the people "to meet" when the offer gives them.
4. Write `/files/out/<lastname>-<firstname>/plan.md`:
   - Header: name, role, location, start date, manager, buddy.
   - First-day schedule as a table (time, what, who).
   - Three sections "First 30 days", "Days 31-60", "Days 61-90", each with the plan's goals and the review date from the script.
   - "Key dates": security training due, probation end, probation feedback talks (month 3 and 5 of the probation).
   - "Open questions" for HR (a missing buddy, an unclear holiday).

## Never
- No goals with numbers (quota, revenue, ticket counts) that the role plan does not give; those belong to the manager.
- No statements about salary, bonus or promotion.
