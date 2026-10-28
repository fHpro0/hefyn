#!/usr/bin/env python3
"""Dates and first-day schedule for a new hire.
Usage: python3 schedule.py --start 2026-11-02 --location Hamburg|Munich|remote [--probation-months 6]
       python3 schedule.py --self-test
Prints JSON. Refuses weekend start dates. shortcut: public holidays are not known; the person is asked about them."""
import argparse, calendar, json, sys
from datetime import date, timedelta

DAY_ONE = [('09:00', 'Welcome at reception, badge and desk'), ('09:30', 'IT: equipment handover and account setup'), ('10:30', 'HR: paperwork and company overview'),
           ('12:00', 'Lunch with team and buddy'), ('14:00', 'Welcome to Nordwerk session'), ('15:30', 'Manager 1:1: expectations and the 30/60/90 plan'), ('16:30', 'Day-end check-in with buddy')]
REMOTE = {'09:00': 'Video call with manager and buddy', '09:30': 'IT: video setup of accounts and laptop', '10:30': 'HR: video call for paperwork'}


def next_weekday(d):
    return d + timedelta(days=(7 - d.weekday()) % 7 if d.weekday() > 4 else 0)


def add_months(d, n):
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def plan(start, location, probation_months=6):
    if start.weekday() > 4:
        raise ValueError(f'{start} is a {start.strftime("%A")}: pick a working day')
    if location not in ('Hamburg', 'Munich', 'remote'):
        raise ValueError(f'unknown location {location!r}')
    day = lambda n: next_weekday(start + timedelta(days=n)).isoformat()
    sched = [{'time': t, 'what': REMOTE.get(t, w) if location == 'remote' else w} for t, w in DAY_ONE]
    return {'start': start.isoformat(), 'weekday': start.strftime('%A'), 'location': location,
            'review_30': day(30), 'review_60': day(60), 'review_90': day(90),
            'probation_end': (add_months(start, probation_months) - timedelta(days=1)).isoformat(),
            'security_training_due': day(7), 'equipment_order_deadline': (start - timedelta(days=14)).isoformat(),  # 10 business days is 14 calendar days
            'first_day': sched}


def self_test():
    p = plan(date(2026, 11, 2), 'Hamburg')
    assert p['weekday'] == 'Monday' and p['review_30'] == '2026-12-02' and p['review_60'] == '2027-01-01', p  # a holiday: the person is asked about holidays
    assert p['review_90'] == '2027-02-01' and p['probation_end'] == '2027-05-01' and p['equipment_order_deadline'] == '2026-10-19'
    assert plan(date(2026, 11, 2), 'remote')['first_day'][0]['what'].startswith('Video')
    assert add_months(date(2026, 8, 31), 6) == date(2027, 2, 28)
    try:
        plan(date(2026, 11, 7), 'Munich')
        raise SystemExit('weekend accepted')
    except ValueError:
        pass
    print('self-test ok')


if __name__ == '__main__':
    a = argparse.ArgumentParser()
    a.add_argument('--start')
    a.add_argument('--location', default='Hamburg')
    a.add_argument('--probation-months', type=int, default=6)
    a.add_argument('--self-test', action='store_true')
    o = a.parse_args()
    if o.self_test:
        self_test()
        sys.exit(0)
    try:
        print(json.dumps(plan(date.fromisoformat(o.start or ''), o.location, o.probation_months), indent=2))
    except ValueError as e:
        sys.exit(f'schedule.py: {e}')
