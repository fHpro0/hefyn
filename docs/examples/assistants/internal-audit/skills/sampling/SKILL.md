---
name: sampling
description: "Choose the audit sample size and the sampled items for a control from the sampling table in the methodology, deterministically, with sample.py."
---
# Sampling

`sample.py` is in the folder this SKILL.md is in; run it by that location (`<skill folder>`). It reads the sampling table in `/tmp/assistant/methodology.md`.
```
python3 <skill folder>/sample.py --self-test
python3 <skill folder>/sample.py --control A.8.32 --population 212 --risk high
python3 <skill folder>/sample.py --control A.5.18 --ids T-101,T-102,T-103 --risk high
```
The first line must print `self-test ok`. The result is JSON: `population`, `risk`, `size`, `picks` (1-based positions in the export, or the ids you passed). The same input always gives the same sample, so a reviewer can reproduce it.

## How to use it
1. Population: count the rows of the evidence export for the audit period (state where the count comes from). Risk: the control's `risk` in `/tmp/assistant/controls/annex-a-selection.csv`, one level higher if the last audit found a nonconformity for it.
2. Run the script, write the printed JSON into the control's working notes `/files/out/controls/<control>/sample.json`, then test exactly the picked items.
3. A failed item extends the sample once by the same size: run the script again with `--seed <control>-ext` and test only the new picks.

## Never
- Never pick the sample or its size by hand, and never re-run with another seed to get a "better" sample.
- Never change the risk to reduce the work; a changed risk needs the audit lead and a note in the plan.
