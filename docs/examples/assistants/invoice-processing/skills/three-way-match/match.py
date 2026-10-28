#!/usr/bin/env python3
"""Deterministic 3-way match: invoice vs purchase order vs goods receipt.
Usage: python3 match.py [--root /tmp/assistant] [--work /files/out]   (reads <work>/invoices.json and <root>/data/{purchase-orders,goods-receipts,suppliers}.csv, writes <work>/match.json)
       each file can also be given with --invoices --po --gr --suppliers --out
       python3 match.py --self-test
Thresholds mirror policies/approval-matrix.md. shortcut: only invoices in this batch count as "already invoiced"; add a history file if POs are billed over several runs."""
import argparse, csv, json, os, sys
from decimal import Decimal as D

PRICE_TOL = D('0.02')  # relative, upward only
SUM_TOL = D('0.02')    # absolute
APPROVAL = [(D(1000), 'AP clerk'), (D(5000), 'Cost center manager'), (D(25000), 'Head of department'), (D(100000), 'CFO')]


def approver(gross):
    return next((role for limit, role in APPROVAL if gross <= limit), 'CFO and CEO')


def run(invoices, pos, grs, suppliers):
    po = {(r['po_number'], int(r['line'])): r for r in pos}
    received = {}
    for r in grs:
        k = (r['po_number'], int(r['line']))
        received[k] = received.get(k, D(0)) + D(r['qty_received'])
    sup = {r['supplier_id']: r for r in suppliers}
    used, seen_no, seen_amt, results = {}, set(), set(), []
    for inv in invoices:
        found = []
        flag = lambda code, detail: found.append({'code': code, 'detail': detail})
        sid, no = inv.get('supplier_id'), str(inv.get('invoice_no') or '').strip().upper()
        gross = D(inv['gross']) if inv.get('gross') is not None else None
        dup = (sid, no) in seen_no or (gross is not None and (sid, inv.get('date'), gross) in seen_amt)
        if dup:
            flag('DUPLICATE', f'invoice {no} from {sid} was already seen in this batch')
        seen_no.add((sid, no))
        if gross is not None:
            seen_amt.add((sid, inv.get('date'), gross))
        s = sup.get(sid)
        if not s:
            flag('UNKNOWN_SUPPLIER', f'supplier {sid} is not in suppliers.csv')
        elif inv.get('iban') and inv['iban'].replace(' ', '') != s['iban']:
            flag('IBAN_MISMATCH', f'invoice IBAN {inv["iban"]} differs from master data')
        if inv.get('currency', 'EUR') != 'EUR':
            flag('CURRENCY', f'currency {inv.get("currency")} is not EUR')
        pn = inv.get('po_number')
        if not pn:
            flag('NO_PO', 'invoice has no PO number')
        elif not any(k[0] == pn for k in po):
            flag('UNKNOWN_PO', f'{pn} is not in purchase-orders.csv')
        else:
            wrong_supplier = False
            for ln in inv.get('lines') or []:
                k, qty, price = (pn, int(ln['po_line'])), D(ln['qty']), D(ln['unit_price'])
                p = po.get(k)
                if not p:
                    flag('LINE_NOT_ON_PO', f'{pn} line {k[1]} does not exist')
                    continue
                if p['supplier_id'] != sid and not wrong_supplier:
                    wrong_supplier = True
                    flag('SUPPLIER_MISMATCH', f'{pn} belongs to {p["supplier_id"]}, invoice is from {sid}')
                if price > D(p['unit_price']) * (1 + PRICE_TOL):
                    flag('PRICE_DIFF', f'{pn} line {k[1]}: invoiced {price} vs PO {p["unit_price"]}')
                if dup:
                    continue
                used[k] = used.get(k, D(0)) + qty
                if used[k] > D(p['qty']):
                    flag('QTY_OVER_ORDERED', f'{pn} line {k[1]}: invoiced {used[k]} vs ordered {p["qty"]}')
                if received.get(k, D(0)) == 0:
                    flag('NO_RECEIPT', f'{pn} line {k[1]}: no goods receipt')
                elif used[k] > received[k]:
                    flag('QTY_OVER_RECEIVED', f'{pn} line {k[1]}: invoiced {used[k]} vs received {received[k]}')
        net, vat = inv.get('net'), inv.get('vat')
        if None in (net, vat, gross):
            flag('MISSING_TOTALS', 'net, vat or gross could not be read')
        else:
            net, vat = D(net), D(vat)
            lines = sum(D(l['qty']) * D(l['unit_price']) for l in inv.get('lines') or [])
            if abs(lines - net) > SUM_TOL or abs(net + vat - gross) > SUM_TOL:
                flag('ARITHMETIC', f'lines {lines}, net {net}, vat {vat}, gross {gross} do not add up')
        results.append({'invoice_no': inv.get('invoice_no'), 'file': inv.get('file'), 'supplier_id': sid, 'gross': gross,
                        'status': 'FLAG' if found else 'OK', 'findings': found,
                        'approver': 'AP lead' if found else (approver(gross) if gross is not None else None),
                        'approver_if_cleared': approver(gross) if gross is not None else None})
    return results


def rows(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def self_test():
    pos = [{'po_number': 'P1', 'line': '1', 'supplier_id': 'S1', 'qty': '10', 'unit_price': '100.00'}]
    grs = [{'po_number': 'P1', 'line': '1', 'qty_received': '8'}]
    sup = [{'supplier_id': 'S1', 'iban': 'DE00'}]
    inv = lambda **k: {'invoice_no': 'A', 'supplier_id': 'S1', 'date': '2026-01-01', 'po_number': 'P1', 'iban': 'DE00', 'lines': [{'po_line': 1, 'qty': 8, 'unit_price': 100}], 'net': 800, 'vat': 152, 'gross': 952, **k}
    codes = lambda r: [f['code'] for f in r['findings']]
    r = run([inv()], pos, grs, sup)[0]
    assert r['status'] == 'OK' and r['approver'] == 'AP clerk', r
    assert codes(run([inv(), inv()], pos, grs, sup)[1]) == ['DUPLICATE'], 'duplicate'
    assert 'QTY_OVER_RECEIVED' in codes(run([inv(lines=[{'po_line': 1, 'qty': 9, 'unit_price': 100}], net=900, vat=171, gross=1071)], pos, grs, sup)[0])
    assert codes(run([inv(lines=[{'po_line': 1, 'qty': 8, 'unit_price': 102}], net=816, vat=155.04, gross=971.04)], pos, grs, sup)[0]) == [], '2% is tolerated'
    assert 'PRICE_DIFF' in codes(run([inv(lines=[{'po_line': 1, 'qty': 8, 'unit_price': 103}], net=824, vat=156.56, gross=980.56)], pos, grs, sup)[0])
    assert codes(run([inv(po_number=None)], pos, grs, sup)[0]) == ['NO_PO']
    assert 'IBAN_MISMATCH' in codes(run([inv(iban='DE99')], pos, grs, sup)[0])
    assert 'ARITHMETIC' in codes(run([inv(gross=960)], pos, grs, sup)[0])
    assert [approver(D(x)) for x in ('1000', '1000.01', '25000', '100000.01')] == ['AP clerk', 'Cost center manager', 'Head of department', 'CFO and CEO']
    print('self-test ok')


if __name__ == '__main__':
    a = argparse.ArgumentParser()
    a.add_argument('--root', default='/tmp/assistant', help='the Assistant\'s reference files')
    a.add_argument('--work', default='/files/out', help='where the chat reads and writes results')
    a.add_argument('--invoices')
    a.add_argument('--po')
    a.add_argument('--gr')
    a.add_argument('--suppliers')
    a.add_argument('--out')
    a.add_argument('--self-test', action='store_true')
    o = a.parse_args()
    o.invoices, o.out = o.invoices or f'{o.work}/invoices.json', o.out or f'{o.work}/match.json'
    o.po, o.gr, o.suppliers = o.po or f'{o.root}/data/purchase-orders.csv', o.gr or f'{o.root}/data/goods-receipts.csv', o.suppliers or f'{o.root}/data/suppliers.csv'
    if o.self_test:
        self_test()
        sys.exit(0)
    try:
        with open(o.invoices, encoding='utf-8') as f:
            invoices = json.load(f, parse_float=D)
        res = run(invoices, rows(o.po), rows(o.gr), rows(o.suppliers))
    except (OSError, ValueError, KeyError, TypeError) as e:
        sys.exit(f'match.py: {type(e).__name__}: {e}')
    os.makedirs(os.path.dirname(o.out) or '.', exist_ok=True)
    with open(o.out, 'w', encoding='utf-8') as f:
        json.dump({'ok': sum(r['status'] == 'OK' for r in res), 'flagged': sum(r['status'] == 'FLAG' for r in res), 'results': res}, f, indent=2, default=str, ensure_ascii=False)
    for r in res:
        print(f"{r['status']:4} {r['invoice_no']} {r['supplier_id']} {r['gross']} -> {r['approver']}" + ''.join(f"\n       {x['code']}: {x['detail']}" for x in r['findings']))
