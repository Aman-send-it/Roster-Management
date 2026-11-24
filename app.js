(() => {
  const state = {
    activeTab: "roster",
    monthKey: "2026-12",
    filters: {
      podId: "ALL",
      role: "ALL",
      search: "",
      staffingModel: "ALL",
      brandId: "ALL",
    },
  };

  const els = {
    monthInput: document.getElementById("month-picker") || document.getElementById("monthInput"),
    generateBtn: document.getElementById("btn-generate") || document.getElementById("generateBtn"),
    exportDbBtn: document.getElementById("btn-export-db") || document.getElementById("exportDbBtn"),
    resetDbBtn: document.getElementById("btn-reset-db") || document.getElementById("resetDbBtn"),
    statusBanner: document.getElementById("status-banner"),
    kpiContainer: document.getElementById("kpi-container") || document.getElementById("summaryStrip"),
    filterBar: document.getElementById("roster-filters") || document.getElementById("filterBar"),
    viewContainer: document.getElementById("view-container") || document.getElementById("appContent"),
    tabButtons: [...document.querySelectorAll(".tab-btn")],
  };

  function setStatus(message, isError = false) {
    if (!els.statusBanner) return;
    els.statusBanner.textContent = message;
    els.statusBanner.classList.toggle("status-ok", !isError);
    els.statusBanner.classList.toggle("status-error", isError);
  }

  function syncActiveTabButton() {
    els.tabButtons.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === state.activeTab);
    });
  }

  function refreshFilters() {
    if (els.filterBar && typeof RosterViews !== "undefined") {
      els.filterBar.innerHTML = RosterViews.renderFilterBar(state.activeTab, state.filters);
    }
  }

  function updateStaticLabels() {
    const [c] = RosterDB.queryAll(
      "SELECT (SELECT COUNT(*) FROM pods) AS pods, (SELECT COUNT(*) FROM employees) AS emps, (SELECT COUNT(*) FROM brands) AS brands;"
    );
    const sub = document.getElementById("app-subtitle");
    if (sub) sub.textContent = `SQLite + HTML/JS · ${c.pods} Process Pods · ${c.emps} Employees · ${c.brands} Brands`;
    els.tabButtons.forEach((btn) => {
      if (btn.dataset.tab === "brands") btn.textContent = `Brands & Processes (${c.brands})`;
      if (btn.dataset.tab === "pods") btn.textContent = `Pods & Employees (${c.emps})`;
    });
  }

  // rebuildFilters = false while typing/selecting in a filter, so the input keeps focus
  function refreshUI(rebuildFilters = true) {
    if (els.monthInput && els.monthInput.value) {
      state.monthKey = els.monthInput.value;
    }
    syncActiveTabButton();
    if (rebuildFilters) refreshFilters();

    if (els.kpiContainer && typeof RosterViews !== "undefined") {
      els.kpiContainer.innerHTML = RosterViews.renderSummaryCards(state.monthKey);
    }
    if (els.viewContainer && typeof RosterViews !== "undefined") {
      els.viewContainer.innerHTML = RosterViews.renderTabContent(
        state.activeTab,
        state.monthKey,
        state.filters
      );
    }
    bindDynamicControls();
  }

  function bindDynamicControls() {
    const bindFilter = (id, evt, key, transform = (v) => v) => {
      const el = document.getElementById(id);
      if (el) el[evt] = (e) => { state.filters[key] = transform(e.target.value); refreshUI(false); };
    };
    bindFilter("filter-pod", "onchange", "podId");
    bindFilter("filter-role", "onchange", "role");
    bindFilter("filter-search", "oninput", "search");
    bindFilter("filter-model", "onchange", "staffingModel");
    bindFilter("filter-brand", "onchange", "brandId");

    
    const assignmentForm = document.getElementById("assignmentForm");
    if (assignmentForm) {
      assignmentForm.onsubmit = (e) => {
        e.preventDefault();
        const fd = new FormData(assignmentForm);
        const empId = fd.get("employee_id");
        const brandId = fd.get("brand_id");
        const processId = fd.get("process_id");

        const [proc] = RosterDB.queryAll("SELECT id, brand_id FROM processes WHERE id = ?;", [processId]);
        if (!proc || proc.brand_id !== brandId) {
          setStatus("Selected process does not belong to the chosen brand.", true);
          return;
        }

        RosterDB.runSql(
          `INSERT INTO assignments (id, employee_id, brand_id, process_id, is_backup_slot)
           VALUES (?, ?, ?, ?, 0)
           ON CONFLICT(employee_id, brand_id, process_id) DO NOTHING;`,
          [`ASG-${Date.now()}`, empId, brandId, processId]
        );
        RosterScheduler.generateMonthlyRoster(state.monthKey);
        refreshUI();
        setStatus(`Assignment added and roster updated for ${state.monthKey}.`);
      };
    }

    document.querySelectorAll(".delete-assignment-btn").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        if (!id) return;
        RosterDB.runSql("DELETE FROM assignments WHERE id = ?;", [id]);
        RosterScheduler.generateMonthlyRoster(state.monthKey);
        refreshUI();
        setStatus(`Assignment ${id} removed and roster updated for ${state.monthKey}.`);
      };
    });

    const leaveForm = document.getElementById("leaveForm");
    if (leaveForm) {
      leaveForm.onsubmit = (e) => {
        e.preventDefault();
        const fd = new FormData(leaveForm);
        RosterDB.runSql(
          `INSERT INTO leave_requests (id, employee_id, start_date, end_date, type, status)
           VALUES (?, ?, ?, ?, ?, 'APPROVED');`,
          [
            `LEV-${Date.now()}`,
            fd.get("employee_id"),
            fd.get("start_date"),
            fd.get("end_date"),
            fd.get("type"),
          ]
        );
        RosterScheduler.generateMonthlyRoster(state.monthKey);
        refreshUI();
        setStatus(`Leave entry saved and roster regenerated for ${state.monthKey}.`);
      };
    }

    document.querySelectorAll(".assign-backup-btn").forEach((btn) => {
      btn.onclick = () => {
        const date = btn.dataset.date;
        const brandId = btn.dataset.brand;
        const processId = btn.dataset.process || null;
        const wrapper = btn.closest(".conflict-item");
        const selectEl = wrapper ? wrapper.querySelector(".backup-lead-select") : null;
        const leadId = selectEl ? selectEl.value : null;
        if (!leadId) return;

        const [slot] = RosterDB.queryAll(
        `SELECT status, brand_id, is_manual_override
        FROM roster_entries
        WHERE month_key = ? AND date = ? AND employee_id = ?`,
        [state.monthKey, date, leadId]
      );

      if (!slot || slot.status !== "WORKING" || slot.brand_id || slot.is_manual_override) {
        const reason = !slot ? "has no roster entry"
          : slot.is_manual_override ? "has a locked assignment"
          : slot.status === "BACKUP_WORKING" ? "is already covering another process"
          : slot.status === "WORKING" ? "already has assigned work"
          : "is marked " + slot.status;

        setStatus(`Cannot assign backup: ${leadId} ${reason} on ${date}.`, true);
        return;
      }

        RosterDB.runSql(
          `INSERT INTO roster_entries
            (month_key, date, employee_id, status, brand_id, process_id, is_manual_override)
           VALUES (?, ?, ?, 'BACKUP_WORKING', ?, ?, 1)
           ON CONFLICT(month_key, date, employee_id)
           DO UPDATE SET
             status = 'BACKUP_WORKING',
             brand_id = excluded.brand_id,
             process_id = excluded.process_id,
             is_manual_override = 1;`,
          [state.monthKey, date, leadId, brandId, processId]
        );
        RosterScheduler.generateMonthlyRoster(state.monthKey);
        refreshUI();
        setStatus(`Assigned backup ${leadId} on ${date}.`);
      };
    });
  }

  function bindStaticControls() {
    els.tabButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activeTab = btn.dataset.tab;
        refreshUI();
      });
    });

    if (els.monthInput) {
      els.monthInput.addEventListener("change", () => {
        state.monthKey = els.monthInput.value || "2026-12";
        const existing = RosterDB.queryAll(
          "SELECT COUNT(*) AS cnt FROM roster_entries WHERE month_key = ?;",
          [state.monthKey]
        );
        if (!existing[0] || existing[0].cnt === 0) {
          RosterScheduler.generateMonthlyRoster(state.monthKey);
        }
        refreshUI();
        setStatus(`Viewing roster for ${state.monthKey}.`);
      });
    }

    if (els.generateBtn) {
      els.generateBtn.addEventListener("click", () => {
        state.monthKey = (els.monthInput && els.monthInput.value) || "2026-12";
        const result = RosterScheduler.generateMonthlyRoster(state.monthKey);
        refreshUI();
        setStatus(
          `Generated ${result.entriesGenerated} entries for ${state.monthKey} (${result.hardConflicts} hard conflicts, ${result.softWarnings} soft warnings).`
        );
      });
    }

    if (els.exportDbBtn) {
      els.exportDbBtn.addEventListener("click", () => {
        RosterDB.downloadDbFile(`roster_404_creatives_${state.monthKey}.db`);
        setStatus(`Exported SQLite database for ${state.monthKey}.`);
      });
    }

    if (els.resetDbBtn) {
      els.resetDbBtn.addEventListener("click", async () => {
        await RosterDB.resetFromSourceDb();
        updateStaticLabels();
        state.monthKey = (els.monthInput && els.monthInput.value) || "2026-12";
        RosterScheduler.generateMonthlyRoster(state.monthKey);
        refreshUI();
        setStatus(`Database reset from source and roster generated for ${state.monthKey}.`);
      });
    }
  }

  (async function boot() {
    try {
      bindStaticControls();
      await RosterDB.init();
      updateStaticLabels();
      state.monthKey = (els.monthInput && els.monthInput.value) || "2026-12";
      const existing = RosterDB.queryAll(
        "SELECT COUNT(*) AS cnt FROM roster_entries WHERE month_key = ?;",
        [state.monthKey]
      );
      if (!existing[0] || existing[0].cnt === 0) {
        RosterScheduler.generateMonthlyRoster(state.monthKey);
      }
      refreshUI();
      setStatus(`Ready · Roster loaded for ${state.monthKey}.`);
    } catch (err) {
      console.error(err);
      setStatus(`Startup Error: ${err.message}`, true);
      if (els.viewContainer) {
        els.viewContainer.innerHTML = `<p style="color:#991b1b;"><strong>Startup Error:</strong> ${err.message}</p>`;
      }
    }
  })();
})();