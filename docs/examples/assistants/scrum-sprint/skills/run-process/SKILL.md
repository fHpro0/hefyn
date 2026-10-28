---
name: run-process
description: "Run the Assistant's looping process (its process file) stage by stage with a small runner: it keeps the current stage, the item queues, the loop counters and the history, and refuses skipped stages and unconfirmed person steps."
---
# Run the process

The Assistant's process is described in `/tmp/assistant/process.json` (stages, who does each one, the ways out of each stage, loops with a limit). `process.py` is in the folder this SKILL.md is in; run it by that location (`<skill folder>`). It keeps the state in `/files/out/<process-title>/state.json`. Every command prints JSON.

```
python3 <skill folder>/process.py --self-test
python3 <skill folder>/process.py start --items-<list> a,b,c
python3 <skill folder>/process.py status
python3 <skill folder>/process.py advance --outcome "<outcome>" --note "<what happened>"
python3 <skill folder>/process.py history
```

## Rules
- Call `status` first in every turn. The stage it prints is the only stage you work on. Never decide yourself which stage comes next and never skip one.
- `start` once, when no state exists. Stages that loop over a list (`each`) need the items: `--items-<list> a,b,c` on `start`, or on the `advance` that leads to the loop. The runner tells you the exact option when it is missing.
- Look at `stage.by`: `agent` means you do the work; `helper:<role>` means you delegate to that helper with the exact checklist from the skill named in the Assistant's instructions; `script:<skill>/<file>` means you run that script from its skill folder; `person` means you stop and ask the person.
- When the stage is done, `advance --outcome` with one of the `outcomes` the status lists, or `done` for the default way out. Put what happened in `--note` (short, with the file names you wrote).
- A `person` stage is refused unless you pass `--by-person` and the person's own answer quoted in `--note`. Never answer for the person.
- Inside a loop the status shows the current `item`. At a stage that walks the items, use `--outcome done`; the runner takes the next item or leaves the loop.
- A loop-back (`changes requested`, `rework`, ...) has a limit. When it is used up, the runner sends you to the escape stage (`moved.via` is `max-then`): tell the person that the limit was reached and why.
- If `advance` prints an error, nothing changed: read the message, fix the cause (usually the outcome text or the missing items) and call it again.
