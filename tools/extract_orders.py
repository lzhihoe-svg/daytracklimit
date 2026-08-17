"""Extract order rows from the Aramega Order Book workbook into orders.json.

Sheet layout (per OB - <MONTH>26 tab):
  A = order date, C = customer, D = job name, E = pcs, H = due date

Due-date quirk: the sheet's locale parsed "9/8" (9 Aug, d/m) as 9 Sept (m/d),
so date cells come back with day and month transposed. Anything the sheet
could not parse as m/d (day > 12) stayed a plain string in d/m form.
"""
import collections
import datetime
import json
import os
import re
import sys

import openpyxl

WB = 'ob.xlsx'
MONTHS = {
    'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUNE': 6,
    'JULY': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12,
}


def sheet_period(name):
    """'OB - JULY26' -> (2026, 7). Returns None for tabs we can't date."""
    name = name.strip()
    if name == 'OB - BULAN 12':
        return 2025, 12
    m = re.match(r"OB - ([A-Z]+)(\d{2})$", name)
    if not m or m.group(1) not in MONTHS:
        return None
    return 2000 + int(m.group(2)), MONTHS[m.group(1)]


def parse_order_date(value, period, carried):
    """Column A: a real date, or a '12HB' (haribulan) day label, or blank.

    The Jan-26 and Dec-25 tabs label each day group once with '<day>HB' and
    leave the following rows blank, so an unlabelled row inherits the day
    above it.
    """
    if isinstance(value, datetime.datetime):
        return value.date()
    if isinstance(value, str):
        m = re.match(r'\s*(\d{1,2})\s*(?:HB)?\s*$', value, re.I)
        if m:
            try:
                return datetime.date(period[0], period[1], int(m.group(1)))
            except ValueError:
                return carried
    if isinstance(value, (int, float)) and 1 <= value <= 31:
        try:
            return datetime.date(period[0], period[1], int(value))
        except ValueError:
            return carried
    return carried


def resolve_year(day, month, order_date):
    """Pick the year that puts a bare d/m due date nearest after the order."""
    for year in (order_date.year, order_date.year + 1, order_date.year - 1):
        try:
            cand = datetime.date(year, month, day)
        except ValueError:
            continue
        if cand >= order_date - datetime.timedelta(days=45):
            return cand
    return None


def parse_due(cell, order_date):
    """Normalise a DUE cell into a date, undoing the m/d transposition."""
    v = cell.value
    if v is None:
        return None
    if isinstance(v, datetime.datetime):
        # Displayed as "<month>/<day>" but typed as day/month -> swap back.
        day, month = v.month, v.day
        if month > 12:
            day, month = v.day, v.month
        return resolve_year(day, month, order_date)
    if isinstance(v, str):
        s = v.strip()
        m = re.fullmatch(r'(\d{1,2})\s*/\s*(\d{1,2})(?:\s*/\s*(\d{2,4}))?', s)
        if not m:
            return None  # "-", "?", "hold"
        day, month = int(m.group(1)), int(m.group(2))
        if m.group(3):
            year = int(m.group(3))
            year += 2000 if year < 100 else 0
            try:
                return datetime.date(year, month, day)
            except ValueError:
                return None
        return resolve_year(day, month, order_date)
    return None


def main():
    workbook = sys.argv[1] if len(sys.argv) > 1 else WB
    wb = openpyxl.load_workbook(workbook, data_only=True)
    orders = []
    stats = collections.Counter()

    for name in wb.sheetnames:
        period = sheet_period(name)
        if not period:
            continue
        ws = wb[name]
        order_date = None
        for r in range(2, ws.max_row + 1):
            order_date = parse_order_date(ws.cell(r, 1).value, period, order_date)
            if order_date is None:
                continue
            pcs = ws.cell(r, 5).value
            if isinstance(pcs, str):
                digits = re.sub(r'[^\d.]', '', pcs)
                pcs = float(digits) if digits else None
            if not isinstance(pcs, (int, float)) or pcs <= 0:
                stats['skipped_no_pcs'] += 1
                continue

            due = parse_due(ws.cell(r, 8), order_date)
            stats['due_given' if due else 'due_derived'] += 1
            if due and due < order_date:
                stats['due_before_order'] += 1

            orders.append({
                'd': order_date.isoformat(),
                'c': (str(ws.cell(r, 3).value or '')).strip(),
                'j': (str(ws.cell(r, 4).value or '')).strip(),
                'q': int(round(pcs)),
                'due': due.isoformat() if due else None,
            })

    orders.sort(key=lambda o: (o['d'], o['c']))
    payload = {
        'source': "Order Book - Ara's Subli 26'",
        'sheetId': '1Ug2pkQdKb2oa7RMnux1M_blQUkX6jDRFYxT5h87Kjag',
        'generatedAt': datetime.datetime.now().replace(microsecond=0).isoformat(),
        'orders': orders,
    }
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data')
    blob = json.dumps(payload, separators=(',', ':'))
    with open(os.path.join(root, 'orders.json'), 'w') as f:
        f.write(blob)
    # The app loads this as a plain script so it also works from file://
    with open(os.path.join(root, 'orders.js'), 'w') as f:
        f.write('/* Generated by tools/extract_orders.py — do not edit by hand. */\n')
        f.write('window.ARAMEGA_ORDERBOOK = ' + blob + ';\n')

    print('orders:', len(orders), dict(stats))
    print('order date range:', orders[0]['d'], '->', orders[-1]['d'])
    print('total pcs:', sum(o['q'] for o in orders))
    # quick look at load per due date for the current month
    load = collections.Counter()
    for o in orders:
        due = o['due'] or (datetime.date.fromisoformat(o['d']) + datetime.timedelta(days=7)).isoformat()
        load[due] += o['q']
    recent = sorted(k for k in load if k >= '2026-08-01')[:28]
    for k in recent:
        print(' ', k, load[k], '*' if load[k] > 400 else '')


if __name__ == '__main__':
    main()
