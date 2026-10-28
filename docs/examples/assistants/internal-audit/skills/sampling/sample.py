#!/usr/bin/env python3
"""Deterministic audit sample: the size comes from the sampling table in methodology.md (population x risk), the picks from a seeded shuffle.
Usage: python3 sample.py --population 120 --risk high [--control A.5.15] [--ids id1,id2,...] [--methodology /tmp/assistant/methodology.md] [--seed TEXT]
       python3 sample.py --self-test
Prints JSON {population, risk, size, picks}. picks are 1-based positions in the population, or ids when --ids is given. The same input always gives the same sample.
Table rows look like: | 16-50 | 5 | 8 | 12 |   (columns: population range, low, medium, high; size "all" means the whole population; "1001+" is open-ended)."""
import argparse, json, random, re, sys

ROW = re.compile(r'^\|\s*(\d+)\s*(?:-\s*(\d+)|(\+))\s*\|\s*(\w+)\s*\|\s*(\w+)\s*\|\s*(\w+)\s*\|\s*$')
RISKS = ('low', 'medium', 'high')


def table(text):
    rows = [(int(m[1]), int(m[2]) if m[2] else None, m.groups()[3:]) for m in map(ROW.match, text.splitlines()) if m]
    if not rows:
        raise ValueError('no sampling table rows like "| 16-50 | 5 | 8 | 12 |" found in the methodology')
    return rows


def size(rows, population, risk):
    if risk not in RISKS:
        raise ValueError(f'risk must be one of {", ".join(RISKS)}')
    if population < 1:
        raise ValueError('population must be at least 1')
    for lo, hi, cols in rows:
        if population >= lo and (hi is None or population <= hi):
            c = cols[RISKS.index(risk)]
            return population if c == 'all' else min(int(c), population)
    raise ValueError(f'population {population} is not covered by the table')


def pick(rows, population, risk, seed, ids=None):
    n = size(rows, population, risk)
    pool = ids if ids else list(range(1, population + 1))
    chosen = random.Random(seed).sample(pool, n)
    return {'population': population, 'risk': risk, 'size': n, 'picks': sorted(chosen) if not ids else [i for i in pool if i in chosen]}


def self_test():
    rows = table('| Population | low | medium | high |\n|---|---|---|---|\n| 1-4 | all | all | all |\n| 5-15 | 3 | 4 | 5 |\n| 16-50 | 5 | 8 | 12 |\n| 51+ | 8 | 13 | 20 |\n')
    assert [size(rows, n, r) for n, r in ((3, 'low'), (5, 'low'), (15, 'high'), (16, 'medium'), (50, 'high'), (51, 'low'), (5000, 'high'))] == [3, 3, 5, 8, 12, 8, 20]
    a, b = pick(rows, 40, 'high', 'x'), pick(rows, 40, 'high', 'x')
    assert a == b and len(set(a['picks'])) == 12 and all(1 <= i <= 40 for i in a['picks'])
    assert pick(rows, 40, 'high', 'y') != a
    assert pick(rows, 3, 'low', 'x')['picks'] == [1, 2, 3]
    assert pick(rows, 6, 'low', 'x', ['a', 'b', 'c', 'd', 'e', 'f'])['size'] == 3
    for bad in (lambda: size(rows, 0, 'low'), lambda: size(rows, 5, 'extreme'), lambda: table('no table')):
        try:
            bad()
            raise AssertionError('should fail')
        except ValueError:
            pass
    print('self-test ok')


if __name__ == '__main__':
    a = argparse.ArgumentParser()
    a.add_argument('--population', type=int)
    a.add_argument('--risk')
    a.add_argument('--control', default='')
    a.add_argument('--ids')
    a.add_argument('--methodology', default='/tmp/assistant/methodology.md')
    a.add_argument('--seed')
    a.add_argument('--self-test', action='store_true')
    o = a.parse_args()
    if o.self_test:
        self_test()
        sys.exit(0)
    try:
        ids = [x.strip() for x in o.ids.split(',') if x.strip()] if o.ids else None
        pop = len(ids) if ids else o.population
        if pop is None or o.risk is None:
            raise ValueError('give --population (or --ids) and --risk')
        rows = table(open(o.methodology, encoding='utf-8').read())
        print(json.dumps(pick(rows, pop, o.risk.lower(), o.seed or f'{o.control}|{pop}|{o.risk.lower()}', ids)))
    except (OSError, ValueError) as e:
        sys.exit(f'sample.py: {e}')
