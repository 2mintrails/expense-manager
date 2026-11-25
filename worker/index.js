// Expense Manager server (Cloudflare Worker + one SQLite-backed Durable Object).
// The Worker checks the PIN and passes requests to the Store, which keeps
// all expenses and categories in its own private SQLite database.
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CATEGORIES = ["Travel", "Rent", "Food", "Groceries", "Domestic Help", "Bills", "Shopping", "Health"];
const MODES = ["UPI", "Card", "Cash"];
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
      name TEXT PRIMARY KEY, budget INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    const n = this.sql.exec(`SELECT COUNT(*) AS n FROM categories`).one().n;
    if (n === 0) {
      DEFAULT_CATEGORIES.forEach((name, i) =>
        this.sql.exec(`INSERT INTO categories (name, budget, pos) VALUES (?, 0, ?)`, name, i));
    }
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

  listCategories() {
    return this.sql.exec(`SELECT name, budget FROM categories ORDER BY pos`).toArray();
  }
  saveCategories(list) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM categories`);
      list.forEach((c, i) => this.sql.exec(`INSERT INTO categories (name, budget, pos) VALUES (?, ?, ?)`, c.name, c.budget, i));
    });
    return this.listCategories();
  }

  listExpenses(from, to) {
    return this.sql.exec(`SELECT id, ts, amount, category, mode, note FROM expenses
      WHERE ts >= ? AND ts < ? ORDER BY ts DESC`, from, to).toArray();
  }
  addExpense(e) {
    // Same id twice (an offline retry) just overwrites, so nothing is doubled.
    this.sql.exec(`INSERT INTO expenses (id, ts, amount, category, mode, note) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, amount = excluded.amount, category = excluded.category,
      mode = excluded.mode, note = excluded.note`, e.id, e.ts, e.amount, e.category, e.mode, e.note);
    return e;
  }
  deleteExpense(id) {
    this.sql.exec(`DELETE FROM expenses WHERE id = ?`, id);
    return true;
  }
  allExpenses() {
    return this.sql.exec(`SELECT id, ts, amount, category, mode, note FROM expenses ORDER BY ts`).toArray();
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
  const mode = MODES.includes(body.mode) ? body.mode : null;
  if (!id || !category || !mode) return null;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return null;
  if (!Number.isFinite(ts) || ts < 946684800000 || ts > Date.now() + 366 * 864e5) return null;
  return { id, ts, amount, category, mode, note: cleanText(body.note, 120) };
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

      if (path === "/api/categories" && request.method === "GET")
        return json(await store.listCategories(), 200, headers);
      if (path === "/api/categories" && request.method === "PUT") {
        const list = validCategories(await request.json());
        if (!list) return json({ error: "bad categories" }, 400, headers);
        return json(await store.saveCategories(list), 200, headers);
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
        const lines = ["date,time,amount,category,mode,note"];
        for (const r of rows) {
          const d = new Date(r.ts + 5.5 * 3600 * 1000); // shown in India time
          const iso = d.toISOString();
          lines.push([iso.slice(0, 10), iso.slice(11, 16), r.amount, r.category, r.mode, r.note].map(csvCell).join(","));
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
