#!/usr/bin/env python3
"""Sprint planning: capacity from team.csv, then stories from the backlog in priority order while they fit. Also the sprint metrics.
Usage: python3 plan.py [--backlog /files/out/backlog.csv] [--team /tmp/assistant/team.csv]
       python3 plan.py --metrics --committed US-101,US-102 --done US-101 [--backlog ...]
       python3 plan.py --self-test
team.csv columns: member,role,days_in_sprint,points_per_day. Capacity = floor(sum of days_in_sprint x points_per_day).
Backlog columns: id,title,story,acceptance_criteria,estimate,priority,status (priority 1 is first). Only stories that are not done and have acceptance criteria and an estimate are planned; the rest is listed under skipped with the reason.
A story that does not fit is skipped and the next one is tried. Prints JSON {capacity, planned_points, stories, skipped}; --metrics prints {committed_points, done_points, carried, completion_pct}."""
import argparse, csv, io, json, math, sys


def capacity(team):
    return math.floor(sum(float(r['days_in_sprint']) * float(r['points_per_day']) for r in team) + 1e-9)


def plan(backlog, team):
    cap, left, picked, skipped = capacity(team), capacity(team), [], []
    for r in sorted(backlog, key=lambda r: (int(r['priority'] or 99), r['id'])):
        est = (r['estimate'] or '').strip()
        why = ('done' if (r['status'] or '').strip().lower() == 'done' else 'missing acceptance criteria' if not (r['acceptance_criteria'] or '').strip()
               else 'missing estimate' if not est.isdigit() else f'{est} points do not fit in the {left} left' if int(est) > left else '')
        if why:
            skipped.append({'id': r['id'], 'reason': why}) if why != 'done' else None
        else:
            picked.append(r['id'])
            left -= int(est)
    return {'capacity': cap, 'planned_points': cap - left, 'stories': picked, 'skipped': skipped}


def metrics(backlog, committed, done):
    pts = {r['id']: int(r['estimate'] or 0) for r in backlog}
    unknown = [i for i in committed + done if i not in pts]
    if unknown:
        raise ValueError(f'not in the backlog: {", ".join(unknown)}')
    c, d = sum(pts[i] for i in committed), sum(pts[i] for i in done)
    return {'committed_points': c, 'done_points': d, 'carried': [i for i in committed if i not in done], 'completion_pct': round(100 * d / c) if c else 0}


def self_test():
    team = list(csv.DictReader(io.StringIO('member,role,days_in_sprint,points_per_day\nA,dev,10,0.5\nB,dev,5,0.5\nP,po,0,0\n')))
    assert capacity(team) == 7
    bl = list(csv.DictReader(io.StringIO('id,title,story,acceptance_criteria,estimate,priority,status\n'
        'S1,t,s,ok,5,1,new\nS2,t,s,ok,3,2,new\nS3,t,s,ok,2,3,new\nS4,t,s,,1,4,new\nS5,t,s,ok,,5,new\nS6,t,s,ok,1,6,done\nS7,t,s,ok,1,7,new\n')))
    r = plan(bl, team)
    assert r['stories'] == ['S1', 'S3'] and r['planned_points'] == 7, r
    assert [s['id'] for s in r['skipped']] == ['S2', 'S4', 'S5', 'S7'], r
    assert metrics(bl, ['S1', 'S3'], ['S3']) == {'committed_points': 7, 'done_points': 2, 'carried': ['S1'], 'completion_pct': 29}
    print('self-test ok')


if __name__ == '__main__':
    a = argparse.ArgumentParser()
    a.add_argument('--backlog', default='/files/out/backlog.csv')
    a.add_argument('--team', default='/tmp/assistant/team.csv')
    a.add_argument('--metrics', action='store_true')
    a.add_argument('--committed', default='')
    a.add_argument('--done', default='')
    a.add_argument('--self-test', action='store_true')
    o = a.parse_args()
    if o.self_test:
        self_test()
        sys.exit(0)
    split = lambda s: [x.strip() for x in s.split(',') if x.strip()]
    try:
        backlog = list(csv.DictReader(open(o.backlog, encoding='utf-8', newline='')))
        print(json.dumps(metrics(backlog, split(o.committed), split(o.done)) if o.metrics else plan(backlog, list(csv.DictReader(open(o.team, encoding='utf-8', newline=''))))))
    except (OSError, ValueError, KeyError) as e:
        sys.exit(f'plan.py: {e!r}')
