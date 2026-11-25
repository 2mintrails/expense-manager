// Expense Manager server (Cloudflare Worker + one SQLite-backed Durable Object).
// The Worker checks the PIN and passes requests to the Store, which keeps
// all expenses and categories in its own private SQLite database.
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CATEGORIES = ["Travel", "Rent", "Food", "Groceries", "Domestic Help", "Bills", "Shopping", "Health"];
const DEFAULT_INCOME = ["Salary", "Freelance", "Interest", "Other"];
const KINDS = ["expense", "income"];
const MODES = ["UPI", "Credit card", "Debit card", "Cash", "Auto-debit"];
const MAX_FAILS = 8;               // wrong PINs allowed before a lockout
const LOCK_MS = 15 * 60 * 1000;    // lockout length

export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, amount INTEGER NOT NULL,
      category TEXT NOT NULL, mode TEXT NOT NULL, note TEXT NOT NULL DEFAULT '')`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS expenses_ts ON expenses (ts)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS categories (
      name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'expense', budget INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL, PRIMARY KEY (kind, name))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    // v2: income. Each entry and category gets a kind ("expense" or "income").
    const hasKind = (t) => this.sql.exec(`PRAGMA table_info(${t})`).toArray().some((c) => c.name === "kind");
    if (!hasKind("expenses")) this.sql.exec(`ALTER TABLE expenses ADD COLUMN kind TEXT NOT NULL DEFAULT 'expense'`);
    if (!hasKind("categories")) {
      // a category name may now exist once per kind
      this.sql.exec(`CREATE TABLE categories2 (name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'expense',
        budget INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL, PRIMARY KEY (kind, name))`);
      this.sql.exec(`INSERT INTO categories2 (name, kind, budget, pos) SELECT name, 'expense', budget, pos FROM categories`);
      this.sql.exec(`DROP TABLE categories`);
      this.sql.exec(`ALTER TABLE categories2 RENAME TO categories`);
    }
    const seed = (kind, names) => {
      const n = this.sql.exec(`SELECT COUNT(*) AS n FROM categories WHERE kind = ?`, kind).one().n;
      if (n === 0) names.forEach((name, i) =>
        this.sql.exec(`INSERT INTO categories (name, kind, budget, pos) VALUES (?, ?, 0, ?)`, name, kind, i));
    };
    // v3: "Card" was split into Credit card / Debit card; old card entries were debit.
    this.sql.exec(`UPDATE expenses SET mode = 'Debit card' WHERE mode = 'Card'`);
    seed("expense", DEFAULT_CATEGORIES);
    seed("income", DEFAULT_INCOME);
  }

  meta(k, fallback) {
    const row = this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0];
    return row ? row.v : fallback;
  }
  setMeta(k, v) {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, String(v));
  }

  // Returns "ok", "wrong" or "locked". `match` is computed by the Worker.
  recordPin(match, now) {
    const lockUntil = Number(this.meta("lockUntil", 0));
    if (lockUntil > now) return "locked";
    if (match) { this.setMeta("fails", 0); return "ok"; }
    const fails = Number(this.meta("fails", 0)) + 1;
    if (fails >= MAX_FAILS) { this.setMeta("fails", 0); this.setMeta("lockUntil", now + LOCK_MS); return "locked"; }
    this.setMeta("fails", fails);
    return "wrong";
  }

  listCategories(kind) {
    return this.sql.exec(`SELECT name, budget FROM categories WHERE kind = ? ORDER BY pos`, kind).toArray();
  }
  saveCategories(kind, list) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM categories WHERE kind = ?`, kind);
      list.forEach((c, i) => this.sql.exec(`INSERT INTO categories (name, kind, budget, pos) VALUES (?, ?, ?, ?)`, c.name, kind, c.budget, i));
    });
    return this.listCategories(kind);
  }

  listExpenses(from, to) {
    return this.sql.exec(`SELECT id, ts, amount, category, mode, note, kind FROM expenses
      WHERE ts >= ? AND ts < ? ORDER BY ts DESC`, from, to).toArray();
  }
  addExpense(e) {
    // Same id twice (an offline retry) just overwrites, so nothing is doubled.
    this.sql.exec(`INSERT INTO expenses (id, ts, amount, category, mode, note, kind) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, amount = excluded.amount, category = excluded.category,
      mode = excluded.mode, note = excluded.note, kind = excluded.kind`, e.id, e.ts, e.amount, e.category, e.mode, e.note, e.kind);
    return e;
  }
  deleteExpense(id) {
    this.sql.exec(`DELETE FROM expenses WHERE id = ?`, id);
    return true;
  }
  allExpenses() {
    return this.sql.exec(`SELECT id, ts, amount, category, mode, note, kind FROM expenses ORDER BY ts`).toArray();
  }
}

// ---------- helpers ----------
function cors(env, origin) {
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "null",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-PIN",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
async function pinMatches(given, real) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(given))),
    crypto.subtle.digest("SHA-256", enc.encode(String(real))),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
function cleanText(s, max) {
  return String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}
function validExpense(body) {
  const amount = Math.round(Number(body.amount));
  const ts = Math.round(Number(body.ts));
  const id = cleanText(body.id, 64);
  const category = cleanText(body.category, 40);
  const kind = KINDS.includes(body.kind) ? body.kind : "expense";
  const m = body.mode === "Card" ? "Debit card" : body.mode; // older app versions
  const mode = kind === "income" ? "" : MODES.includes(m) ? m : null;
  if (!id || !category || mode === null) return null;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return null;
  if (!Number.isFinite(ts) || ts < 946684800000 || ts > Date.now() + 366 * 864e5) return null;
  return { id, ts, amount, category, mode, note: cleanText(body.note, 120), kind };
}
function validCategories(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > 50) return null;
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const name = cleanText(c && c.name, 40);
    const budget = Math.round(Number(c && c.budget) || 0);
    if (!name || seen.has(name.toLowerCase()) || budget < 0 || budget > 100000000) return null;
    seen.add(name.toLowerCase());
    out.push({ name, budget });
  }
  return out;
}
function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------- the Worker ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = cors(env, request.headers.get("Origin") || "");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (!url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404, headers);
    if (!env.APP_PIN) return json({ error: "server has no PIN set" }, 500, headers);

    const store = env.STORE.get(env.STORE.idFromName("me"));
    const match = await pinMatches(request.headers.get("X-PIN") || "", env.APP_PIN);
    const pinState = await store.recordPin(match, Date.now());
    if (pinState === "locked") return json({ error: "locked", message: "Too many wrong PINs. Try again in 15 minutes." }, 429, headers);
    if (pinState !== "ok") return json({ error: "wrong pin" }, 401, headers);

    const path = url.pathname;
    try {
      if (path === "/api/ping" && request.method === "GET") return json({ ok: true }, 200, headers);

      const kind = KINDS.includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : "expense";
      if (path === "/api/categories" && request.method === "GET")
        return json(await store.listCategories(kind), 200, headers);
      if (path === "/api/categories" && request.method === "PUT") {
        const list = validCategories(await request.json());
        if (!list) return json({ error: "bad categories" }, 400, headers);
        return json(await store.saveCategories(kind, list), 200, headers);
      }

      if (path === "/api/expenses" && request.method === "GET") {
        const from = Number(url.searchParams.get("from"));
        const to = Number(url.searchParams.get("to"));
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return json({ error: "bad range" }, 400, headers);
        return json(await store.listExpenses(from, to), 200, headers);
      }
      if (path === "/api/expenses" && request.method === "POST") {
        const e = validExpense(await request.json());
        if (!e) return json({ error: "bad expense" }, 400, headers);
        return json(await store.addExpense(e), 200, headers);
      }
      const del = path.match(/^\/api\/expenses\/([A-Za-z0-9-]{1,64})$/);
      if (del && request.method === "DELETE") {
        await store.deleteExpense(del[1]);
        return json({ ok: true }, 200, headers);
      }

      if (path === "/api/export" && request.method === "GET") {
        const rows = await store.allExpenses();
        const lines = ["date,time,type,amount,category,mode,note"];
        for (const r of rows) {
          const d = new Date(r.ts + 5.5 * 3600 * 1000); // shown in India time
          const iso = d.toISOString();
          lines.push([iso.slice(0, 10), iso.slice(11, 16), r.kind, r.amount, r.category, r.mode, r.note].map(csvCell).join(","));
        }
        return new Response(lines.join("\n") + "\n", {
          status: 200,
          headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="expenses.csv"' },
        });
      }
      return json({ error: "not found" }, 404, headers);
    } catch (err) {
      return json({ error: "server error" }, 500, headers);
    }
  },
};
