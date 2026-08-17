# Aramega — Daily Quantity Limit Tracker

A web app that reads the Aramega order book and shows, day by day, how many pieces and
how many jobs are due — against the **450 PCS daily production limit** — so orders can be
accepted or pushed out before the floor is overloaded.

## How a job lands on a day

| Order book | Rule |
| --- | --- |
| Column **A** | Order (submission) date |
| Column **E** | Quantity in PCS |
| Column **H** | Due date |

* **Due date filled in** → the job counts on that day.
* **Due date blank** (or `-`, `?`, `hold`) → the job counts **7 days after the order date**.

The lead time and the daily limit are both editable in Settings.

## Which months are on the board

The board follows the order book's latest month tab: right now that is August 2026 alone.
From the following month it also carries the month before — September shows August and
September, October shows September and October — because the previous month's jobs are
still on the floor. Closed months stay in the data and can be brought back with
**Settings → Include closed months as well**. `TRACK_FROM` in `assets/app.js` sets the
month the board starts from.

## What it does

* **Calendar** — every day shows PCS due, the number of jobs and a capacity bar,
  colour-coded light / healthy / near limit / over limit. Click a day for its jobs,
  listed by customer, job name, PCS and due date.
* **KPI strip** — today's load, the next 7 days against capacity, how many of the next
  30 days are over the limit, and the open pipeline; each carries its job count.
* **"Can we take this order?"** (foot of the page) — enter a quantity and (optionally) a
  due date. The app answers yes/no, names the next available date, and proposes a split
  across the free capacity before the due date. Nothing is offered sooner than the
  minimum production lead (3 days), so the floor has time to run it. The order can be
  pinned to the calendar as a *provisional* booking while the customer decides.
* **Refresh** — recomputes everything against the current date, and pulls the latest rows
  straight from the sheet when a published CSV link is set (Settings → Live sheet CSV link;
  in Sheets: *File → Share → Publish to web*, pick the month's tab, choose CSV). Incoming
  rows replace only the dates they cover, so earlier months stay intact.
* **Update data** — paste rows copied straight out of Google Sheets (or upload a CSV/TSV
  export) to refresh the numbers; kept in the browser's local storage.
* **Export month CSV** — the day-by-day load for the month on screen.

## Running it

It is a static site — no build step, no server code.

```bash
# any static server, e.g.
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly from disk works too. To host it, publish the repository
with GitHub Pages (Settings → Pages → deploy from branch) — everything is client-side.

## Refreshing the bundled snapshot

`data/orders.js` holds a snapshot of the order book (Dec 2025 → 17 Aug 2026, 4,151 orders).
Day-to-day updates are easiest through **Update data** in the app, but the snapshot can be
regenerated from a downloaded copy of the sheet:

```bash
pip install openpyxl
# File → Download → Microsoft Excel (.xlsx) in Google Sheets
python3 tools/extract_orders.py ~/Downloads/order-book.xlsx
```

That rewrites `data/orders.js` and `data/orders.json`.

### One quirk the extractor fixes

The sheet's locale reads a typed `9/8` (9 August) as 9 September, so those cells come back
with the day and month transposed; dates the sheet could not read as month/day (`13/8`)
stayed as text. The extractor and the in-app importer both treat column H as **day/month**,
which is how the dates are read on screen.

## Files

```
index.html              app shell
assets/styles.css       lime-green theme, light + dark
assets/app.js           capacity model, calendar, checker, import/export
data/orders.js          bundled order snapshot (generated)
data/orders.json        same data as JSON
tools/extract_orders.py regenerates the snapshot from the .xlsx export
```

## Logo

The header falls back to a lime `ARAMEGA` wordmark. To show the real logo, paste its direct
image URL into **Settings → Logo image URL**; it is remembered in the browser.

## Hosted copy

A published copy lives at <https://claude.ai/code/artifact/db11c85a-d0e0-4495-b7f1-a2199090fc81>
(private to the account that published it until shared). Rebuild it with
`python3 tools/build_artifact.py`; `python3 tools/build_single.py` produces a
standalone `dist/tracker.html` that runs from anywhere.

The hosted copy blocks outbound requests, so the live CSV link works in the self-hosted
version (GitHub Pages, a local server, `dist/tracker.html`); on the hosted copy, Refresh
recomputes the day and **Update data** takes a paste.
