---
name: compliance-claims-guard
description: "Check a drafted response against the claims register so no certification, attestation or audit claim is made that the company does not hold."
---
# Compliance claims guard

Run on every draft of `/files/out/rfp-response.csv`. `claims_check.py` is in the folder this SKILL.md is in; run it by that location (`<skill folder>`). It reads the register from `/tmp/assistant/claims-register.csv`.
```
python3 <skill folder>/claims_check.py --self-test
python3 <skill folder>/claims_check.py
```
The first line must print `self-test ok`. The checker exits 1 and lists each violation as `<question id>: <reason>`.

## What it enforces
- A certification or attestation named in an answer (ISO 27001, SOC 2, TISAX, PCI DSS, HIPAA, FedRAMP, CSA STAR) must be listed in `/tmp/assistant/claims-register.csv` as `held=yes`, not expired, and its `evidence_id` must be in the row's `source_id`.
- If the company does not hold it, the answer must contain the register's `official_statement` word for word, or the row must be `needs_sme`.

## Fixing a violation
- Change the row, never the register. Replace the claim with the official statement from the register, or set the row to `needs_sme` with the reason in `notes`. Do not soften ("compliant with the principles of SOC 2", "aligned with", "in progress") and do not invent timelines: "planned", "in audit", "expected" are claims too.
- A register that looks wrong or out of date (expired certificate): do not decide. Tell the person and ask the owner named in the register.

## Beyond the script
The script finds names, not paraphrases. Also read each answer for claims of the same kind without the name, such as "independently audited", "attested", "meets banking regulator requirements", "approved by the authority". Each must come from a library answer's own words, else `needs_sme`. For technical claims ask the `security-sme` helper.
