/* Thin bridge: reads the DB, runs the pure engine (Sched), writes results back.
   Keeps the same public API that app.js already uses. */
const RosterScheduler = (() => {
  function loadRaw() {
    return {
      employees: RosterDB.queryAll("SELECT * FROM employees ORDER BY id;"),
      pods: RosterDB.queryAll("SELECT * FROM pods ORDER BY id;"),
      brands: RosterDB.queryAll("SELECT * FROM brands ORDER BY id;"),
      processes: RosterDB.queryAll("SELECT * FROM processes ORDER BY id;"),
      assignments: RosterDB.queryAll("SELECT * FROM assignments ORDER BY id;"),
      holidays: RosterDB.queryAll("SELECT * FROM holidays;"),
      leaves: RosterDB.queryAll("SELECT * FROM leave_requests;"),
    };
  }

  function generateMonthlyRoster(monthKey) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(monthKey || ""))) {
      throw new Error(`Invalid month "${monthKey}". Expected YYYY-MM.`);
    }

    const raw = loadRaw();

    // Manual overrides are "locked": the engine will not change them.
    const locks = RosterDB.queryAll(
      "SELECT date, employee_id, status, brand_id, process_id FROM roster_entries WHERE month_key = ? AND is_manual_override = 1;",
      [monthKey]
    );

    const { entries, conflicts } = Sched.generate(raw, monthKey, locks);

    RosterDB.runInTransaction((db) => {
      db.run("DELETE FROM roster_entries WHERE month_key = ?;", [monthKey]);
      db.run("DELETE FROM roster_conflicts WHERE month_key = ?;", [monthKey]);

      const insE = db.prepare(
        `INSERT INTO roster_entries (month_key, date, employee_id, status, brand_id, process_id, is_manual_override)
         VALUES (?, ?, ?, ?, ?, ?, ?);`
      );
      try {
        for (const r of entries) {
          insE.run([r.month_key, r.date, r.employee_id, r.status, r.brand_id ?? null, r.process_id ?? null, r.is_manual_override]);
        }
      } finally { insE.free(); }

      const insC = db.prepare(
        `INSERT INTO roster_conflicts (month_key, date, severity, code, brand_id, process_id, employee_id, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?);`
      );
      try {
        for (const c of conflicts) {
          insC.run([c.month_key, c.date, c.severity, c.code, c.brand_id ?? null, c.process_id ?? null, c.employee_id ?? null, c.message]);
        }
      } finally { insC.free(); }
    });

    return {
      monthKey,
      entriesGenerated: entries.length,
      hardConflicts: conflicts.filter((c) => c.severity === "HARD_CONFLICT").length,
      softWarnings: conflicts.filter((c) => c.severity === "SOFT_WARNING").length,
    };
  }

  return { generateMonthlyRoster };
})();