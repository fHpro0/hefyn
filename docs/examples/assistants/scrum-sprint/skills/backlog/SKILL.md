---
name: backlog
description: "Backlog scripts for the Scrum process: refine.py flags stories that fail the INVEST check, plan.py plans a sprint under the team's capacity and prints the sprint metrics."
---
# Backlog scripts

Both scripts are in the folder this SKILL.md is in; run them by that location (`<skill folder>`). The working backlog is `/files/out/backlog.csv`: at the start copy the person's backlog (or the demo `/tmp/assistant/samples/backlog.csv`) there and edit only that copy. Columns: `id,title,story,acceptance_criteria,estimate,priority,status`.
```
python3 <skill folder>/refine.py --self-test
python3 <skill folder>/plan.py --self-test
python3 <skill folder>/refine.py
python3 <skill folder>/plan.py
python3 <skill folder>/plan.py --metrics --committed US-101,US-102 --done US-101
```
The self-tests print `self-test ok`.

## Refinement (`refine.py`)
It prints `ready` and `flagged` stories with the reasons (missing acceptance criteria, missing or off-scale estimate, estimate above 8, story not in "As a ... I want ... so that" form). Fix every flagged story you can fix from the story's own text: write acceptance criteria that can be shown, split a large story into stories of at most 8 points (new ids, same priority area). An estimate you cannot justify stays empty and the story is listed as "needs the team" in the notes for the product owner. Never invent business intent: when the story does not say what it should do, ask the product owner. Run `refine.py` again; the flagged list is what the product owner sees.

## Planning (`plan.py`)
It reads `/tmp/assistant/team.csv` (days and points per day per member), computes the capacity and takes ready stories in priority order while they fit. Copy its `stories` list into `/files/out/sprint/sprint.md` with the capacity and the skipped reasons. The sprint's stories are the loop items: pass them to the runner with `--items-stories`. Do not add a story to the sprint by hand.

## Metrics (`plan.py --metrics`)
`--committed` is the sprint's story list, `--done` the accepted stories. It prints committed and done points, the carried stories and the completion percentage; put the output into the sprint review.
