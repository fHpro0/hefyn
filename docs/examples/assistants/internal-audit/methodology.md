# Audit methodology (Northwind Logistics GmbH, ISMS internal audit, ISO/IEC 27001:2022)

Internal audits follow ISO 19011 and clause 9.2 of ISO/IEC 27001. The auditor is independent of the area audited. Nothing in an audit report is stated without a reference to evidence.

## Sampling table
The sample size depends on the population (the number of items the control produces in the audit period: tickets, accounts, changes, devices, suppliers) and on the risk of the control (low, medium, high; from `controls/annex-a-selection.csv`, raised by one level if the control failed in the last audit). `sample.py` reads this table; do not choose sizes yourself.

| Population | low | medium | high |
|---|---|---|---|
| 1-4 | all | all | all |
| 5-15 | 3 | 4 | 5 |
| 16-50 | 5 | 8 | 12 |
| 51-250 | 8 | 13 | 20 |
| 251-1000 | 13 | 20 | 32 |
| 1001+ | 20 | 32 | 50 |

If one sampled item fails, extend the sample by the same size once; two failures in the sample are a finding even if the extension is clean.

## Rating scale
| Rating | Meaning |
|---|---|
| major | A requirement of ISO/IEC 27001 (clauses 4-10) or a whole control is not met or not operating: the ISMS cannot achieve its intended outcome in that area. Also: several minor nonconformities with the same cause. |
| minor | A requirement or control is met in general, but a single lapse or a failed sample item shows it is not applied consistently. |
| observation | Conforms today, but there is a weakness that will probably become a nonconformity (for example a review done late once, a policy due to expire). |
| OFI | Opportunity for improvement: conforms, and the auditor suggests a better practice. Not a requirement. |

Rules for rating
- Major and minor nonconformities need a reference to the requirement or control that is not met and at least one evidence reference.
- A rating is lowered only by the audit lead, never by the auditee. A rating that the auditee disputes is re-examined against the evidence, not negotiated.
- Findings with the same root cause are grouped in the report and rated together.

## Evidence
Evidence is a document, a record, a system export, an interview note or an observation, each with an id from `samples/evidence-index.csv` (or the index the audit builds), a date and the person who provided it. Interview statements alone do not close a finding: ask for a record.

## Timelines
- Management response: 10 working days after the draft findings are sent.
- Corrective action plan for a nonconformity: 30 days; for a major, with a containment action within 5 working days.
- Follow-up check on corrective actions: at the latest 90 days after the report.
