#!/usr/bin/env python3
"""Index of the approved answer library with the stale flag (reviewed more than 365 days before today).
Usage: python3 library.py [--dir /tmp/assistant/answers-library] [--today YYYY-MM-DD] [--json]
       python3 library.py --self-test
Reads the front matter (id, topic, owner, reviewed, tags) of every *.md file. A file with a missing or unreadable field is reported as an error (exit 1)."""
import argparse, glob, json, os, sys
from datetime import date

STALE_DAYS = 365


def parse(text):
    head, _, body = text.partition('\n---\n')
    meta = dict(l.split(':', 1) for l in head.removeprefix('---\n').splitlines() if ':' in l)
    meta = {k.strip(): v.strip() for k, v in meta.items()}
    for k in ('id', 'topic', 'owner', 'reviewed'):
        if not meta.get(k):
            raise ValueError(f'missing {k}')
    meta['reviewed_date'] = date.fromisoformat(meta['reviewed'])
    meta['answer'] = body.strip()
    return meta


def index(texts, today):
    out = []
    for name, text in texts:
        try:
            m = parse(text)
        except ValueError as e:
            raise ValueError(f'{name}: {e}')
        age = (today - m['reviewed_date']).days
        out.append({'id': m['id'], 'topic': m['topic'], 'owner': m['owner'], 'reviewed': m['reviewed'], 'age_days': age, 'stale': age > STALE_DAYS,
                    'tags': [t.strip() for t in m.get('tags', '').split(',') if t.strip()], 'file': name})
    return sorted(out, key=lambda x: x['id'])


def self_test():
    doc = '---\nid: X-1\ntopic: T\nowner: O\nreviewed: 2025-10-27\ntags: a, b\n---\nBody.\n'
    r = index([('x.md', doc)], date(2026, 10, 28))[0]
    assert r['stale'] and r['age_days'] == 366 and r['tags'] == ['a', 'b'], r
    assert not index([('x.md', doc.replace('2025-10-27', '2025-10-28'))], date(2026, 10, 28))[0]['stale'], 'exactly 365 days is not stale'
    try:
        index([('y.md', '---\nid: Y\n---\nx')], date(2026, 1, 1))
        raise SystemExit('missing fields accepted')
    except ValueError:
        pass
    print('self-test ok')


if __name__ == '__main__':
    a = argparse.ArgumentParser()
    a.add_argument('--dir', default='/tmp/assistant/answers-library')
    a.add_argument('--today', default=None)
    a.add_argument('--json', action='store_true')
    a.add_argument('--self-test', action='store_true')
    o = a.parse_args()
    if o.self_test:
        self_test()
        sys.exit(0)
    try:
        texts = [(os.path.basename(p), open(p, encoding='utf-8').read()) for p in sorted(glob.glob(os.path.join(o.dir, '*.md')))]
        rows = index(texts, date.fromisoformat(o.today) if o.today else date.today())
    except (OSError, ValueError) as e:
        sys.exit(f'library.py: {e}')
    if o.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
    else:
        for r in rows:
            print(f"{r['id']:8} {'STALE' if r['stale'] else 'ok   '} {r['reviewed']} ({r['age_days']:4} d) {r['topic']} | {r['owner']} | {', '.join(r['tags'])}")
        print(f"{len(rows)} answers, {sum(r['stale'] for r in rows)} stale")
