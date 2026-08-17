/* Aramega — Daily Quantity Limit Tracker
 *
 * Every order occupies one production day: its due date if the order book has
 * one, otherwise the order date plus the lead time (7 days by default).
 * The calendar shows the pieces and jobs landing on each day against the
 * 450 PCS daily limit (editable in Settings).
 */
(function () {
  'use strict';

  var STORE_KEY = 'aramega-dlt-v1';
  var BUNDLED = window.ARAMEGA_ORDERBOOK || { orders: [], source: 'empty' };
  var DEFAULTS = { limit: 450, lead: 7, minLead: 3, rest: '', logo: '', csvUrl: '', history: 'window' };
  // Bumped when a default changes so saved settings pick the new value up once.
  var DEFAULTS_VERSION = 2;
  // The month the board starts from — earlier tabs are finished work.
  var TRACK_FROM = '2026-08-01';
  var DAY_MS = 86400000;
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  var MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  var state = {
    settings: Object.assign({}, DEFAULTS),
    theme: null,          // null = follow the viewer's system setting
    dataset: null,        // imported orders, null = use bundled snapshot
    provisional: [],
    view: startOfMonth(new Date()),
    selected: null,
    lastRefresh: null,
    index: null,
    pendingImport: null
  };

  /* ---------------- date helpers ---------------- */

  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function todayDate() { var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  function iso(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fromISO(s) {
    var p = String(s).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function isoAdd(s, n) { return iso(addDays(fromISO(s), n)); }
  function daysBetween(a, b) { return Math.round((fromISO(b) - fromISO(a)) / DAY_MS); }
  function fmtDate(s) {
    var d = fromISO(s);
    return WEEKDAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear();
  }
  function fmtShort(s) {
    var d = fromISO(s);
    return d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3);
  }
  function num(n) { return Number(n).toLocaleString('en-US'); }

  /* ---------------- storage ---------------- */

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (saved.settings) state.settings = Object.assign({}, DEFAULTS, saved.settings);
      if (saved.defaultsVersion !== DEFAULTS_VERSION) {
        state.settings.limit = DEFAULTS.limit;
        state.settings.minLead = DEFAULTS.minLead;
      }
      if (saved.theme) state.theme = saved.theme;
      if (saved.dataset && saved.dataset.orders) state.dataset = saved.dataset;
      if (Array.isArray(saved.provisional)) state.provisional = saved.provisional;
    } catch (e) { /* corrupt or unavailable storage — fall back to defaults */ }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        defaultsVersion: DEFAULTS_VERSION,
        settings: state.settings,
        theme: state.theme,
        dataset: state.dataset,
        provisional: state.provisional
      }));
    } catch (e) { /* storage full or blocked — the app still works in-session */ }
  }

  /* ---------------- data model ---------------- */

  function activeData() { return state.dataset || BUNDLED; }

  /**
   * The board tracks the current month's tab, and from the month after
   * TRACK_FROM it also carries the previous month, whose jobs are still on the
   * floor. Older tabs are closed work — kept in the data, left out of the view
   * unless "all history" is switched on in Settings.
   */
  function windowStart() {
    if (state.settings.history === 'all') return null;
    var now = todayDate();
    var prevMonth = iso(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    return prevMonth > TRACK_FROM ? prevMonth : TRACK_FROM;
  }

  function allOrders() {
    var from = windowStart();
    var orders = activeData().orders;
    if (from) orders = orders.filter(function (o) { return o.d >= from; });
    return orders.concat(state.provisional);
  }

  /** The day an order consumes capacity on. */
  function effectiveDue(o) {
    return o.due || isoAdd(o.d, state.settings.lead);
  }

  /** day -> { qty, jobs[] } for every day that carries work. */
  function buildIndex() {
    var map = Object.create(null);
    allOrders().forEach(function (o) {
      var day = effectiveDue(o);
      if (!map[day]) map[day] = { qty: 0, jobs: [] };
      map[day].qty += o.q;
      map[day].jobs.push(o);
    });
    Object.keys(map).forEach(function (k) {
      map[k].jobs.sort(function (a, b) { return b.q - a.q; });
    });
    state.index = map;
    return map;
  }

  function dayLoad(dayISO) {
    var e = state.index[dayISO];
    return e ? e.qty : 0;
  }
  function dayJobs(dayISO) {
    var e = state.index[dayISO];
    return e ? e.jobs : [];
  }
  function freeOn(dayISO) { return Math.max(0, state.settings.limit - dayLoad(dayISO)); }
  /** Nothing can be started before the floor has had its minimum lead. */
  function earliestStart() { return isoAdd(iso(todayDate()), state.settings.minLead); }
  function isRestDay(dayISO) {
    return state.settings.rest !== '' && fromISO(dayISO).getDay() === Number(state.settings.rest);
  }

  function statusOf(qty) {
    var limit = state.settings.limit;
    if (qty <= 0) return 'free';
    var pct = qty / limit;
    if (pct > 1) return 'over';
    if (pct >= 0.85) return 'tight';
    if (pct < 0.5) return 'free';
    return 'ok';
  }

  /* ---------------- rendering ---------------- */

  function renderAll() {
    buildIndex();
    applyTheme();
    document.getElementById('limitChip').textContent = num(state.settings.limit) + ' PCS / day';
    document.getElementById('leadNote').textContent = state.settings.lead;
    document.getElementById('minLeadNote').textContent = state.settings.minLead;
    renderLogo();
    renderKpis();
    renderCalendar();
    renderDayPanel();
    renderFooter();
  }

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyTheme() {
    if (state.theme) document.documentElement.setAttribute('data-theme', state.theme);
    else document.documentElement.removeAttribute('data-theme');
  }

  function renderLogo() {
    var slot = document.getElementById('logoSlot');
    var wordmark = '<svg height="34" viewBox="0 0 210 44" role="img" aria-label="Aramega">' +
      '<rect x="0" y="6" width="32" height="32" rx="9" fill="#a3e635"/>' +
      '<path d="M9 31 L16 13 L23 31 M12.5 25.5 H19.5" stroke="#12200a" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<text x="42" y="30" font-family="Inter, Segoe UI, sans-serif" font-size="19" font-weight="700" letter-spacing="2.5" fill="currentColor">ARAMEGA</text>' +
      '</svg>';
    var url = state.settings.logo ||
      'https://www.google.com/s2/favicons?domain=aramega.com.my&sz=128';
    slot.innerHTML = '<img alt="Aramega" src="' + escapeAttr(url) + '">';
    var img = slot.firstChild;
    img.onerror = function () { slot.innerHTML = wordmark; };
  }

  function renderKpis() {
    var limit = state.settings.limit;
    var today = iso(todayDate());
    var todayQty = dayLoad(today);
    var week = 0, weekJobs = 0;
    for (var i = 0; i < 7; i++) {
      var d = isoAdd(today, i);
      week += dayLoad(d);
      weekJobs += dayJobs(d).length;
    }
    var overDays = 0, overJobs = 0, horizonQty = 0, horizonJobs = 0;
    for (var j = 0; j < 30; j++) {
      var dd = isoAdd(today, j);
      if (dayLoad(dd) > limit) { overDays++; overJobs += dayJobs(dd).length; }
    }
    Object.keys(state.index).forEach(function (k) {
      if (k >= today) { horizonQty += state.index[k].qty; horizonJobs += state.index[k].jobs.length; }
    });

    var cards = [
      {
        label: 'Today · ' + fmtShort(today),
        value: num(todayQty) + ' <span>/ ' + num(limit) + ' PCS</span>',
        jobs: dayJobs(today).length,
        sub: todayQty > limit
          ? 'Over by ' + num(todayQty - limit) + ' PCS'
          : num(limit - todayQty) + ' PCS still free',
        tone: todayQty > limit ? 'bad' : (todayQty >= limit * 0.85 ? 'warn' : '')
      },
      {
        label: 'Next 7 days',
        value: num(week) + ' <span>/ ' + num(limit * 7) + ' PCS</span>',
        jobs: weekJobs,
        sub: Math.round((week / (limit * 7)) * 100) + '% of capacity',
        tone: week > limit * 7 ? 'bad' : (week >= limit * 7 * 0.85 ? 'warn' : '')
      },
      {
        label: 'Over limit · next 30 days',
        value: String(overDays) + ' <span>days</span>',
        jobs: overJobs,
        sub: overDays ? 'Reschedule or split these days' : 'Every day within the limit',
        tone: overDays > 4 ? 'bad' : (overDays ? 'warn' : '')
      },
      {
        label: 'Open pipeline',
        value: num(horizonQty) + ' <span>PCS</span>',
        jobs: horizonJobs,
        sub: 'Due today or later',
        tone: ''
      }
    ];

    document.getElementById('kpis').innerHTML = cards.map(function (c) {
      return '<div class="kpi ' + c.tone + '">' +
        '<div class="k-label">' + c.label + '</div>' +
        '<div class="k-value">' + c.value + '</div>' +
        '<div class="k-foot">' +
          '<span class="k-jobs">' + num(c.jobs) + (c.jobs === 1 ? ' job' : ' jobs') + '</span>' +
          '<span class="k-sub">' + c.sub + '</span>' +
        '</div></div>';
    }).join('');
  }

  function renderCalendar() {
    var head = document.getElementById('weekHead');
    if (!head.childNodes.length) {
      head.innerHTML = WEEKDAYS.map(function (w) { return '<div>' + w + '</div>'; }).join('');
    }

    var view = state.view;
    var limit = state.settings.limit;
    document.getElementById('monthLabel').textContent = MONTHS[view.getMonth()] + ' ' + view.getFullYear();

    var first = startOfMonth(view);
    var start = addDays(first, -first.getDay());
    var last = new Date(view.getFullYear(), view.getMonth() + 1, 0);
    var totalCells = Math.ceil((first.getDay() + last.getDate()) / 7) * 7;
    var today = iso(todayDate());
    var html = '';
    var monthQty = 0, monthJobs = 0, monthOver = 0;

    for (var i = 0; i < totalCells; i++) {
      var d = addDays(start, i);
      var key = iso(d);
      var inMonth = d.getMonth() === view.getMonth();
      var qty = dayLoad(key);
      var jobs = dayJobs(key).length;
      if (inMonth) {
        monthQty += qty; monthJobs += jobs;
        if (qty > limit) monthOver++;
      }
      var st = statusOf(qty);
      var pct = Math.min(100, Math.round((qty / limit) * 100));
      var cls = ['cell', 's-' + st];
      if (!inMonth) cls.push('pad');
      if (key === today) cls.push('today');
      if (key === state.selected) cls.push('selected');
      if (isRestDay(key)) cls.push('rest');

      html += '<button class="' + cls.join(' ') + '" data-day="' + key + '"' + (inMonth ? '' : ' tabindex="-1"') + '>' +
        '<span class="dnum">' + d.getDate() + '</span>' +
        (qty
          ? '<span class="qty">' + num(qty) + '<small>PCS</small></span>' +
            '<span class="jobs">' + jobs + (jobs === 1 ? ' job' : ' jobs') + '</span>' +
            (qty > limit ? '<span class="over-tag">+' + num(qty - limit) + '</span>' : '') +
            '<span class="bar"><i style="width:' + pct + '%"></i></span>'
          : '<span class="qty">—</span><span class="jobs">free</span>') +
        '</button>';
    }
    document.getElementById('calendar').innerHTML = html;
    document.getElementById('monthSummary').textContent =
      num(monthQty) + ' PCS · ' + num(monthJobs) + (monthJobs === 1 ? ' job · ' : ' jobs · ') +
      monthOver + ' day' + (monthOver === 1 ? '' : 's') + ' over limit';
  }

  function renderDayPanel() {
    var title = document.getElementById('dayTitle');
    var body = document.getElementById('dayBody');
    if (!state.selected) {
      title.textContent = 'Select a day';
      body.innerHTML = '<p class="empty">Click any day in the calendar to see the jobs due that day.</p>';
      return;
    }
    var key = state.selected;
    var limit = state.settings.limit;
    var qty = dayLoad(key);
    var jobs = dayJobs(key);
    var st = statusOf(qty);
    var pct = Math.min(100, Math.round((qty / limit) * 100));

    title.textContent = fmtDate(key);
    var head = '<div class="day-summary s-' + st + '">' +
      '<div class="row1"><span class="big">' + num(qty) + ' <span class="muted" style="font-size:.8rem">/ ' + num(limit) + ' PCS</span></span>' +
      '<span class="muted">' + jobs.length + (jobs.length === 1 ? ' job' : ' jobs') + '</span></div>' +
      '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="muted" style="font-size:.8rem">' +
      (qty > limit
        ? 'Over the daily limit by ' + num(qty - limit) + ' PCS'
        : num(limit - qty) + ' PCS of capacity still free') +
      (isRestDay(key) ? ' · rest day' : '') +
      '</div></div>';

    var list = jobs.length
      ? '<div class="job-table-wrap"><table class="job-table">' +
        '<colgroup><col class="c-cust"><col class="c-job"><col class="c-qty"><col class="c-due"></colgroup>' +
        '<thead><tr><th>Customer</th><th>Job name</th><th class="right">PCS</th><th>Due</th></tr></thead><tbody>' +
        jobs.map(function (o) {
          return '<tr' + (o.prov ? ' class="prov"' : '') + '>' +
            '<td class="j-cust">' + esc(o.c || '—') + '</td>' +
            '<td class="j-name">' + esc(o.j || 'Job') + '</td>' +
            '<td class="right j-qty">' + num(o.q) + '</td>' +
            '<td class="j-due"><span class="date">' + fmtShort(effectiveDue(o)) + '</span>' +
              (o.prov ? '<span class="tag prov">booked</span>'
                      : (o.due ? '' : '<span class="tag auto" title="No due date in the order book — ' +
                          state.settings.lead + '-day default">+' + state.settings.lead + 'd</span>')) +
            '</td></tr>';
        }).join('') +
        '</tbody></table></div>'
      : '<p class="empty">No jobs due on this day — full capacity available.</p>';

    body.innerHTML = head + list;
  }

  function monthsInView() {
    var from = windowStart();
    if (!from) return 'All months';
    var start = fromISO(from);
    var now = todayDate();
    var startLabel = MONTHS[start.getMonth()].slice(0, 3);
    var endLabel = MONTHS[now.getMonth()].slice(0, 3) + ' ' + now.getFullYear();
    return start.getMonth() === now.getMonth() && start.getFullYear() === now.getFullYear()
      ? endLabel + ' only'
      : startLabel + ' – ' + endLabel;
  }

  function renderFooter() {
    var data = activeData();
    var count = allOrders().length - state.provisional.length;
    var note = state.dataset
      ? (state.dataset.source === 'live sheet link' ? 'Live sheet link' : 'Your imported data') +
        ' · ' + num(count) + ' orders'
      : 'Snapshot of ' + (data.source || 'order book') +
        (data.generatedAt ? ' · pulled ' + fmtDate(data.generatedAt.slice(0, 10)) : '') +
        ' · ' + num(count) + ' orders';
    note += ' · ' + monthsInView();
    if (state.provisional.length) note += ' · ' + state.provisional.length + ' provisional';
    if (state.lastRefresh) {
      note += ' · refreshed ' + state.lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    document.getElementById('dataNote').textContent = note;
    var link = document.getElementById('sheetLink');
    if (BUNDLED.sheetId) link.href = 'https://docs.google.com/spreadsheets/d/' + BUNDLED.sheetId + '/edit';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escapeAttr(s) { return esc(s); }

  /* ---------------- capacity checker ---------------- */

  /**
   * A due date is a deadline, not a slot: the job only has to be FINISHED by
   * then, so it may run on any day from the first workable day up to the due
   * date. The check is therefore "is there room anywhere in that window", not
   * "is there room on the due date itself".
   */
  function runCheck() {
    var qty = parseInt(document.getElementById('chkQty').value, 10);
    var out = document.getElementById('chkResult');
    if (!qty || qty <= 0) {
      out.innerHTML = '<div class="verdict warn"><div class="v-title">Enter a quantity</div>' +
        '<div class="v-line">How many pieces is the customer asking for?</div></div>';
      return;
    }
    var today = iso(todayDate());
    var soonest = earliestStart();
    var dueInput = document.getElementById('chkDue').value;
    var due = dueInput || isoAdd(today, state.settings.lead);
    var minLead = state.settings.minLead;
    var html = '';
    var plan = null;

    if (due < soonest) {
      // The deadline itself is inside the production lead — nothing to schedule.
      var soonestDeadline = earliestDeadline(qty, soonest);
      var away = daysBetween(today, due);
      html += verdict('bad', '✕ Not by ' + fmtShort(due),
        [away < 0 ? 'That date has already passed.'
                  : (away === 0 ? 'That is today, and we need at least ' + minLead + ' days.'
                                : 'That is ' + away + ' day' + (away === 1 ? '' : 's') +
                                  ' away and we need at least ' + minLead + '.'),
         soonestDeadline
           ? 'The soonest we can finish ' + num(qty) + ' PCS is ' + fmtDate(soonestDeadline) + '.'
           : 'No capacity for this quantity in the months ahead.']);
      if (soonestDeadline) plan = capacityPlan(qty, soonest, soonestDeadline);
    } else {
      plan = capacityPlan(qty, soonest, due);
      if (plan.short === 0 && plan.rows.length === 1) {
        var only = plan.rows[0];
        var buffer = daysBetween(only.day, due);
        html += verdict('good', '✓ Yes — we can meet ' + fmtShort(due),
          ['Run it on ' + fmtDate(only.day) + ', which has ' + num(freeOn(only.day)) + ' PCS free.',
           buffer > 0
             ? buffer + ' day' + (buffer === 1 ? '' : 's') + ' of buffer before the deadline.'
             : 'That is the deadline itself — no buffer.',
           dueInput ? '' : 'No due date given, so this uses the ' + state.settings.lead + '-day default.']);
      } else if (plan.short === 0) {
        html += verdict('good', '✓ Yes — we can meet ' + fmtShort(due),
          ['It does not fit in one day, so it runs across ' + plan.rows.length + ' days before the deadline.',
           dueInput ? '' : 'No due date given, so this uses the ' + state.settings.lead + '-day default.']);
      } else {
        var reachable = earliestDeadline(qty, soonest);
        html += verdict('bad', '✕ Not by ' + fmtShort(due),
          ['Only ' + num(qty - plan.short) + ' of ' + num(qty) + ' PCS can be made by then — ' +
            num(plan.short) + ' PCS short.',
           reachable
             ? 'The whole order can be finished by ' + fmtDate(reachable) + '.'
             : 'No capacity for this quantity in the months ahead.']);
        if (reachable) plan = capacityPlan(qty, soonest, reachable);
      }
    }

    if (plan && plan.rows.length) {
      html += renderPlan(plan);
      html += '<button class="btn ghost sm" id="addProv">+ Book ' + num(qty) + ' PCS as provisional' +
        (plan.rows.length > 1 ? ' across these ' + plan.rows.length + ' days' : ' on ' + fmtShort(plan.rows[0].day)) +
        '</button>';
    }
    out.innerHTML = html;

    var addBtn = document.getElementById('addProv');
    if (addBtn) addBtn.addEventListener('click', function () {
      plan.rows.forEach(function (r) { addProvisional(r.qty, r.day); });
    });

    if (plan && plan.rows.length) {
      var last = plan.rows[plan.rows.length - 1].day;
      state.selected = last;
      state.view = startOfMonth(fromISO(last));
    }
    renderCalendar();
    renderDayPanel();
  }

  function verdict(tone, title, lines) {
    return '<div class="verdict ' + tone + '"><div class="v-title">' + title + '</div>' +
      lines.filter(Boolean).map(function (l) { return '<div class="v-line">' + l + '</div>'; }).join('') +
      '</div>';
  }

  /**
   * Fill the order into the free capacity between two dates, earliest day
   * first so the job finishes with buffer before the deadline.
   */
  function capacityPlan(qty, from, to) {
    var rows = [], left = qty;
    var span = daysBetween(from, to);
    for (var i = 0; i <= span && left > 0; i++) {
      var d = isoAdd(from, i);
      if (isRestDay(d)) continue;
      var free = freeOn(d);
      if (free <= 0) continue;
      var take = Math.min(free, left);
      left -= take;
      rows.push({ day: d, qty: take });
    }
    return { rows: rows, short: left, deadline: to };
  }

  /** The soonest date by which the whole quantity can be finished. */
  function earliestDeadline(qty, from, horizon) {
    var left = qty;
    for (var i = 0; i < (horizon || 180); i++) {
      var d = isoAdd(from, i);
      if (isRestDay(d)) continue;
      left -= freeOn(d);
      if (left <= 0) return d;
    }
    return null;
  }

  function renderPlan(plan) {
    var head = plan.rows.length === 1
      ? 'Production day'
      : 'Runs across ' + plan.rows.length + ' days, finishing ' + fmtShort(plan.rows[plan.rows.length - 1].day);
    var rows = plan.rows.map(function (r) {
      return '<div class="plan-row"><span>' + fmtShort(r.day) + ' <span class="muted">' +
        WEEKDAYS[fromISO(r.day).getDay()] + '</span></span><b>' + num(r.qty) + ' PCS</b></div>';
    }).join('');
    if (plan.short > 0) {
      rows += '<div class="plan-row short"><span>Cannot be placed by ' + fmtShort(plan.deadline) + '</span>' +
        '<b>' + num(plan.short) + ' PCS</b></div>';
    }
    return '<div class="plan"><div class="plan-head">' + head + '</div>' + rows + '</div>';
  }

  function addProvisional(qty, due) {
    state.provisional.push({
      id: 'p' + Date.now() + Math.floor(Math.random() * 1000),
      d: iso(todayDate()),
      c: 'PROVISIONAL',
      j: 'Provisional booking',
      q: qty,
      due: due,
      prov: true
    });
    save();
    renderAll();
  }

  /* ---------------- import ---------------- */

  function splitRows(text) {
    return text.replace(/\r/g, '').split('\n').filter(function (l) { return l.trim() !== ''; });
  }

  function splitCells(line) {
    if (line.indexOf('\t') !== -1) return line.split('\t');
    var cells = [], cur = '', quoted = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells;
  }

  /**
   * Parse a date the way the order book displays it: day-first ("9/8" is
   * 9 August), with the year inferred from a reference date when omitted.
   */
  function parseLooseDate(text, refISO) {
    if (text == null) return null;
    var s = String(text).trim();
    if (!s || s === '-' || s === '?' || /^hold$/i.test(s)) return null;

    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return safeISO(+m[1], +m[2], +m[3]);

    m = s.match(/^(\d{1,2})\s*[\/.\-]\s*(\d{1,2})(?:\s*[\/.\-]\s*(\d{2,4}))?$/);
    if (m) {
      var day = +m[1], mon = +m[2];
      if (m[3]) {
        var y = +m[3];
        return safeISO(y < 100 ? 2000 + y : y, mon, day);
      }
      return inferYear(day, mon, refISO);
    }

    m = s.match(/^(\d{1,2})\s*[\-\s]\s*([A-Za-z]{3,})\.?(?:\s*[\-\s]\s*(\d{2,4}))?$/);
    if (!m) {
      m = s.match(/^([A-Za-z]{3,})\.?\s*[\-\s]\s*(\d{1,2})(?:\s*,?\s*(\d{2,4}))?$/);
      if (m) m = [m[0], m[2], m[1], m[3]];
    }
    if (m) {
      var idx = MONTH_KEYS.indexOf(String(m[2]).slice(0, 3).toLowerCase());
      if (idx === -1) return null;
      if (m[3]) {
        var yy = +m[3];
        return safeISO(yy < 100 ? 2000 + yy : yy, idx + 1, +m[1]);
      }
      return inferYear(+m[1], idx + 1, refISO);
    }
    return null;
  }

  function safeISO(y, mo, d) {
    if (!y || !mo || !d || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var dt = new Date(y, mo - 1, d);
    if (dt.getMonth() !== mo - 1) return null;
    return iso(dt);
  }

  /** Choose the year that lands closest after the reference date. */
  function inferYear(day, mon, refISO) {
    var ref = refISO ? fromISO(refISO) : todayDate();
    var best = null;
    [0, 1, -1].forEach(function (delta) {
      var cand = safeISO(ref.getFullYear() + delta, mon, day);
      if (!cand) return;
      var diff = (fromISO(cand) - ref) / DAY_MS;
      if (diff >= -45 && (best === null || diff < best.diff)) best = { iso: cand, diff: diff };
    });
    return best ? best.iso : null;
  }

  function parseSheetText(text) {
    var rows = splitRows(text);
    var orders = [], skipped = 0;
    rows.forEach(function (line) {
      var c = splitCells(line);
      if (c.length < 5) { skipped++; return; }
      var orderDate = parseLooseDate(c[0], null);
      var qty = parseInt(String(c[4] || '').replace(/[^\d]/g, ''), 10);
      if (!orderDate || !qty || qty <= 0) { skipped++; return; }
      orders.push({
        d: orderDate,
        c: String(c[2] || '').trim(),
        j: String(c[3] || '').trim(),
        q: qty,
        due: c.length > 7 ? parseLooseDate(c[7], orderDate) : null
      });
    });
    return { orders: orders, skipped: skipped };
  }

  function previewImport(text) {
    var box = document.getElementById('importPreview');
    if (!text.trim()) { box.innerHTML = ''; state.pendingImport = null; return; }
    var res = parseSheetText(text);
    state.pendingImport = res;
    if (!res.orders.length) {
      box.innerHTML = '<span class="bad">No order rows recognised.</span> Make sure column A holds the order date and column E the PCS.';
      return;
    }
    var pcs = res.orders.reduce(function (a, o) { return a + o.q; }, 0);
    var dates = res.orders.map(function (o) { return o.d; }).sort();
    var withDue = res.orders.filter(function (o) { return o.due; }).length;
    box.innerHTML = '<b>' + num(res.orders.length) + ' orders</b> · ' + num(pcs) + ' PCS · ' +
      fmtShort(dates[0]) + ' → ' + fmtShort(dates[dates.length - 1]) + '<br>' +
      withDue + ' with a due date, ' + (res.orders.length - withDue) + ' will use the ' +
      state.settings.lead + '-day default' +
      (res.skipped ? ' · ' + res.skipped + ' rows skipped (headers or no quantity)' : '');
  }

  function applyImport() {
    if (!state.pendingImport || !state.pendingImport.orders.length) {
      previewImport(document.getElementById('pasteBox').value);
      if (!state.pendingImport || !state.pendingImport.orders.length) return;
    }
    var incoming = state.pendingImport.orders;
    var append = document.getElementById('appendMode').checked;
    var base = append ? activeData().orders.slice() : [];
    state.dataset = {
      source: append ? 'order book (merged import)' : 'order book (imported)',
      sheetId: BUNDLED.sheetId,
      generatedAt: new Date().toISOString(),
      orders: base.concat(incoming)
    };
    save();
    closeModal('importModal');
    document.getElementById('pasteBox').value = '';
    document.getElementById('importPreview').innerHTML = '';
    state.pendingImport = null;
    renderAll();
  }

  /* ---------------- refresh ---------------- */

  var toastTimer = null;

  function toast(message, tone) {
    var el = document.getElementById('toast');
    el.textContent = message;
    el.className = 'toast' + (tone ? ' ' + tone : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, tone === 'bad' ? 7000 : 3500);
  }

  function spin(on) {
    document.getElementById('refreshIcon').classList.toggle('spinning', !!on);
    document.getElementById('refreshBtn').disabled = !!on;
  }

  /**
   * Recompute everything against the current date, and — when a published
   * sheet link is set — pull the latest rows from it first.
   */
  function refresh() {
    var url = state.settings.csvUrl;
    if (!url) {
      state.lastRefresh = new Date();
      renderAll();
      toast('Refreshed · showing ' + fmtDate(iso(todayDate())));
      return;
    }
    spin(true);
    var bust = url + (url.indexOf('?') === -1 ? '?' : '&') + 't=' + Date.now();
    fetch(bust, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('The sheet link returned ' + res.status);
        return res.text();
      })
      .then(function (text) {
        if (/^\s*</.test(text)) {
          throw new Error('That link returned a web page, not CSV — republish it as CSV');
        }
        var parsed = parseSheetText(text);
        if (!parsed.orders.length) {
          throw new Error('No order rows found — check the published tab and its columns');
        }
        var merged = mergeByDateRange(activeData().orders, parsed.orders);
        state.dataset = {
          source: 'live sheet link',
          sheetId: BUNDLED.sheetId,
          generatedAt: new Date().toISOString(),
          orders: merged.orders
        };
        state.lastRefresh = new Date();
        save();
        renderAll();
        toast('Updated from the sheet · ' + num(parsed.orders.length) + ' orders for ' +
          fmtShort(merged.from) + ' – ' + fmtShort(merged.to) +
          (merged.kept ? ' · ' + num(merged.kept) + ' earlier orders kept' : ''));
      })
      .catch(function (err) {
        renderAll();
        toast('Could not reach the sheet: ' + err.message + '. Use Update data to paste the rows instead.', 'bad');
      })
      .then(function () { spin(false); });
  }

  /**
   * A published link usually covers one month's tab, so the incoming rows
   * replace only the order dates they span — earlier months stay put.
   */
  function mergeByDateRange(existing, incoming) {
    var dates = incoming.map(function (o) { return o.d; }).sort();
    var from = dates[0], to = dates[dates.length - 1];
    var kept = existing.filter(function (o) { return o.d < from || o.d > to; });
    return {
      orders: kept.concat(incoming).sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); }),
      kept: kept.length,
      from: from,
      to: to
    };
  }

  /** A tab left open overnight should not keep showing yesterday as today. */
  function watchDayRollover() {
    var day = iso(todayDate());
    setInterval(function () {
      var now = iso(todayDate());
      if (now !== day) { day = now; renderAll(); }
    }, 60000);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      var now = iso(todayDate());
      if (now !== day) { day = now; renderAll(); }
    });
  }

  /* ---------------- export ---------------- */

  function monthCSV() {
    var view = state.view;
    var last = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    var limit = state.settings.limit;
    var lines = ['Date,Weekday,PCS due,Jobs,Daily limit,Free capacity,Over by'];
    for (var d = 1; d <= last; d++) {
      var key = iso(new Date(view.getFullYear(), view.getMonth(), d));
      var qty = dayLoad(key);
      lines.push([key, WEEKDAYS[fromISO(key).getDay()], qty, dayJobs(key).length,
        limit, Math.max(0, limit - qty), Math.max(0, qty - limit)].join(','));
    }
    return lines.join('\n');
  }

  function browserDownload(filename, text) {
    var blob = new Blob([text], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportMonthCSV() {
    var view = state.view;
    var name = 'aramega-load-' + view.getFullYear() + '-' + pad(view.getMonth() + 1) + '.csv';
    var text = monthCSV();
    // Hosted viewers hand the file over through the downloads capability;
    // a plain page just downloads it.
    if (!window.claude || typeof window.claude.use !== 'function') {
      browserDownload(name, text);
      return;
    }
    window.claude.use('downloads').then(function (downloads) {
      if (!downloads) { browserDownload(name, text); return; }
      return downloads.save({ filename: name, data: text }).catch(function (err) {
        var code = err && err.code;
        if (code === 'extension_not_enabled') {
          return downloads.save({ filename: name.replace(/\.csv$/, '.txt'), data: text });
        }
        if (code === 'declined' || code === 'rate_limited') return;
        browserDownload(name, text);
      });
    }).catch(function () { browserDownload(name, text); });
  }

  /* ---------------- modals + settings ---------------- */

  function openModal(id) { document.getElementById(id).hidden = false; }
  function closeModal(id) { document.getElementById(id).hidden = true; }

  function fillSettings() {
    document.getElementById('setLimit').value = state.settings.limit;
    document.getElementById('setLead').value = state.settings.lead;
    document.getElementById('setMinLead').value = state.settings.minLead;
    document.getElementById('setRest').value = state.settings.rest;
    document.getElementById('setLogo').value = state.settings.logo;
    document.getElementById('setCsv').value = state.settings.csvUrl;
    document.getElementById('setHistory').checked = state.settings.history === 'all';
    var list = document.getElementById('provList');
    if (!state.provisional.length) { list.innerHTML = ''; return; }
    list.innerHTML = '<div class="muted sm-note">Provisional bookings</div>' +
      state.provisional.map(function (p) {
        return '<div class="prov-item"><span>' + num(p.q) + ' PCS on ' + fmtShort(p.due) + '</span>' +
          '<button class="btn ghost sm" data-drop="' + p.id + '">Remove</button></div>';
      }).join('');
    list.querySelectorAll('[data-drop]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.provisional = state.provisional.filter(function (p) { return p.id !== btn.dataset.drop; });
        save(); fillSettings(); renderAll();
      });
    });
  }

  function saveSettings() {
    var limit = parseInt(document.getElementById('setLimit').value, 10);
    var lead = parseInt(document.getElementById('setLead').value, 10);
    state.settings.limit = limit > 0 ? limit : DEFAULTS.limit;
    state.settings.lead = lead >= 0 ? lead : DEFAULTS.lead;
    var minLead = parseInt(document.getElementById('setMinLead').value, 10);
    state.settings.minLead = minLead >= 0 ? minLead : DEFAULTS.minLead;
    state.settings.rest = document.getElementById('setRest').value;
    state.settings.logo = document.getElementById('setLogo').value.trim();
    state.settings.csvUrl = document.getElementById('setCsv').value.trim();
    state.settings.history = document.getElementById('setHistory').checked ? 'all' : 'window';
    save();
    closeModal('settingsModal');
    renderAll();
  }

  /* ---------------- wiring ---------------- */

  function init() {
    load();
    state.selected = iso(todayDate());
    state.view = startOfMonth(todayDate());

    document.getElementById('prevMonth').addEventListener('click', function () {
      state.view = new Date(state.view.getFullYear(), state.view.getMonth() - 1, 1);
      renderCalendar();
    });
    document.getElementById('nextMonth').addEventListener('click', function () {
      state.view = new Date(state.view.getFullYear(), state.view.getMonth() + 1, 1);
      renderCalendar();
    });
    document.getElementById('todayBtn').addEventListener('click', function () {
      state.view = startOfMonth(todayDate());
      state.selected = iso(todayDate());
      renderCalendar(); renderDayPanel();
    });
    document.getElementById('calendar').addEventListener('click', function (e) {
      var cell = e.target.closest('.cell');
      if (!cell || cell.classList.contains('pad')) return;
      state.selected = cell.dataset.day;
      renderCalendar(); renderDayPanel();
    });

    document.getElementById('chkRun').addEventListener('click', runCheck);
    document.getElementById('chkQty').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') runCheck();
    });

    document.getElementById('themeBtn').addEventListener('click', function () {
      var current = state.theme || systemTheme();
      state.theme = current === 'dark' ? 'light' : 'dark';
      save();
      applyTheme();
    });
    document.getElementById('exportBtn').addEventListener('click', exportMonthCSV);
    document.getElementById('refreshBtn').addEventListener('click', refresh);

    document.getElementById('importBtn').addEventListener('click', function () { openModal('importModal'); });
    document.getElementById('settingsBtn').addEventListener('click', function () {
      fillSettings(); openModal('settingsModal');
    });
    document.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', function () { closeModal(btn.closest('.modal').id); });
    });
    document.querySelectorAll('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) { if (e.target === m) closeModal(m.id); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') document.querySelectorAll('.modal').forEach(function (m) { m.hidden = true; });
    });

    document.getElementById('pasteBox').addEventListener('input', function (e) {
      previewImport(e.target.value);
    });
    document.getElementById('fileInput').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        document.getElementById('pasteBox').value = reader.result;
        previewImport(String(reader.result));
      };
      reader.readAsText(file);
    });
    document.getElementById('applyImport').addEventListener('click', applyImport);
    document.getElementById('resetData').addEventListener('click', function () {
      state.dataset = null; save(); closeModal('importModal'); renderAll();
    });
    document.getElementById('saveSettings').addEventListener('click', saveSettings);

    renderAll();
    watchDayRollover();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
