#!/usr/bin/env python3
"""Runs the looping process described in process.json, one stage at a time, and keeps the state on disk.
Usage: python3 process.py start [--items-<list> a,b,c]
       python3 process.py status
       python3 process.py advance --outcome "<when or done>" [--note "..."] [--by-person] [--items-<list> a,b,c]
       python3 process.py history
Options for all commands: --root /tmp/assistant  --process <root>/process.json  --state /files/out/<title-slug>/state.json  --now <ISO time>
       python3 process.py --self-test
Every command prints JSON. A refused step prints {"error": ...} on stderr and exits 1; the state is then unchanged."""
import argparse, copy, json, os, re, sys, tempfile
from datetime import datetime, timezone

ID = re.compile(r'^[a-z][a-z0-9-]{0,31}$')
BY = re.compile(r'^(agent|person|helper:[a-z][a-z0-9-]{0,31}|script:[A-Za-z0-9._-]+/[A-Za-z0-9._-]+)$')
NEXT, ALL = 'next item', 'all items done'


class Fail(Exception):
    pass


def reach(p, src):
    seen, todo = set(), [src]
    while todo:
        s = todo.pop()
        if s in seen:
            continue
        seen.add(s)
        for e in p['next']:
            if e['from'] == s:
                todo += [e['to']] + ([e['then']] if 'then' in e else [])
    return seen


def validate(p, root=None):
    errs = []
    if not isinstance(p, dict) or p.get('version') != 1:
        raise Fail('process.json: "version" must be 1')
    if not isinstance(p.get('title'), str) or not p['title'].strip():
        errs.append('"title" is required')
    stages, edges = p.get('stages'), p.get('next')
    if not isinstance(stages, list) or not 1 <= len(stages) <= 40:
        raise Fail('process.json: "stages" must be a list of 1 to 40 stages')
    if not isinstance(edges, list) or len(edges) > 120:
        raise Fail('process.json: "next" must be a list of at most 120 edges')
    ids = [s.get('id') if isinstance(s, dict) else None for s in stages]
    roles = skills = None
    if root and os.path.exists(os.path.join(root, 'helpers.json')):
        roles = {h.get('role') for h in json.load(open(os.path.join(root, 'helpers.json'), encoding='utf-8'))}
    if root and os.path.isdir(os.path.join(root, 'skills')):
        skills = os.path.join(root, 'skills')
    for s in stages:
        if not isinstance(s, dict) or not isinstance(s.get('id'), str) or not ID.match(s['id']):
            errs.append(f'stage id {s.get("id") if isinstance(s, dict) else s!r} must match {ID.pattern}')
            continue
        i = s['id']
        if ids.count(i) > 1:
            errs.append(f'stage {i}: id used twice')
        if not isinstance(s.get('title'), str) or not 0 < len(s['title']) <= 60:
            errs.append(f'stage {i}: "title" must be 1 to 60 characters')
        if not isinstance(s.get('by'), str) or not BY.match(s['by']):
            errs.append(f'stage {i}: "by" must be agent, person, helper:<role> or script:<skill>/<file>')
        else:
            if s['by'].startswith('helper:') and roles is not None and s['by'][7:] not in roles:
                errs.append(f'stage {i}: helper "{s["by"][7:]}" is not in helpers.json')
            if s['by'].startswith('script:') and skills and not os.path.isfile(os.path.join(skills, s['by'][7:])):
                errs.append(f'stage {i}: script skills/{s["by"][7:]} does not exist')
        if 'does' in s and (not isinstance(s['does'], str) or len(s['does']) > 200):
            errs.append(f'stage {i}: "does" must be at most 200 characters')
        if 'each' in s and (not isinstance(s['each'], str) or not ID.match(s['each'])):
            errs.append(f'stage {i}: "each" must be a list name like {ID.pattern}')
    if errs:
        raise Fail('; '.join(errs))
    if p['start'] not in ids:
        errs.append(f'"start" {p["start"]!r} is not a stage')
    by_id = {s['id']: s for s in stages}
    seen = set()
    for n, e in enumerate(edges):
        if not isinstance(e, dict) or e.get('from') not in by_id or e.get('to') not in by_id:
            errs.append(f'edge {n}: "from" and "to" must be stage ids')
            continue
        f, w = e['from'], e.get('when')
        if by_id[f].get('end'):
            errs.append(f'edge {n}: end stage {f} has no outgoing edge')
        if w is not None and (not isinstance(w, str) or not 0 < len(w) <= 40):
            errs.append(f'edge {n}: "when" must be 1 to 40 characters')
        if (f, w) in seen:
            errs.append(f'edge {n}: stage {f} has two edges for {w if w else "the default way out"}')
        seen.add((f, w))
        if 'max' in e:
            if not isinstance(e['max'], int) or isinstance(e['max'], bool) or not 1 <= e['max'] <= 20:
                errs.append(f'edge {n}: "max" must be 1 to 20')
            if e.get('then') not in by_id:
                errs.append(f'edge {n}: "max" needs "then" naming a stage')
        elif 'then' in e:
            errs.append(f'edge {n}: "then" needs "max"')
    if errs:
        raise Fail('; '.join(errs))
    out = {s['id']: [e for e in edges if e['from'] == s['id']] for s in stages}
    for s in stages:
        if s.get('end') and out[s['id']]:
            errs.append(f'end stage {s["id"]} has outgoing edges')
        if not s.get('end') and not out[s['id']]:
            errs.append(f'stage {s["id"]} is not an end stage and has no outgoing edge')
    after_each = set().union(*[reach(p, s['id']) for s in stages if s.get('each')])
    for f, es in out.items():
        res = {e.get('when') for e in es} & {NEXT, ALL}
        if res and (res != {NEXT, ALL} or None in {e.get('when') for e in es}):
            errs.append(f'stage {f}: "{NEXT}" and "{ALL}" come as a pair and without a default way out')
        elif res and f not in after_each:
            errs.append(f'stage {f}: "{NEXT}" must come after an "each" stage')
    r = reach(p, p['start'])
    errs += [f'stage {i} is not reachable from start' for i in ids if i not in r]
    if not any(by_id[i].get('end') for i in r):
        errs.append('no end stage is reachable')
    if errs:
        raise Fail('; '.join(errs))
    return p


def slug(t):
    return re.sub(r'[^a-z0-9]+', '-', t.lower()).strip('-') or 'process'


def stage_of(p, sid):
    return next(s for s in p['stages'] if s['id'] == sid)


def edges_from(p, sid):
    return [e for e in p['next'] if e['from'] == sid]


def ekey(e):
    return f"{e['from']}|{e.get('when', '')}"


def scope(st):
    return st['item'] if st['loop'] else ''


def enter(p, st, sid, now, item_before):
    """Moves to a stage; leaves a loop the process can no longer return to; starts the loop of an each stage."""
    s = stage_of(p, sid)
    st['stage'] = sid
    st['finished'] = bool(s.get('end'))
    abandoned = None
    if st['loop'] and st['loop_stage'] not in reach(p, sid):
        abandoned = list(st['queues'].get(st['loop'], []))
        st['loop'] = st['item'] = st['loop_stage'] = None
    if s.get('each') and st['loop'] != s['each']:
        if st['loop']:
            raise Fail(f'stage {sid} starts the loop "{s["each"]}" while "{st["loop"]}" is still running')
        q = st['queues'].get(s['each'])
        if not q:
            raise Fail(f'stage {sid} loops over "{s["each"]}" but there are no items: pass --items-{s["each"]} a,b,c')
        st['loop'], st['loop_stage'], st['item'] = s['each'], sid, q.pop(0)
    return abandoned


def stage_view(p, st):
    s = stage_of(p, st['stage'])
    sc = st['counters'].get(scope(st), {})
    v = {k: s[k] for k in ('id', 'title', 'by', 'does') if k in s}
    v['action'] = {'agent': 'do this yourself', 'person': 'stop and ask the person; then advance with --by-person and their answer in --note'}.get(
        s['by'], f'delegate to the helper "{s["by"][7:]}" with the checklist from the skill' if s['by'].startswith('helper:') else f'run {s["by"][7:]} from its skill folder')
    if s.get('end'):
        v['end'] = True
    if st['loop']:
        v['loop'] = {'list': st['loop'], 'item': st['item'], 'remaining': st['queues'].get(st['loop'], []), 'done': st['done_items'].get(st['loop'], [])}
    outs = []
    for e in edges_from(p, s['id']):
        w = e.get('when')
        o = {'outcome': w or 'done', 'to': e['to']}
        if w in (NEXT, ALL):
            o['outcome'] = 'done'
            o['picks'] = w
        if 'max' in e:
            o.update(max=e['max'], left=max(0, e['max'] - sc.get(ekey(e), 0)), then=e['then'])
        outs.append(o)
    if any(o.get('picks') for o in outs):  # the runner picks between the two item edges
        want = NEXT if st['queues'].get(st['loop']) else ALL
        outs = [o for o in outs if o['picks'] == want]
    v['outcomes'] = outs
    return {'finished': st['finished'], 'stage': v}


def advance(p, st, outcome, note, by_person, items, now):
    if st['finished']:
        raise Fail('the process has finished')
    s = stage_of(p, st['stage'])
    for l, v in items.items():
        if st['loop'] == l:
            raise Fail(f'the loop "{l}" is running; items can only be set between loops')
        st['queues'][l] = v
    if s['by'] == 'person' and not (by_person and note):
        raise Fail(f'stage {s["id"]} is a person stage: ask the person, then pass --by-person with their answer quoted in --note')
    es, o = edges_from(p, s['id']), (outcome or '').strip().lower()
    if any(e.get('when') in (NEXT, ALL) for e in es):
        if o != 'done' or not st['loop']:
            raise Fail(f'stage {s["id"]} walks the items: use --outcome done inside a running loop')
        want = NEXT if st['queues'].get(st['loop']) else ALL
        edge = next(e for e in es if e['when'] == want)
    else:
        edge = next((e for e in es if (e.get('when') or 'done').lower() == o), None)
        if not edge:
            raise Fail(f'stage {s["id"]}: outcome {outcome!r} is not one of: ' + ', '.join(e.get('when') or 'done' for e in es))
    sc = st['counters'].setdefault(scope(st), {})
    to, via = edge['to'], 'edge'
    if 'max' in edge:
        if sc.get(ekey(edge), 0) < edge['max']:
            sc[ekey(edge)] = sc.get(ekey(edge), 0) + 1
        else:
            to, via = edge['then'], 'max-then'
    item, loop = st['item'], st['loop']
    if edge.get('when') in (NEXT, ALL):
        st['done_items'].setdefault(loop, []).append(item)
        if edge['when'] == NEXT:
            st['item'] = st['queues'][loop].pop(0)
        else:
            st['loop'] = st['item'] = st['loop_stage'] = None
    h = {'at': now, 'from': s['id'], 'outcome': edge.get('when') or 'done', 'to': to, 'via': via, 'item': item, 'by_person': bool(by_person), 'note': note or ''}
    ab = enter(p, st, to, now, item)
    if ab is not None:
        h['abandoned_items'] = ab
    st['history'].append(h)
    return {'moved': {k: h[k] for k in ('from', 'outcome', 'to', 'via')}, **stage_view(p, st)}


def run(argv, now=None):
    items, rest = {}, []
    i = 0
    while i < len(argv):
        m = re.match(r'^--items-([a-z][a-z0-9-]*)(?:=(.*))?$', argv[i])
        if m:
            val = m.group(2) if m.group(2) is not None else (argv[i + 1] if i + 1 < len(argv) else '')
            i += 1 if m.group(2) is not None else 2
            items[m.group(1)] = [x.strip() for x in val.split(',') if x.strip()]
        else:
            rest.append(argv[i])
            i += 1
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--root', default='/tmp/assistant')
    common.add_argument('--process')
    common.add_argument('--state')
    common.add_argument('--now')
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = a.add_subparsers(dest='cmd', required=True)
    sub.add_parser('start', parents=[common]).add_argument('--force', action='store_true')
    sub.add_parser('status', parents=[common])
    sub.add_parser('history', parents=[common])
    adv = sub.add_parser('advance', parents=[common])
    adv.add_argument('--outcome', required=True)
    adv.add_argument('--note', default='')
    adv.add_argument('--by-person', action='store_true')
    o = a.parse_args(rest)
    try:
        p = validate(json.load(open(o.process or os.path.join(o.root, 'process.json'), encoding='utf-8')), o.root)
    except (OSError, ValueError) as e:
        raise Fail(f'cannot read process.json: {e}')
    path = o.state or os.path.join('/files/out', slug(p['title']), 'state.json')
    now = o.now or now or datetime.now(timezone.utc).isoformat(timespec='seconds')
    if o.cmd == 'start':
        if os.path.exists(path) and not o.force:
            raise Fail(f'{path} exists: use status, or start --force to begin again')
        st = {'process': p['title'], 'stage': None, 'finished': False, 'loop': None, 'loop_stage': None, 'item': None,
              'queues': items, 'done_items': {}, 'counters': {}, 'history': []}
        enter(p, st, p['start'], now, None)
        st['history'].append({'at': now, 'event': 'start', 'to': p['start'], 'items': {k: list(v) for k, v in items.items()}})
        res = stage_view(p, st)
    else:
        if not os.path.exists(path):
            raise Fail(f'no state at {path}: run start first')
        st = json.load(open(path, encoding='utf-8'))
        if o.cmd == 'history':
            return st['history']
        if o.cmd == 'status':
            return {**stage_view(p, st), 'steps': len(st['history']) - 1}
        st = copy.deepcopy(st)
        res = advance(p, st, o.outcome, o.note, o.by_person, items, now)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(st, open(path, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    return res


SELF = {'version': 1, 'title': 'Self test', 'start': 'plan', 'stages': [
    {'id': 'plan', 'title': 'Plan', 'by': 'agent'},
    {'id': 'gate', 'title': 'Person gate', 'by': 'person'},
    {'id': 'work', 'title': 'Work', 'by': 'agent', 'each': 'jobs'},
    {'id': 'check', 'title': 'Check', 'by': 'agent'},
    {'id': 'more', 'title': 'Next job', 'by': 'agent'},
    {'id': 'ship', 'title': 'Ship', 'by': 'agent', 'end': True}],
    'next': [{'from': 'plan', 'to': 'gate'},
             {'from': 'gate', 'to': 'work'}, {'from': 'gate', 'when': 'redo', 'to': 'plan', 'max': 1, 'then': 'work'},
             {'from': 'work', 'to': 'check'},
             {'from': 'check', 'to': 'more'}, {'from': 'check', 'when': 'fail', 'to': 'work', 'max': 1, 'then': 'more'},
             {'from': 'more', 'when': NEXT, 'to': 'work'}, {'from': 'more', 'when': ALL, 'to': 'ship'}]}


def self_test():
    d = tempfile.mkdtemp()
    pf, base = os.path.join(d, 'process.json'), ['--process', os.path.join(d, 'process.json'), '--state', os.path.join(d, 's.json'), '--root', d, '--now', '2026-01-01T00:00:00Z']
    json.dump(SELF, open(pf, 'w'))
    r = lambda *x, **k: run(list(x) + base, **k)

    def refused(*x):
        try:
            r(*x)
        except Fail as e:
            return str(e)
        raise AssertionError(f'{x} should be refused')
    assert r('start', '--items-jobs', 'a,b,c')['stage']['id'] == 'plan'
    assert 'exists' in refused('start')
    assert 'not one of' in refused('advance', '--outcome', 'nope')
    go = lambda o, *x: r('advance', '--outcome', o, *x)
    p1 = ('--by-person', '--note', 'the person said so')
    go('done')  # plan -> gate
    assert 'person stage' in refused('advance', '--outcome', 'redo')
    assert 'person stage' in refused('advance', '--outcome', 'redo', '--note', 'yes')
    assert go('redo', *p1)['moved'] == {'from': 'gate', 'outcome': 'redo', 'to': 'plan', 'via': 'edge'}
    go('done')
    m = go('redo', *p1)  # max 1 used up: then
    assert (m['moved']['via'], m['moved']['to'], m['stage']['loop']['item']) == ('max-then', 'work', 'a'), m
    go('done')  # work a -> check
    assert go('fail')['moved']['via'] == 'edge'  # check -> work, budget 1 of 1 used
    go('done')  # work -> check
    assert go('fail')['moved'] == {'from': 'check', 'outcome': 'fail', 'to': 'more', 'via': 'max-then'}
    assert 'walks the items' in refused('advance', '--outcome', 'fail')
    m = go('done')  # next item
    assert (m['moved']['to'], m['stage']['loop']['item'], m['stage']['loop']['remaining']) == ('work', 'b', ['c']), m
    go('done')
    assert go('fail')['moved']['via'] == 'edge'  # b has its own loop budget
    go('done'), go('done'), go('done')  # work, check, more -> c
    go('done'), go('done')  # work, check
    m = go('done')  # more: all items done
    assert m['finished'] and m['stage']['id'] == 'ship' and 'loop' not in m['stage'], m
    assert 'finished' in refused('advance', '--outcome', 'done')
    assert [h['item'] for h in r('history')[1:] if h['from'] == 'more'] == ['a', 'b', 'c']
    bad = dict(SELF, next=SELF['next'][:-1])
    try:
        validate(bad)
        raise AssertionError('a lone "next item" must fail')
    except Fail as e:
        assert 'pair' in str(e)
    print('self-test ok')


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        self_test()
    else:
        try:
            print(json.dumps(run(sys.argv[1:]), indent=1, ensure_ascii=False))
        except Fail as e:
            print(json.dumps({'error': str(e)}), file=sys.stderr)
            sys.exit(1)
