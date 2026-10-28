#!/usr/bin/env python3
"""Booking CSV from matched invoices. Books status OK invoices plus any listed in --release.
Usage: python3 export.py [--root /tmp/assistant] [--work /files/out] [--release INV-1,INV-2]   (reads <work>/invoices.json, <work>/match.json and <root>/data/*.csv, writes <work>/booking.csv)
       each file can also be given with --invoices --match --po --chart --suppliers --out
       python3 export.py --self-test
Per invoice: one debit row per (expense account, cost center) for the net, one debit row on the input VAT account, all credited to the supplier's creditor account."""
import argparse, csv, json, os, sys
from decimal import Decimal as D, ROUND_HALF_UP

HEAD = ['booking_date', 'doc_no', 'debit_account', 'credit_account', 'amount', 'tax_code', 'text', 'cost_center']
q = lambda x: x.quantize(D('0.01'), ROUND_HALF_UP)


def book(invoices, matches, pos, chart, suppliers, release=()):
    po = {(r['po_number'], int(r['line'])): r for r in pos}
    acct = {r['category']: r['account'] for r in chart if r['type'] != 'vat'}
    vat_acct = {r['vat_rate']: r['account'] for r in chart if r['type'] == 'vat'}
    cred = {r['supplier_id']: r['creditor_account'] for r in suppliers}
    out, held = [], []
    assert len(invoices) == len(matches), 'match.json is not from this invoices.json: run match.py again'
    for inv, m in zip(invoices, matches):  # same order; invoice numbers repeat for duplicates
        no = inv['invoice_no']
        if m['status'] != 'OK' and (no not in release or any(f['code'] == 'DUPLICATE' for f in m['findings'])):  # a duplicate is never booked, even when released
            held.append(no)
            continue
        groups = {}
        for ln in inv['lines']:
            p = po[(inv['po_number'], int(ln['po_line']))]
            k = (acct[p['category']], p['cost_center'])
            groups[k] = groups.get(k, D(0)) + D(ln['qty']) * D(ln['unit_price'])
        net, vat = D(inv['net']), D(inv['vat'])
        rate = str(int((vat / net * 100).quantize(D('1'), ROUND_HALF_UP)))
        c, text = cred[inv['supplier_id']], f"{inv['supplier_id']} {no}"
        for (a, cc), amount in sorted(groups.items()):
            out.append([inv['date'], no, a, c, f'{q(amount)}', rate, text, cc])
        out.append([inv['date'], no, vat_acct[rate], c, f'{q(vat)}', rate, text + ' VAT', next(iter(groups))[1]])
    return out, held


def rows(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def self_test():
    inv = [{'invoice_no': 'A', 'supplier_id': 'S1', 'date': '2026-01-01', 'po_number': 'P1', 'lines': [{'po_line': 1, 'qty': 2, 'unit_price': '50.00'}], 'net': '100.00', 'vat': '19.00'}]
    pos = [{'po_number': 'P1', 'line': '1', 'category': 'tools', 'cost_center': 'CC1'}]
    chart = [{'account': '4985', 'type': 'expense', 'category': 'tools', 'vat_rate': '19'}, {'account': '1576', 'type': 'vat', 'category': '', 'vat_rate': '19'}]
    sup = [{'supplier_id': 'S1', 'creditor_account': '70001'}]
    rows_, held = book(inv, [{'invoice_no': 'A', 'status': 'OK', 'findings': []}], pos, chart, sup)
    assert rows_ == [['2026-01-01', 'A', '4985', '70001', '100.00', '19', 'S1 A', 'CC1'], ['2026-01-01', 'A', '1576', '70001', '19.00', '19', 'S1 A VAT', 'CC1']] and not held, rows_
    flagged = [{'invoice_no': 'A', 'status': 'FLAG', 'findings': [{'code': 'PRICE_DIFF'}]}]
    assert book(inv, flagged, pos, chart, sup) == ([], ['A']), 'flagged is held'
    assert len(book(inv, flagged, pos, chart, sup, release=['A'])[0]) == 2, 'released is booked'
    dup = [{'invoice_no': 'A', 'status': 'FLAG', 'findings': [{'code': 'DUPLICATE'}]}]
    assert book(inv, dup, pos, chart, sup, release=['A']) == ([], ['A']), 'duplicate is never booked'
    print('self-test ok')


if __name__ == '__main__':
    a = argparse.ArgumentParser()
    a.add_argument('--root', default='/tmp/assistant', help='the Assistant\'s reference files')
    a.add_argument('--work', default='/files/out', help='where the chat reads and writes results')
    a.add_argument('--invoices')
    a.add_argument('--match')
    a.add_argument('--po')
    a.add_argument('--chart')
    a.add_argument('--suppliers')
    a.add_argument('--out')
    a.add_argument('--release', default='')
    a.add_argument('--self-test', action='store_true')
    o = a.parse_args()
    o.invoices, o.match, o.out = o.invoices or f'{o.work}/invoices.json', o.match or f'{o.work}/match.json', o.out or f'{o.work}/booking.csv'
    o.po, o.chart, o.suppliers = o.po or f'{o.root}/data/purchase-orders.csv', o.chart or f'{o.root}/data/chart-of-accounts.csv', o.suppliers or f'{o.root}/data/suppliers.csv'
    if o.self_test:
        self_test()
        sys.exit(0)
    try:
        with open(o.invoices, encoding='utf-8') as f:
            invoices = json.load(f)
        with open(o.match, encoding='utf-8') as f:
            matches = json.load(f)['results']
        out, held = book(invoices, matches, rows(o.po), rows(o.chart), rows(o.suppliers), [x for x in o.release.split(',') if x])
    except (OSError, ValueError, KeyError, TypeError, AssertionError) as e:
        sys.exit(f'export.py: {type(e).__name__}: {e}')
    os.makedirs(os.path.dirname(o.out) or '.', exist_ok=True)
    with open(o.out, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(HEAD)
        w.writerows(out)
    print(f'{len(out)} booking rows written to {o.out}; held back: {", ".join(held) or "none"}')
