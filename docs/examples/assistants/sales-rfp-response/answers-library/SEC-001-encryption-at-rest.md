---
id: SEC-001
topic: Encryption at rest
owner: Mara Lindqvist (Head of Security)
reviewed: 2026-03-04
tags: encryption, storage, database
---
Customer data is encrypted at rest with AES-256. Database volumes and object storage use provider-managed keys held in the cloud provider's key management service. Backups are encrypted with the same standard. Customer-managed keys are not offered.
