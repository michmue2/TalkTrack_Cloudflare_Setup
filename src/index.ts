/**
 * VoiceCost Tracker – Cloudflare Worker
 *
 * Authenticated write endpoints (iOS app):
 *   POST /sync            Authorization: Bearer <supabase-jwt>
 *   POST /users           Authorization: Bearer <supabase-jwt>
 *   GET  /users/me        Authorization: Bearer <supabase-jwt>
 *   POST /ai/proxy        Authorization: Bearer <supabase-jwt>
 *
 * Read endpoints (AI agents / dashboards):
 *   GET  /ai/usage        Authorization: Bearer <READ_API_KEY>
 *   GET  /expenses        Authorization: Bearer <READ_API_KEY>
 *   GET  /expenses/:id
 *   GET  /categories
 *   GET  /budgets
 *   GET  /recurring
 *   GET  /summary
 *   GET  /export/csv
 */

export interface Env {
    DB: D1Database;
    READ_API_KEY: string;
    SUPABASE_URL: string;
    OPENROUTER_API_KEY: string;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function corsHeaders(): HeadersInit {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
}

function authRead(req: Request, env: Env): boolean {
    const auth = req.headers.get("Authorization") ?? "";
    return auth === `Bearer ${env.READ_API_KEY}`;
}

function base64UrlDecode(str: string): Uint8Array {
    const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, c => c.charCodeAt(0));
}

// Module-level JWKS cache (survives warm worker re-use, refreshes hourly)
let jwksCache: JsonWebKey[] | null = null;
let jwksCacheTime = 0;
const JWKS_TTL_MS = 3_600_000; // 1 hour

async function getJWKS(supabaseUrl: string): Promise<JsonWebKey[]> {
    const now = Date.now();
    if (jwksCache && now - jwksCacheTime < JWKS_TTL_MS) return jwksCache;
    const res = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const { keys } = await res.json() as { keys: JsonWebKey[] };
    jwksCache = keys;
    jwksCacheTime = now;
    return keys;
}

/** Verifies a Supabase JWT (RS256 via JWKS). Returns the user's UUID or null if invalid. */
async function verifyUserJWT(req: Request, env: Env): Promise<string | null> {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return null;
    const token = auth.slice(7);
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;
    try {
        const header  = JSON.parse(atob(headerB64.replace(/-/g, "+").replace(/_/g, "/")));
        const keys    = await getJWKS(env.SUPABASE_URL);
        const jwk     = keys.find(k => !header.kid || k.kid === header.kid) ?? keys[0];
        if (!jwk) return null;
        const isEC     = (jwk as { kty?: string }).kty === "EC";
        const importAlg = isEC
            ? { name: "ECDSA", namedCurve: "P-256" }
            : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
        const verifyAlg = isEC
            ? { name: "ECDSA", hash: "SHA-256" }
            : "RSASSA-PKCS1-v1_5";
        const key     = await crypto.subtle.importKey(
            "jwk", jwk as JsonWebKey, importAlg, false, ["verify"]
        );
        const sigBytes = base64UrlDecode(signatureB64);
        const msgBytes = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
        const valid    = await crypto.subtle.verify(verifyAlg, key, sigBytes, msgBytes);
        if (!valid) return null;
        const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
        if (payload.exp && payload.exp < Date.now() / 1000) return null;
        if (payload.aud !== "authenticated") return null;
        return (payload.sub as string) ?? null;
    } catch {
        return null;
    }
}

function toCSV(headers: string[], rows: (string | number | null)[][]): string {
    const escape = (v: string | number | null): string => {
        const s = String(v ?? "");
        return s.includes(",") || s.includes('"') || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [headers, ...rows].map(row => row.map(escape).join(",")).join("\n");
}

// ─── router ──────────────────────────────────────────────────────────────────

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        try {
            return await handleRequest(request, env);
        } catch (err) {
            console.error("Unhandled worker error:", err);
            return json({ error: "Internal server error" }, 500);
        }
    },
} satisfies ExportedHandler<Env>;

async function handleRequest(request: Request, env: Env): Promise<Response> {
        const url    = new URL(request.url);
        const path   = url.pathname.replace(/\/$/, "") || "/";
        const method = request.method;

        if (method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

        // ── Authenticated write endpoints ──
        if (method === "POST" && path === "/sync") {
            const userID = await verifyUserJWT(request, env);
            if (!userID) return json({ error: "Unauthorized" }, 401);
            return handleSync(request, env, userID);
        }

        if (method === "POST" && path === "/users") {
            const userID = await verifyUserJWT(request, env);
            if (!userID) return json({ error: "Unauthorized" }, 401);
            return handleCreateUser(env, userID);
        }

        if (method === "GET" && path === "/users/me") {
            const userID = await verifyUserJWT(request, env);
            if (!userID) return json({ error: "Unauthorized" }, 401);
            return handleGetUser(env, userID);
        }

        if (method === "POST" && path === "/ai/proxy") {
            const userID = await verifyUserJWT(request, env);
            if (!userID) return json({ error: "Unauthorized" }, 401);
            return handleAIProxy(request, env, userID);
        }

        // ── Read endpoints (external tools) ──
        if (method !== "GET") return json({ error: "Method not allowed" }, 405);
        if (!authRead(request, env)) return json({ error: "Unauthorized" }, 401);

        if (path === "/expenses")          return handleExpenses(url, env);
        if (path.match(/^\/expenses\/.+/)) return handleExpense(path, env);
        if (path === "/categories")        return handleCategories(env);
        if (path === "/budgets")           return handleBudgets(url, env);
        if (path === "/recurring")         return handleRecurring(env);
        if (path === "/summary")           return handleSummary(url, env);
        if (path === "/export/csv")        return handleCSVExport(env);
        if (path === "/ai/usage")          return handleAIUsage(url, env);

        return json({ error: "Not found" }, 404);
}

// ─── POST /users ──────────────────────────────────────────────────────────────

async function handleCreateUser(env: Env, userID: string): Promise<Response> {
    const now = new Date().toISOString();
    await env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, trial_start_at, created_at) VALUES (?, ?, ?)`
    ).bind(userID, now, now).run();
    const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(userID).first();
    return json(user, 201);
}

// ─── POST /ai/proxy ───────────────────────────────────────────────────────────

const AI_PROXY_DAILY_LIMIT = 100;

async function handleAIProxy(request: Request, env: Env, userID: string): Promise<Response> {
    let body: unknown;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid JSON" }, 400); }

    // ── Per-user daily rate limit ──────────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" UTC
    const row = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM ai_requests WHERE user_id = ? AND created_at >= ?`
    ).bind(userID, `${today}T00:00:00.000Z`).first<{ count: number }>();

    const usedToday = row?.count ?? 0;
    if (usedToday >= AI_PROXY_DAILY_LIMIT) {
        console.warn(`[ai/proxy] rate limit hit user=${userID} used=${usedToday}`);
        return json({
            error: "Daily limit reached",
            limit: AI_PROXY_DAILY_LIMIT,
            used: usedToday,
            resets_at: `${today}T24:00:00Z`,
        }, 429);
    }

    const model = (body as Record<string,unknown>)?.model as string ?? "unknown";
    console.log(`[ai/proxy] user=${userID} model=${model} used=${usedToday + 1}/${AI_PROXY_DAILY_LIMIT}`);

    // Record request (fire-and-forget, don't block the response)
    const now = new Date().toISOString();
    env.DB.prepare(`INSERT INTO ai_requests (user_id, model, created_at) VALUES (?, ?, ?)`)
        .bind(userID, model, now).run().catch(e => console.error("[ai/proxy] log error:", e));

    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
            "x-title": "TalkTrack",
        },
        body: JSON.stringify(body),
    });

    const data = await upstream.json() as Record<string, unknown>;
    if (upstream.status >= 400) {
        console.error(`[ai/proxy] upstream error ${upstream.status}:`, JSON.stringify(data).slice(0, 300));
    }
    return json(data, upstream.status);
}

// ─── GET /users/me ────────────────────────────────────────────────────────────

async function handleGetUser(env: Env, userID: string): Promise<Response> {
    const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(userID).first();
    if (!user) return json({ error: "User not found" }, 404);
    return json(user);
}

// ─── POST /sync ───────────────────────────────────────────────────────────────

async function handleSync(request: Request, env: Env, userID: string): Promise<Response> {
    type SyncPayload = {
        expenses:         Record<string, unknown>[];
        categories:       Record<string, unknown>[];
        budget_defaults:  Record<string, unknown>[];
        budget_overrides: Record<string, unknown>[];
        recurring:        Record<string, unknown>[];
    };

    let body: SyncPayload;
    try {
        body = await request.json() as SyncPayload;
    } catch {
        return json({ error: "Invalid JSON" }, 400);
    }

    const now = new Date().toISOString();
    const db  = env.DB;

    // Helper: execute statements in batches of 100 (D1 batch limit).
    // Each db.batch() call counts as ONE subrequest — critical for free-plan limits.
    async function runBatches(stmts: D1PreparedStatement[]): Promise<void> {
        if (stmts.length === 0) return;
        for (let i = 0; i < stmts.length; i += 100) {
            await db.batch(stmts.slice(i, i + 100));
        }
    }

    // 1. Wipe all existing data for this user so the DB reflects the app exactly.
    //    Delete child tables (which have category_id FKs) BEFORE categories.
    await db.batch([
        db.prepare(`DELETE FROM expenses         WHERE user_id = ?`).bind(userID),
        db.prepare(`DELETE FROM budget_defaults  WHERE user_id = ?`).bind(userID),
        db.prepare(`DELETE FROM budget_overrides WHERE user_id = ?`).bind(userID),
        db.prepare(`DELETE FROM recurring        WHERE user_id = ?`).bind(userID),
        db.prepare(`DELETE FROM categories       WHERE user_id = ?`).bind(userID),
    ]);

    // 2. Insert fresh categories
    await runBatches((body.categories ?? []).map(c =>
        db.prepare(
            `INSERT INTO categories (id, user_id, name, icon, is_default, sort_order)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(c.id, userID, c.name, c.icon, c.is_default, c.sort_order)
    ));

    // 3. Insert fresh expenses
    await runBatches((body.expenses ?? []).map(e =>
        db.prepare(
            `INSERT INTO expenses
             (id, user_id, amount, note, category_id, date, created_at, raw_transcript,
              status, source, categorization_source, recurring_expense_id,
              account_id, account_name, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            e.id, userID, e.amount, e.note, e.category_id ?? null, e.date, e.created_at,
            e.raw_transcript ?? "", e.status, e.source, e.categorization_source,
            e.recurring_expense_id ?? null, e.account_id ?? null, e.account_name ?? null, now
        )
    ));

    // 4. Insert fresh budget defaults
    await runBatches((body.budget_defaults ?? []).map(b =>
        db.prepare(
            `INSERT INTO budget_defaults
             (id, user_id, category_id, monthly_amount, effective_from, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(b.id, userID, b.category_id ?? null, b.monthly_amount, b.effective_from, b.created_at)
    ));

    // 5. Insert fresh budget overrides
    await runBatches((body.budget_overrides ?? []).map(b =>
        db.prepare(
            `INSERT INTO budget_overrides
             (id, user_id, category_id, monthly_amount, year, month, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(b.id, userID, b.category_id ?? null, b.monthly_amount, b.year, b.month, b.created_at)
    ));

    // 6. Insert fresh recurring expenses
    await runBatches((body.recurring ?? []).map(r =>
        db.prepare(
            `INSERT INTO recurring
             (id, user_id, amount, note, category_id, cadence, start_date, end_date,
              last_generated_date, is_active, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            r.id, userID, r.amount, r.note, r.category_id ?? null, r.cadence,
            r.start_date, r.end_date ?? null, r.last_generated_date ?? null,
            r.is_active, r.created_at
        )
    ));

    return json({ ok: true, synced_at: now });
}

// ─── GET /ai/usage ────────────────────────────────────────────────────────────

async function handleAIUsage(url: URL, env: Env): Promise<Response> {
    const since = url.searchParams.get("since"); // optional YYYY-MM-DD filter

    const where = since ? "WHERE created_at >= ?" : "";
    const params = since ? [since] : [];

    const { results } = await env.DB.prepare(`
        SELECT user_id,
               COUNT(*)         AS total_requests,
               COUNT(DISTINCT DATE(created_at)) AS active_days,
               MIN(created_at)  AS first_request,
               MAX(created_at)  AS last_request
        FROM ai_requests
        ${where}
        GROUP BY user_id
        ORDER BY total_requests DESC
    `).bind(...params).all();

    const totalsRow = await env.DB.prepare(`
        SELECT COUNT(*) AS total FROM ai_requests ${where}
    `).bind(...params).first<{ total: number }>();

    return json({ total_requests: totalsRow?.total ?? 0, users: results, since: since ?? "all-time" });
}

// ─── GET /expenses ────────────────────────────────────────────────────────────

async function handleExpenses(url: URL, env: Env): Promise<Response> {
    const from     = url.searchParams.get("from");
    const to       = url.searchParams.get("to");
    const category = url.searchParams.get("category");
    const status   = url.searchParams.get("status");
    const account  = url.searchParams.get("account");
    const limit    = Math.min(parseInt(url.searchParams.get("limit")  ?? "500"), 1000);
    const offset   = parseInt(url.searchParams.get("offset") ?? "0");

    const where: string[]             = ["1=1"];
    const params: (string | number)[] = [];

    if (from)     { where.push("e.date >= ?");        params.push(from); }
    if (to)       { where.push("e.date <= ?");        params.push(to); }
    if (category) { where.push("c.name = ?");         params.push(category); }
    if (status)   { where.push("e.status = ?");       params.push(status); }
    if (account)  { where.push("e.account_name = ?"); params.push(account); }

    params.push(limit, offset);

    const { results } = await env.DB.prepare(`
        SELECT e.*, c.name AS category_name, c.icon AS category_icon
        FROM expenses e
        LEFT JOIN categories c ON e.category_id = c.id
        WHERE ${where.join(" AND ")}
        ORDER BY e.date DESC
        LIMIT ? OFFSET ?
    `).bind(...params).all();

    return json({ expenses: results, count: results.length, limit, offset });
}

// ─── GET /expenses/:id ────────────────────────────────────────────────────────

async function handleExpense(path: string, env: Env): Promise<Response> {
    const id = path.split("/").pop();
    const row = await env.DB.prepare(`
        SELECT e.*, c.name AS category_name, c.icon AS category_icon
        FROM expenses e
        LEFT JOIN categories c ON e.category_id = c.id
        WHERE e.id = ?
    `).bind(id).first();
    if (!row) return json({ error: "Not found" }, 404);
    return json(row);
}

// ─── GET /categories ──────────────────────────────────────────────────────────

async function handleCategories(env: Env): Promise<Response> {
    const { results } = await env.DB.prepare(
        "SELECT * FROM categories ORDER BY sort_order"
    ).all();
    return json({ categories: results });
}

// ─── GET /budgets ─────────────────────────────────────────────────────────────

async function handleBudgets(url: URL, env: Env): Promise<Response> {
    const year  = url.searchParams.get("year");
    const month = url.searchParams.get("month");

    const { results: defaults } = await env.DB.prepare(`
        SELECT bd.*, c.name AS category_name
        FROM budget_defaults bd
        LEFT JOIN categories c ON bd.category_id = c.id
        ORDER BY bd.effective_from DESC
    `).all();

    let overrides: unknown[] = [];
    if (year && month) {
        const { results } = await env.DB.prepare(`
            SELECT bo.*, c.name AS category_name
            FROM budget_overrides bo
            LEFT JOIN categories c ON bo.category_id = c.id
            WHERE bo.year = ? AND bo.month = ?
        `).bind(parseInt(year), parseInt(month)).all();
        overrides = results;
    }

    return json({ budget_defaults: defaults, budget_overrides: overrides });
}

// ─── GET /recurring ───────────────────────────────────────────────────────────

async function handleRecurring(env: Env): Promise<Response> {
    const { results } = await env.DB.prepare(`
        SELECT r.*, c.name AS category_name
        FROM recurring r
        LEFT JOIN categories c ON r.category_id = c.id
        ORDER BY r.start_date DESC
    `).all();
    return json({ recurring: results });
}

// ─── GET /summary ─────────────────────────────────────────────────────────────

async function handleSummary(url: URL, env: Env): Promise<Response> {
    const monthParam = url.searchParams.get("month");
    let dateFilter = "";
    const dateParams: string[] = [];

    if (monthParam) {
        const [y, m] = monthParam.split("-").map(Number);
        const start  = `${y}-${String(m).padStart(2, "0")}-01`;
        const end    = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
        dateFilter = "AND e.date >= ? AND e.date < ?";
        dateParams.push(start, end);
    }

    const { results: byCategory } = await env.DB.prepare(`
        SELECT c.name AS category, SUM(e.amount) AS total, COUNT(*) AS count
        FROM expenses e
        LEFT JOIN categories c ON e.category_id = c.id
        WHERE e.status = 'confirmed' ${dateFilter}
        GROUP BY e.category_id
        ORDER BY total DESC
    `).bind(...dateParams).all();

    const totalsRow = await env.DB.prepare(`
        SELECT SUM(e.amount) AS total, COUNT(*) AS count
        FROM expenses e
        WHERE e.status = 'confirmed' ${dateFilter}
    `).bind(...dateParams).first<{ total: number; count: number }>();

    let budgets: unknown[] = [];
    if (monthParam) {
        const [y, m] = monthParam.split("-").map(Number);
        const { results } = await env.DB.prepare(`
            SELECT c.name AS category,
                COALESCE(
                    (SELECT bo.monthly_amount FROM budget_overrides bo
                     WHERE bo.category_id = c.id AND bo.year = ? AND bo.month = ? LIMIT 1),
                    (SELECT bd.monthly_amount FROM budget_defaults bd
                     WHERE bd.category_id = c.id ORDER BY bd.effective_from DESC LIMIT 1)
                ) AS budget
            FROM categories c
        `).bind(y, m).all();
        budgets = results;
    }

    return json({ month: monthParam ?? "all-time", total: totalsRow?.total ?? 0,
        count: totalsRow?.count ?? 0, by_category: byCategory, budgets });
}

// ─── GET /export/csv ──────────────────────────────────────────────────────────

async function handleCSVExport(env: Env): Promise<Response> {
    const { results: expenses } = await env.DB.prepare(`
        SELECT e.*, c.name AS category_name FROM expenses e
        LEFT JOIN categories c ON e.category_id = c.id ORDER BY e.date DESC
    `).all<Record<string, unknown>>();

    const { results: budgetDefaults } = await env.DB.prepare(`
        SELECT bd.*, c.name AS category_name FROM budget_defaults bd
        LEFT JOIN categories c ON bd.category_id = c.id
    `).all<Record<string, unknown>>();

    const { results: budgetOverrides } = await env.DB.prepare(`
        SELECT bo.*, c.name AS category_name FROM budget_overrides bo
        LEFT JOIN categories c ON bo.category_id = c.id
    `).all<Record<string, unknown>>();

    const { results: recurring } = await env.DB.prepare(`
        SELECT r.*, c.name AS category_name FROM recurring r
        LEFT JOIN categories c ON r.category_id = c.id
    `).all<Record<string, unknown>>();

    const expensesCSV = toCSV(
        ["id", "date", "amount", "category", "note", "status", "source", "created_at"],
        expenses.map(e => [e.id, e.date, e.amount, e.category_name ?? "", e.note, e.status, e.source, e.created_at] as (string | number | null)[])
    );
    const budgetsCSV = toCSV(
        ["id", "type", "category", "monthly_amount", "effective_from", "year", "month"],
        [
            ...budgetDefaults.map(b => [b.id, "default", b.category_name ?? "", b.monthly_amount, b.effective_from, "", ""] as (string | number | null)[]),
            ...budgetOverrides.map(b => [b.id, "override", b.category_name ?? "", b.monthly_amount, "", b.year, b.month] as (string | number | null)[]),
        ]
    );
    const recurringCSV = toCSV(
        ["id", "note", "category", "amount", "cadence", "start_date", "end_date", "is_active"],
        recurring.map(r => [r.id, r.note, r.category_name ?? "", r.amount, r.cadence, r.start_date, r.end_date ?? "", r.is_active] as (string | number | null)[])
    );

    const today    = new Date().toISOString().split("T")[0];
    const combined = `=== EXPENSES ===\n${expensesCSV}\n\n=== BUDGETS ===\n${budgetsCSV}\n\n=== RECURRING ===\n${recurringCSV}`;

    return new Response(combined, {
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="voicecost-export-${today}.csv"`,
            ...corsHeaders(),
        },
    });
}
