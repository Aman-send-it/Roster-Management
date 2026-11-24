const RosterViews = (() => {
  function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function statusBadgeClass(status) {
    return `status-${status}`;
  }

  const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
  const dayIndex = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  const isSunday = (iso) => dayIndex(iso) === 0;

  function shortCellLabel(status) {
    const labels = {
      WORKING: "W",
      BACKUP_WORKING: "BK",
      WEEKLY_OFF: "WO",
      HOLIDAY_OFF: "HO",
      LEAVE: "LV",
      COMP_OFF: "CO",
      UNAVAILABLE: "UN",
    };
    return labels[status] || status;
  }

  function renderSummaryCards(monthKey) {
    const [s] = RosterDB.queryAll(
      `SELECT
        (SELECT COUNT(*) FROM employees) AS total_employees,
        (SELECT COUNT(*) FROM employees WHERE role = 'POD_LEAD') AS pod_leads,
        (SELECT COUNT(*) FROM pods) AS total_pods,
        (SELECT COUNT(*) FROM brands) AS total_brands,
        (SELECT COUNT(*) FROM brands WHERE staffing_model = 'SINGLE_DEDICATED') AS single_brands,
        (SELECT COUNT(*) FROM brands WHERE staffing_model = 'MULTI_EMPLOYEE') AS multi_brands,
        (SELECT COUNT(*) FROM roster_conflicts WHERE month_key = ? AND severity = 'HARD_CONFLICT') AS hard_conflicts,
        (SELECT COUNT(*) FROM roster_conflicts WHERE month_key = ? AND severity = 'SOFT_WARNING') AS soft_warnings;`,
      [monthKey, monthKey]
    );
    const pct = (n, t) => (t ? Math.round((n / t) * 100) : 0);

    return `
      <div class="kpi-card">
        <div class="kpi-label">Total Employees</div>
        <div class="kpi-value">${escapeHtml(s.total_employees)}</div>
        <div class="kpi-sub">${escapeHtml(s.pod_leads)} Pod Leads · ${escapeHtml(s.total_employees - s.pod_leads)} Team Members · ${escapeHtml(s.total_pods)} Pods</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Total Brands</div>
        <div class="kpi-value">${escapeHtml(s.total_brands)}</div>
        <div class="kpi-sub">${escapeHtml(s.single_brands)} Single (${pct(s.single_brands, s.total_brands)}%) · ${escapeHtml(s.multi_brands)} Multi (${pct(s.multi_brands, s.total_brands)}%)</div>
      </div>
      <div class="kpi-card ${s.hard_conflicts > 0 ? "kpi-danger" : ""}">
        <div class="kpi-label">Hard Conflicts (${escapeHtml(monthKey)})</div>
        <div class="kpi-value">${escapeHtml(s.hard_conflicts)}</div>
        <div class="kpi-sub">${s.hard_conflicts > 0 ? "Needs attention before publishing" : "All required coverage is met"}</div>
      </div>
      <div class="kpi-card ${s.soft_warnings > 0 ? "kpi-warn" : ""}">
        <div class="kpi-label">Soft Warnings (${escapeHtml(monthKey)})</div>
        <div class="kpi-value">${escapeHtml(s.soft_warnings)}</div>
        <div class="kpi-sub">Backup cover, preferences, long streaks</div>
      </div>
    `;
  }

  function opts(rows, selected, labelFn) {
    return rows
      .map((r) => `<option value="${escapeHtml(r.id)}" ${selected === r.id ? "selected" : ""}>${escapeHtml(labelFn(r))}</option>`)
      .join("");
  }

  function renderFilterBar(activeTab, filters = {}) {
    const pods = RosterDB.queryAll("SELECT id, name FROM pods ORDER BY id;");
    const brands = RosterDB.queryAll("SELECT id, name FROM brands ORDER BY id;");
    const [m] = RosterDB.queryAll(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN staffing_model='SINGLE_DEDICATED' THEN 1 ELSE 0 END) AS single,
              SUM(CASE WHEN staffing_model='MULTI_EMPLOYEE' THEN 1 ELSE 0 END) AS multi FROM brands;`
    );
    const roles = ["POD_LEAD", "DEDICATED_SINGLE", "MULTI_BRAND"];
    const sel = (v, cur) => (v === cur ? "selected" : "");
    const brandSelect = `
      <select id="filter-brand" aria-label="Filter by Brand">
        <option value="ALL">All Brands</option>
        ${opts(brands, filters.brandId, (b) => `${b.id} · ${b.name}`)}
      </select>`;

    if (activeTab === "roster" || activeTab === "pods") {
      return `
        <select id="filter-pod" aria-label="Filter by Pod">
          <option value="ALL">All Pods (${pods.length})</option>
          ${opts(pods, filters.podId, (p) => `${p.name} (${p.id})`)}
        </select>
        <select id="filter-role" aria-label="Filter by Role">
          <option value="ALL">All Roles</option>
          ${roles.map((r) => `<option value="${r}" ${sel(r, filters.role)}>${r}</option>`).join("")}
        </select>
        <input type="search" id="filter-search" placeholder="Search employee ID or name..." value="${escapeHtml(filters.search || "")}" aria-label="Search employee" />
      `;
    }

    if (activeTab === "brands" || activeTab === "company") {
      return `
        <select id="filter-model" aria-label="Filter by staffing model">
          <option value="ALL">All ${m.total} Brands</option>
          <option value="SINGLE_DEDICATED" ${sel("SINGLE_DEDICATED", filters.staffingModel)}>${m.single} Single-Dedicated</option>
          <option value="MULTI_EMPLOYEE" ${sel("MULTI_EMPLOYEE", filters.staffingModel)}>${m.multi} Multi-Employee</option>
        </select>
        ${brandSelect}
      `;
    }

    if (activeTab === "conflicts") return brandSelect;
    return "";
  }

  function renderRosterGrid(monthKey, filters = {}) {
    const entries = RosterDB.queryAll(
      `SELECT re.date, re.employee_id, re.status, b.name AS brand_name, p.name AS process_name,
              e.name AS emp_name, e.role, e.pod_id
       FROM roster_entries re
       JOIN employees e ON re.employee_id = e.id
       LEFT JOIN brands b ON re.brand_id = b.id
       LEFT JOIN processes p ON re.process_id = p.id
       WHERE re.month_key = ?
       ORDER BY e.id, re.date;`,
      [monthKey]
    );

    if (!entries.length) {
      return `<p>No roster generated for <strong>${escapeHtml(monthKey)}</strong>. Click <strong>Generate Roster</strong> above.</p>`;
    }

    const dates = [...new Set(entries.map((r) => r.date))].sort();
    const byEmp = new Map();

    for (const r of entries) {
      if (filters.podId && filters.podId !== "ALL" && r.pod_id !== filters.podId) continue;
      if (filters.role && filters.role !== "ALL" && r.role !== filters.role) continue;
      const q = (filters.search || "").trim().toLowerCase();
      if (q && !r.emp_name.toLowerCase().includes(q) && !r.employee_id.toLowerCase().includes(q)) continue;

      if (!byEmp.has(r.employee_id)) {
        byEmp.set(r.employee_id, {
          id: r.employee_id,
          name: r.emp_name,
          role: r.role,
          days: new Map(),
        });
      }
      byEmp.get(r.employee_id).days.set(r.date, r);
    }

    const bodyRows = [...byEmp.values()]
      .map((emp) => {
        const dayCells = dates
          .map((dt) => {
            const cell = emp.days.get(dt);
            const st = cell ? cell.status : "WORKING";
            const tip = cell
              ? `${emp.name} (${dt}): ${st}${cell.brand_name ? ` · ${cell.brand_name} (${cell.process_name})` : ""}`
              : dt;
            return `<td class="cell ${isSunday(dt) ? "sun-col" : ""}" title="${escapeHtml(tip)}"><span class="badge ${statusBadgeClass(st)}">${escapeHtml(shortCellLabel(st))}</span></td>`;
          })
          .join("");

        return `
          <tr>
            <td class="sticky-col"><strong>${escapeHtml(emp.id)}</strong> · ${escapeHtml(emp.name)} <span style="color:var(--muted)">(${escapeHtml(emp.role)})</span></td>
            ${dayCells}
          </tr>
        `;
      })
      .join("");

    return `
      <p style="margin-top:0;color:var(--muted);font-size:0.84rem;">
        Legend: <strong>W</strong> = Working · <strong>BK</strong> = Backup Working · <strong>WO</strong> = Weekly Off · <strong>HO</strong> = Holiday Off · <strong>LV</strong> = Leave · <strong>CO</strong> = Comp-Off · <strong>UN</strong> = Unavailable
      </p>
      <div class="table-scroll"><table class="roster-table">
        <thead>
          <tr>
            <th class="sticky-col">Employee</th>
            ${dates.map((d) => `<th class="cell ${isSunday(d) ? "sun-col" : ""}">${escapeHtml(d.slice(8, 10))}<div class="day-mini">${DAY_LETTERS[dayIndex(d)]}</div></th>`).join("")}
          </tr>
        </thead>
        <tbody>${bodyRows || `<tr><td colspan="${dates.length + 1}">No matching employees.</td></tr>`}</tbody>
      </table></div>
    `;
  }

  function renderCompanyAndProcessView(monthKey, filters = {}) {
    const conflicts = RosterDB.queryAll(
      `SELECT rc.date, rc.severity, rc.code, rc.message, b.id AS brand_id, b.name AS brand_name, p.name AS process_name
       FROM roster_conflicts rc
       LEFT JOIN brands b ON rc.brand_id = b.id
       LEFT JOIN processes p ON rc.process_id = p.id
       WHERE rc.month_key = ? AND rc.severity = 'HARD_CONFLICT'
       ORDER BY rc.date, b.id;`,
      [monthKey]
    ).filter((c) => !filters.brandId || filters.brandId === "ALL" || c.brand_id === filters.brandId);

    const processSummary = RosterDB.queryAll(
      `SELECT b.id AS brand_id, b.name AS brand_name, b.staffing_model,
              p.id AS process_id, p.name AS process_name, p.min_staff_required,
              COALESCE(p.calendar_mode_override, b.calendar_mode) AS effective_calendar,
              COUNT(a.id) AS assigned_count
       FROM brands b
       JOIN processes p ON p.brand_id = b.id
       LEFT JOIN assignments a ON a.process_id = p.id AND a.is_backup_slot = 0
       GROUP BY b.id, b.name, b.staffing_model, p.id, p.name, p.min_staff_required, p.calendar_mode_override, b.calendar_mode
       ORDER BY b.id, p.id;`
    ).filter((r) => {
      if (filters.staffingModel && filters.staffingModel !== "ALL" && r.staffing_model !== filters.staffingModel) return false;
      if (filters.brandId && filters.brandId !== "ALL" && r.brand_id !== filters.brandId) return false;
      return true;
    });

    return `
      <h3>Company & Process Coverage Summary (${escapeHtml(monthKey)})</h3>
      <p style="color:var(--muted);font-size:0.86rem;">
        Hard coverage gaps detected in <strong>${escapeHtml(monthKey)}</strong>: <strong>${conflicts.length}</strong>
      </p>
      <div class="table-scroll"><table class="data-table">
        <thead>
          <tr>
            <th>Brand</th><th>Model</th><th>Process</th><th>Calendar Rule</th><th>Min Staff</th><th>Assigned</th>
          </tr>
        </thead>
        <tbody>
          ${processSummary
            .map(
              (r) => `
            <tr>
              <td><strong>${escapeHtml(r.brand_id)}</strong> · ${escapeHtml(r.brand_name)}</td>
              <td>${escapeHtml(r.staffing_model)}</td>
              <td>${escapeHtml(r.process_name)}</td>
              <td>${escapeHtml(r.effective_calendar)}</td>
              <td>${escapeHtml(r.min_staff_required)}</td>
              <td>${escapeHtml(r.assigned_count)}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table></div>
    `;
  }

  function renderDailyCoverage(monthKey, filters) {
  const brandId = filters.brandId;
  if (!brandId || brandId === "ALL") {
    return "<p>Select a brand to see its daily process coverage.</p>";
  }

  const [brand] = RosterDB.queryAll(
    "SELECT * FROM brands WHERE id = ?", [brandId]
  );
  if (!brand || (filters.staffingModel && filters.staffingModel !== "ALL" &&
      filters.staffingModel !== brand.staffing_model)) return "";

  const calendar = {
    bm: { [brandId]: brand },
    holidays: RosterDB.queryAll("SELECT * FROM holidays")
  };
  const processes = RosterDB.queryAll(
    "SELECT * FROM processes WHERE brand_id = ? ORDER BY id", [brandId]
  );
  const workers = RosterDB.queryAll(`
    SELECT r.date, p.id AS process, e.name, r.status
    FROM roster_entries r
    JOIN employees e ON e.id = r.employee_id
    JOIN processes p ON p.brand_id = ?
    WHERE r.month_key = ? AND (
      (r.status = 'BACKUP_WORKING' AND r.brand_id = p.brand_id AND r.process_id = p.id)
      OR (r.status = 'WORKING' AND EXISTS (
        SELECT 1 FROM assignments a WHERE a.employee_id = e.id
        AND a.process_id = p.id AND a.is_backup_slot = 0)))
    ORDER BY r.date, p.id, e.name`, [brandId, monthKey]);

  const rows = Sched.days(monthKey).flatMap(day => processes.map(process => {
    const required = Sched.need(calendar, process, day);
    const team = required
      ? workers.filter(w => w.date === day.date && w.process === process.id)
      : [];
    const names = team.map(w =>
      escapeHtml(w.name) + (w.status === "BACKUP_WORKING" ? " (backup)" : "")
    );
    const status = !required ? "Closed"
      : team.length >= required ? "Covered" : "Short by " + (required - team.length);

    return `<tr><td>${day.date}</td><td>${escapeHtml(process.name)}</td>
      <td>${names.join(", ") || "—"}</td><td>${team.length} / ${required}</td>
      <td>${status}</td></tr>`;
  }));

  return `<h3>Daily coverage · ${escapeHtml(brand.name)}</h3>
    <div class="table-scroll"><table class="data-table"><thead><tr>
    <th>Date</th><th>Process</th><th>Working employees</th>
    <th>Working / required</th><th>Status</th>
    </tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

  function renderBrandsView(filters = {}) {
    const rows = RosterDB.queryAll(
      `SELECT b.id AS brand_id, b.name AS brand_name, b.staffing_model, b.calendar_mode,
              p.name AS process_name, p.calendar_mode_override, p.min_staff_required,
              GROUP_CONCAT(e.name || ' (' || e.id || ')', ', ') AS assigned_employees
       FROM brands b
       JOIN processes p ON p.brand_id = b.id
       LEFT JOIN assignments a ON a.process_id = p.id
       LEFT JOIN employees e ON a.employee_id = e.id
       GROUP BY b.id, b.name, b.staffing_model, b.calendar_mode, p.id, p.name, p.calendar_mode_override, p.min_staff_required
       ORDER BY b.id, p.id;`
    ).filter((r) => {
      if (filters.staffingModel && filters.staffingModel !== "ALL" && r.staffing_model !== filters.staffingModel) return false;
      if (filters.brandId && filters.brandId !== "ALL" && r.brand_id !== filters.brandId) return false;
      return true;
    });

    return `
      <div class="table-scroll"><table class="data-table">
        <thead>
          <tr>
            <th>Brand</th><th>Model</th><th>Process</th><th>Effective Calendar</th><th>Min Staff</th><th>Assigned Employees</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr>
              <td><strong>${escapeHtml(r.brand_id)}</strong> · ${escapeHtml(r.brand_name)}</td>
              <td>${escapeHtml(r.staffing_model)}</td>
              <td>${escapeHtml(r.process_name)}</td>
              <td>${escapeHtml(r.calendar_mode_override || r.calendar_mode)}</td>
              <td>${escapeHtml(r.min_staff_required)}</td>
              <td>${escapeHtml(r.assigned_employees || "—")}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table></div>
    `;
  }

  function renderPodsEmployeesView(filters = {}) {
    const rows = RosterDB.queryAll(
      `SELECT e.id, e.name, e.role, p.name AS pod_name, e.pod_id,
              e.weekly_off_pattern, e.preferred_off_day, e.comp_offs_available,
              GROUP_CONCAT(DISTINCT b.name || ':' || pr.name) AS allocations
       FROM employees e
       JOIN pods p ON e.pod_id = p.id
       LEFT JOIN assignments a ON a.employee_id = e.id
       LEFT JOIN brands b ON a.brand_id = b.id
       LEFT JOIN processes pr ON a.process_id = pr.id
       GROUP BY e.id, e.name, e.role, p.name, e.pod_id, e.weekly_off_pattern, e.preferred_off_day, e.comp_offs_available
       ORDER BY p.id, e.id;`
    ).filter((e) => {
      if (filters.podId && filters.podId !== "ALL" && e.pod_id !== filters.podId) return false;
      if (filters.role && filters.role !== "ALL" && e.role !== filters.role) return false;
      const q = (filters.search || "").trim().toLowerCase();
      if (q && !e.name.toLowerCase().includes(q) && !e.id.toLowerCase().includes(q)) return false;
      return true;
    });

    return `
      <div class="table-scroll"><table class="data-table">
        <thead>
          <tr>
            <th>ID</th><th>Name</th><th>Role</th><th>Pod</th><th>Off Pattern</th><th>Preferred Off</th><th>Comp-Offs</th><th>Allocations</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (e) => `
            <tr>
              <td>${escapeHtml(e.id)}</td>
              <td><strong>${escapeHtml(e.name)}</strong></td>
              <td>${escapeHtml(e.role)}</td>
              <td>${escapeHtml(e.pod_name)}</td>
              <td>${escapeHtml(e.weekly_off_pattern)}</td>
              <td>${escapeHtml(e.preferred_off_day)}</td>
              <td>${escapeHtml(e.comp_offs_available)}</td>
              <td>${escapeHtml(e.allocations || "Pod Oversight / Backup")}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table></div>
    `;
  }

  function renderConflictsAndLeavesView(monthKey, filters = {}) {
    const employees = RosterDB.queryAll("SELECT id, name FROM employees ORDER BY id;");
    const brands = RosterDB.queryAll("SELECT id, name FROM brands ORDER BY id;");
    const processes = RosterDB.queryAll("SELECT id, brand_id, name FROM processes ORDER BY id;");
    const assignments = RosterDB.queryAll(
      `SELECT a.id, a.employee_id, a.brand_id, a.process_id,
              e.name AS emp_name, b.name AS brand_name, p.name AS process_name
       FROM assignments a
       JOIN employees e ON a.employee_id = e.id
       JOIN brands b ON a.brand_id = b.id
       JOIN processes p ON a.process_id = p.id
       ORDER BY b.id, p.id, e.id;`
    );
    const podLeads = RosterDB.queryAll("SELECT id, name FROM employees WHERE role = 'POD_LEAD' ORDER BY id;");
    const leaves = RosterDB.queryAll(
      `SELECT lr.*, e.name AS emp_name
       FROM leave_requests lr
       JOIN employees e ON lr.employee_id = e.id
       ORDER BY lr.start_date;`
    );
    const conflicts = RosterDB.queryAll(
      `SELECT rc.*, b.name AS brand_name, p.name AS process_name
       FROM roster_conflicts rc
       LEFT JOIN brands b ON rc.brand_id = b.id
       LEFT JOIN processes p ON rc.process_id = p.id
       WHERE rc.month_key = ?
       ORDER BY rc.date, rc.severity;`,
      [monthKey]
    ).filter((c) => !filters.brandId || filters.brandId === "ALL" || c.brand_id === filters.brandId);

    return `
      <h3>Add Employee Assignment</h3>
      <form id="assignmentForm" class="inline-form">
        <select name="employee_id" required>
          ${employees.map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.id)} · ${escapeHtml(e.name)}</option>`).join("")}
        </select>
        <select name="brand_id" required>
          ${brands.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.id)} · ${escapeHtml(b.name)}</option>`).join("")}
        </select>
        <select name="process_id" required>
          ${processes.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.brand_id)} / ${escapeHtml(p.name)} (${escapeHtml(p.id)})</option>`).join("")}
        </select>
        <button type="submit" class="btn btn-primary">Add Assignment</button>
      </form>

      <h3>Add Leave / Comp-Off / Unavailability</h3>
      <form id="leaveForm" class="inline-form">
        <select name="employee_id" required>
          ${employees.map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.id)} · ${escapeHtml(e.name)}</option>`).join("")}
        </select>
        <select name="type">
          <option value="PLANNED_LEAVE">PLANNED_LEAVE</option>
          <option value="COMP_OFF">COMP_OFF</option>
          <option value="UNAVAILABLE">UNAVAILABLE</option>
        </select>
        <input type="date" name="start_date" value="${escapeHtml(monthKey)}-05" required />
        <input type="date" name="end_date" value="${escapeHtml(monthKey)}-05" required />
        <button type="submit" class="btn btn-primary">Save & Regenerate</button>
      </form>

      <h3>Detected Conflicts & Warnings (${escapeHtml(monthKey)})</h3>
      ${
        conflicts.length
          ? `<div class="conflict-list">` + conflicts
              .map(
                (c) => `
            <div class="conflict-row conflict-item ${c.severity === "HARD_CONFLICT" ? "conflict-hard" : "conflict-soft"}">
              <span class="badge ${c.severity === "HARD_CONFLICT" ? "badge-hard" : "badge-soft"}">${escapeHtml(c.severity)}</span>
              <strong>${escapeHtml(c.date)}</strong> · <code>${escapeHtml(c.code)}</code>
              <p style="margin:6px 0 8px;">${escapeHtml(c.message)}</p>
              ${
                c.severity === "HARD_CONFLICT" && c.brand_id
                  ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                       <select class="backup-lead-select">
                         ${podLeads.map((l) => `<option value="${escapeHtml(l.id)}">Backup: ${escapeHtml(l.name)} (${escapeHtml(l.id)})</option>`).join("")}
                       </select>
                       <button type="button" class="btn-small assign-backup-btn" data-date="${escapeHtml(c.date)}" data-brand="${escapeHtml(c.brand_id)}" data-process="${escapeHtml(c.process_id || "")}">
                         Assign Pod Lead Backup
                       </button>
                     </div>`
                  : ""
              }
            </div>
          `
              )
              .join("") + `</div>`
          : `<p>No conflicts or warnings recorded for ${escapeHtml(monthKey)}.</p>`
      }

      <h3>Active Assignments (${assignments.length})</h3>
      <div class="table-scroll"><table class="data-table">
        <thead>
          <tr><th>ID</th><th>Employee</th><th>Brand</th><th>Process</th><th>Action</th></tr>
        </thead>
        <tbody>
          ${assignments
            .map(
              (a) => `
            <tr>
              <td>${escapeHtml(a.id)}</td>
              <td>${escapeHtml(a.emp_name)} (${escapeHtml(a.employee_id)})</td>
              <td>${escapeHtml(a.brand_name)} (${escapeHtml(a.brand_id)})</td>
              <td>${escapeHtml(a.process_name)} (${escapeHtml(a.process_id)})</td>
              <td><button type="button" class="btn-small delete-assignment-btn" data-id="${escapeHtml(a.id)}">Remove</button></td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table></div>

      <h3>Leave & Comp-Off Entries</h3>
      <div class="table-scroll"><table class="data-table">
        <thead>
          <tr><th>ID</th><th>Employee</th><th>Type</th><th>Start</th><th>End</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${leaves
            .map(
              (l) => `
            <tr>
              <td>${escapeHtml(l.id)}</td>
              <td>${escapeHtml(l.emp_name)} (${escapeHtml(l.employee_id)})</td>
              <td>${escapeHtml(l.type)}</td>
              <td>${escapeHtml(l.start_date)}</td>
              <td>${escapeHtml(l.end_date)}</td>
              <td>${escapeHtml(l.status)}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table></div>
    `;
  }

  function renderTabContent(activeTab, monthKey, filters = {}) {
    if (activeTab === "roster") return renderRosterGrid(monthKey, filters);
    if (activeTab === "company") return renderCompanyAndProcessView(monthKey, filters);
    if (activeTab === "brands") return renderBrandsView(filters)+renderDailyCoverage(monthKey, filters);
    if (activeTab === "pods") return renderPodsEmployeesView(filters);
    if (activeTab === "conflicts") return renderConflictsAndLeavesView(monthKey, filters);
    return renderRosterGrid(monthKey, filters);
  }

  return {
    renderSummaryCards,
    renderFilterBar,
    renderTabContent,
  };
})();