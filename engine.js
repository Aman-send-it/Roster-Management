/* Scheduling engine (pure functions, no DOM). Exposes window.Sched. */
(function (root) {
  const DN = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const LV = { PLANNED_LEAVE: "LEAVE", COMP_OFF: "COMP_OFF", UNAVAILABLE: "UNAVAILABLE" };
  const pad = (n) => String(n).padStart(2, "0");
 
  function prep(raw) {
    const D = { ...raw, bm: {}, pm: {}, em: {}, podm: {}, prim: {}, pe: {} };
    raw.brands.forEach((b) => (D.bm[b.id] = b));
    raw.processes.forEach((p) => { D.pm[p.id] = p; D.pe[p.id] = []; });
    raw.employees.forEach((e) => { D.em[e.id] = e; D.prim[e.id] = []; });
    raw.pods.forEach((p) => (D.podm[p.id] = p));
    raw.assignments.filter((a) => !a.is_backup_slot).forEach((a) => {
      D.prim[a.employee_id].push(D.pm[a.process_id]); D.pe[a.process_id].push(a.employee_id);
    });
    D.leads = raw.employees.filter((e) => e.role === "POD_LEAD" && D.podm[e.pod_id].can_act_as_backup);
    return D;
  }
  function days(mk) {
    const [y, m] = mk.split("-").map(Number), n = new Date(y, m, 0).getDate();
    return Array.from({ length: n }, (_, i) => ({ i, date: `${mk}-${pad(i + 1)}`, dow: new Date(y, m - 1, i + 1).getDay() }));
  }
  function weeks(ds) {
    const off = (ds[0].dow + 6) % 7, w = {};
    ds.forEach((d) => (w[Math.floor((d.i + off) / 7)] ??= []).push(d));
    return Object.values(w);
  }
  const isHol = (D, b, date) => D.holidays.some((h) => h.date === date && (!h.brand_id || h.brand_id === b));
  function opens(D, p, d) {
    const m = p.calendar_mode_override || D.bm[p.brand_id].calendar_mode;
    return m === "ALL_365" || (!isHol(D, p.brand_id, d.date) && (m === "DAILY_EXCEPT_HOLIDAYS" || d.dow !== 0));
  }
  const need = (D, p, d) => (opens(D, p, d) ? p.min_staff_required : 0);
  function have(D, st, p, date) {
    let c = 0;
    D.pe[p.id].forEach((e) => { if (st[e][date].s === "WORKING") c++; });
    D.employees.forEach((e) => { const v = st[e.id][date]; if (v.s === "BACKUP_WORKING" && v.b === p.brand_id && v.p === p.id) c++; });
    return c;
  }
 
  function init(D, ds, locks) {
    const st = {};
    D.employees.forEach((e) => {
      st[e.id] = {};
      ds.forEach((d) => {
        const L = D.leaves.find((l) => l.status === "APPROVED" && l.employee_id === e.id && l.start_date <= d.date && d.date <= l.end_date);
        const pr = D.prim[e.id], op = pr.filter((p) => opens(D, p, d));
        st[e.id][d.date] = L ? { s: LV[L.type] }
          : pr.length && !op.length ? { s: pr.some((p) => isHol(D, p.brand_id, d.date)) ? "HOLIDAY_OFF" : "WEEKLY_OFF" }
          : { s: "WORKING", b: op[0] ? op[0].brand_id : null, p: op[0] ? op[0].id : null };
      });
    });
    (locks || []).forEach((l) => { if (st[l.employee_id]) st[l.employee_id][l.date] = { s: l.status, b: l.brand_id, p: l.process_id, m: 1 }; });
    return st;
  }
 
  function deficits(D, st, d) {
    const out = {};
    D.processes.forEach((p) => { const n = need(D, p, d); if (n && have(D, st, p, d.date) < n) (out[p.brand_id] ??= []).push(p); });
    return out;
  }
 
  /* Place one weekly off per week for each employee, minimising coverage loss; preferences are soft. */
  function placeOffs(D, ds, st) {
    const demand = {}, cnt = {}, last = {}, offLeads = {};
    ds.forEach((d) => (demand[d.date] = Object.keys(deficits(D, st, d)).length));
    const crit = (e) => D.prim[e.id].reduce((s, p) => s + 1 / D.pe[p.id].length, 0);
    const emps = D.employees.filter((e) => e.role !== "POD_LEAD").sort((a, b) => crit(b) - crit(a));
    weeks(ds).forEach((w) => {
      emps.forEach((e) => {
        const rest = w.filter((d) => st[e.id][d.date].s !== "WORKING");
        if (rest.length) { last[e.id] = rest[rest.length - 1].i; return; }
        if (w.length < 7) return; /* partial weeks: the 6-day streak rule (fixStreaks) handles them */
        const fixed = e.weekly_off_pattern === "FIXED_SUNDAY", pref = fixed ? 0 : DN.indexOf(e.preferred_off_day);
        let best = null, bc = 1e9, bg = 0;
        w.filter((d) => !st[e.id][d.date].m).forEach((d) => {
          let c = 0, gb = new Set();
          D.prim[e.id].forEach((p) => { const n = need(D, p, d); if (n && Math.max(0, n - have(D, st, p, d.date) + 1) > Math.max(0, n - have(D, st, p, d.date))) { c += 1000; gb.add(p.brand_id); } });
          if (gb.size) c += demand[d.date] >= D.leads.length - 1 ? 2000 : demand[d.date] * 60;
          if (d.dow !== pref) c += fixed ? 25 : 10;
          c += ((cnt[e.id] || {})[d.dow] || 0) * 3;
          if (last[e.id] != null && d.i - last[e.id] > 7) c += (d.i - last[e.id] - 7) * 20;
          c += ((d.i + parseInt(e.id.slice(4))) % 7) * 0.01;
          if (c < bc) { bc = c; best = d; bg = gb.size; }
        });
        if (best) {
          st[e.id][best.date] = { s: "WEEKLY_OFF" }; last[e.id] = best.i; demand[best.date] += bg;
          (cnt[e.id] ??= {})[best.dow] = ((cnt[e.id] || {})[best.dow] || 0) + 1;
        }
      });
      D.leads.forEach((l) => {
        if (w.some((d) => st[l.id][d.date].s !== "WORKING") || w.length < 7) return;
        let best = null, bc = 1e9;
        w.filter((d) => !st[l.id][d.date].m).forEach((d) => {
          const c = demand[d.date] * 100 + (d.dow !== 0 ? 5 : 0) + (offLeads[d.date] || 0) * 60;
          if (c < bc) { bc = c; best = d; }
        });
        if (best) { st[l.id][best.date] = { s: "WEEKLY_OFF" }; offLeads[best.date] = (offLeads[best.date] || 0) + 1; }
      });
    });
  }
 
  /* Rule: nobody works more than 6 days in a row. A run of 7+ working days gets an extra weekly off,
     placed on the day that opens the fewest coverage gaps (and, if tied, matches the employee's preferred day).
     Manual (locked) entries are never changed. */
  function fixStreaks(D, ds, st) {
    const work = (v) => v.s === "WORKING" || v.s === "BACKUP_WORKING";
    const defCount = (d) => Object.values(deficits(D, st, d)).reduce((n, a) => n + a.length, 0);
    const freeLeads = (d) => D.leads.filter((l) => { const v = st[l.id][d.date]; return v.s === "WORKING" && !v.b && !v.m; }).length;
    D.employees.forEach((e) => {
      const isLead = e.role === "POD_LEAD";
      const pref = e.weekly_off_pattern === "FIXED_SUNDAY" ? 0 : DN.indexOf(e.preferred_off_day);
      for (let guard = 0; guard < 8; guard++) {
        let found = null, start = 0, len = 0;
        for (let i = 0; i <= ds.length && !found; i++) {
          if (i < ds.length && work(st[e.id][ds[i].date])) { if (!len) start = i; len++; }
          else { if (len > 6) found = { start, len }; len = 0; }
        }
        if (!found) break;
        let best = null, bc = 1e9;
        // an off at position k leaves runs of k and (len-k-1) days; both must be <= 6
        for (let k = Math.max(0, found.len - 7); k <= Math.min(6, found.len - 1); k++) {
          const d = ds[found.start + k], keep = st[e.id][d.date];
          if (keep.m) continue;
          const before = defCount(d);
          st[e.id][d.date] = { s: "WEEKLY_OFF" };
          const after = defCount(d), free = freeLeads(d);
          const otherLeadsOff = isLead ? D.leads.filter((l) => l.id !== e.id && st[l.id][d.date].s === "WEEKLY_OFF").length : 0;
          st[e.id][d.date] = keep;
          const c = (after - before) * 1000 + Math.max(0, after - free) * 2000 + otherLeadsOff * 60 + (d.dow !== pref ? 10 : 0) + Math.abs(k - 5) * 0.01;
          if (c < bc) { bc = c; best = d; }
        }
        if (!best) break;
        st[e.id][best.date] = { s: "WEEKLY_OFF" };
      }
    });
  }

  /* Cover remaining gaps with free pod leads (same pod first). Does not touch manual entries. */
  function autoBackup(D, ds, st) {
  for (const day of ds) {
    const gaps = deficits(D, st, day);
    const brands = Object.keys(gaps).sort(
      (a, b) => gaps[b].length - gaps[a].length
    );

    for (const brandId of brands) {
      for (const process of gaps[brandId]) {
        const required = need(D, process, day);
        const processPods = new Set(
          D.pe[process.id].map((employeeId) => D.em[employeeId].pod_id)
        );

        while (have(D, st, process, day.date) < required) {
          const available = D.leads.filter((lead) => {
            const entry = st[lead.id][day.date];
            return entry.s === "WORKING" && !entry.b && !entry.m;
          });

          const lead = available.find((person) => processPods.has(person.pod_id))
            || available[0];

          if (!lead) break;

          st[lead.id][day.date] = {
            s: "BACKUP_WORKING",
            b: brandId,
            p: process.id
          };
        }
      }
    }
  }
}
 
  /* People who could cover a brand on a date without opening a new gap. */
  function candidates(D, st, date, brandId, d) {
    const pods = new Set(D.processes.filter((p) => p.brand_id === brandId).flatMap((p) => D.pe[p.id].map((e) => D.em[e].pod_id)));
    return D.employees.filter((e) => {
      const v = st[e.id][date];
      if (v.s !== "WORKING" || D.prim[e.id].some((p) => p.brand_id === brandId)) return false;
      if (e.role === "POD_LEAD") return !v.b;
      const keep = st[e.id][date]; st[e.id][date] = { s: "BACKUP_WORKING", b: brandId };
      const ok = !D.prim[e.id].some((p) => { const n = need(D, p, d); return n && have(D, st, p, date) < n; });
      st[e.id][date] = keep; return ok;
    }).sort((a, b) => (pods.has(b.pod_id) ? 1 : 0) - (pods.has(a.pod_id) ? 1 : 0) || (a.role === "POD_LEAD" ? -1 : 1)).slice(0, 4);
  }
 
  function analyze(D, mk, st) {
    const ds = days(mk), out = [], add = (sev, code, d, o) => out.push({ month_key: mk, date: d, severity: sev, code, brand_id: null, process_id: null, employee_id: null, ...o });
    ds.forEach((d) => {
      D.processes.forEach((p) => {
        const n = need(D, p, d), h = n ? have(D, st, p, d.date) : 0;
        if (n && h < n) {
          const cs = candidates(D, st, d.date, p.brand_id, d).map((e) => e.name).join(", ");
          add("HARD_CONFLICT", "UNDERSTAFFED_PROCESS", d.date, { brand_id: p.brand_id, process_id: p.id,
            message: `${D.bm[p.brand_id].name} — ${p.name} needs ${n} staff on ${d.date} (${DN[d.dow]}), but has ${h}. ` + (cs ? `Free cover: ${cs}.` : "No free internal cover available. Needs a leave change or a client decision.") });
        }
      });
      D.employees.forEach((e) => { const v = st[e.id][d.date];
        if (v.s === "BACKUP_WORKING") add("SOFT_WARNING", "BACKUP_COVER", d.date, { brand_id: v.b, process_id: v.p, employee_id: e.id, message: `${e.name} is covering ${D.bm[v.b].name}${D.pm[v.p] ? " / " + D.pm[v.p].name : ""} on ${d.date}.` }); });
    });
    D.employees.forEach((e) => {
      weeks(ds).forEach((w) => { if (w.length === 7 && w.every((d) => ["WORKING", "BACKUP_WORKING"].includes(st[e.id][d.date].s)))
        add("HARD_CONFLICT", "NO_WEEKLY_OFF", w[0].date, { employee_id: e.id, message: `${e.name} has no weekly off in the week starting ${w[0].date}.` }); });
      let run = 0, mx = 0;
      ds.forEach((d) => { run = ["WORKING", "BACKUP_WORKING"].includes(st[e.id][d.date].s) ? run + 1 : 0; mx = Math.max(mx, run); });
      if (mx > 6) add("SOFT_WARNING", "LONG_STREAK", ds[0].date, { employee_id: e.id, message: `${e.name} works ${mx} days in a row.` });
      const pref = e.weekly_off_pattern === "FIXED_SUNDAY" ? 0 : DN.indexOf(e.preferred_off_day);
      const miss = ds.filter((d) => st[e.id][d.date].s === "WEEKLY_OFF" && d.dow !== pref && D.prim[e.id].length && D.prim[e.id].every((p) => opens(D, p, d))).length;
      if (miss) add("SOFT_WARNING", "PREFERENCE_OVERRIDDEN", ds[0].date, { employee_id: e.id, message: `${e.name}: ${miss} weekly off(s) moved off the preferred ${DN[pref]}. Required coverage came first.` });
    });
    return out;
  }
 
  const toEntries = (D, mk, st) => D.employees.flatMap((e) => days(mk).map((d) => { const v = st[e.id][d.date];
    return { month_key: mk, date: d.date, employee_id: e.id, status: v.s, brand_id: v.b || null, process_id: v.p || null, is_manual_override: v.m ? 1 : 0 }; }));
  function fromEntries(D, mk, entries) {
    const st = init(D, days(mk), []);
    entries.forEach((r) => { if (st[r.employee_id]) st[r.employee_id][r.date] = { s: r.status, b: r.brand_id, p: r.process_id, m: r.is_manual_override }; });
    return st;
  }
  function generate(raw, mk, locks) {
    const D = prep(raw), ds = days(mk), st = init(D, ds, locks);
    placeOffs(D, ds, st); fixStreaks(D, ds, st); autoBackup(D, ds, st);
    return { D, st, entries: toEntries(D, mk, st), conflicts: analyze(D, mk, st) };
  }
  root.Sched = { DN, prep, days, weeks, opens, need, have, generate, analyze, autoBackup, fixStreaks, candidates, toEntries, fromEntries };
  if (typeof module !== "undefined") module.exports = root.Sched;
})(typeof window !== "undefined" ? window : globalThis);