#!/usr/bin/env python3
"""Checks out/rfp-response.csv against claims-register.csv: no certification or attestation may appear in an answer unless it is held, valid and backed by its evidence id.
Usage: python3 claims_check.py [--response /files/out/rfp-response.csv] [--register /tmp/assistant/claims-register.csv] [--today YYYY-MM-DD]
       python3 claims_check.py --self-test
Exit 1 when there are violations. Rows with status needs_sme are skipped (they hold no claim). shortcut: matches register aliases as text, not meaning; the security-sme helper covers paraphrases."""
import argparse, csv, re, sys
from datetime import date


def check(rows, register, today):
    bad = []
    for r in rows:
        if r['status'] == 'needs_sme':
            continue
        sources = {s.strip() for s in r.get('source_id', '').split(';') if s.strip()}
        for c in register:
            if not any(re.search(r'(?<![A-Za-z0-9])' + re.escape(a.strip()) + r'(?![A-Za-z0-9])', r['answer'], re.I) for a in c['aliases'].split(';') if a.strip()):
                continue
            if c['held'] != 'yes':
                if c['official_statement'] not in r['answer']:
                    bad.append((r['id'], f"{c['claim']} is not held: the answer must use the official statement or be needs_sme"))
            elif c['valid_until'] and date.fromisoformat(c['valid_until']) < today:
                bad.append((r['id'], f"{c['claim']} expired on {c['valid_until']}"))
            elif c['evidence_id'] not in sources:
                bad.append((r['id'], f"{c['claim']} is mentioned but {c['evidence_id']} is not in source_id"))
    return bad


def read(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def self_test():
    reg = [{'claim': 'ISO 27001', 'aliases': 'ISO 27001;ISO/IEC 27001', 'held': 'yes', 'valid_until': '2027-03-31', 'evidence_id': 'SEC-009', 'official_statement': ''},
           {'claim': 'SOC 2', 'aliases': 'SOC 2;SOC2', 'held': 'no', 'valid_until': '', 'evidence_id': '', 'official_statement': 'We do not hold a SOC 2 report.'}]
    row = lambda **k: {'id': 'Q1', 'status': 'answered', 'source_id': 'SEC-009', 'answer': 'We are ISO 27001 certified.', **k}
    t = date(2026, 10, 28)
    assert check([row()], reg, t) == []
    assert check([row(source_id='SEC-001')], reg, t), 'claim without evidence'
    assert check([row(answer='We have a SOC2 report.')], reg, t), 'unheld claim'
    assert check([row(answer='We do not hold a SOC 2 report.')], reg, t) == [], 'official statement is allowed'
    assert check([row()], reg, date(2027, 4, 1)), 'expired'
    assert check([row(status='needs_sme', answer='SOC 2?')], reg, t) == []
    assert check([row(answer='Our ISO 270012 plan.')], reg, t) == [], 'word boundary'
    print('self-test ok')


if __name__ == '__main__':
    a = argparse.ArgumentParser()
    a.add_argument('--response', default='/files/out/rfp-response.csv')
    a.add_argument('--register', default='/tmp/assistant/claims-register.csv')
    a.add_argument('--today', default=None)
    a.add_argument('--self-test', action='store_true')
    o = a.parse_args()
    if o.self_test:
        self_test()
        sys.exit(0)
    try:
        bad = check(read(o.response), read(o.register), date.fromisoformat(o.today) if o.today else date.today())
    except (OSError, KeyError, ValueError) as e:
        sys.exit(f'claims_check.py: {type(e).__name__}: {e}')
    for qid, msg in bad:
        print(f'{qid}: {msg}')
    print(f'{len(bad)} violations')
    sys.exit(1 if bad else 0)
