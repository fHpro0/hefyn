#!/usr/bin/env python3
"""INVEST check of a backlog CSV: flags stories that are not ready for a sprint.
Usage: python3 refine.py [--backlog /files/out/backlog.csv]
       python3 refine.py --self-test
Columns: id,title,story,acceptance_criteria,estimate,priority,status. Prints JSON {ready: [ids], flagged: [{id, issues}]}; stories with status done are skipped.
Checks: acceptance criteria present (Testable), estimate present and 1,2,3,5,8 or 13 (Estimable), estimate at most 8 (Small), story in the form "As a ... I want ... so that ..." (Valuable), duplicate ids."""
import argparse, csv, io, json, sys

SCALE = {1, 2, 3, 5, 8, 13}


def check(rows):
    ready, flagged, seen = [], [], set()
    for r in rows:
        if (r.get('status') or '').strip().lower() == 'done':
            continue
        i, issues = (r.get('id') or '').strip(), []
        if not i or i in seen:
            issues.append('missing or duplicate id')
        seen.add(i)
        if not (r.get('acceptance_criteria') or '').strip():
            issues.append('missing acceptance criteria')
        est = (r.get('estimate') or '').strip()
        if not est:
            issues.append('missing estimate')
        elif not est.isdigit() or int(est) not in SCALE:
            issues.append(f'estimate {est} is not on the scale 1,2,3,5,8,13')
        elif int(est) > 8:
            issues.append(f'estimate {est} is too large: split the story')
        s = (r.get('story') or '').lower()
        if not ('as a' in s and 'i want' in s and 'so that' in s):
            issues.append('story is not in the form "As a ... I want ... so that ..."')
        (flagged.append({'id': i, 'issues': issues}) if issues else ready.append(i))
    return {'ready': ready, 'flagged': flagged}


def self_test():
    head = 'id,title,story,acceptance_criteria,estimate,priority,status\n'
    ok = 'As a dev I want x so that y'
    res = check(csv.DictReader(io.StringIO(head + f'A,t,{ok},works,3,1,new\nB,t,{ok},,3,1,new\nC,t,{ok},works,,1,new\nD,t,{ok},works,13,1,new\nE,t,do x,works,4,1,new\nF,t,{ok},works,3,1,done\nA,t,{ok},works,3,1,new\n')))
    assert res['ready'] == ['A'], res
    assert [(f['id'], len(f['issues'])) for f in res['flagged']] == [('B', 1), ('C', 1), ('D', 1), ('E', 2), ('A', 1)], res
    print('self-test ok')


if __name__ == '__main__':
    a = argparse.ArgumentParser()
    a.add_argument('--backlog', default='/files/out/backlog.csv')
    a.add_argument('--self-test', action='store_true')
    o = a.parse_args()
    if o.self_test:
        self_test()
        sys.exit(0)
    try:
        print(json.dumps(check(list(csv.DictReader(open(o.backlog, encoding='utf-8', newline=''))))))
    except OSError as e:
        sys.exit(f'refine.py: {e}')
