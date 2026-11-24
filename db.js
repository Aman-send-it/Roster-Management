const STORAGE_KEY = "roster_404_creatives_db_v1";
const DB_URL = "./Roster.db"; // Change to "./Roster.db" if your file has a capital R

const RosterDB = (() => {
  let SQL = null;
  let db = null;

  async function init() {
    if (db) return db;

    if (typeof window.initSqlJs !== "function") {
      throw new Error("sql.js failed to load. Check the sql-wasm.js script tag.");
    }

    SQL = await window.initSqlJs({
      locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`
    });

    const savedBase64 = localStorage.getItem(STORAGE_KEY);
    if (savedBase64) {
      const bytes = base64ToUint8Array(savedBase64);
      db = new SQL.Database(bytes);
    } else {
      const response = await fetch(DB_URL, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Failed to fetch ${DB_URL} (${response.status})`);
      }
      const buffer = await response.arrayBuffer();
      db = new SQL.Database(new Uint8Array(buffer));
      db.run("PRAGMA foreign_keys = ON;");
      saveToLocalStorage();
      return db;
    }

    db.run("PRAGMA foreign_keys = ON;");
    return db;
  }

  function queryAll(sql, params = []) {
    if (!db) throw new Error("Database not initialized yet.");
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  function runSql(sql, params = [], persist = true) {
    if (!db) throw new Error("Database not initialized yet.");
    db.run(sql, params);
    if (persist) {
      saveToLocalStorage();
    }
  }

  function runBatch(statements, persist = true) {
    if (!db) throw new Error("Database not initialized yet.");
    db.run("BEGIN TRANSACTION;");
    try {
      for (const { sql, params = [] } of statements) {
        db.run(sql, params);
      }
      db.run("COMMIT;");
    } catch (err) {
      db.run("ROLLBACK;");
      throw err;
    }
    if (persist) {
      saveToLocalStorage();
    }
  }

  function saveToLocalStorage() {
    if (!db) return;
    const bytes = db.export();
    localStorage.setItem(STORAGE_KEY, uint8ArrayToBase64(bytes));
  }

  async function resetFromSourceDb() {
    localStorage.removeItem(STORAGE_KEY);
    db = null;
    const response = await fetch(DB_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to reload ${DB_URL} (${response.status})`);
    }
    const buffer = await response.arrayBuffer();
    db = new SQL.Database(new Uint8Array(buffer));
    db.run("PRAGMA foreign_keys = ON;");
    saveToLocalStorage();
    return db;
  }

  function downloadDbFile(filename = "roster_404_creatives_updated.db") {
    if (!db) return;
    const bytes = db.export();
    const blob = new Blob([bytes], { type: "application/x-sqlite3" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function uint8ArrayToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  
  function runInTransaction(fn, persist = true) {
    if (!db) throw new Error("Database not initialized yet.");
    db.run("BEGIN TRANSACTION;");
    try {
      const result = fn(db);
      db.run("COMMIT;");
      if (persist) {
        saveToLocalStorage();
      }
      return result;
    } catch (err) {
      try {
        db.run("ROLLBACK;");
      } catch (_) {
        // Ignore rollback errors if transaction already closed
      }
      throw err;
    }
  }
  
  return {
    init,
    queryAll,
    runSql,
    runBatch,
    saveToLocalStorage,
    resetFromSourceDb,
    downloadDbFile,
    runInTransaction
  };
})();