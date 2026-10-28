---
name: write-finding
description: "Write an audit finding with condition, criteria, cause, effect and recommendation, evidence references and a rating per the methodology; also the checklists for the senior-auditor and quality-reviewer helpers."
---
# Write a finding

One finding per file: `/files/out/findings/<control>.md`, from the template `/tmp/assistant/templates/finding.md`. A control without a finding gets the file too, with rating `conforming` and the evidence that supports it.

## The five parts
- **Condition**: what you found, with numbers from the sample ("4 of 13 sampled leaver accounts were disabled after the 5-day limit, the latest after 19 days"). Facts only; no adjectives, no names of individuals.
- **Criteria**: the requirement that applies: the ISO/IEC 27001:2022 clause or Annex A control and the company's policy section.
- **Cause**: only what the evidence shows. If it is not known, write "not determined" and what is needed.
- **Effect**: the risk to confidentiality, integrity or availability, or the compliance consequence. No exaggeration.
- **Recommendation**: one concrete action; the auditee chooses the means.

## Rules
- Every statement in condition, cause and effect carries at least one evidence id from the evidence index (`EV-nnn`) in the `Evidence` section. A finding without an evidence reference is not a finding: collect the evidence or drop it.
- Rating per `/tmp/assistant/methodology.md` only: major, minor, observation, OFI. Say in one sentence why that rating and not the next one up.
- Sampling: put population, size and failed items in the table, from the sampling script's output.
- Management disputes change the finding only when they bring evidence; the rating is not negotiated.

## Checklist for the helper `senior-auditor` (peer review of one finding)
Give the helper the finding file, the sample JSON and the evidence index rows. Ask it to answer `approved` or `changes requested: <numbered list>`, checking:
1. Every claim has an evidence id, and the evidence says what the finding says it does.
2. Condition has numbers that match the sample result; criteria cite a real clause or control.
3. The rating matches the methodology's definition; the reasoning is given.
4. Cause and effect are not speculation; "not determined" is used where needed.
5. The recommendation is actionable and does not name a product.
6. No individual is named; the tone is neutral.

## Checklist for the helper `quality-reviewer` (the whole report)
Give the helper the draft report, all finding files and the methodology. Ask it to answer `approved` or `rework: <numbered list>`, checking:
1. Counts per rating in the summary equal the findings in section 3.
2. Every finding in the report equals its finding file, with the management response quoted.
3. Findings with one root cause are grouped and rated together.
4. Disputed findings state the audit lead's or the evidence-based decision, not a compromise.
5. Controls that were not tested (the audit was stopped by the audit lead) and findings the audit lead withdrew are listed as "not audited" in the scope, never as conforming.
6. The conclusion follows from the findings; no new claims appear that no finding supports.
