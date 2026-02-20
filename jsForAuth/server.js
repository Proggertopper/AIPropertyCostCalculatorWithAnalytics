require("dotenv").config();
const db = require("./db");
const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const fs = require("fs/promises");
const PDFDocument = require("pdfkit");
const helmet = require("helmet");
const path = require("path");

const pgSession = require("connect-pg-simple")(session);
const tokens = require("./tokens");
const authRoutes = require("./auth"); 
const calcRoutes = require("./calculator");

const registerFacebookRoutes = require("./facebook");
const registerGoogleRoutes = require("./google");
const contactRoutes = require("./contactUs");
const makeRateLimit = require("./rateLimit");
const { buildScenarios, buildMortgageScenarios, buildRentVsBuyScenarios, buildBreakEvenScenarios, buildCashFlowScenarios, buildIRRScenarios, buildRenovationRoiScenarios , buildPropertySaleScenarios , buildPropertyTaxesScenarios,
    buildOwnershipCostScenarios, buildAlternativeInvestmentScenarios , buildMortgageOverpaymentScenarios,  MINI_TEXT } = require("./scenarioEngine");
const { computeResultByType } = require("./compute");
const { CALC_FORMATS } = require("./calcFormats");
const {
    runOpenAiChat,
    getOpenAiQueueStats,
    enqueueOpenAiChat,
    getOpenAiJobStatus,
    chatJobIdFromDedupKey
} = require("./aiQueue");

// const registerAppleRoutes = require("./apple");


const { RedisStore } = require("connect-redis");
const redisClient = require("./redis");
const rl = makeRateLimit(redisClient);
 
const app = express();

function resolveTrustProxy() {
    const raw = process.env.TRUST_PROXY;
    if (raw == null || raw === "") {
        // Typical production chain for this app is: LB -> Nginx -> Node.
        // Trusting 2 hops preserves real client IP for req.ip/rate limits.
        return process.env.NODE_ENV === "production" ? 2 : false;
    }
    const v = String(raw).trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
    if (/^\d+$/.test(v)) return Number(v);
    return raw;
}

app.set("trust proxy", resolveTrustProxy());


const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1'; 

if (process.env.NODE_ENV === 'development') {
    app.use(session({
        store: new RedisStore({
            client: redisClient,
            prefix: "sess:"
        }),
        name: "session",
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false, // было true
        proxy: false,
        cookie: {
            httpOnly: true,
            secure: false,        // обязательно в проде
            sameSite: "lax",     // OAuth работает
            maxAge: 1000 * 60 * 60 * 24
        }
    }));
} else if (process.env.NODE_ENV === 'production') {
    app.use(session({
        store: new RedisStore({
            client: redisClient,
            prefix: "sess:"
        }),
        name: "__Host-session",
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        proxy: true,
        cookie: {
            httpOnly: true,
            secure: true,        // обязательно в проде
            sameSite: "lax",     // OAuth работает
            maxAge: 1000 * 60 * 60 * 24
        }
    }));
} 

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

app.use(express.json({
    limit: "10mb",
    verify: (req, res, buf) => {
        if (req.originalUrl.includes("/api/webhooks/paddle") || req.originalUrl.includes("/api/webhooks/nowpayments")) {
            req.rawBody = buf;
        }
    }
}));

function needsCsrfProtection(req) {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(String(req.method || "").toUpperCase())) return false;
    if (!String(req.path || "").startsWith("/api/")) return false;
    if (req.path === "/api/webhooks/paddle") return false;
    if (req.path === "/api/webhooks/nowpayments") return false;
    return true;
}

app.use((req, res, next) => {
    if (!needsCsrfProtection(req)) return next();
    const csrfToken = req.headers["x-csrf-token"];
    const secret = req.session?.csrfSecret;
    if (!secret || !csrfToken || !tokens.verify(secret, csrfToken)) {
        return res.status(403).json({ error: "csrf" });
    }
    return next();
});

const HTML_ROOT = path.join(__dirname, "..", "html");
const templateCache = new Map();

const LEGACY_REDIRECTS = Object.freeze({
    "/mainPage.html": "/",
    "/AboutProject.html": "/about/",
    "/contactUs.html": "/contact/",
    "/allCalculators.html": "/calculators/",
    "/termsOfService.html": "/terms/",
    "/privacyPolicy.html": "/privacy/",
    "/refundPolicy.html": "/refund/",
    "/disclaimer.html": "/disclaimer/",

    "/login.html": "/login/",
    "/register.html": "/signup/",
    "/account.html": "/account/",

    "/mortgage.html": "/mortgage/calculator/",
    "/rentVsBuy.html": "/rent-vs-buy/calculator/",
    "/breakEvenCalc.html": "/break-even/calculator/",
    "/cashFlow.html": "/cash-flow/calculator/",
    "/IRRcalc.html": "/irr/calculator/",
    "/ownership-cost.html": "/homeownership-cost/calculator/",
    "/propertySaleWithInflation.html": "/property-sale/calculator/",
    "/propertyTaxCalculatorWithInflation.html": "/property-tax/calculator/",
    "/realOverpayment.html": "/mortgage-overpayment/calculator/",
    "/renovationCalcWithInflation.html": "/renovation-roi/calculator/",
    "/alternativeInvest.html": "/rent-or-invest/calculator/",

    "/guides.html": "/blog/",
    "/dataDeletion.html": "/privacy/"
});

app.use((req, res, next) => {
    const m = String(req.method || "").toUpperCase();
    if (m !== "GET" && m !== "HEAD") return next();

    const target = LEGACY_REDIRECTS[req.path];
    if (!target) return next();

    const qIndex = req.originalUrl.indexOf("?");
    const query = qIndex >= 0 ? req.originalUrl.slice(qIndex) : "";
    return res.redirect(301, `${target}${query}`);
});


async function loadTemplate(absPath) {
    const cached = templateCache.get(absPath);
    if (cached) return cached;

    const txt = await fs.readFile(absPath, "utf8");
    templateCache.set(absPath, txt);
    return txt;
}

async function aiChatCompletion({ model, temperature, max_tokens, messages, dedupKey }) {
    const out = await runOpenAiChat(
        {
            model: model || "gpt-4o-mini",
            temperature,
            max_tokens,
            messages
        },
        {
            dedupKey: dedupKey ? String(dedupKey) : undefined,
            waitMs: Number(process.env.AI_QUEUE_WAIT_MS || 90000)
        }
    );

    const text = String(out?.text || "").trim();
    if (!text) throw new Error("OpenAI returned empty content");
    return text;
}

let aiJobsTableReady = null;

async function ensureAiJobsTable() {
    if (aiJobsTableReady) return aiJobsTableReady;
    aiJobsTableReady = (async () => {
        await db.query(`
      create table if not exists ai_jobs (
        id bigserial primary key,
        user_id bigint not null references users(id) on delete cascade,
        job_id text not null unique,
        kind text not null,
        status text not null default 'queued',
        payload jsonb,
        result jsonb,
        error text,
        reserved_credits integer not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
        await db.query(`create index if not exists idx_ai_jobs_user_created on ai_jobs(user_id, created_at desc)`);
        await db.query(`create index if not exists idx_ai_jobs_status_created on ai_jobs(status, created_at desc)`);
    })().catch((e) => {
        aiJobsTableReady = null;
        throw e;
    });
    return aiJobsTableReady;
}

async function aiJobInsert({ userId, jobId, kind, status = "queued", payload = null, reservedCredits = 0 }) {
    await ensureAiJobsTable();
    await db.query(
        `insert into ai_jobs(user_id, job_id, kind, status, payload, reserved_credits, updated_at)
     values($1,$2,$3,$4,$5::jsonb,$6,now())
     on conflict (job_id) do update
     set user_id=excluded.user_id,
         kind=excluded.kind,
         status=excluded.status,
         payload=excluded.payload,
         reserved_credits=excluded.reserved_credits,
         updated_at=now()`,
        [userId, String(jobId), String(kind), String(status), payload ? JSON.stringify(payload) : null, Number(reservedCredits || 0)]
    );
}

async function aiJobGet(userId, jobId) {
    await ensureAiJobsTable();
    const r = await db.query(
        `select id, user_id, job_id, kind, status, payload, result, error, reserved_credits, created_at, updated_at
     from ai_jobs
     where user_id=$1 and job_id=$2
     limit 1`,
        [userId, String(jobId)]
    );
    return r.rowCount ? r.rows[0] : null;
}

async function aiJobUpdate(userId, jobId, patch = {}) {
    await ensureAiJobsTable();

    const fields = [];
    const vals = [];
    let idx = 1;

    if (patch.status !== undefined) {
        fields.push(`status=$${idx++}`);
        vals.push(String(patch.status));
    }
    if (patch.payload !== undefined) {
        fields.push(`payload=$${idx++}::jsonb`);
        vals.push(patch.payload ? JSON.stringify(patch.payload) : null);
    }
    if (patch.result !== undefined) {
        fields.push(`result=$${idx++}::jsonb`);
        vals.push(patch.result ? JSON.stringify(patch.result) : null);
    }
    if (patch.error !== undefined) {
        fields.push(`error=$${idx++}`);
        vals.push(patch.error ? String(patch.error) : null);
    }
    if (patch.reserved_credits !== undefined) {
        fields.push(`reserved_credits=$${idx++}`);
        vals.push(Number(patch.reserved_credits || 0));
    }

    if (!fields.length) return;
    fields.push(`updated_at=now()`);
    vals.push(userId, String(jobId));

    await db.query(
        `update ai_jobs set ${fields.join(", ")}
     where user_id=$${idx++} and job_id=$${idx++}`,
        vals
    );
}

async function aiJobTryTransition(userId, jobId, fromStatuses, toStatus) {
    await ensureAiJobsTable();
    const from = Array.isArray(fromStatuses) ? fromStatuses.map((x) => String(x)) : [];
    if (!from.length) return false;
    const r = await db.query(
        `update ai_jobs
     set status=$3, updated_at=now()
     where user_id=$1 and job_id=$2 and status = any($4::text[])
     returning id`,
        [userId, String(jobId), String(toStatus), from]
    );
    return !!r.rowCount;
}

function asyncProcessingEnabled() {
    const raw = String(process.env.AI_ASYNC_ENABLED || "1").trim().toLowerCase();
    return !(raw === "0" || raw === "false" || raw === "off");
}

function toBool(v) {
    if (typeof v === "boolean") return v;
    const s = String(v || "").trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on";
}

function aiJobIdFromDedupKey(dedupKey) {
    return chatJobIdFromDedupKey(dedupKey);
}

function aiQueueAcceptedBody({ jobId, type, wallet, message }) {
    return {
        ok: true,
        status: "queued",
        jobId: String(jobId || ""),
        type: String(type || ""),
        message: String(message || "AI task queued."),
        wallet: wallet || undefined
    };
}

function aiErrorMeta(err) {
    const message = String(err?.message || err || "AI_FAILED").trim() || "AI_FAILED";
    const code = err?.code ? String(err.code) : "";
    const name = err?.name ? String(err.name) : "";
    const marker = `${message} ${code}`.toUpperCase();

    const upstream = message.match(/OpenAI failed \((\d{3})\)/i);
    if (upstream?.[1]) {
        const upstreamStatus = Number(upstream[1]);
        let status = 500;
        if (upstreamStatus === 429) status = 429;
        else if (upstreamStatus >= 500) status = 503;
        else if (upstreamStatus >= 400) status = 400;
        return {
            status,
            error: "OPENAI_UPSTREAM_ERROR",
            message,
            code,
            name,
            upstreamStatus
        };
    }

    if (
        marker.includes("AI_QUEUE_") ||
        marker.includes("BULLMQ") ||
        marker.includes("REDIS") ||
        marker.includes("EAI_AGAIN") ||
        marker.includes("ETIMEDOUT") ||
        marker.includes("ECONNRESET") ||
        marker.includes("ECONNREFUSED") ||
        marker.includes("ENOTFOUND") ||
        marker.includes("EHOSTUNREACH") ||
        marker.includes("ENETUNREACH")
    ) {
        return {
            status: 503,
            error: "AI_QUEUE_ERROR",
            message,
            code,
            name
        };
    }

    if (message === "OPENAI_API_KEY is not configured") {
        return {
            status: 500,
            error: "AI_CONFIG_ERROR",
            message,
            code,
            name
        };
    }

    return {
        status: 500,
        error: "AI_FAILED",
        message,
        code,
        name
    };
}

function sendAiError(res, err, fallbackError = "AI_FAILED") {
    const meta = aiErrorMeta(err);
    const body = {
        error: String(meta.error || fallbackError || "AI_FAILED"),
        message: String(meta.message || "AI_FAILED")
    };

    if (meta.code) body.code = meta.code;
    if (Number.isFinite(Number(meta.upstreamStatus)) && Number(meta.upstreamStatus) > 0) {
        body.upstreamStatus = Number(meta.upstreamStatus);
    }

    if (String(process.env.NODE_ENV || "").trim().toLowerCase() !== "production") {
        if (meta.name) body.name = meta.name;
        if (err?.stack) {
            body.stack = String(err.stack)
                .split("\n")
                .slice(0, 8)
                .join("\n");
        }
    }

    const status = Math.max(400, Math.min(599, Number(meta.status || 500)));
    return res.status(status).json(body);
}


function aiEscapeRegExp(s) {
    return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aiNormalizeText(s) {
    return String(s || "")
        .replace(/\r\n?/g, "\n")
        .replace(/\u00A0/g, " ")
        .trim();
}

function aiCountNumericMentions(text) {
    const t = String(text || "");
    const m = t.match(/[-+]?\$?\d[\d,]*(?:\.\d+)?%?/g);
    return Array.isArray(m) ? m.length : 0;
}

function aiHasSection(text, sectionName) {
    const re = new RegExp(`(^|\\n)\\s*${aiEscapeRegExp(sectionName)}\\s*:`, "i");
    return re.test(String(text || ""));
}

function aiHasTemplateArtifacts(text) {
    const t = String(text || "");
    if (/<[^>\n]{1,120}>/.test(t)) return true;
    if (/(^|\n)\s*-\s*\.\.\.\s*($|\n)/m.test(t)) return true;
    if (/\bPayload JSON\b/i.test(t)) return true;
    return false;
}

function aiLooksUseful(text, cfg = {}) {
    const t = aiNormalizeText(text);
    if (!t) return false;
    if (t.length < Number(cfg.minChars || 80)) return false;
    if (aiHasTemplateArtifacts(t)) return false;
    const sections = Array.isArray(cfg.requiredSections) ? cfg.requiredSections : [];
    for (const s of sections) {
        if (!aiHasSection(t, s)) return false;
    }
    const minNums = Number(cfg.minNumbers || 0);
    if (minNums > 0 && aiCountNumericMentions(t) < minNums) return false;
    return true;
}

function aiHumanizeField(key) {
    const s = String(key || "")
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim();
    if (!s) return "Metric";
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function aiFmtNum(v, fraction = 2) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "n/a";
    const abs = Math.abs(n);
    const maxFractionDigits = abs >= 1000 ? 0 : fraction;
    return n.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits });
}

function aiIsPercentField(key) {
    return /(percent|pct|rate|irr|roi|growth|inflation|vacancy|tax)/i.test(String(key || ""));
}

function aiIsMoneyField(key) {
    return /(payment|cost|price|profit|value|rent|loan|interest|fees|cash|down|income|expense|mortgage|equity|overpayment|amount|total)/i.test(String(key || ""));
}

function aiFormatValueByField(key, value) {
    const v = Number(value);
    if (!Number.isFinite(v)) {
        if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
        return String(value);
    }
    if (aiIsPercentField(key)) return `${aiFmtNum(v, 2)}%`;
    if (aiIsMoneyField(key)) return `$${aiFmtNum(v, 2)}`;
    return aiFmtNum(v, 2);
}

function aiFormatSignedByField(key, value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return "n/a";
    const sign = v >= 0 ? "+" : "-";
    const abs = Math.abs(v);
    if (aiIsPercentField(key)) return `${sign}${aiFmtNum(abs, 2)}%`;
    if (aiIsMoneyField(key)) return `${sign}$${aiFmtNum(abs, 2)}`;
    return `${sign}${aiFmtNum(abs, 2)}`;
}

function aiCollectNumericPairs(obj, prefix = "", depth = 0, maxDepth = 2, out = []) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > maxDepth) return out;
    for (const [k, v] of Object.entries(obj)) {
        if (String(k).startsWith("__")) continue;
        const key = prefix ? `${prefix}.${k}` : k;
        if (typeof v === "number" && Number.isFinite(v)) {
            out.push({ key, value: v });
            continue;
        }
        if (v && typeof v === "object" && !Array.isArray(v)) {
            aiCollectNumericPairs(v, key, depth + 1, maxDepth, out);
        }
    }
    return out;
}

function aiTopPairsFromPayload(payload, limit = 8) {
    const out = [];
    const seen = new Set();

    const pushFrom = (obj, preferPrefix = "") => {
        const pairs = aiCollectNumericPairs(obj, preferPrefix, 0, 1, []);
        for (const p of pairs) {
            const k = String(p.key || "").replace(/^.*\./, "");
            if (!k || seen.has(k)) continue;
            seen.add(k);
            out.push({ key: k, value: p.value });
            if (out.length >= limit) return;
        }
    };

    pushFrom(payload?.derived_metrics?.keyNumbers || {});
    if (out.length < limit) pushFrom(payload?.result_data || {});
    if (out.length < limit) pushFrom(payload?.derived_metrics?.metrics || {});
    if (out.length < limit) pushFrom(payload?.input_data || {});

    return out.slice(0, limit);
}

function aiFallbackBulletsFromPairs(pairs, limit = 4) {
    const rows = Array.isArray(pairs) ? pairs : [];
    return rows.slice(0, limit).map((p) => `- ${aiHumanizeField(p.key)}: ${aiFormatValueByField(p.key, p.value)}.`);
}

function aiBuildInputChanges(payload, limit = 5) {
    const raw = Array.isArray(payload?.input_changes) && payload.input_changes.length
        ? payload.input_changes
        : diffInputData(payload?.baseline_input_data || {}, payload?.input_data || {}, limit);
    return raw.slice(0, limit).map((x) => `- ${aiHumanizeField(x.field)}: ${x.from} -> ${x.to}`);
}

function aiSuggestTargetValue(baseInput, field) {
    const r = leverRange(field, baseInput || {});
    if (!r || !Number.isFinite(baseInput?.[field])) return null;
    const base = Number(baseInput[field]);
    const raw = r.prefer === "down"
        ? (base + r.lo) / 2
        : (base + r.hi) / 2;
    const v = normalizeLeverValueForField(field, raw, baseInput || {});
    return Number.isFinite(v) ? v : null;
}

function aiFallbackFullVerdict(payload) {
    const type = String(payload?.calculator_type || "");
    const metric = primaryMetricByType(type);
    const metricKey = String(metric?.key || "");
    const metricVal = metricValue(payload?.result_data || {}, metricKey);
    const metricHint = metric?.better === "min" ? "lower is better" : "higher is better";
    const icon = normalizeVerdictIcon(payload?.mini_verdict?.icon) || "ℹ️";
    const miniText = String(payload?.mini_verdict?.text || `${humanNameSSR(type)} summary for current assumptions.`).trim();
    const pairs = aiTopPairsFromPayload(payload, 10);
    const missing = (payload?.derived_metrics?.missingChecklist || []).slice(0, 3);
    const levers = compareLeversByType(type, payload?.input_data || {}).slice(0, 3);

    const why = [];
    if (metricKey && Number.isFinite(metricVal)) {
        why.push(`- ${aiHumanizeField(metricKey)} is ${aiFormatValueByField(metricKey, metricVal)} (${metricHint}).`);
    }
    why.push(...aiFallbackBulletsFromPairs(pairs, 3));

    const keyNumbers = aiFallbackBulletsFromPairs(pairs.slice(0, 6), 6);
    const missingBullets = missing.length
        ? missing.map((x) => `- ${x}.`)
        : ["- Verify any cost items not present in inputs (taxes, insurance, fees).", "- Validate realistic horizon and stress assumptions."];

    const improve = levers.length
        ? levers.map((f) => {
            const t = aiSuggestTargetValue(payload?.input_data || {}, f);
            const target = Number.isFinite(t) ? aiFormatValueByField(f, t) : "a realistic improved target";
            return `- Test ${f} toward ${target}; re-check ${aiHumanizeField(metricKey || "primary metric")}.`;
        })
        : ["- Adjust the most sensitive cost input and re-check the primary metric.", "- Run scenarios to test upside and downside assumptions.", "- Compare with another saved deal to see relative performance."];

    const sens = levers.length
        ? levers.map((f) => `- ${aiHumanizeField(f)}: run +10% and -10% sensitivity to measure impact.`)
        : ["- Run +10% / -10% on key cost assumptions.", "- Stress test horizon shorter and longer.", "- Stress test rate/inflation assumptions."];

    const nextLevers = levers.length ? levers : ["price", "ratePercent", "years"];
    const scenarioA = nextLevers[0] || "price";
    const scenarioB = nextLevers[1] || scenarioA;
    const scenarioC = nextLevers[2] || scenarioA;

    return [
        `Verdict: ${icon} ${miniText}${metricKey && Number.isFinite(metricVal) ? ` Primary metric ${aiHumanizeField(metricKey)} = ${aiFormatValueByField(metricKey, metricVal)}.` : ""}`,
        "",
        "Why this verdict (3 bullets):",
        ...(why.length ? why.slice(0, 3) : ["- Result is based on the current calculation outputs and key metrics."]),
        "",
        "Key numbers (4–6 bullets):",
        ...(keyNumbers.length ? keyNumbers.slice(0, 6) : ["- Key numeric outputs are available in the result table."]),
        "",
        "Missing checklist (2–5 bullets):",
        ...missingBullets,
        "",
        "What to do to improve the result (3 bullets):",
        ...improve.slice(0, 3),
        "",
        "Sensitivity quick test (3 bullets):",
        ...sens.slice(0, 3),
        "",
        "Next runs inside the app (3 scenarios):",
        `- Scenario A: Change ${scenarioA} to improve ${aiHumanizeField(metricKey || "primary metric")}.`,
        `- Scenario B: Change ${scenarioB} to test trade-off vs baseline.`,
        `- Scenario C: Stress-test ${scenarioC} (adverse case).`
    ].join("\n");
}

function aiFallbackScenario(payload) {
    const icon = normalizeVerdictIcon(payload?.mini_verdict?.icon) || "ℹ️";
    const scenarioLabel = String(payload?.scenario_label || "Scenario").trim();
    const miniText = String(payload?.mini_verdict?.text || "Scenario summary under current assumptions.").trim();
    const tag = String(payload?.scenario_tag || "Scenario impact vs baseline").trim();
    const mainDriver = String(payload?.main_driver || "").trim();
    const changes = aiBuildInputChanges(payload, 5);
    const deltaPairs = aiCollectNumericPairs(payload?.deltas_vs_baseline || {}, "", 0, 1, [])
        .filter((x) => Number.isFinite(Number(x.value)) && Number(x.value) !== 0);
    const impact = deltaPairs.slice(0, 4).map((x) => `- ${aiHumanizeField(x.key)}: ${aiFormatSignedByField(x.key, x.value)} vs baseline.`);
    const pairFallback = aiFallbackBulletsFromPairs(aiTopPairsFromPayload(payload, 4), 3);
    const levers = compareLeversByType(String(payload?.calculator_type || ""), payload?.input_data || {}).slice(0, 2);

    const mixedSigns = deltaPairs.some((x) => Number(x.value) > 0) && deltaPairs.some((x) => Number(x.value) < 0);
    const tradeoff = mixedSigns
        ? "- Mixed effect vs baseline: some metrics improved while others worsened."
        : "- Impact appears directionally consistent; verify with one stress rerun.";

    return [
        `Scenario: ${scenarioLabel}`,
        "",
        `Verdict: ${icon} ${miniText}${impact.length ? ` ${impact[0].replace(/^- /, "")}` : ""}`,
        "",
        "Tag:",
        `- ${tag}`,
        "",
        "Main driver:",
        `- ${mainDriver || (impact[0] ? impact[0].replace(/^- /, "") : "Primary movement is visible in key scenario deltas.")}`,
        "",
        "What changed (inputs you control):",
        ...(changes.length ? changes : ["- No explicit input changes were provided."]),
        "",
        "Impact vs baseline (numbers):",
        ...(impact.length ? impact : pairFallback),
        "",
        "Trade-off / note:",
        tradeoff,
        "",
        "Recommendation:",
        `- ${levers[0] ? `Test ${levers[0]} next, then validate with ${levers[1] || levers[0]}.` : "Run one additional scenario focusing on your most controllable cost/input."}`
    ].join("\n");
}

async function aiJobInsertIfAbsent({ userId, jobId, kind, status = "queued", payload = null, reservedCredits = 0 }) {
    await ensureAiJobsTable();
    const r = await db.query(
        `insert into ai_jobs(user_id, job_id, kind, status, payload, reserved_credits, updated_at)
     values($1,$2,$3,$4,$5::jsonb,$6,now())
     on conflict (job_id) do nothing
     returning id`,
        [userId, String(jobId), String(kind), String(status), payload ? JSON.stringify(payload) : null, Number(reservedCredits || 0)]
    );
    return !!r.rowCount;
}

function comparePrimaryGapStats({ aVal, bVal, winner, better }) {
    const av = Number(aVal);
    const bv = Number(bVal);
    if (!Number.isFinite(av) || !Number.isFinite(bv)) {
        return { winnerVal: NaN, loserVal: NaN, absGap: NaN, relGapPct: NaN };
    }

    const winnerVal = winner === "A" ? av : bv;
    const loserVal = winner === "A" ? bv : av;
    const signedGap = better === "min" ? (loserVal - winnerVal) : (winnerVal - loserVal);
    const absGap = Math.abs(signedGap);
    const denom = Math.max(Math.abs(winnerVal), Math.abs(loserVal), 1e-9);
    const relGapPct = (absGap / denom) * 100;

    return { winnerVal, loserVal, absGap, relGapPct };
}

function compareConfidenceFromGapPct(relGapPct) {
    const v = Number(relGapPct);
    if (!Number.isFinite(v)) return "low";
    if (v < 2) return "low";
    if (v < 8) return "medium";
    return "high";
}

function compareResultSnapshot(type, resultData, metricKey, limit = 5) {
    const keys = Array.from(new Set([metricKey, ...(STALE_CHECK_KEYS_BY_TYPE[type] || [])])).filter(Boolean);
    const out = {};
    for (const k of keys) {
        const v = metricValue(resultData || {}, k);
        if (!Number.isFinite(v)) continue;
        out[k] = v;
        if (Object.keys(out).length >= limit) break;
    }
    return out;
}

function buildComparePromptPayload(payload) {
    const type = String(payload?.calculator_type || "");
    const metricKey = String(payload?.primary_metric?.key || primaryMetricByType(type)?.key || "");
    const better = String(payload?.primary_metric?.better || primaryMetricByType(type)?.better || "min");

    const aVal = metricValue(payload?.A?.result_data || {}, metricKey);
    const bVal = metricValue(payload?.B?.result_data || {}, metricKey);
    const winner = String(payload?.winner || (isBetter(aVal, bVal, better) ? "A" : "B"));
    const gap = comparePrimaryGapStats({ aVal, bVal, winner, better });
    const confidence = compareConfidenceFromGapPct(gap.relGapPct);
    const aSnapshot = compareResultSnapshot(type, payload?.A?.result_data || {}, metricKey, 6);
    const bSnapshot = compareResultSnapshot(type, payload?.B?.result_data || {}, metricKey, 6);

    const keys = Array.from(new Set([metricKey, ...(STALE_CHECK_KEYS_BY_TYPE[type] || [])])).filter(Boolean);
    const keyDiffs = [];
    for (const k of keys) {
        const av = metricValue(payload?.A?.result_data || {}, k);
        const bv = metricValue(payload?.B?.result_data || {}, k);
        if (!Number.isFinite(av) || !Number.isFinite(bv) || av === bv) continue;
        const absGap = Math.abs(av - bv);
        const relGapPct = Math.abs(av - bv) / Math.max(Math.abs(av), Math.abs(bv), 1e-9) * 100;
        keyDiffs.push({
            key: k,
            a: av,
            b: bv,
            aFmt: aiFormatValueByField(k, av),
            bFmt: aiFormatValueByField(k, bv),
            absGap,
            absGapFmt: aiFormatValueByField(k, absGap),
            relGapPct,
            relGapPctFmt: `${aiFmtNum(relGapPct, 1)}%`
        });
    }
    keyDiffs.sort((x, y) => {
        if (x.key === metricKey && y.key !== metricKey) return -1;
        if (y.key === metricKey && x.key !== metricKey) return 1;
        return Number(y.absGap || 0) - Number(x.absGap || 0);
    });

    return {
        calculator_type: type,
        primary_metric: {
            key: metricKey,
            better,
            winner,
            winnerValue: Number.isFinite(gap.winnerVal) ? gap.winnerVal : null,
            winnerValueFmt: Number.isFinite(gap.winnerVal) ? aiFormatValueByField(metricKey, gap.winnerVal) : "n/a",
            loserValue: Number.isFinite(gap.loserVal) ? gap.loserVal : null,
            loserValueFmt: Number.isFinite(gap.loserVal) ? aiFormatValueByField(metricKey, gap.loserVal) : "n/a",
            absGap: Number.isFinite(gap.absGap) ? gap.absGap : null,
            absGapFmt: Number.isFinite(gap.absGap) ? aiFormatValueByField(metricKey, gap.absGap) : "n/a",
            relGapPct: Number.isFinite(gap.relGapPct) ? gap.relGapPct : null,
            relGapPctFmt: Number.isFinite(gap.relGapPct) ? `${aiFmtNum(gap.relGapPct, 1)}%` : "n/a",
            confidence
        },
        deals: {
            A: {
                id: payload?.A?.id ?? null,
                mini_verdict: payload?.A?.mini_verdict || null,
                key_numbers: aSnapshot,
                key_numbers_fmt: Object.fromEntries(
                    Object.entries(aSnapshot)
                        .map(([k, v]) => [k, aiFormatValueByField(k, v)])
                )
            },
            B: {
                id: payload?.B?.id ?? null,
                mini_verdict: payload?.B?.mini_verdict || null,
                key_numbers: bSnapshot,
                key_numbers_fmt: Object.fromEntries(
                    Object.entries(bSnapshot)
                        .map(([k, v]) => [k, aiFormatValueByField(k, v)])
                )
            }
        },
        key_differences: keyDiffs.slice(0, 5),
        bestFlip: payload?.bestFlip || null,
        flips: Array.isArray(payload?.flips) ? payload.flips.slice(0, 3) : []
    };
}

function optimizerResultSnapshot(type, resultData, goalKey, limit = 6) {
    const primaryKey = String(primaryMetricByType(type)?.key || "");
    const keys = Array.from(new Set([goalKey, primaryKey, ...(STALE_CHECK_KEYS_BY_TYPE[type] || [])])).filter(Boolean);
    const out = {};
    for (const k of keys) {
        const v = metricValue(resultData || {}, k);
        if (!Number.isFinite(v)) continue;
        out[k] = v;
        if (Object.keys(out).length >= limit) break;
    }
    return out;
}

function optimizerFeasibilityLevelLabel(v) {
    const raw = String(v || "medium").trim().toLowerCase();
    if (raw === "high") return "HIGH";
    if (raw === "low") return "LOW";
    return "MEDIUM";
}

function optimizerFeasibilityRank(level) {
    const v = optimizerFeasibilityLevelLabel(level);
    if (v === "HIGH") return 3;
    if (v === "MEDIUM") return 2;
    return 1;
}

function optimizerNormalizeDirectionHints(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [k, v] of Object.entries(raw)) {
        const key = String(k || "").trim();
        if (!key) continue;
        const dir = String(v || "").trim().toLowerCase();
        if (dir === "up" || dir === "down") out[key] = dir;
    }
    return out;
}

function optimizerDirectionHints(type, goal, baseInput, baseResult = null) {
    const t = String(type || "");
    const input = (baseInput && typeof baseInput === "object") ? baseInput : {};
    if (!t || !Object.keys(input).length) return {};

    const { key: objectiveKey, better } = resolveOptimizerObjective(t, goal || {});
    if (!objectiveKey) return {};

    let baseRes = (baseResult && typeof baseResult === "object") ? baseResult : null;
    if (!baseRes) {
        try {
            baseRes = computeResultByType(t, input);
        } catch {
            baseRes = null;
        }
    }

    const baseObjective = metricValue(baseRes || {}, objectiveKey);
    if (!Number.isFinite(baseObjective)) return {};

    const fields = compareLeversByType(t, input);
    const out = {};

    const improvement = (probeVal) => {
        if (!Number.isFinite(probeVal)) return NaN;
        return better === "min"
            ? (baseObjective - probeVal)
            : (probeVal - baseObjective);
    };

    for (const field of fields) {
        const baseValue = toNum(input?.[field], NaN);
        if (!Number.isFinite(baseValue)) continue;

        const rng = leverRange(field, input);
        const lo = toNum(rng?.lo, NaN);
        const hi = toNum(rng?.hi, NaN);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) continue;

        const span = Math.abs(hi - lo);
        let step = span * 0.08;
        if (aiIsMoneyField(field)) step = Math.max(step, Math.max(100, Math.abs(baseValue) * 0.03));
        else if (aiIsPercentField(field)) step = Math.max(step, 0.2);
        else if (/(year|term|years|months)/i.test(String(field || ""))) step = Math.max(step, 1);
        else step = Math.max(step, Math.max(0.2, Math.abs(baseValue) * 0.03));

        const probeValue = (raw) => {
            const v = normalizeLeverValueForField(field, raw, input);
            if (!Number.isFinite(v) || v === baseValue) return null;
            const probeInput = { ...input, [field]: v };
            let probeRes = null;
            try {
                probeRes = computeResultByType(t, probeInput);
            } catch {
                probeRes = null;
            }
            const probeObjective = metricValue(probeRes || {}, objectiveKey);
            if (!Number.isFinite(probeObjective)) return null;
            return {
                value: v,
                objective: probeObjective,
                improvement: improvement(probeObjective)
            };
        };

        let downProbe = probeValue(baseValue - step);
        let upProbe = probeValue(baseValue + step);

        if ((!downProbe || !upProbe) && Number.isFinite(step)) {
            const widerStep = step * 1.8;
            if (!downProbe) downProbe = probeValue(baseValue - widerStep);
            if (!upProbe) upProbe = probeValue(baseValue + widerStep);
        }

        const tolerance = Math.max(Math.abs(baseObjective) * 0.001, 1e-6);
        const downImprove = toNum(downProbe?.improvement, NaN);
        const upImprove = toNum(upProbe?.improvement, NaN);

        if (Number.isFinite(downImprove) && Number.isFinite(upImprove)) {
            if (downImprove > upImprove + tolerance && downImprove > -tolerance) out[field] = "down";
            else if (upImprove > downImprove + tolerance && upImprove > -tolerance) out[field] = "up";
        } else if (Number.isFinite(downImprove) && downImprove > tolerance) {
            out[field] = "down";
        } else if (Number.isFinite(upImprove) && upImprove > tolerance) {
            out[field] = "up";
        }
    }

    return out;
}

function optimizerDirectionHintsFromPayload(payload) {
    const direct = optimizerNormalizeDirectionHints(payload?.direction_hints || payload?.selection?.direction_hints);
    if (Object.keys(direct).length) return direct;
    return optimizerDirectionHints(
        payload?.calculator_type,
        payload?.goal || {},
        payload?.base?.input_data || {},
        payload?.base?.result_data || null
    );
}

function optimizerPreferredDirectionForField(type, goalMetric, field, directionHints = null) {
    const t = String(type || "");
    const g = String(goalMetric || "");
    const f = String(field || "");
    if (!f) return "";

    const hints = optimizerNormalizeDirectionHints(directionHints);
    if (hints[f]) return hints[f];

    const byGoal = {
        monthlyPayment: { price: "down", ratePercent: "down", down: "up", termYears: "up" },
        totalInterest: { price: "down", ratePercent: "down", down: "up", termYears: "down" },
        totalPayment: { price: "down", ratePercent: "down", down: "up", termYears: "down" }
    };
    if (t === "mortgage") {
        const map = byGoal[g] || byGoal.monthlyPayment;
        return String(map[f] || "");
    }
    return "";
}

function optimizerRowIsCounterproductive(row, ctx = {}) {
    const field = String(row?.field || "").trim();
    const dir = String(row?.dir || "").toLowerCase() === "increase" ? "increase" : "decrease";
    const pref = optimizerPreferredDirectionForField(ctx?.type, ctx?.goalMetric, field, ctx?.directionHints);
    if (!pref) return false;
    return (pref === "down" && dir === "increase") || (pref === "up" && dir === "decrease");
}

function optimizerNegotiationRowsForOutput(rows, ctx = {}) {
    const src = Array.isArray(rows) ? rows : [];
    if (!src.length) return [];

    const out = [];
    let firstIdx = src.findIndex((r) => !optimizerRowIsCounterproductive(r, ctx));
    if (firstIdx < 0) firstIdx = 0;
    const first = src[firstIdx] || null;
    if (first) out.push(first);

    for (let i = 0; i < src.length; i++) {
        if (i === firstIdx) continue;
        const n = src[i];
        if (!n) continue;
        if (optimizerRowIsCounterproductive(n, ctx)) continue;
        if (first && String(n?.field || "") === String(first?.field || "")) continue;
        const field = String(n?.field || "").trim();
        const from = toNum(n?.from, NaN);
        const to = toNum(n?.to, NaN);
        const relAbs = Math.abs(toNum(n?.rel, 0));
        const absDiff = Number.isFinite(from) && Number.isFinite(to) ? Math.abs(to - from) : 0;

        const materialByRel = relAbs >= 0.008; // >=0.8%
        const materialByMoney = aiIsMoneyField(field) && absDiff >= 1000;
        const materialByRate = aiIsPercentField(field) && absDiff >= 0.2;
        const materialByTerm = /(year|term|years|months)/i.test(field) && absDiff >= 1;
        if (materialByRel || materialByMoney || materialByRate || materialByTerm) {
            out.push(n);
        }
        if (out.length >= 3) break;
    }

    return out.slice(0, 3);
}

function optimizerMustNegotiateBulletRows(candidate, ctx = {}) {
    const rows = optimizerNegotiationRowsForOutput(Array.isArray(candidate?.negotiation) ? candidate.negotiation : [], ctx);
    if (!rows.length) return ["No mandatory change identified."];

    return rows.map((n) => {
        const field = String(n?.field || "").trim();
        const from = toNum(n?.from, NaN);
        const to = toNum(n?.to, NaN);
        const rel = toNum(n?.rel, NaN);
        const dir = String(n?.dir || "").toLowerCase() === "increase" ? "increase" : "decrease";
        const fromFmt = Number.isFinite(from) ? aiFormatValueByField(field, from) : "n/a";
        const toFmt = Number.isFinite(to) ? aiFormatValueByField(field, to) : "n/a";
        const relFmt = Number.isFinite(rel) ? `${aiFmtNum(Math.abs(rel) * 100, 1)}%` : "n/a";
        return `${aiHumanizeField(field)}: ${toFmt} (${dir} from ${fromFmt}, change ${relFmt}).`;
    }).slice(0, 3);
}

function optimizerFeasibilityReason(candidate) {
    const negotiationRows = Array.isArray(candidate?.negotiation) ? candidate.negotiation : [];
    const strategy = candidate?.strategy || optimizerStrategyMetaFromNegotiation(negotiationRows);
    const level = optimizerFeasibilityLevelLabel(strategy?.feasibility);
    const dominantField = String(strategy?.dominant_field || "").trim();
    const dominantFieldHuman = aiHumanizeField(dominantField || "primary lever");
    const relPct = toNum(strategy?.max_rel_change_pct, NaN);
    const relTxt = Number.isFinite(relPct) ? `${aiFmtNum(relPct, 1)}%` : "material";

    if (level === "LOW") {
        return `${dominantFieldHuman} adjustment is aggressive (${relTxt}) and may be difficult to negotiate`;
    }
    if (level === "MEDIUM") {
        return `requires coordinated negotiation on ${dominantFieldHuman} (around ${relTxt})`;
    }
    return `${dominantFieldHuman} change is relatively modest (${relTxt}) under current constraints`;
}

function optimizerTradeoffLine(candidate, payload = {}) {
    const type = String(payload?.calculator_type || "");
    const goalMetric = String(payload?.goal?.metric || primaryMetricByType(type)?.key || "");
    const better = String(resolveOptimizerObjective(type, payload?.goal || {}).better || "min");
    const baseResult = payload?.base?.result_data || {};
    const candResult = candidate?.result_data || {};

    const basePrimary = metricValue(baseResult, goalMetric);
    const candPrimary = metricValue(candResult, goalMetric);
    const pDelta = Number.isFinite(basePrimary) && Number.isFinite(candPrimary) ? (candPrimary - basePrimary) : NaN;

    if (type === "mortgage") {
        const baseMonthly = metricValue(baseResult, "monthlyPayment");
        const candMonthly = metricValue(candResult, "monthlyPayment");
        const baseTotalPay = metricValue(baseResult, "totalPayment");
        const candTotalPay = metricValue(candResult, "totalPayment");
        const baseTotalInt = metricValue(baseResult, "totalInterest");
        const candTotalInt = metricValue(candResult, "totalInterest");

        const dm = Number.isFinite(baseMonthly) && Number.isFinite(candMonthly) ? candMonthly - baseMonthly : NaN;
        const dtp = Number.isFinite(baseTotalPay) && Number.isFinite(candTotalPay) ? candTotalPay - baseTotalPay : NaN;
        const dti = Number.isFinite(baseTotalInt) && Number.isFinite(candTotalInt) ? candTotalInt - baseTotalInt : NaN;

        const worsensLifetime = (Number.isFinite(dtp) && dtp > 1000) || (Number.isFinite(dti) && dti > 1000);
        const improvesLifetime = (Number.isFinite(dtp) && dtp < -1000) || (Number.isFinite(dti) && dti < -1000);

        if (Number.isFinite(dm) && dm < -0.5 && worsensLifetime) {
            return "Lower monthly payment, but higher lifetime cost (total payment/interest).";
        }
        if (Number.isFinite(dm) && dm < -0.5 && improvesLifetime) {
            return "Lower monthly payment and lower lifetime cost versus base.";
        }
        if (Number.isFinite(dm) && dm > 0.5 && improvesLifetime) {
            return "Higher monthly payment, but lower lifetime cost versus base.";
        }

        const termBase = toNum(payload?.base?.input_data?.termYears, NaN);
        const termNow = toNum(candidate?.input_data?.termYears, NaN);
        if (Number.isFinite(termBase) && Number.isFinite(termNow) && termNow > termBase + 0.5) {
            return "Relies on a longer loan term, which can increase total interest.";
        }
    }

    if (Number.isFinite(pDelta)) {
        if (better === "min" && pDelta < -1e-9) return `Primary metric improves by ${aiFormatSignedByField(goalMetric, pDelta)} vs base.`;
        if (better === "min" && pDelta > 1e-9) return `Primary metric worsens by ${aiFormatSignedByField(goalMetric, pDelta)} vs base.`;
        if (better === "max" && pDelta > 1e-9) return `Primary metric improves by ${aiFormatSignedByField(goalMetric, pDelta)} vs base.`;
        if (better === "max" && pDelta < -1e-9) return `Primary metric worsens by ${aiFormatSignedByField(goalMetric, pDelta)} vs base.`;
    }

    return "Validate secondary metrics and execution risk before final decision.";
}

function optimizerFeasibilityRealityBullets(payload) {
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates.slice(0, 3) : [];
    if (!candidates.length) {
        return [
            "- Option 1 is easiest to execute now due to lower change pressure.",
            "- Option 1 has the biggest negotiation risk until alternatives are generated.",
            "- Diversity status is unavailable; run optimizer again with refreshed candidates."
        ];
    }

    const directionHints = optimizerDirectionHintsFromPayload(payload);

    const scored = candidates.map((c, idx) => {
        const negotiation = optimizerNegotiationRowsForOutput(
            Array.isArray(c?.negotiation) ? c.negotiation : [],
            { type: payload?.calculator_type, goalMetric: payload?.goal?.metric, directionHints }
        );
        const strategy = c?.strategy || optimizerStrategyMetaFromNegotiation(negotiation);
        const level = optimizerFeasibilityLevelLabel(strategy?.feasibility);
        const levelRank = optimizerFeasibilityRank(level);
        const maxRel = toNum(strategy?.max_rel_change_pct, NaN);
        const relScore = Number.isFinite(maxRel) ? maxRel : 999;
        return {
            idx: idx + 1,
            level,
            levelRank,
            relScore,
            note: String(strategy?.note || "").trim()
        };
    });

    const easiest = [...scored].sort((a, b) => {
        if (b.levelRank !== a.levelRank) return b.levelRank - a.levelRank;
        return a.relScore - b.relScore;
    })[0];
    const riskiest = [...scored].sort((a, b) => {
        if (a.levelRank !== b.levelRank) return a.levelRank - b.levelRank;
        return b.relScore - a.relScore;
    })[0];

    const diversityScore = toNum(payload?.selection?.diversity_score, NaN);
    const diversityTarget = Math.max(1, Math.trunc(toNum(payload?.selection?.target_distinct_dominant, 1) || 1));
    const diversityOk = !!payload?.selection?.diversity_ok;
    const got = Number.isFinite(diversityScore) ? Math.trunc(diversityScore) : 0;
    const modeLabel = String(payload?.mode || "standard");
    const diversityLine = diversityOk
        ? `- Diversity target met for ${modeLabel}: ${got}/${diversityTarget} distinct dominant lever(s).`
        : `- Diversity below target for ${modeLabel}: ${got}/${diversityTarget} distinct dominant lever(s); constraints in candidates limit variation.`;

    const uniqueLevels = new Set(scored.map((x) => x.level));
    let easiestLine = `- Option ${easiest?.idx || 1} is easiest to execute now (${easiest?.level || "MEDIUM"} feasibility).`;
    let riskiestLine = `- Option ${riskiest?.idx || 1} has the biggest negotiation risk (${riskiest?.level || "LOW"} feasibility).`;
    if (uniqueLevels.size === 1 && easiest?.level === "LOW") {
        easiestLine = `- All current options are LOW feasibility; option ${easiest?.idx || 1} is the least difficult among them.`;
        riskiestLine = `- Within the LOW-feasibility set, option ${riskiest?.idx || 1} has the highest execution risk.`;
    }

    return [
        easiestLine,
        riskiestLine,
        diversityLine
    ];
}

function optimizerPreferredFieldForNextAction(payload) {
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
    for (const c of candidates) {
        if (!c?.goal?.ok) continue;
        const f = String(c?.negotiation?.[0]?.field || "").trim();
        if (f) return f;
    }
    for (const c of candidates) {
        const f = String(c?.negotiation?.[0]?.field || "").trim();
        if (f) return f;
    }
    const dominant = Array.isArray(payload?.selection?.dominant_levers)
        ? String(payload.selection.dominant_levers[0] || "").trim()
        : "";
    if (dominant) return dominant;
    const type = String(payload?.calculator_type || "");
    const baseInput = payload?.base?.input_data || {};
    const fallback = compareLeversByType(type, baseInput).find((x) => String(x || "").trim());
    return fallback || "";
}

function optimizerModeSelectionProfile(mode) {
    const m = String(mode || "").toLowerCase();
    if (m === "deep") {
        return {
            minDistinctDominant: 3,
            maxPerDominant: 1,
            allowNearMissForDiversity: true,
            targetBandPadRatio: 0.18
        };
    }
    if (m === "quick") {
        return {
            minDistinctDominant: 2,
            maxPerDominant: 2,
            allowNearMissForDiversity: true,
            targetBandPadRatio: 0.08
        };
    }
    return {
        minDistinctDominant: 2,
        maxPerDominant: 1,
        allowNearMissForDiversity: true,
        targetBandPadRatio: 0.12
    };
}

function optimizerTargetBandFromCandidates(payload, field, baseInput) {
    const mode = String(payload?.mode || "standard");
    const profile = optimizerModeSelectionProfile(mode);
    const rows = Array.isArray(payload?.candidates) ? payload.candidates : [];
    const targets = [];

    for (const c of rows) {
        const negotiations = Array.isArray(c?.negotiation) ? c.negotiation : [];
        for (const n of negotiations) {
            if (String(n?.field || "").trim() !== String(field || "").trim()) continue;
            const v = toNum(n?.to, NaN);
            if (Number.isFinite(v)) targets.push(v);
        }
    }

    if (!targets.length) return null;

    const goalOkTargets = [];
    for (const c of rows) {
        if (!c?.goal?.ok) continue;
        const negotiations = Array.isArray(c?.negotiation) ? c.negotiation : [];
        for (const n of negotiations) {
            if (String(n?.field || "").trim() !== String(field || "").trim()) continue;
            const v = toNum(n?.to, NaN);
            if (Number.isFinite(v)) goalOkTargets.push(v);
        }
    }

    const picked = goalOkTargets.length ? goalOkTargets : targets;
    let lo = Math.min(...picked);
    let hi = Math.max(...picked);

    const base = toNum(baseInput?.[field], NaN);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    if (picked.length === 1) {
        const t = picked[0];
        if (Number.isFinite(t)) {
            let padSingle;
            if (aiIsMoneyField(field)) padSingle = Math.max(5000, Math.abs(t) * 0.06);
            else if (aiIsPercentField(field)) padSingle = Math.max(0.25, Math.abs(t) * 0.08);
            else padSingle = Math.max(1, Math.abs(t) * 0.08);

            lo = t - padSingle;
            hi = t + padSingle;
            if (Number.isFinite(base)) {
                const gap = Math.abs(base - t);
                if (gap <= Math.abs(padSingle) * 0.6) {
                    lo = Math.min(lo, base);
                    hi = Math.max(hi, base);
                }
            }
        }
    } else if (lo === hi && Number.isFinite(base)) {
        lo = Math.min(lo, base);
        hi = Math.max(hi, base);
    }

    const rawSpan = Math.abs(hi - lo);
    const minPad = aiIsMoneyField(field)
        ? Math.max(250, rawSpan * 0.04)
        : (aiIsPercentField(field) ? 0.1 : 0.5);
    const pad = Math.max(minPad, rawSpan * Number(profile.targetBandPadRatio || 0.1));

    lo -= pad;
    hi += pad;

    return { lo, hi, pickedCount: picked.length };
}

function optimizerStepValue(field, lo, hi, baseInput = {}) {
    const span = Math.abs(Number(hi) - Number(lo));
    if (!Number.isFinite(span) || span <= 0) return null;

    let step;
    if (aiIsPercentField(field)) {
        if (span <= 1) step = 0.1;
        else if (span <= 3) step = 0.25;
        else if (span <= 10) step = 0.5;
        else step = 1;
    } else if (/(year|term|years|months)/i.test(String(field || ""))) {
        step = 1;
    } else if (aiIsMoneyField(field)) {
        if (span >= 200000) step = 10000;
        else if (span >= 100000) step = 5000;
        else if (span >= 50000) step = 2500;
        else if (span >= 20000) step = 1000;
        else if (span >= 10000) step = 500;
        else step = 100;
    } else {
        step = span / 10;
    }

    const base = Number(lo);
    const normalizedProbe = normalizeLeverValueForField(field, base + step, baseInput);
    if (Number.isFinite(normalizedProbe) && Number.isFinite(base)) {
        const normalizedStep = normalizedProbe - base;
        if (Number.isFinite(normalizedStep) && normalizedStep > 0) step = normalizedStep;
    }

    if (!Number.isFinite(step) || step <= 0) return null;
    if (/(year|term|years|months)/i.test(String(field || ""))) return Math.max(1, Math.round(step));
    if (aiIsMoneyField(field)) return Math.max(1, Math.round(step));
    return round2(step);
}

function optimizerActionLabelForField(field) {
    const f = String(field || "").toLowerCase();
    if (f.includes("price")) return "Negotiate Price";
    if (f.includes("rate")) return "Rate Plan";
    if (f.includes("down")) return "Down Payment Plan";
    if (f.includes("term") || f.includes("year")) return "Term Options";
    return "Run Scenarios";
}

function optimizerNextActionHint(payload) {
    const baseInput = payload?.base?.input_data || {};
    const field = optimizerPreferredFieldForNextAction(payload);

    if (!field) {
        return {
            label: "Run Scenarios",
            field: "",
            bullet: "- Run Scenarios: test one stress case around your most controllable input."
        };
    }

    const range = leverRange(field, baseInput);
    const globalLo = toNum(range?.lo, NaN);
    const globalHi = toNum(range?.hi, NaN);
    const targetBand = optimizerTargetBandFromCandidates(payload, field, baseInput);
    let lo = Number.isFinite(targetBand?.lo) ? targetBand.lo : globalLo;
    let hi = Number.isFinite(targetBand?.hi) ? targetBand.hi : globalHi;

    if (Number.isFinite(globalLo)) lo = Math.max(lo, globalLo);
    if (Number.isFinite(globalHi)) hi = Math.min(hi, globalHi);

    const label = optimizerActionLabelForField(field);
    const fieldHuman = aiHumanizeField(field);

    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
        return {
            label,
            field,
            bullet: `- ${label}: test ${fieldHuman} in a tighter band around the current value.`
        };
    }

    const step = optimizerStepValue(field, lo, hi, baseInput);
    const loFmt = aiFormatValueByField(field, lo);
    const hiFmt = aiFormatValueByField(field, hi);
    const stepFmt = Number.isFinite(step) ? aiFormatValueByField(field, step) : "n/a";

    return {
        label,
        field,
        lo,
        hi,
        step: Number.isFinite(step) ? step : null,
        loFmt,
        hiFmt,
        stepFmt,
        bullet: Number.isFinite(step)
            ? `- ${label}: test ${fieldHuman} from ${loFmt} to ${hiFmt} with step ${stepFmt}.`
            : `- ${label}: test ${fieldHuman} from ${loFmt} to ${hiFmt}.`
    };
}

function buildOptimizerPromptPayload(payload) {
    const type = String(payload?.calculator_type || "");
    const mode = String(payload?.mode || "standard");
    const goal = payload?.goal || {};
    const goalKey = String(goal?.metric || primaryMetricByType(type)?.key || "");
    const goalVal = Number(goal?.value);
    const goalOp = String(goal?.op || "<=");
    const primaryKey = String(primaryMetricByType(type)?.key || goalKey || "");

    const baseInput = payload?.base?.input_data || {};
    const baseResult = payload?.base?.result_data || {};
    const directionHints = optimizerDirectionHintsFromPayload(payload);
    const baseSnapshot = optimizerResultSnapshot(type, baseResult, goalKey, 6);
    const baseGoalVal = metricValue(baseResult, goalKey);
    const basePrimaryVal = metricValue(baseResult, primaryKey);

    const candidatesRaw = Array.isArray(payload?.candidates) ? payload.candidates.slice(0, 3) : [];
    const candidates = candidatesRaw.map((c, idx) => {
        const negotiationRows = optimizerNegotiationRowsForOutput(
            Array.isArray(c?.negotiation) ? c.negotiation : [],
            { type, goalMetric: goalKey, directionHints }
        );
        const strategy = c?.strategy || optimizerStrategyMetaFromNegotiation(negotiationRows);
        const resultData = c?.result_data || {};
        const snapshot = optimizerResultSnapshot(type, resultData, goalKey, 6);
        const goalMetricValue = metricValue(resultData, goalKey);
        const primaryMetricValue = metricValue(resultData, primaryKey);
        const primaryDeltaVsBase = Number.isFinite(primaryMetricValue) && Number.isFinite(basePrimaryVal)
            ? (primaryMetricValue - basePrimaryVal)
            : NaN;

        const negotiationRowsFmt = negotiationRows.map((n) => {
            const field = String(n?.field || "").trim();
            const from = toNum(n?.from, NaN);
            const to = toNum(n?.to, NaN);
            const rel = toNum(n?.rel, NaN);
            const absChange = Number.isFinite(from) && Number.isFinite(to) ? Math.abs(to - from) : NaN;
            const dir = String(n?.dir || "").toLowerCase() === "increase" ? "increase" : "decrease";
            return {
                field,
                field_human: aiHumanizeField(field),
                direction: dir,
                from: Number.isFinite(from) ? from : null,
                to: Number.isFinite(to) ? to : null,
                fromFmt: Number.isFinite(from) ? aiFormatValueByField(field, from) : "n/a",
                toFmt: Number.isFinite(to) ? aiFormatValueByField(field, to) : "n/a",
                absChange: Number.isFinite(absChange) ? absChange : null,
                absChangeFmt: Number.isFinite(absChange) ? aiFormatValueByField(field, absChange) : "n/a",
                relPct: Number.isFinite(rel) ? Math.abs(rel) * 100 : null,
                relPctFmt: Number.isFinite(rel) ? `${aiFmtNum(Math.abs(rel) * 100, 1)}%` : "n/a"
            };
        });

        const mustNegotiateBullets = optimizerMustNegotiateBulletRows(
            { negotiation: negotiationRows },
            { type, goalMetric: goalKey, directionHints }
        );

        const strategyMaxRelPct = Number(strategy?.max_rel_change_pct);
        const strategyMaxRelPctFmt = Number.isFinite(strategyMaxRelPct)
            ? `${aiFmtNum(strategyMaxRelPct, 1)}%`
            : "n/a";
        const tradeoffHint = optimizerTradeoffLine(c, payload);
        const feasibilityLevel = optimizerFeasibilityLevelLabel(strategy?.feasibility);
        const feasibilityReason = optimizerFeasibilityReason({ strategy, negotiation: negotiationRows });
        const feasibilityLine = `Feasibility: ${feasibilityLevel} - ${feasibilityReason}.`;

        return {
            option: idx + 1,
            goal_ok: !!c?.goal?.ok,
            key_numbers: snapshot,
            key_numbers_fmt: Object.fromEntries(
                Object.entries(snapshot).map(([k, v]) => [k, aiFormatValueByField(k, v)])
            ),
            goal_metric_value: Number.isFinite(goalMetricValue) ? goalMetricValue : null,
            goal_metric_value_fmt: Number.isFinite(goalMetricValue) ? aiFormatValueByField(goalKey, goalMetricValue) : "n/a",
            primary_metric_value: Number.isFinite(primaryMetricValue) ? primaryMetricValue : null,
            primary_metric_value_fmt: Number.isFinite(primaryMetricValue) ? aiFormatValueByField(primaryKey, primaryMetricValue) : "n/a",
            primary_delta_vs_base: Number.isFinite(primaryDeltaVsBase) ? primaryDeltaVsBase : null,
            primary_delta_vs_base_fmt: Number.isFinite(primaryDeltaVsBase) ? aiFormatSignedByField(primaryKey, primaryDeltaVsBase) : "n/a",
            strategy: {
                dominant_field: String(strategy?.dominant_field || ""),
                dominant_field_human: aiHumanizeField(String(strategy?.dominant_field || "primary lever")),
                dominant_dir: String(strategy?.dominant_dir || ""),
                changed_fields: Number(strategy?.changed_fields || 0),
                max_rel_change_pct: Number.isFinite(strategyMaxRelPct) ? strategyMaxRelPct : null,
                max_rel_change_pct_fmt: strategyMaxRelPctFmt,
                feasibility: String(strategy?.feasibility || "medium"),
                feasibility_label: feasibilityLevel,
                feasibility_reason: feasibilityReason,
                feasibility_line: feasibilityLine,
                note: String(strategy?.note || "")
            },
            tradeoff_hint: tradeoffHint,
            negotiation_rows: negotiationRowsFmt,
            must_negotiate_bullets: mustNegotiateBullets
        };
    });

    const nextActionHint = optimizerNextActionHint(payload);

    return {
        calculator_type: type,
        mode,
        achieved: !!payload?.achieved,
        goal: {
            metric: goalKey,
            metric_human: aiHumanizeField(goalKey),
            op: goalOp,
            value: Number.isFinite(goalVal) ? goalVal : null,
            valueFmt: Number.isFinite(goalVal) ? aiFormatValueByField(goalKey, goalVal) : "n/a"
        },
        base: {
            input_data: baseInput,
            goal_metric_value: Number.isFinite(baseGoalVal) ? baseGoalVal : null,
            goal_metric_value_fmt: Number.isFinite(baseGoalVal) ? aiFormatValueByField(goalKey, baseGoalVal) : "n/a",
            primary_metric_key: primaryKey,
            primary_metric_value: Number.isFinite(basePrimaryVal) ? basePrimaryVal : null,
            primary_metric_value_fmt: Number.isFinite(basePrimaryVal) ? aiFormatValueByField(primaryKey, basePrimaryVal) : "n/a",
            key_numbers: baseSnapshot,
            key_numbers_fmt: Object.fromEntries(
                Object.entries(baseSnapshot).map(([k, v]) => [k, aiFormatValueByField(k, v)])
            )
        },
        candidates,
        direction_hints: directionHints,
        next_action_hint: nextActionHint,
        selection: payload?.selection || null,
        formatting_rules: [
            "Prefer values from fields ending with Fmt.",
            "Do not output placeholder labels like 'field:'.",
            "Must negotiate must list all bullet lines from candidate.must_negotiate_bullets.",
            "Use candidate.strategy.feasibility_line wording for each option."
        ],
        feasibility_reality_bullets: optimizerFeasibilityRealityBullets(payload)
    };
}

function aiFallbackCompare(payload) {
    const type = String(payload?.calculator_type || "");
    const metricKey = String(payload?.primary_metric?.key || primaryMetricByType(type)?.key || "");
    const better = String(payload?.primary_metric?.better || primaryMetricByType(type)?.better || "min");

    const aVal = metricValue(payload?.A?.result_data || {}, metricKey);
    const bVal = metricValue(payload?.B?.result_data || {}, metricKey);
    const winner = String(payload?.winner || (isBetter(aVal, bVal, better) ? "A" : "B"));
    const gap = comparePrimaryGapStats({ aVal, bVal, winner, better });
    const confidence = compareConfidenceFromGapPct(gap.relGapPct);
    const confidenceLine = Number.isFinite(gap.relGapPct)
        ? `- ${confidence.toUpperCase()} confidence: primary-metric edge is ${aiFmtNum(gap.relGapPct, 1)}% (${aiFormatValueByField(metricKey, gap.winnerVal)} vs ${aiFormatValueByField(metricKey, gap.loserVal)}).`
        : "- LOW confidence: primary-metric values are incomplete, validate core outputs first.";

    const keys = Array.from(new Set([metricKey, ...(STALE_CHECK_KEYS_BY_TYPE[type] || [])])).filter(Boolean);
    const diffs = [];
    keys.forEach((k) => {
        const av = metricValue(payload?.A?.result_data || {}, k);
        const bv = metricValue(payload?.B?.result_data || {}, k);
        if (!Number.isFinite(av) || !Number.isFinite(bv) || av === bv) return;
        const relPct = Math.abs(av - bv) / Math.max(Math.abs(av), Math.abs(bv), 1e-9) * 100;
        diffs.push(`- ${aiHumanizeField(k)}: Deal A ${aiFormatValueByField(k, av)} vs Deal B ${aiFormatValueByField(k, bv)} (gap ${aiFmtNum(relPct, 1)}%).`);
    });

    const bestFlip = payload?.bestFlip || null;
    const flipLine = bestFlip && Number.isFinite(bestFlip.threshold)
        ? `- Change ${bestFlip.field} toward ${aiFormatValueByField(bestFlip.field, bestFlip.threshold)}${Number.isFinite(bestFlip.rel_change) ? ` (${aiFmtNum(Math.abs(bestFlip.rel_change) * 100, 1)}% from base)` : ""} to approach winner-level ${aiHumanizeField(metricKey)}.`
        : "- No clean single-parameter flip found in realistic range; test two-parameter scenario pack.";

    return [
        "Winner:",
        `- ${winner} because ${aiHumanizeField(metricKey)} is ${aiFormatValueByField(metricKey, gap.winnerVal)} vs ${aiFormatValueByField(metricKey, gap.loserVal)} (${winner === "A" ? "A vs B" : "B vs A"}).`,
        "",
        "Confidence:",
        confidenceLine,
        "",
        "Key differences:",
        ...(diffs.length ? diffs.slice(0, 4) : ["- Core differences are limited; run deeper scenarios to separate outcomes."]),
        "",
        "What assumption flips it:",
        flipLine,
        "",
        "Recommended next run:",
        `- ${bestFlip ? `Run Scenarios on the losing deal with ${bestFlip.field} near ${aiFormatValueByField(bestFlip.field, bestFlip.threshold)}.` : "Run Optimizer on the losing deal for the primary metric."}`
    ].join("\n");
}

function aiFallbackOptimizer(payload) {
    const type = String(payload?.calculator_type || "");
    const goal = payload?.goal || {};
    const goalKey = String(goal.metric || primaryMetricByType(type)?.key || "");
    const goalOp = String(goal.op || "<=");
    const goalVal = Number(goal.value);
    const baseInput = payload?.base?.input_data || {};
    const baseResult = payload?.base?.result_data || {};
    const directionHints = optimizerDirectionHintsFromPayload(payload);
    const baseGoalMetric = metricValue(baseResult, goalKey);
    const status = payload?.achieved ? "Achieved" : "Not achieved (closest found)";

    const candRaw = Array.isArray(payload?.candidates) ? payload.candidates.slice(0, 3) : [];
    while (candRaw.length < 3) {
        candRaw.push({ input_data: baseInput, result_data: baseResult, negotiation: null, _base: true });
    }

    const blocks = candRaw.map((c, idx) => {
        const changes = diffInputData(baseInput, c?.input_data || {}, 2);
        const title = changes.length
            ? `${aiHumanizeField(changes[0].field)} ${changes[0].from} -> ${changes[0].to}`
            : "Base configuration (no changes)";
        const gVal = metricValue(c?.result_data || {}, goalKey);
        const primary = primaryMetricByType(type)?.key || goalKey;
        const pVal = metricValue(c?.result_data || {}, primary);
        const goalStatus = c?.goal?.ok ? "Achieved" : "Closest above target";
        const negotiationRows = optimizerNegotiationRowsForOutput(
            Array.isArray(c?.negotiation) ? c.negotiation : [],
            { type, goalMetric: goalKey, directionHints }
        );
        const strategy = c?.strategy || optimizerStrategyMetaFromNegotiation(negotiationRows);
        const strategyLine = String(strategy?.note || "").trim() || "No clear dominant lever; small balanced adjustments.";
        const feasibilityLabel = optimizerFeasibilityLevelLabel(strategy?.feasibility);
        const feasibilityReason = optimizerFeasibilityReason({ strategy, negotiation: negotiationRows });
        const tradeoffLine = optimizerTradeoffLine(c, payload);
        let negotiateRows = [];
        if (negotiationRows.length) {
            negotiateRows = negotiationRows.map((n) => {
                const from = aiFormatValueByField(n.field, toNum(n.from, NaN));
                const to = aiFormatValueByField(n.field, toNum(n.to, NaN));
                const relPct = Number.isFinite(n.rel) ? `${aiFmtNum(Math.abs(n.rel) * 100, 1)}%` : "n/a";
                return `   - ${aiHumanizeField(n.field)}: ${to} (${n.dir} from ${from}, change ${relPct}).`;
            });
        } else if (changes.length) {
            negotiateRows = [`   - ${aiHumanizeField(changes[0].field)} toward ${changes[0].to}.`];
        } else {
            negotiateRows = ["   - No mandatory change identified."];
        }

        return [
            `${idx + 1}) ${title}`,
            `   - Goal status: ${goalStatus}.`,
            `   - Strategy: ${strategyLine}`,
            `   - Goal metric ${aiHumanizeField(goalKey)}: ${aiFormatValueByField(goalKey, gVal)}.`,
            `   - Primary metric ${aiHumanizeField(primary)}: ${aiFormatValueByField(primary, pVal)}.`,
            `   - Why it works: adjusts controllable inputs toward the target boundary.`,
            `   - Trade-off: ${tradeoffLine}`,
            "   Must negotiate:",
            ...negotiateRows,
            `   - Feasibility: ${feasibilityLabel} - ${feasibilityReason}.`
        ].join("\n");
    });

    const levers = compareLeversByType(type, baseInput).slice(0, 3);
    const feasibilityRows = candRaw.map((c, idx) => {
        const negotiationRows = optimizerNegotiationRowsForOutput(
            Array.isArray(c?.negotiation) ? c.negotiation : [],
            { type, goalMetric: goalKey, directionHints }
        );
        const strategy = c?.strategy || optimizerStrategyMetaFromNegotiation(negotiationRows);
        const level = optimizerFeasibilityLevelLabel(strategy?.feasibility);
        const note = String(strategy?.note || "Balanced small adjustments are required.").trim();
        return `- Option ${idx + 1}: ${level} feasibility. ${note}`;
    });
    const realityRows = optimizerFeasibilityRealityBullets({
        ...payload,
        candidates: candRaw
    });
    const nextActionHint = optimizerNextActionHint(payload);
    return [
        "Goal:",
        `- ${aiHumanizeField(goalKey)} ${goalOp} ${Number.isFinite(goalVal) ? aiFormatValueByField(goalKey, goalVal) : "target value"}`,
        "Status:",
        `- ${status}`,
        "",
        "Top 3 configurations:",
        ...blocks,
        "",
        "Main driver:",
        `- Base ${aiHumanizeField(goalKey)}: ${aiFormatValueByField(goalKey, baseGoalMetric)}.`,
        `- Candidate ranking prioritizes goal satisfaction and lower change-cost.`,
        `- Most influence comes from: ${(levers.length ? levers.map(aiHumanizeField).join(", ") : "core cost inputs")}.`,
        "",
        "Risks / checks:",
        "- Verify negotiated inputs are realistic before execution.",
        "- Re-run with stress assumptions (+/-10%) for robustness.",
        "- Confirm any missing operating costs are included.",
        "",
        "Feasibility / realism:",
        ...(realityRows.length ? realityRows : feasibilityRows),
        "",
        "Recommended next action:",
        nextActionHint?.bullet || `- ${levers[0] ? `Run Scenarios focused on ${levers[0]} and ${levers[1] || levers[0]}.` : "Run Scenarios to validate optimizer output under stress."}`
    ].join("\n");
}

function aiOptimizerStructureStrong(text) {
    const t = aiNormalizeText(text);
    if (!t) return false;

    const numbered = (t.match(/^\s*[1-3]\)\s+/gm) || []).length;
    if (numbered < 3) return false;

    const mustCount = (t.match(/Must negotiate:/gi) || []).length;
    if (mustCount < 3) return false;

    const feasCount = (t.match(/Feasibility:\s*/gi) || []).length;
    if (feasCount < 3) return false;

    const tradeoffCount = (t.match(/Trade-off:\s*/gi) || []).length;
    if (tradeoffCount < 3) return false;

    // Guard against placeholder-style output like "- field: price"
    if (/\n\s*-\s*field:\s*/i.test(t)) return false;

    return true;
}

function optimizerReplaceRecommendedSection(text, bulletLine) {
    const t = aiNormalizeText(text);
    if (!t) return t;
    const bullet = String(bulletLine || "").trim();
    if (!bullet) return t;

    const idx = t.search(/(^|\n)\s*Recommended next action\s*:/i);
    if (idx < 0) {
        return `${t}\n\nRecommended next action:\n${bullet}`.trim();
    }
    const head = t.slice(0, idx).trimEnd();
    return `${head}\n\nRecommended next action:\n${bullet}`.trim();
}

function optimizerReplaceFeasibilityRealitySection(text, bullets) {
    const t = aiNormalizeText(text);
    if (!t) return t;
    const rows = (Array.isArray(bullets) ? bullets : [])
        .map((x) => String(x || "").trim())
        .filter(Boolean)
        .slice(0, 3);
    if (!rows.length) return t;

    const block = `Feasibility / realism:\n${rows.join("\n")}`;
    const re = /(^|\n)\s*Feasibility \/ realism\s*:\s*\n[\s\S]*?(?=\n\s*Recommended next action\s*:|\s*$)/i;
    if (re.test(t)) {
        return t.replace(re, (match, prefix = "\n") => `${prefix}${block}\n`);
    }
    return `${t}\n\n${block}`.trim();
}

function optimizerGoalBulletFromPayload(payload) {
    const goal = payload?.goal || {};
    const key = String(goal?.metric || "");
    const op = String(goal?.op || "<=");
    const value = toNum(goal?.value, NaN);
    const keyHuman = aiHumanizeField(key || "metric");
    const valueFmt = Number.isFinite(value) ? aiFormatValueByField(key, value) : "target value";
    return `- ${keyHuman} ${op} ${valueFmt}`;
}

function optimizerReplaceGoalSection(text, payload) {
    const t = aiNormalizeText(text);
    if (!t) return t;
    const bullet = optimizerGoalBulletFromPayload(payload);
    const block = `Goal:\n${bullet}`;

    const re = /(^|\n)\s*Goal\s*:\s*\n[\s\S]*?(?=\n\s*Status\s*:|\s*$)/i;
    if (re.test(t)) {
        return t.replace(re, (match, prefix = "\n") => `${prefix}${block}\n`);
    }

    const statusIdx = t.search(/(^|\n)\s*Status\s*:/i);
    if (statusIdx >= 0) {
        const head = t.slice(0, statusIdx).trimEnd();
        const tail = t.slice(statusIdx).trimStart();
        return `${head}\n\n${block}\n\n${tail}`.trim();
    }
    return `${block}\n\n${t}`.trim();
}

function aiEnforceOptimizerDeterministicSections(text, payload) {
    let out = aiNormalizeText(text);
    if (!out) return out;

    out = optimizerReplaceGoalSection(out, payload);
    const directionHints = optimizerDirectionHintsFromPayload(payload);

    const candidates = Array.isArray(payload?.candidates) ? payload.candidates.slice(0, 3) : [];
    if (candidates.length) {
        const mustRowsByOption = [0, 1, 2].map((idx) => optimizerMustNegotiateBulletRows(
            candidates[idx] || {},
            { type: payload?.calculator_type, goalMetric: payload?.goal?.metric, directionHints }
        ));
        const tradeoffByOption = [0, 1, 2].map((idx) =>
            optimizerTradeoffLine(candidates[idx] || {}, payload)
        );
        const feasibilityLines = [0, 1, 2].map((idx) => {
            const c = candidates[idx] || {};
            const negotiationRows = optimizerNegotiationRowsForOutput(
                Array.isArray(c?.negotiation) ? c.negotiation : [],
                { type: payload?.calculator_type, goalMetric: payload?.goal?.metric, directionHints }
            );
            const strategy = c?.strategy || optimizerStrategyMetaFromNegotiation(negotiationRows);
            const level = optimizerFeasibilityLevelLabel(strategy?.feasibility);
            const reason = optimizerFeasibilityReason({ strategy, negotiation: negotiationRows });
            return `Feasibility: ${level} - ${reason}.`;
        });
        const lines = out.split("\n");
        const rewritten = [];
        let currentOption = 0;
        let insideMust = false;
        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            const start = /^\s*([1-3])\)\s+/.exec(raw);
            if (start) currentOption = Number(start[1]);
            if (/^\s*Main driver\s*:/i.test(raw)) {
                currentOption = 0;
                insideMust = false;
            }

            if (currentOption >= 1 && currentOption <= 3 && /^\s*Must negotiate\s*:/i.test(raw)) {
                const indent = (raw.match(/^(\s*)/) || ["", ""])[1];
                rewritten.push(`${indent}Must negotiate:`);
                const mustRows = mustRowsByOption[currentOption - 1] || [];
                for (const row of mustRows) rewritten.push(`${indent}   - ${row}`);
                rewritten.push(`${indent}   - ${feasibilityLines[currentOption - 1]}`);
                insideMust = true;
                continue;
            }

            if (currentOption >= 1 && currentOption <= 3 && /^\s*-\s*Trade-off:/i.test(raw)) {
                const indent = (raw.match(/^(\s*)/) || ["", ""])[1];
                rewritten.push(`${indent}- Trade-off: ${tradeoffByOption[currentOption - 1]}`);
                continue;
            }

            if (insideMust && currentOption >= 1 && currentOption <= 3) {
                if (/^\s*-\s*Feasibility:/i.test(raw)) {
                    insideMust = false;
                    continue;
                }
                if (/^\s*-\s*/.test(raw)) {
                    continue;
                }
                if (/^\s*([1-3])\)\s+/.test(raw) || /^\s*Main driver\s*:/i.test(raw)) {
                    insideMust = false;
                } else {
                    continue;
                }
            }
            rewritten.push(raw);
        }
        out = rewritten.join("\n");
    }

    const feasibilityReality = optimizerFeasibilityRealityBullets(payload);
    out = optimizerReplaceFeasibilityRealitySection(out, feasibilityReality);

    const nextActionHint = optimizerNextActionHint(payload);
    if (nextActionHint?.bullet) out = optimizerReplaceRecommendedSection(out, nextActionHint.bullet);

    return aiNormalizeText(out);
}

function deepDiveMetricBetter(type, key) {
    const t = String(type || "");
    const k = String(key || "");
    if (!k) return "min";
    if (k === "rentMinusBuyNet") return "max";

    const catalog = optimizerMetricCatalogByType(t);
    const byCatalog = Array.isArray(catalog) ? catalog.find((x) => String(x?.key || "") === k) : null;
    if (byCatalog?.better === "max") return "max";
    if (byCatalog?.better === "min") return "min";

    if (/(cost|payment|interest|tax|overpayment|payback|breakEven)/i.test(k)) return "min";
    return "max";
}

function deepDiveMetricValue(type, resultData, key) {
    if (String(key || "") === "rentMinusBuyNet") {
        const rentTotal = metricValue(resultData || {}, "rentTotal");
        const buyNetCost = metricValue(resultData || {}, "buyNetCost");
        if (!Number.isFinite(rentTotal) || !Number.isFinite(buyNetCost)) return NaN;
        return rentTotal - buyNetCost;
    }
    return metricValue(resultData || {}, key);
}

function deepDiveDeltaRows(payload) {
    const type = String(payload?.calculator_type || "");
    const primaryKey = String(primaryMetricByType(type)?.key || "");
    const keys = Array.from(new Set([primaryKey, ...(STALE_CHECK_KEYS_BY_TYPE[type] || [])])).filter(Boolean);
    if (type === "rent_vs_buy") keys.push("rentMinusBuyNet");

    const out = [];
    for (const key of keys) {
        const baseVal = deepDiveMetricValue(type, payload?.baseline_result || {}, key);
        const curVal = deepDiveMetricValue(type, payload?.result_data || {}, key);
        if (!Number.isFinite(baseVal) || !Number.isFinite(curVal)) continue;

        const delta = curVal - baseVal;
        const better = deepDiveMetricBetter(type, key);
        const improves = better === "min" ? delta < 0 : delta > 0;
        const worsens = better === "min" ? delta > 0 : delta < 0;
        out.push({
            key,
            label: aiHumanizeField(key),
            better,
            baseVal,
            curVal,
            delta,
            baseFmt: aiFormatValueByField(key, baseVal),
            curFmt: aiFormatValueByField(key, curVal),
            deltaFmt: aiFormatSignedByField(key, delta),
            improves,
            worsens,
            absDelta: Math.abs(delta)
        });
    }

    out.sort((a, b) => {
        if (a.key === primaryKey && b.key !== primaryKey) return -1;
        if (b.key === primaryKey && a.key !== primaryKey) return 1;
        return Number(b.absDelta || 0) - Number(a.absDelta || 0);
    });
    return out;
}

function deepDiveInputChangeRows(payload, limit = 6) {
    const baseInput = payload?.baseline_input_data || {};
    const curInput = payload?.input_data || {};
    const src = diffInputData(baseInput, curInput, Math.max(6, limit * 2));

    const rows = src.map((row) => {
        const field = String(row?.field || "").trim();
        const fromNum = toNum(row?.from, NaN);
        const toNumVal = toNum(row?.to, NaN);
        const relAbs = (Number.isFinite(fromNum) && Number.isFinite(toNumVal) && fromNum !== 0)
            ? Math.abs((toNumVal - fromNum) / fromNum)
            : NaN;
        const fromFmt = Number.isFinite(fromNum) ? aiFormatValueByField(field, fromNum) : String(row?.from);
        const toFmt = Number.isFinite(toNumVal) ? aiFormatValueByField(field, toNumVal) : String(row?.to);
        return {
            field,
            label: aiHumanizeField(field),
            fromNum,
            toNum: toNumVal,
            fromFmt,
            toFmt,
            relAbs,
            relFmt: Number.isFinite(relAbs) ? `${aiFmtNum(relAbs * 100, 1)}% change` : ""
        };
    });

    rows.sort((a, b) => {
        const ar = Number.isFinite(a.relAbs) ? a.relAbs : -1;
        const br = Number.isFinite(b.relAbs) ? b.relAbs : -1;
        if (br !== ar) return br - ar;
        const ad = Math.abs(toNum(a?.toNum, 0) - toNum(a?.fromNum, 0));
        const bd = Math.abs(toNum(b?.toNum, 0) - toNum(b?.fromNum, 0));
        return bd - ad;
    });

    return rows.slice(0, limit);
}

function deepDiveMissingChecklist(type, payload, max = 5) {
    const out = [];
    const seen = new Set();
    const add = (raw) => {
        const s = String(raw || "").trim();
        if (!s) return;
        const key = s.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(s);
    };

    const fromPayload = Array.isArray(payload?.derived_metrics?.missingChecklist)
        ? payload.derived_metrics.missingChecklist
        : [];
    fromPayload.forEach(add);

    const fallbackByType = {
        mortgage: [
            "Monthly net income (after tax) to validate payment-to-income ratio.",
            "Property tax + insurance + HOA estimate for all-in monthly payment.",
            "Emergency buffer coverage in months of payments."
        ],
        rent_vs_buy: [
            "Buying one-time costs (closing costs) if not included.",
            "Ongoing ownership costs (tax/insurance/maintenance/HOA) if not included.",
            "Move probability and horizon realism (years)."
        ],
        cash_flow: [
            "Vacancy stress and collection loss assumptions.",
            "Repair capex reserve and irregular maintenance spikes.",
            "Property management and leasing costs under stress."
        ],
        property_irr: [
            "Exit price and liquidity assumptions at sale.",
            "Stability of rent growth and expense inflation.",
            "Tax/fee treatment on sale and cash flows."
        ],
        default: [
            "Stress assumptions (+/-10%) around the main driver.",
            "Realistic execution constraints for changed inputs.",
            "Any missing recurring costs or taxes."
        ]
    };

    const fb = fallbackByType[type] || fallbackByType.default;
    fb.forEach(add);

    return out.slice(0, Math.max(2, max));
}

function deepDiveDirectionHintsForPrimary(payload, primary) {
    const type = String(payload?.calculator_type || "");
    const input = payload?.input_data || {};
    const result = payload?.result_data || {};
    const key = String(primary?.key || "");
    const better = String(primary?.better || "min");
    const value = toNum(primary?.current, NaN);
    if (!key || !Number.isFinite(value)) return {};

    const goal = { metric: key, op: better === "min" ? "<=" : ">=", value };
    return optimizerDirectionHints(type, goal, input, result);
}

function deepDiveTargetValue(field, inputData, direction) {
    const fieldKey = String(field || "");
    const input = inputData || {};
    const base = toNum(input?.[fieldKey], NaN);
    const rng = leverRange(fieldKey, input);

    if (!Number.isFinite(base) || !rng || !Number.isFinite(rng.lo) || !Number.isFinite(rng.hi) || rng.hi <= rng.lo) {
        return aiSuggestTargetValue(input, fieldKey);
    }

    const dir = String(direction || "").trim().toLowerCase();
    let raw = base;
    if (dir === "down") raw = base - Math.abs(base - rng.lo) * 0.55;
    else if (dir === "up") raw = base + Math.abs(rng.hi - base) * 0.55;
    else raw = aiSuggestTargetValue(input, fieldKey);

    if (!Number.isFinite(raw)) return aiSuggestTargetValue(input, fieldKey);

    const normalized = normalizeLeverValueForField(fieldKey, raw, input);
    if (Number.isFinite(normalized) && normalized !== base) return normalized;

    const fallbackRaw = dir === "down" ? rng.lo : (dir === "up" ? rng.hi : base);
    const fallbackNorm = normalizeLeverValueForField(fieldKey, fallbackRaw, input);
    if (Number.isFinite(fallbackNorm) && fallbackNorm !== base) return fallbackNorm;

    return aiSuggestTargetValue(input, fieldKey);
}

function deepDiveProjectedPrimary(type, currentInput, field, target, primaryKey) {
    const input = currentInput || {};
    const targetVal = toNum(target, NaN);
    if (!Number.isFinite(targetVal) || !String(field || "") || !String(primaryKey || "")) return { value: NaN, delta: NaN };

    let baseResult = null;
    try {
        baseResult = computeResultByType(type, input);
    } catch {
        baseResult = null;
    }
    const basePrimary = deepDiveMetricValue(type, baseResult || {}, primaryKey);

    const probeInput = { ...input, [field]: targetVal };
    let probeResult = null;
    try {
        probeResult = computeResultByType(type, probeInput);
    } catch {
        probeResult = null;
    }
    const probePrimary = deepDiveMetricValue(type, probeResult || {}, primaryKey);
    if (!Number.isFinite(probePrimary)) return { value: NaN, delta: NaN };

    const delta = Number.isFinite(basePrimary) ? (probePrimary - basePrimary) : NaN;
    return { value: probePrimary, delta };
}

function deepDiveMainDriverBullets(primary, deltaRows, changeRows) {
    const out = [];
    if (primary?.key && Number.isFinite(primary?.current)) {
        if (Number.isFinite(primary?.delta)) {
            out.push(`- ${primary.label} moved from ${primary.baseFmt} to ${primary.currentFmt} (${primary.deltaFmt} vs baseline).`);
        } else {
            out.push(`- ${primary.label} is ${primary.currentFmt} in this scenario.`);
        }
    }

    const secondary = (Array.isArray(deltaRows) ? deltaRows : []).find((x) => String(x?.key || "") !== String(primary?.key || ""));
    if (secondary) {
        out.push(`- Secondary metric: ${secondary.label} is ${secondary.curFmt} (${secondary.deltaFmt} vs baseline).`);
    }

    const topChange = Array.isArray(changeRows) ? changeRows[0] : null;
    if (topChange) {
        out.push(`- Biggest input shift: ${topChange.label} ${topChange.fromFmt} -> ${topChange.toFmt}${topChange.relFmt ? ` (${topChange.relFmt})` : ""}.`);
    }

    while (out.length < 3) out.push("- Validate this driver with one additional downside stress scenario.");
    return out.slice(0, 3);
}

function deepDiveRiskBullets(primary, deltaRows, changeRows, missingRows) {
    const out = [];
    if (Number.isFinite(primary?.delta)) {
        if (primary?.improves) out.push(`- Current edge is ${primary.deltaFmt} vs baseline on ${primary.label}; adverse moves can compress this advantage.`);
        else if (primary?.worsens) out.push(`- ${primary.label} is ${primary.deltaFmt} vs baseline; confirm this downside is acceptable.`);
        else out.push("- Primary metric is near baseline; small assumption changes can flip the conclusion.");
    } else if (Number.isFinite(primary?.current)) {
        out.push(`- ${primary.label} stands at ${primary.currentFmt}; run stress checks to verify robustness.`);
    }

    const topChange = Array.isArray(changeRows) ? changeRows[0] : null;
    if (topChange) {
        out.push(`- ${topChange.label} moved to ${topChange.toFmt}; test +/-10% around this level to measure fragility.`);
    }

    const secondary = (Array.isArray(deltaRows) ? deltaRows : []).find((x) => String(x?.key || "") !== String(primary?.key || ""));
    if (secondary) {
        out.push(`- Secondary driver ${secondary.label} moved ${secondary.deltaFmt}; monitor it before final decision.`);
    }

    if (out.length < 3 && Array.isArray(missingRows) && missingRows[0]) {
        out.push(`- Missing assumption still open: ${missingRows[0]}.`);
    }

    while (out.length < 3) out.push("- Run one adverse stress case before execution.");
    return out.slice(0, 3);
}

function deepDiveBestLeverBullets(payload, primary, changeRows) {
    const type = String(payload?.calculator_type || "");
    const input = payload?.input_data || {};
    const directionHints = deepDiveDirectionHintsForPrimary(payload, primary);
    const changedFields = (Array.isArray(changeRows) ? changeRows : []).map((x) => String(x?.field || "").trim()).filter(Boolean);
    const baseLevers = compareLeversByType(type, input).map((x) => String(x || "").trim()).filter(Boolean);
    const merged = Array.from(new Set([...changedFields, ...baseLevers]));

    const rows = [];
    for (const field of merged) {
        if (!field) continue;
        const currentVal = toNum(input?.[field], NaN);
        if (!Number.isFinite(currentVal)) continue;

        const direction = String(directionHints?.[field] || leverRange(field, input)?.prefer || "").toLowerCase();
        const target = deepDiveTargetValue(field, input, direction);
        const targetVal = toNum(target, NaN);
        if (!Number.isFinite(targetVal) || targetVal === currentVal) continue;

        const projected = deepDiveProjectedPrimary(type, input, field, targetVal, primary?.key || "");
        const action = direction === "down" ? "reduce" : (direction === "up" ? "increase" : "adjust");
        let line = `- ${aiHumanizeField(field)}: ${action} toward ${aiFormatValueByField(field, targetVal)} (from ${aiFormatValueByField(field, currentVal)}).`;
        if (Number.isFinite(projected?.value) && Number.isFinite(projected?.delta)) {
            line += ` Projected ${primary?.label || "primary metric"} ~ ${aiFormatValueByField(primary?.key || "", projected.value)} (${aiFormatSignedByField(primary?.key || "", projected.delta)} vs current).`;
        } else {
            line += ` Re-check ${primary?.label || "primary metric"} after this change.`;
        }
        rows.push(line);
        if (rows.length >= 3) break;
    }

    while (rows.length < 3) {
        rows.push(`- Test one controllable lever and re-check ${primary?.label || "the primary metric"} under base and stress assumptions.`);
    }
    return rows.slice(0, 3);
}

function deepDiveNegotiateOneThingBullet(payload, primary, changeRows, deltaRows) {
    const type = String(payload?.calculator_type || "");
    const input = payload?.input_data || {};
    const directionHints = deepDiveDirectionHintsForPrimary(payload, primary);
    const changed = Array.isArray(changeRows) ? changeRows : [];
    const levers = compareLeversByType(type, input).map((x) => String(x || "").trim()).filter(Boolean);

    let field = String(changed?.[0]?.field || "").trim();
    if (!field) {
        field = levers.find((f) => Number.isFinite(toNum(input?.[f], NaN)))
            || String(deltaRows?.[0]?.key || "")
            || "price";
    }

    const currentVal = toNum(input?.[field], NaN);
    const direction = String(directionHints?.[field] || leverRange(field, input)?.prefer || "").toLowerCase();
    const target = deepDiveTargetValue(field, input, direction);
    const targetVal = toNum(target, NaN);
    const action = direction === "down" ? "reduce" : (direction === "up" ? "increase" : "adjust");

    if (Number.isFinite(currentVal) && Number.isFinite(targetVal) && targetVal !== currentVal) {
        const goalDir = String(primary?.better || "min") === "min" ? "down" : "up";
        return `- Prioritize ${aiHumanizeField(field)}: ${action} from ${aiFormatValueByField(field, currentVal)} to ${aiFormatValueByField(field, targetVal)} to push ${primary?.label || "primary metric"} ${goalDir}.`;
    }
    return `- Prioritize ${aiHumanizeField(field)} first, then validate impact on ${primary?.label || "the primary metric"} with one stress rerun.`;
}

function aiBuildDeepDiveDeterministic(payload) {
    const type = String(payload?.calculator_type || "");
    const scenarioLabel = String(payload?.scenario_label || "Scenario").trim();
    const icon = normalizeVerdictIcon(payload?.mini_verdict?.icon) || "ℹ️";
    const miniText = String(payload?.mini_verdict?.text || "Outcome summary for this scenario.").trim();

    const primaryMeta = primaryMetricByType(type) || { key: "", better: "min" };
    const primaryKey = String(primaryMeta?.key || "");
    const primaryBetter = String(primaryMeta?.better || deepDiveMetricBetter(type, primaryKey));
    const primaryCurrent = deepDiveMetricValue(type, payload?.result_data || {}, primaryKey);
    const primaryBase = deepDiveMetricValue(type, payload?.baseline_result || {}, primaryKey);
    const primaryDelta = Number.isFinite(primaryCurrent) && Number.isFinite(primaryBase)
        ? (primaryCurrent - primaryBase)
        : NaN;
    const primary = {
        key: primaryKey,
        better: primaryBetter,
        label: aiHumanizeField(primaryKey || "primary metric"),
        current: primaryCurrent,
        base: primaryBase,
        delta: primaryDelta,
        currentFmt: Number.isFinite(primaryCurrent) ? aiFormatValueByField(primaryKey, primaryCurrent) : "n/a",
        baseFmt: Number.isFinite(primaryBase) ? aiFormatValueByField(primaryKey, primaryBase) : "n/a",
        deltaFmt: Number.isFinite(primaryDelta) ? aiFormatSignedByField(primaryKey, primaryDelta) : "n/a",
        improves: Number.isFinite(primaryDelta) ? (primaryBetter === "min" ? primaryDelta < 0 : primaryDelta > 0) : false,
        worsens: Number.isFinite(primaryDelta) ? (primaryBetter === "min" ? primaryDelta > 0 : primaryDelta < 0) : false
    };

    const deltaRows = deepDiveDeltaRows(payload);
    const changeRows = deepDiveInputChangeRows(payload, 6);
    const missingRows = deepDiveMissingChecklist(type, payload, 5);
    const mainDriverRows = deepDiveMainDriverBullets(primary, deltaRows, changeRows);
    const riskRows = deepDiveRiskBullets(primary, deltaRows, changeRows, missingRows);
    const bestLeverRows = deepDiveBestLeverBullets(payload, primary, changeRows);
    const negotiateOne = deepDiveNegotiateOneThingBullet(payload, primary, changeRows, deltaRows);

    let baselineStatus = "low-impact vs baseline";
    if (Number.isFinite(primary.delta)) {
        const lowBand = Math.max(Math.abs(toNum(primary.base, 0)) * 0.01, 1);
        if (Math.abs(primary.delta) <= lowBand) baselineStatus = "low-impact vs baseline";
        else baselineStatus = primary.improves ? "better vs baseline" : "worse vs baseline";
    }

    const verdictLine = `Verdict: ${icon} ${miniText}${primary.key && Number.isFinite(primary.current) ? ` ${primary.label} is ${primary.currentFmt}${Number.isFinite(primary.delta) ? ` (${primary.deltaFmt} vs baseline)` : ""}.` : ""} This scenario is ${baselineStatus}.`;

    return aiNormalizeText([
        `Scenario: ${scenarioLabel}`,
        "",
        verdictLine,
        "",
        "Main driver (what moved the outcome):",
        ...mainDriverRows.slice(0, 3),
        "",
        "Risk & fragility (stress points):",
        ...riskRows.slice(0, 3),
        "",
        "Missing assumptions checklist:",
        ...(missingRows.length ? missingRows.slice(0, 5).map((x) => `- ${x}.`) : ["- Validate missing cost assumptions and horizon realism."]),
        "",
        "Best next lever (highest ROI change):",
        ...bestLeverRows.slice(0, 3),
        "",
        "If you had to negotiate ONE thing (price/rent/fees):",
        negotiateOne
    ].join("\n"));
}

function aiFallbackDeepDive(payload) {
    return aiBuildDeepDiveDeterministic(payload);
}

function aiFallbackPortfolio(payload) {
    const byType = payload?.byTypeCounts && typeof payload.byTypeCounts === "object" ? payload.byTypeCounts : {};
    const verdictCounts = payload?.verdictCounts && typeof payload.verdictCounts === "object" ? payload.verdictCounts : {};
    const missingTop = Array.isArray(payload?.missingTop) ? payload.missingTop : [];
    const samples = Array.isArray(payload?.samples) ? payload.samples : [];

    const typeRows = Object.entries(byType)
        .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
        .slice(0, 6)
        .map(([k, v]) => `- ${humanNameSSR(k)}: ${aiFmtNum(v, 0)} deal(s).`);
    const verdictRow = `- Verdict mix: good ${aiFmtNum(verdictCounts.good || 0, 0)}, warn ${aiFmtNum(verdictCounts.warn || 0, 0)}, bad ${aiFmtNum(verdictCounts.bad || 0, 0)}, info ${aiFmtNum(verdictCounts.info || 0, 0)}.`;

    const riskRows = [];
    if (Number(verdictCounts.bad || 0) > 0) {
        riskRows.push(`- ${aiFmtNum(verdictCounts.bad, 0)} deal(s) are in bad zone; review these first for downside control.`);
    }
    if (Number(verdictCounts.warn || 0) > 0) {
        riskRows.push(`- ${aiFmtNum(verdictCounts.warn, 0)} deal(s) are in warning zone; run stress scenarios before committing.`);
    }
    if (!riskRows.length) riskRows.push("- No severe risk concentration detected in current snapshot.");

    const oppRows = [];
    if (Number(verdictCounts.good || 0) > 0) {
        oppRows.push(`- ${aiFmtNum(verdictCounts.good, 0)} deal(s) are good candidates for optimization and scaling.`);
    }
    if (samples[0]?.calculator_type) {
        oppRows.push(`- Start with ${humanNameSSR(samples[0].calculator_type)} deals: they are the freshest data in your workspace.`);
    }
    if (!oppRows.length) oppRows.push("- Build a wider sample (more calculators) to increase portfolio signal quality.");

    const missingRows = missingTop.length
        ? missingTop.slice(0, 5).map((x) => `- ${x.item}: ${aiFmtNum(x.count, 0)} occurrence(s).`)
        : ["- No dominant missing-assumption cluster detected."];

    return [
        "Portfolio snapshot:",
        ...(typeRows.length ? typeRows : ["- No type distribution available."]),
        verdictRow,
        "",
        "Top risks:",
        ...riskRows.slice(0, 5),
        "",
        "Top opportunities:",
        ...oppRows.slice(0, 5),
        "",
        "Missing assumptions (most common):",
        ...missingRows,
        "",
        "What I would do next (in order):",
        "1) Run Scenarios on highest-risk deals to quantify downside.",
        "2) Run Optimizer on strongest candidates to lock target metrics.",
        "3) Run Compare on top two alternatives before execution."
    ].join("\n");
}

function aiEnsureUsefulVerdict(text, payload) {
    const cfg = {
        minChars: 320,
        minNumbers: 6,
        requiredSections: [
            "Verdict",
            "Why this verdict",
            "Key numbers",
            "Missing checklist",
            "What to do to improve the result",
            "Sensitivity quick test",
            "Next runs inside the app"
        ]
    };
    return aiLooksUseful(text, cfg) ? aiNormalizeText(text) : aiFallbackFullVerdict(payload);
}

function aiEnsureUsefulScenario(text, payload) {
    const cfg = {
        minChars: 220,
        minNumbers: 4,
        requiredSections: [
            "Scenario",
            "Verdict",
            "Tag",
            "Main driver",
            "What changed (inputs you control)",
            "Impact vs baseline (numbers)",
            "Trade-off / note",
            "Recommendation"
        ]
    };
    return aiLooksUseful(text, cfg) ? aiNormalizeText(text) : aiFallbackScenario(payload);
}

function aiEnsureUsefulCompare(text, payload) {
    const cfg = {
        minChars: 220,
        minNumbers: 5,
        requiredSections: [
            "Winner",
            "Confidence",
            "Key differences",
            "What assumption flips it",
            "Recommended next run"
        ]
    };
    return aiLooksUseful(text, cfg) ? aiNormalizeText(text) : aiFallbackCompare(payload);
}

function aiEnsureUsefulOptimizer(text, payload) {
    const cfg = {
        minChars: 300,
        minNumbers: 8,
        requiredSections: [
            "Goal",
            "Status",
            "Top 3 configurations",
            "Main driver",
            "Risks / checks",
            "Feasibility / realism",
            "Recommended next action"
        ]
    };
    const normalized = aiEnforceOptimizerDeterministicSections(text, payload);
    if (aiLooksUseful(normalized, cfg) && aiOptimizerStructureStrong(normalized)) return normalized;
    return aiFallbackOptimizer(payload);
}

function aiEnsureUsefulDeepDive(text, payload) {
    const cfg = {
        minChars: 260,
        minNumbers: 5,
        requiredSections: [
            "Scenario",
            "Verdict",
            "Main driver (what moved the outcome)",
            "Risk & fragility (stress points)",
            "Missing assumptions checklist",
            "Best next lever (highest ROI change)",
            "If you had to negotiate ONE thing (price/rent/fees)"
        ]
    };
    const normalized = aiBuildDeepDiveDeterministic(payload);
    if (aiLooksUseful(normalized, cfg)) return normalized;
    return aiFallbackDeepDive(payload);
}

function aiEnsureUsefulPortfolio(text, payload) {
    const cfg = {
        minChars: 260,
        minNumbers: 5,
        requiredSections: [
            "Portfolio snapshot",
            "Top risks",
            "Top opportunities",
            "Missing assumptions (most common)",
            "What I would do next (in order)"
        ]
    };
    return aiLooksUseful(text, cfg) ? aiNormalizeText(text) : aiFallbackPortfolio(payload);
}


async function getAuthForSSR(req, db) {
    const out = { loggedIn: false, email: null, initial: "A", authClass: "auth--guest" };
    if (!req.session?.userId) return out;

    try {
        const r = await db.query("SELECT email FROM users WHERE id=$1", [req.session.userId]);
        const email = r.rows?.[0]?.email;
        if (!email) return out;
        out.loggedIn = true;
        out.email = email;
        out.initial ="A"  //(email[0] || "U").toUpperCase();
        out.authClass = "auth--user";
        return out;
    } catch (e) {
        console.error("SSR auth error:", e);
        return out;
    }
}

async function getAccountDataForSSR(req, db) {
    if (!req.session?.userId) return { calculations: [], wallet: { free_used: false, credits: 0 } };

    const calcs = await db.query(
        `SELECT id, calculator_type, created_at, input_data, result_data
         FROM calculations
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [req.session.userId]
    );

    const w = await db.query(
        `SELECT free_used, credits
         FROM verdict_wallets
         WHERE user_id = $1`,
        [req.session.userId]
    );

    const wallet = w.rowCount
        ? { free_used: !!w.rows[0].free_used, credits: Number(w.rows[0].credits || 0) }
        : { free_used: false, credits: 0 };

    return { calculations: calcs.rows, wallet };
}



// 1) SSR ДОЛЖЕН быть ДО статики
app.use(async (req, res, next) => {
    try {
        if (req.method !== "GET") return next();

        const p = req.path;

        // не трогаем API и ассеты
        if (p.startsWith("/api/")) return next();
        if (/\.[a-zA-Z0-9]+$/.test(p) && !p.endsWith(".html")) return next();

        let rel = decodeURIComponent(p);

        // "/" -> "/index.html"
        if (rel === "/") rel = "/index.html";
        // "/about/" -> "/about/index.html"
        else if (rel.endsWith("/")) rel += "index.html";
        // "/about" -> "/about/index.html"
        else if (!rel.endsWith(".html")) rel += "/index.html";

        const absPath = path.resolve(HTML_ROOT, "." + rel);
        if (!absPath.startsWith(HTML_ROOT + path.sep)) return next();
        await fs.access(absPath);
        
        const isAccount = (p === "/account" || p === "/account/");

        // ✅ редирект если не авторизован
        if (isAccount && !req.session?.userId) {
            return res.redirect("/login/");
        }

        let accountData = null;
        if (isAccount) {
            accountData = await getAccountDataForSSR(req, db);
        }

        
        const tpl = await loadTemplate(absPath);
        const auth = await getAuthForSSR(req, db);

        res.set("Vary", "Cookie");
        res.set("Cache-Control", "no-store");

        const tz = getCookie(req, "tz");
        return res.send(injectAuth(tpl, auth , accountData , tz));
    } catch (e) {
        return next();
    }
});

function humanNameSSR(type) {
    const map = {
        alternative_investment: "Alternative Investments",
        break_even: "Break-even",
        cash_flow: "Cash Flow",
        property_irr: "Property IRR",
        mortgage: "Mortgage",
        ownership_cost: "Ownership Cost",
        property_sale: "Property Sale",
        property_taxes: "Property Taxes",
        mortgage_overpayment: "Mortgage Overpayment",
        renovation_roi: "Renovation ROI",
        rent_vs_buy: "Rent vs Buy"
    };
    return map[type] || type;
}

function escapeHtml(s = "") {
    return String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function aiBtnTextSSR(wallet) {
    const freeUsed = !!wallet?.free_used;

    if (!freeUsed) return "✨Full Analysis (Free)";
    return "✨Full Analysis";
}

function renderCalcListSSR(list, tz , wallet) {
    if (!Array.isArray(list) || list.length === 0) {
        return `<div class="muted">No calculations yet. Create your first calculation to analyze your investment.</div>`;
    }

    return list.map(c => {
        const title = escapeHtml(humanNameSSR(c.calculator_type));
        const dt = new Date(c.created_at);
        const iso = dt.toISOString();

        
        const text = tz ? escapeHtml(formatInTz(dt, tz)) : "";

    
        const readyClass = tz ? " is-ready" : "";

        return `
<div class="calc-item" data-id="${c.id}">
  <div class="calc-info">
    <div class="calc-title">${title}</div>
    <div class="calc-date${readyClass}" data-iso="${escapeHtml(iso)}">${text}</div>
  </div>
  <div class="calc-actions">
    <button class="btn btn-open" data-action="open">▶ Open</button>
    ${(() => {
                const freeUsed = !!wallet?.free_used;
                const credits = Number(wallet?.credits || 0);
                const noCredits = freeUsed && credits <= 0;

                const text = escapeHtml(aiBtnTextSSR(wallet));
                const extraClass = noCredits ? " is-no-credits" : "";

                return `<button class="btn btn-ai${extraClass}" data-action="ai" data-no-credits="${noCredits ? "1" : "0"}">${text}</button>`;
            })()}
    <button class="btn btn-delete" data-action="delete">Delete</button>
  </div>
  <div class="calc-details hidden"></div>
  <div class="ai-details hidden"></div>
</div>`;
    }).join("");
}



function setPromoVisibilitySSR(html, loggedIn) {
    // helper: убрать/добавить hidden в class=""
    function toggleHiddenById(html, id, show) {
        const re = new RegExp(`(<div\\b[^>]*\\bid=["']${id}["'][^>]*\\bclass=["'])([^"']*)(["'][^>]*>)`, "i");
        if (!re.test(html)) return html;

        return html.replace(re, (m, pre, cls, post) => {
            const set = new Set(cls.split(/\s+/).filter(Boolean));
            if (show) set.delete("hidden");
            else set.add("hidden");
            return pre + Array.from(set).join(" ") + post;
        });
    }

    html = toggleHiddenById(html, "guest-promo", !loggedIn); // гость видит 🚀
    html = toggleHiddenById(html, "user-promo", loggedIn);   // юзер видит 💡
    return html;
}

function getCookie(req, name) {
    const raw = req.headers.cookie || "";
    const parts = raw.split(";").map(s => s.trim());
    for (const p of parts) {
        if (p.startsWith(name + "=")) return decodeURIComponent(p.slice(name.length + 1));
    }
    return "";
}

function normalizeMini(m) {
    if (!m || typeof m !== "object") return null;
    const icon = String(m.icon || "");
    const text = String(m.text || "");
    const level = String(m.level || "");
    const okIcon = ["✅", "⚠️", "❌", "ℹ️"].includes(icon);
    const okLevel = ["good", "warn", "bad", "info"].includes(level);
    if (!okIcon || !okLevel || !text.trim()) return null;
    return { level, icon, text: text.trim() };
}

function hasRentOrIncome(payload) {
    const i = payload?.input_data || {};
    const keys = Object.keys(i);
    // что считаем "доходом"
    const hit = keys.find(k => /rent|income|noi|cashflow|revenue/i.test(k) && Number(i[k]) > 0);
    return !!hit;
}

function hasRentOrIncomeFromInput(input) {
    const i = input || {};
    const keys = Object.keys(i);
    const hit = keys.find(k => /rent|income|noi|cashflow|revenue/i.test(k) && Number(i[k]) > 0);
    return !!hit;
}

const REPLACEMENTS = [
    { re: /not suitable for investment purposes/ig, to: "not cost-efficient under these terms" },
    { re: /bad investment/ig, to: "high-cost financing" },
    { re: /not suitable for investment/ig, to: "not cost-efficient" },
    { re: /\binvestment purposes\b/ig, to: "cost-efficiency assessment" },
    { re: /\binvestment\b/ig, to: "financing" },
    { re: /\bROI\b/ig, to: "total cost" },
    { re: /profitab\w*/ig, to: "cost-effective" },
    { re: /cash flow (positive|negative)/ig, to: "monthly affordability" }
];

function sanitizeMortgageVerdict(text, payload) {
    let out = String(text || "").trim();
    if (!out) return out;

    out = stripEmojiVS(out);

    const canJudgeInvestment = hasRentOrIncome(payload);

    // 1) если нет дохода/ренты — режем инвестиционные слова
    if (!canJudgeInvestment) {
        for (const { re, to } of REPLACEMENTS) out = out.replace(re, to);
    }

    // 2) железно фиксируем icon (и убираем ⚠️️️ баг)
    out = forceVerdictLine(out, payload?.mini_verdict?.icon);

    // 3) если модель всё равно написала другой icon — добиваем
    // (после forceVerdictLine это почти не нужно, но оставим)
    const mini = normalizeVerdictIcon(payload?.mini_verdict?.icon);
    if (mini) out = out.replace(/^Verdict:\s*[✅⚠❌ℹ️]+\s*/m, `Verdict: ${mini} `);

    return out.trim();
}


function stripEmojiVS(s) {
    // remove emoji variation selectors that делают "⚠️️️"
    return String(s || "").replace(/[\uFE0E\uFE0F]/g, "");
}

function normalizeVerdictIcon(icon) {
    const clean = stripEmojiVS(icon).trim();
    if (clean.includes("✅")) return "✅";
    if (clean.includes("⚠")) return "⚠️";
    if (clean.includes("❌")) return "❌";
    if (clean.includes("ℹ")) return "ℹ️";
    return null;
}

function forceVerdictLine(text, icon) {
    const ic = normalizeVerdictIcon(icon);
    if (!ic) return text;

    let out = stripEmojiVS(text);

    // берём текущую строку Verdict: ... и чистим её
    const reLine = /^Verdict:\s*(.*)$/m;
    if (reLine.test(out)) {
        out = out.replace(/^([✅⚠❌ℹ️]+\s*)+/m, ""); // на всякий случай
        out = out.replace(reLine, (m, tail) => {
            // убираем любые иконки в начале tail и лишние пробелы
            const cleanedTail = String(tail || "")
                .replace(/^[\s✅⚠❌ℹ️]+/g, "")
                .trim();
            // если хвост пустой — оставим просто "Verdict: <icon>"
            return cleanedTail ? `Verdict: ${ic} ${cleanedTail}` : `Verdict: ${ic}`;
        });
    } else {
        // если модель не вывела Verdict: строку — добавим сверху
        out = `Verdict: ${ic}\n\n` + out.trim();
    }

    return out.trim();
}

async function reserveCredits(userId, amount) {
    const r = await db.query(
        `update verdict_wallets
     set credits = credits - $2
     where user_id=$1 and credits >= $2
     returning credits`,
        [userId, amount]
    );
    return r.rowCount ? Number(r.rows[0].credits || 0) : null; 
}

async function reserveCreditsOrThrow(userId, amount) {
    const left = await reserveCredits(userId, amount);
    if (left === null) {
        const err = new Error("NO_CREDITS");
        err.code = "NO_CREDITS";
        throw err;
    }
    return left;
}


async function refundCredits(userId, amount) {
    await db.query(
        `insert into verdict_wallets(user_id, credits)
     values($1,$2)
     on conflict (user_id)
     do update set credits = GREATEST(COALESCE(verdict_wallets.credits,0),0) + EXCLUDED.credits`,
        [userId, amount]
    );
}

function suggestedPackByCost(cost) {
    const c = Number(cost);
    if (!Number.isFinite(c) || c <= 1) return "Basic";
    if (c <= 3) return "Starter";
    return "Value";
}

function noCreditsPayload(suggested = "Basic") {
    return {
        error: "NO_CREDITS",
        action: { type: "BUY_CREDITS", suggested: String(suggested || "Basic") }
    };
}

function formatInTz(d, tz) {
    // важно: те же опции, что и на клиенте, чтобы не было “расхождений”
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
        , timeZone: tz
    }).format(d);
}

function normalizeTimeZone(v) {
    const tz = String(v || "").trim();
    if (!tz) return "";
    try {
        new Intl.DateTimeFormat(undefined, { timeZone: tz }).format(new Date());
        return tz;
    } catch (_) {
        return "";
    }
}

function formatDateTimeForPdf(dateLike, timeZone, locale = "") {
    const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
    if (!Number.isFinite(d.getTime())) return "";

    const opts = {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit"
    };
    if (timeZone) opts.timeZone = timeZone;

    const loc = String(locale || "").trim();
    try {
        return loc
            ? new Intl.DateTimeFormat(loc, opts).format(d)
            : new Intl.DateTimeFormat(undefined, opts).format(d);
    } catch (_) {
        return new Intl.DateTimeFormat(undefined, opts).format(d);
    }
}

function injectAuth(html, auth, accountData , tz) {
    
    html = html.replace(
        /<span\b[^>]*\bid=["']user["'][^>]*>.*?<\/span>/i,
        `<span id="user" class="value muted">${escapeHtml(auth.email || "—")}</span>`
    );

    // ✅ 4) Список расчётов прямо в HTML (чтобы не было перерендера на клиенте)
    const list = accountData?.calculations || [];
    const wallet = accountData?.wallet || { free_used: false, credits: 0 };
    html = html.replace("<!--SSR_CALCS-->", renderCalcListSSR(list , tz , wallet));
    const walletCredits = Math.max(0, Number(wallet?.credits || 0));
    const walletCreditsText = `Credits: ${walletCredits}`;
    const walletFreeText = wallet?.free_used ? "Free verdict: used" : "Free verdict: available";

    html = html.replaceAll("__SSR_WALLET_CREDITS__", escapeHtml(walletCreditsText));
    html = html.replaceAll("__SSR_WALLET_FREE__", escapeHtml(walletFreeText));

    // Legacy fallback if placeholder tags are absent in template.
    html = html.replace(
        /(<div\b[^>]*\bid=["']walletCredits["'][^>]*>).*?(<\/div>)/i,
        `$1${escapeHtml(walletCreditsText)}$2`
    );
    html = html.replace(
        /(<div\b[^>]*\bid=["']walletFree["'][^>]*>).*?(<\/div>)/i,
        `$1${escapeHtml(walletFreeText)}$2`
    );

    // ✅ 5) Счётчики прямо в HTML
    const count = Array.isArray(list) ? list.length : 0;
    html = html.replace(
        /<span\b[^>]*\bid=["']totalCalcs["'][^>]*>.*?<\/span>/i,
        `<span id="totalCalcs" class="summary-value">${count}</span>`
    );

    // ✅ Last calculation date in user's timezone (if tz cookie exists)
    const lastIso = count ? new Date(list[0].created_at).toISOString() : "";

    let lastText = "—";
    let lastReadyClass = "";
    if (count) {
        const d = new Date(list[0].created_at);

        if (tz) {
            // date only, but in correct tz
            lastText = new Intl.DateTimeFormat(undefined, {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                timeZone: tz
            }).format(d);

            lastReadyClass = " is-ready"; // SSR already final
        } else {
            // fallback (will be fixed on client)
            lastText = "";
            lastReadyClass = ""; // do NOT mark ready
        }
    }

    html = html.replace(
        /<span\b[^>]*\bid=["']lastCalc["'][^>]*>.*?<\/span>/i,
        `<span id="lastCalc" class="summary-value muted${lastReadyClass}" data-iso="${escapeHtml(lastIso)}">${escapeHtml(lastText)}</span>`
    );

    const re = /<div\b[^>]*\bid=["']userControls["'][^>]*>/i;

    if (!re.test(html)) {
        console.warn("injectAuth: userControls DIV TAG NOT FOUND");
        return html;
    }

    html = html.replace(re, (tag) => {
        // есть ли class=""
        const classRe = /class\s*=\s*["']([^"']*)["']/i;

        if (classRe.test(tag)) {
            return tag.replace(classRe, (m, cls) => {
                // убрать старые auth-- классы
                cls = cls.replace(/\bauth--(guest|user)\b/g, "").replace(/\s+/g, " ").trim();
                const merged = (cls ? cls + " " : "") + auth.authClass;
                return `class="${merged}"`;
            });
        }

        // если class не было — вставить перед >
        return tag.replace(/>$/, ` class="${auth.authClass}">`);
    });

    // 2) аватар
    html = html.replace(
        /<div\s+id="userAccount"\s+class="avatar">.*?<\/div>/i,
        `<div id="userAccount" class="avatar">${auth.initial}</div>`
    );

    const boot = `<script>window.__BOOT__=${JSON.stringify({
        auth: {
            loggedIn: auth.loggedIn,
            email: auth.email,
            initial: auth.initial
        },
        account: accountData || null
    })};</script>`;

    if (!/window\.__BOOT__\s*=/.test(html)) {
        html = html.replace(/<\/head>/i, `${boot}\n</head>`);
    }
    html = setPromoVisibilitySSR(html, auth.loggedIn);

    return html;
}
const PADDLE_BASE =
    String(process.env.PADDLE_ENV || "").trim().toLowerCase() === "live"
        ? "https://api.paddle.com"
        : "https://sandbox-api.paddle.com";

let paddleTransactionsTableReady = null;

async function ensurePaddleTransactionsTable() {
    if (paddleTransactionsTableReady) return paddleTransactionsTableReady;
    paddleTransactionsTableReady = (async () => {
        await db.query(`
      create table if not exists paddle_transactions (
        id bigserial primary key,
        transaction_id text not null unique,
        user_id bigint not null references users(id) on delete cascade,
        credits integer not null default 0,
        status text not null default 'created',
        pack_key text,
        price_id text,
        amount_usd numeric(10,2),
        custom_data jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
        await db.query(`create index if not exists idx_paddle_transactions_user_created on paddle_transactions(user_id, created_at desc)`);
        await db.query(`create index if not exists idx_paddle_transactions_status_created on paddle_transactions(status, created_at desc)`);
    })().catch((e) => {
        paddleTransactionsTableReady = null;
        throw e;
    });
    return paddleTransactionsTableReady;
}

function paddleApiKey() {
    return String(process.env.PADDLE_API_KEY || "").trim();
}

function paddleClientToken() {
    return String(process.env.PADDLE_CLIENT_TOKEN || "").trim();
}

function paddleWebhookSecret() {
    return String(process.env.PADDLE_WEBHOOK_SECRET || "").trim();
}

function parsePaddleSignature(headerValue) {
    const out = {};
    String(headerValue || "")
        .split(";")
        .forEach((part) => {
            const idx = part.indexOf("=");
            if (idx <= 0) return;
            const k = part.slice(0, idx).trim();
            const v = part.slice(idx + 1).trim();
            if (!k) return;
            out[k] = v;
        });
    return out;
}

function timingSafeHexEqual(a, b) {
    try {
        const left = Buffer.from(String(a || ""), "hex");
        const right = Buffer.from(String(b || ""), "hex");
        if (!left.length || left.length !== right.length) return false;
        return crypto.timingSafeEqual(left, right);
    } catch {
        return false;
    }
}

function verifyPaddleWebhookSignature(rawBody, signatureHeader, secret, toleranceSec = 300) {
    if (!secret) return false;
    const sig = parsePaddleSignature(signatureHeader);
    const ts = Number(sig?.ts || 0);
    const h1 = String(sig?.h1 || "");
    if (!ts || !h1) return false;

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > Math.max(30, Number(toleranceSec || 300))) return false;

    const payload = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
    const expected = crypto.createHmac("sha256", secret).update(`${ts}:${payload}`).digest("hex");
    return timingSafeHexEqual(expected, h1);
}

async function paddleApiRequest(pathname, init = {}) {
    const apiKey = paddleApiKey();
    if (!apiKey) {
        return {
            ok: false,
            status: 500,
            body: { error: "PADDLE_API_KEY_MISSING" }
        };
    }

    const headers = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers || {})
    };
    const response = await fetch(`${PADDLE_BASE}${pathname}`, {
        ...init,
        headers
    });
    const body = await response.json().catch(() => ({}));
    return {
        ok: response.ok,
        status: response.status,
        body
    };
}

const NOWPAYMENTS_BASE = String(process.env.NOWPAYMENTS_API_BASE || "https://api.nowpayments.io/v1")
    .trim()
    .replace(/\/+$/, "");

let nowPaymentsTransactionsTableReady = null;

async function ensureNowPaymentsTables() {
    if (nowPaymentsTransactionsTableReady) return nowPaymentsTransactionsTableReady;
    nowPaymentsTransactionsTableReady = (async () => {
        await db.query(`
      create table if not exists nowpayments_transactions (
        id bigserial primary key,
        transaction_id text not null unique,
        provider_invoice_id text,
        provider_payment_id text,
        user_id bigint not null references users(id) on delete cascade,
        credits integer not null default 0,
        status text not null default 'created',
        pack_key text,
        amount_usd numeric(10,2),
        price_currency text not null default 'usd',
        pay_currency text,
        paid_price_amount numeric(16,8),
        paid_currency text,
        actually_paid numeric(24,12),
        outcome_amount numeric(24,12),
        outcome_currency text,
        webhook_count integer not null default 0,
        last_webhook_event_hash text,
        last_payload jsonb,
        paid_at timestamptz,
        last_ipn_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
        await db.query(`
      create table if not exists nowpayments_webhook_events (
        id bigserial primary key,
        event_hash text not null unique,
        payment_id text,
        order_id text,
        invoice_id text,
        status text,
        signature text,
        payload jsonb not null,
        created_at timestamptz not null default now()
      )
    `);
        await db.query(`create index if not exists idx_nowpayments_transactions_user_created on nowpayments_transactions(user_id, created_at desc)`);
        await db.query(`create index if not exists idx_nowpayments_transactions_status_created on nowpayments_transactions(status, created_at desc)`);
        await db.query(`create index if not exists idx_nowpayments_transactions_invoice on nowpayments_transactions(provider_invoice_id)`);
        await db.query(`create index if not exists idx_nowpayments_webhook_events_payment_created on nowpayments_webhook_events(payment_id, created_at desc)`);
    })().catch((e) => {
        nowPaymentsTransactionsTableReady = null;
        throw e;
    });
    return nowPaymentsTransactionsTableReady;
}

function nowPaymentsApiKey() {
    return String(process.env.NOWPAYMENTS_API_KEY || "").trim();
}

function nowPaymentsIpnSecret() {
    return String(process.env.NOWPAYMENTS_IPN_SECRET || "").trim();
}

function sortObjectKeysDeep(value) {
    if (Array.isArray(value)) return value.map(sortObjectKeysDeep);
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
        out[key] = sortObjectKeysDeep(value[key]);
    }
    return out;
}

function jsonStableStringify(value) {
    return JSON.stringify(sortObjectKeysDeep(value ?? {}));
}

function nowPaymentsTopLevelSortedJson(value) {
    const obj = (value && typeof value === "object" && !Array.isArray(value)) ? value : {};
    const sorted = {};
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = obj[key];
    }
    return JSON.stringify(sorted);
}

function hmacSha512Hex(secret, payload) {
    return crypto.createHmac("sha512", String(secret || ""))
        .update(String(payload || ""))
        .digest("hex");
}

function sha256Hex(payload) {
    return crypto.createHash("sha256")
        .update(String(payload || ""))
        .digest("hex");
}

function verifyNowPaymentsWebhookSignature(payloadObj, signatureHeader, secret, rawBody = "") {
    if (!secret) return false;
    const signature = String(signatureHeader || "").trim();
    if (!signature) return false;
    const payload = nowPaymentsTopLevelSortedJson(payloadObj);
    const expected = hmacSha512Hex(secret, payload);
    if (timingSafeHexEqual(expected, signature)) return true;

    // Compatibility fallback: some providers sign raw JSON body.
    if (rawBody) {
        const expectedRaw = hmacSha512Hex(secret, String(rawBody || ""));
        if (timingSafeHexEqual(expectedRaw, signature)) return true;
    }
    return false;
}

function shortHex(value, left = 10, right = 6) {
    const s = String(value || "").trim();
    if (!s) return "";
    if (s.length <= left + right + 3) return s;
    return `${s.slice(0, left)}...${s.slice(-right)}`;
}

function nowpDiag(stage, meta = {}) {
    try {
        console.info("NOWP_DIAG", stage, meta);
    } catch (_) { }
}

async function nowPaymentsApiRequest(pathname, init = {}) {
    const apiKey = nowPaymentsApiKey();
    if (!apiKey) {
        return {
            ok: false,
            status: 500,
            body: { error: "NOWPAYMENTS_API_KEY_MISSING" }
        };
    }

    const headers = {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        ...(init.headers || {})
    };

    const path = String(pathname || "");
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const response = await fetch(`${NOWPAYMENTS_BASE}${normalizedPath}`, {
        ...init,
        headers
    });
    const body = await response.json().catch(() => ({}));
    return {
        ok: response.ok,
        status: response.status,
        body
    };
}

function appBaseUrl() {
    return String(process.env.APP_URL || "").trim().replace(/\/+$/, "");
}

function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || "").trim());
}

function buildAppUrl(pathname) {
    const base = appBaseUrl();
    if (!isHttpUrl(base)) return "";
    const suffix = String(pathname || "").startsWith("/") ? String(pathname || "") : `/${String(pathname || "")}`;
    return `${base}${suffix}`;
}

function appendQueryParam(url, key, value) {
    try {
        const out = new URL(String(url || "").trim());
        const k = String(key || "").trim();
        if (!k) return String(url || "").trim();
        if (!out.searchParams.has(k)) out.searchParams.set(k, String(value ?? ""));
        return out.toString();
    } catch {
        return String(url || "").trim();
    }
}

function parseBoolEnv(raw, fallback = false) {
    if (raw === undefined || raw === null || raw === "") return !!fallback;
    const v = String(raw).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
    return !!fallback;
}

function roundMoney2(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100) / 100;
}

function almostEqualMoney(a, b, tolerance = 0.01) {
    const left = Number(a);
    const right = Number(b);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    return Math.abs(left - right) <= Math.max(0.000001, Number(tolerance || 0.01));
}

function generateNowPaymentsOrderId(userId) {
    const uid = Number(userId || 0);
    const rand = crypto.randomBytes(6).toString("hex");
    return `np_${uid}_${Date.now()}_${rand}`;
}

function userIdFromNowPaymentsOrderId(orderId) {
    const m = /^np_(\d+)_/i.exec(String(orderId || "").trim());
    if (!m) return 0;
    const uid = Number(m[1] || 0);
    return Number.isFinite(uid) && uid > 0 ? uid : 0;
}

const NOWPAYMENTS_PAID_STATUSES = new Set(["finished"]);


function n(v) {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
}
function nz(v) {
    const x = n(v);
    return x === null ? 0 : x;
}
function round2(x) {
    if (!Number.isFinite(x)) return null;
    return Math.round(x * 100) / 100;
}
function pct(num, den) {
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
    return round2((num / den) * 100);
}
function ratio(num, den) {
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
    return round2(num / den);
}

function roundSigMoney(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return "na";
    const a = Math.abs(n);
    const step =
        a < 1_000 ? 25 :
            a < 10_000 ? 100 :
                a < 100_000 ? 500 : 1_000;
    return String(Math.round(n / step) * step);
}
function roundSigPct(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return "na";
    const step = Math.abs(n) >= 20 ? 0.5 : 0.25;
    return String(Math.round(n / step) * step);
}

function outcomeSignature(type, result, mini) {
    const r = result || {};
    const lv = String(mini?.level || "info");
    // signatures by type: pick 2-3 key numbers (what user sees)
    if (type === "mortgage") {
        return ["mortgage", lv, roundSigMoney(r.monthlyPayment), roundSigMoney(r.totalPayment), roundSigMoney(r.totalInterest)].join("|");
    }
    if (type === "cash_flow") {
        return ["cash_flow", lv, roundSigMoney(r.cashFlowMonth), roundSigMoney(r.realCashFlowMonth), roundSigMoney(r.stressCashFlow)].join("|");
    }
    if (type === "break_even") {
        return ["break_even", lv, roundSigMoney(r.breakEvenRent), roundSigMoney(r.breakEvenPrice)].join("|");
    }
    if (type === "rent_vs_buy") {
        return ["rent_vs_buy", lv, roundSigMoney(r.rentTotal), roundSigMoney(r.buyNetCost)].join("|");
    }
    if (type === "property_irr") {
        return ["property_irr", lv, roundSigPct(r.realIRR), roundSigPct(r.irr), roundSigMoney(r.cashFlow)].join("|");
    }
    if (type === "renovation_roi") {
        return ["renovation_roi", lv, roundSigMoney(r.netProfitPV), roundSigPct(r.roiPV), String(r.payback ?? "na")].join("|");
    }
    if (type === "property_sale") {
        return ["property_sale", lv, roundSigMoney(r.netProfit), roundSigPct(r.realReturn), roundSigPct(r.annualReturn)].join("|");
    }
    if (type === "property_taxes") {
        return ["property_taxes", lv, roundSigMoney(r.finalProfitPV), roundSigPct(r.realROI), roundSigPct(r.taxBurdenPercent)].join("|");
    }
    if (type === "ownership_cost") {
        return ["ownership_cost", lv, roundSigMoney(r.totalOwnershipCostPV ?? r.totalCostPV), roundSigPct(r.costAsPercentOfPrice)].join("|");
    }
    if (type === "alternative_investment") {
        return ["alternative_investment", lv, roundSigMoney(r.finalValue ?? r.futureValue ?? r.endingBalance), roundSigMoney(r.difference)].join("|");
    }
    if (type === "mortgage_overpayment") {
        return ["mortgage_overpayment", lv, roundSigMoney(r.realOverpayment), roundSigMoney(r.nominalOverpayment), roundSigMoney(r.monthlyPayment)].join("|");
    }
    return [type, lv].join("|");
}

// Dedup by outcome signature: keep the most “sellable” scenario
function dedupeByOutcome(type, items, baselineInput) {
    const seen = new Map(); // sig -> item
    const countChanged = (base, cur) => {
        const b = base || {};
        const c = cur || {};
        const keys = new Set([...Object.keys(b), ...Object.keys(c)]);
        let n = 0;
        for (const k of keys) {
            if (!(k in b) || !(k in c)) continue;
            const nb = Number(b[k]);
            const nc = Number(c[k]);
            const bothNum = Number.isFinite(nb) && Number.isFinite(nc);
            const eq = bothNum ? (nb === nc) : (String(b[k]) === String(c[k]));
            if (!eq) n++;
        }
        return n;
    };

    for (const it of items) {
        const sig = outcomeSignature(type, it.result_data, it.mini_verdict);
        const prev = seen.get(sig);
        if (!prev) { seen.set(sig, it); continue; }

        // Prefer:
        // 1) meta.kind goal/flip over generic
        // 2) fewer changed inputs (simpler lever)
        // 3) label that includes “Target/Flip/Required/Stress”
        const score = (x) => {
            const kind = String(x?.meta?.kind || "");
            const kindScore =
                kind === "flip" ? 50 :
                    kind === "goal" ? 45 :
                        kind === "stress" ? 30 :
                            kind === "best" ? 25 : 10;

            const changed = countChanged(baselineInput, x.input_data);
            const simplicity = Math.max(0, 20 - changed); // fewer changes = higher

            const label = String(x.label || "");
            const labelBoost = /flip|target|required|boundary|stress|rescue/i.test(label) ? 10 : 0;

            return kindScore + simplicity + labelBoost;
        };

        if (score(it) > score(prev)) seen.set(sig, it);
    }

    return Array.from(seen.values());
}

function clampNum(x, min, max) {
    const v = Number(x);
    if (!Number.isFinite(v)) return min;
    return Math.max(min, Math.min(max, v));
}

// Try 1D search on a field to improve mini verdict rank
function findFlipScenario({ type, baseInput, baseMini, computeResultByType, lever }) {
    const { field, from, to, steps, label } = lever;
    const baseRank = miniRank(baseMini?.level);

    let best = null;

    for (let i = 0; i < steps; i++) {
        const t = steps === 1 ? 1 : (i / (steps - 1));
        const raw = from + (to - from) * t;
        const v = normalizeLeverValueForField(field, raw, baseInput);
        if (!Number.isFinite(v)) continue;

        const input = { ...baseInput, [field]: v };
        const result = computeResultByType(type, input);
        if (!result) continue;

        const mv = miniVerdictUniversal({ calculator_type: type, input_data: input, result_data: result });
        const rank = miniRank(mv?.level);

        if (rank > baseRank) {
            best = { label, input_data: input, result_data: result, mini_verdict: mv, meta: { kind: "flip", field } };
            break; // минимальное изменение, которое улучшило вердикт
        }
    }

    return best;
}

function buildServerGoalScenarios(type, baseInput, baseResult, computeResultByType) {
    const baseMini = miniVerdictUniversal({ calculator_type: type, input_data: baseInput, result_data: baseResult });
    const out = [];
    const c = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // Helper to push with meta
    const push = (x) => { if (x && x.input_data && x.result_data) out.push(x); };

    if (type === "cash_flow") {
        const rent = Number(baseInput.rent || 0);
        const expenses = Number(baseInput.expenses || 0);
        const mortgage = Number(baseInput.mortgage || 0);

        // Required rent to make stressCashFlow >= 0 (try scale)
        if (rent > 0) {
            const targetLabel = "Required: rent to pass stress (stressCashFlow ≥ 0)";
            let lo = rent, hi = rent * 1.8;
            let best = null;

            for (let it = 0; it < 18; it++) {
                const mid = (lo + hi) / 2;
                const input = { ...baseInput, rent: Math.round(mid) };
                const res = computeResultByType(type, input);
                if (!res) break;

                const stress = Number(res.stressCashFlow ?? NaN);
                if (!Number.isFinite(stress)) break;

                if (stress >= 0) { best = { label: targetLabel, input_data: input, result_data: res, meta: { kind: "goal", field: "rent" } }; hi = mid; }
                else lo = mid;
            }
            if (best) {
                best.mini_verdict = miniVerdictUniversal({ calculator_type: type, input_data: best.input_data, result_data: best.result_data });
                push(best);
            }
        }

        // Flip scenario: reduce expenses until verdict improves
        if (expenses > 0) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "expenses",
                    from: expenses,
                    to: Math.max(0, expenses * 0.6),
                    steps: 14,
                    label: "Flip: expenses cut until verdict improves"
                }
            }));
        }

        // Flip scenario: reduce mortgage
        if (mortgage > 0) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "mortgage",
                    from: mortgage,
                    to: Math.max(0, mortgage * 0.75),
                    steps: 12,
                    label: "Flip: refinance mortgage until verdict improves"
                }
            }));
        }
    }

    if (type === "break_even") {
        const marketRent = Number(baseInput.marketRent || 0);
        const baseBreakEvenRent = Number(baseResult.breakEvenRent || 0);

        if (baseBreakEvenRent > 0) {
            // Required market rent exactly at break-even
            const input = { ...baseInput, marketRent: Math.round(baseBreakEvenRent) };
            const res = computeResultByType(type, input);
            if (res) {
                push({
                    label: "Required: marketRent to hit break-even (marketRent = breakEvenRent)",
                    input_data: input,
                    result_data: res,
                    mini_verdict: miniVerdictUniversal({ calculator_type: type, input_data: input, result_data: res }),
                    meta: { kind: "goal", field: "marketRent" }
                });
            }
        }

        // Flip via expenses reduction (if expenses exist)
        const expenses = Number(baseInput.expenses || 0);
        if (expenses > 0 && marketRent > 0) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "expenses",
                    from: expenses,
                    to: Math.max(0, expenses * 0.5),
                    steps: 16,
                    label: "Flip: reduce expenses until break-even improves"
                }
            }));
        }
    }

    if (type === "mortgage") {
        const rate = Number(baseInput.ratePercent || 0);
        const term = Number(baseInput.termYears || 0);
        const down = Number(baseInput.down || 0);
        const price = Number(baseInput.price || 0);

        // Flip: rate down
        if (rate > 0.5) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "ratePercent",
                    from: rate,
                    to: Math.max(0.5, rate - 3.0),
                    steps: 14,
                    label: "Flip: lower rate until verdict improves"
                }
            }));
        }

        // Flip: down up
        if (price > 0) {
            const maxDown = Math.min(price * 0.6, down + price * 0.25);
            if (maxDown > down) {
                push(findFlipScenario({
                    type, baseInput, baseMini, computeResultByType,
                    lever: {
                        field: "down",
                        from: down,
                        to: maxDown,
                        steps: 14,
                        label: "Flip: increase down payment until verdict improves"
                    }
                }));
            }
        }

        // Goal: monthly -10% via term increase (only if term < 35)
        if (term > 0 && term < 35) {
            const target = Number(baseResult.monthlyPayment || 0) * 0.90;
            if (Number.isFinite(target) && target > 0) {
                const label = "Target: monthlyPayment −10% (try longer term)";
                let lo = term, hi = 40;
                let best = null;

                for (let it = 0; it < 16; it++) {
                    const mid = (lo + hi) / 2;
                    const input = { ...baseInput, termYears: Math.round(mid) };
                    const res = computeResultByType(type, input);
                    if (!res) break;

                    const mp = Number(res.monthlyPayment ?? NaN);
                    if (!Number.isFinite(mp)) break;

                    if (mp <= target) { best = { label, input_data: input, result_data: res, meta: { kind: "goal", field: "termYears" } }; hi = mid; }
                    else lo = mid;
                }

                if (best) {
                    best.mini_verdict = miniVerdictUniversal({ calculator_type: type, input_data: best.input_data, result_data: best.result_data });
                    push(best);
                }
            }
        }
    }

    if (type === "property_irr") {
        const price = Number(baseInput.price || 0);
        const rent = Number(baseInput.rent || 0);
        const baseReal = Number(baseResult.realIRR ?? NaN);

        // Goal threshold (default premium): realIRR >= 8
        const TARGET = 8;

        if (Number.isFinite(baseReal) && baseReal < TARGET) {
            // Required price discount to hit target
            if (price > 0) {
                let lo = price * 0.6;
                let hi = price;
                let best = null;

                for (let it = 0; it < 18; it++) {
                    const mid = (lo + hi) / 2;
                    const input = { ...baseInput, price: Math.round(mid) };
                    const res = computeResultByType(type, input);
                    if (!res) break;

                    const real = Number(res.realIRR ?? NaN);
                    if (!Number.isFinite(real)) break;

                    if (real >= TARGET) { best = { label: `Required: price to reach realIRR ≥ ${TARGET}%`, input_data: input, result_data: res, meta: { kind: "goal", field: "price" } }; hi = mid; }
                    else hi = mid; // if lowering price makes returns higher, we search lower; if monotonic opposite, it won’t find best — ok
                }

                if (best) {
                    best.mini_verdict = miniVerdictUniversal({ calculator_type: type, input_data: best.input_data, result_data: best.result_data });
                    push(best);
                }
            }

            // Required rent to hit target (if rent exists)
            if (rent > 0) {
                let lo = rent;
                let hi = rent * 1.8;
                let best = null;

                for (let it = 0; it < 18; it++) {
                    const mid = (lo + hi) / 2;
                    const input = { ...baseInput, rent: Math.round(mid) };
                    const res = computeResultByType(type, input);
                    if (!res) break;

                    const real = Number(res.realIRR ?? NaN);
                    if (!Number.isFinite(real)) break;

                    if (real >= TARGET) { best = { label: `Required: rent to reach realIRR ≥ ${TARGET}%`, input_data: input, result_data: res, meta: { kind: "goal", field: "rent" } }; hi = mid; }
                    else lo = mid;
                }

                if (best) {
                    best.mini_verdict = miniVerdictUniversal({ calculator_type: type, input_data: best.input_data, result_data: best.result_data });
                    push(best);
                }
            }
        }
    }

    if (type === "rent_vs_buy") {
        const years = Number(baseInput.years || 0);
        const mortgageRate = Number(baseInput.mortgageRate ?? 0);
        const propertyGrowth = Number(baseInput.propertyGrowth ?? 0);
        const rentGrowth = Number(baseInput.rentGrowth ?? 0);
        const winner = String(baseResult?.winner || "").toLowerCase();

        if (years > 0) {
            const longer = Math.min(50, Math.max(years + 2, years * 1.7));
            const shorter = Math.max(1, Math.min(years - 2, years * 0.65));
            if (winner === "rent") {
                push(findFlipScenario({
                    type, baseInput, baseMini, computeResultByType,
                    lever: {
                        field: "years",
                        from: years,
                        to: longer,
                        steps: 14,
                        label: "Flip: extend horizon until buy improves"
                    }
                }));
            } else {
                push(findFlipScenario({
                    type, baseInput, baseMini, computeResultByType,
                    lever: {
                        field: "years",
                        from: years,
                        to: shorter,
                        steps: 14,
                        label: "Flip: shorten horizon until rent improves"
                    }
                }));
            }
        }

        if (Number.isFinite(mortgageRate)) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "mortgageRate",
                    from: mortgageRate,
                    to: c(mortgageRate - 2.5, 0, 100),
                    steps: 14,
                    label: "Flip: lower mortgageRate until verdict improves"
                }
            }));
        }

        if (Number.isFinite(propertyGrowth)) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "propertyGrowth",
                    from: propertyGrowth,
                    to: c(propertyGrowth + 3, 0, 50),
                    steps: 14,
                    label: "Flip: increase propertyGrowth until verdict improves"
                }
            }));
        }

        if (Number.isFinite(rentGrowth)) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "rentGrowth",
                    from: rentGrowth,
                    to: c(rentGrowth - 2, 0, 50),
                    steps: 12,
                    label: "Flip: reduce rentGrowth pressure until verdict improves"
                }
            }));
        }
    }

    if (type === "renovation_roi") {
        const renovationCost = Number(baseInput.renovationCost || 0);
        const priceIncrease = Number(baseInput.priceIncrease ?? 0);
        const rentIncrease = Number(baseInput.rentIncrease ?? 0);

        if (renovationCost > 0) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "renovationCost",
                    from: renovationCost,
                    to: Math.max(0, renovationCost * 0.65),
                    steps: 14,
                    label: "Flip: reduce renovationCost until verdict improves"
                }
            }));
        }
        if (Number.isFinite(priceIncrease)) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "priceIncrease",
                    from: priceIncrease,
                    to: c(priceIncrease + 6, -99, 2000),
                    steps: 14,
                    label: "Flip: raise priceIncrease until verdict improves"
                }
            }));
        }
        if (Number.isFinite(rentIncrease)) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "rentIncrease",
                    from: rentIncrease,
                    to: c(rentIncrease + 4, -99, 2000),
                    steps: 12,
                    label: "Flip: raise rentIncrease until verdict improves"
                }
            }));
        }
    }

    if (type === "property_sale") {
        const sellPrice = Number(baseInput.sellPrice || 0);
        const buyPrice = Number(baseInput.buyPrice || 0);
        const renovation = Number(baseInput.renovation || 0);
        const commission = Number(baseInput.commission ?? 0);
        const tax = Number(baseInput.tax ?? 0);
        const baseNet = Number(baseResult?.netProfit ?? NaN);

        if (sellPrice > 0) {
            // Required target: sell price for netProfit >= 0 (if feasible by formula)
            const denom = 1 - (tax / 100) - (commission / 100);
            if (Number.isFinite(baseNet) && baseNet < 0 && denom > 0) {
                const requiredSell = Math.ceil((buyPrice + renovation) / denom);
                if (Number.isFinite(requiredSell) && requiredSell > sellPrice) {
                    const input = { ...baseInput, sellPrice: requiredSell };
                    const res = computeResultByType(type, input);
                    if (res) {
                        push({
                            label: "Required: sellPrice to reach netProfit >= 0",
                            input_data: input,
                            result_data: res,
                            mini_verdict: miniVerdictUniversal({ calculator_type: type, input_data: input, result_data: res }),
                            meta: { kind: "goal", field: "sellPrice" }
                        });
                    }
                }
            }

            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "sellPrice",
                    from: sellPrice,
                    to: sellPrice * 2.2,
                    steps: 24,
                    label: "Flip: increase sellPrice until verdict improves"
                }
            }));
        }
        if (Number.isFinite(commission) && commission > 0) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "commission",
                    from: commission,
                    to: c(commission - 3, 0, 40),
                    steps: 12,
                    label: "Flip: reduce commission until verdict improves"
                }
            }));
        }
        if (Number.isFinite(tax) && tax > 0) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "tax",
                    from: tax,
                    to: c(tax - 4, 0, 70),
                    steps: 12,
                    label: "Flip: reduce sale tax until verdict improves"
                }
            }));
        }
    }

    if (type === "property_taxes") {
        const propertyTax = Number(baseInput.propertyTax ?? 0);
        const rentTax = Number(baseInput.rentTax ?? 0);
        const annualFees = Number(baseInput.annualFees || 0);
        const agentFee = Number(baseInput.agentFee ?? 0);

        if (Number.isFinite(propertyTax) && propertyTax > 0) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "propertyTax",
                    from: propertyTax,
                    to: c(propertyTax - 3, 0, 70),
                    steps: 14,
                    label: "Flip: reduce propertyTax until verdict improves"
                }
            }));
        }
        if (Number.isFinite(rentTax) && rentTax > 0) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "rentTax",
                    from: rentTax,
                    to: c(rentTax - 3, 0, 70),
                    steps: 14,
                    label: "Flip: reduce rentTax until verdict improves"
                }
            }));
        }
        if (annualFees > 0) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "annualFees",
                    from: annualFees,
                    to: Math.max(0, annualFees * 0.6),
                    steps: 14,
                    label: "Flip: cut annualFees until verdict improves"
                }
            }));
        }
        if (Number.isFinite(agentFee) && agentFee > 0) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "agentFee",
                    from: agentFee,
                    to: c(agentFee - 2, 0, 50),
                    steps: 10,
                    label: "Flip: lower agentFee until verdict improves"
                }
            }));
        }
    }

    if (type === "ownership_cost") {
        const taxPercent = Number(baseInput.taxPercent ?? 0);
        const maintenance = Number(baseInput.maintenance || 0);
        const inflation = Number(baseInput.inflation ?? 0);
        const years = Number(baseInput.years || 0);

        if (Number.isFinite(taxPercent) && taxPercent > 0) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "taxPercent",
                    from: taxPercent,
                    to: c(taxPercent - 3, 0, 90),
                    steps: 14,
                    label: "Flip: reduce taxPercent until verdict improves"
                }
            }));
        }
        if (maintenance > 0) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "maintenance",
                    from: maintenance,
                    to: Math.max(0, maintenance * 0.6),
                    steps: 14,
                    label: "Flip: reduce maintenance until verdict improves"
                }
            }));
        }
        if (Number.isFinite(inflation)) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "inflation",
                    from: inflation,
                    to: c(inflation - 3, -5, 40),
                    steps: 12,
                    label: "Flip: lower inflation assumption until verdict improves"
                }
            }));
        }
        if (years > 1) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "years",
                    from: years,
                    to: c(years - 4, 1, 100),
                    steps: 12,
                    label: "Flip: shorter hold period until verdict improves"
                }
            }));
        }
    }

    if (type === "alternative_investment") {
        const altReturn = Number(baseInput.altReturn ?? 0);
        const altContribution = Number(baseInput.altContribution || 0);
        const altTaxRate = Number(baseInput.altTaxRate ?? 0);
        const propertyGrowth = Number(baseInput.propertyGrowth ?? 0);

        if (Number.isFinite(altReturn)) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "altReturn",
                    from: altReturn,
                    to: c(altReturn + 8, -99, 2000),
                    steps: 16,
                    label: "Flip: increase altReturn until verdict improves"
                }
            }));
        }
        if (altContribution > 0) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "altContribution",
                    from: altContribution,
                    to: c(altContribution * 1.8, 0, 10_000_000),
                    steps: 14,
                    label: "Flip: increase altContribution until verdict improves"
                }
            }));
        }
        if (Number.isFinite(altTaxRate) && altTaxRate > 0) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "altTaxRate",
                    from: altTaxRate,
                    to: c(altTaxRate - 6, 0, 100),
                    steps: 12,
                    label: "Flip: reduce altTaxRate until verdict improves"
                }
            }));
        }
        if (Number.isFinite(propertyGrowth)) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "propertyGrowth",
                    from: propertyGrowth,
                    to: c(propertyGrowth - 3, -99, 2000),
                    steps: 10,
                    label: "Flip: reduce propertyGrowth edge until alternative improves"
                }
            }));
        }
    }

    if (type === "mortgage_overpayment") {
        const rate = Number(baseInput.rate ?? baseInput.ratePercent ?? 0);
        const years = Number(baseInput.years || 0);
        const inflation = Number(baseInput.inflation ?? 0);

        if (Number.isFinite(rate) && rate > 0) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "rate",
                    from: rate,
                    to: c(rate - 2.0, 0.1, 70),
                    steps: 14,
                    label: "Flip: lower rate until overpayment verdict improves"
                }
            }));
        }
        if (years > 1) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "years",
                    from: years,
                    to: c(years - 8, 1, 70),
                    steps: 14,
                    label: "Flip: shorten term until overpayment verdict improves"
                }
            }));
        }
        if (Number.isFinite(inflation)) {
            push(findFlipScenario({
                type, baseInput, baseMini, computeResultByType,
                lever: {
                    field: "inflation",
                    from: inflation,
                    to: c(inflation + 3, 0, 50),
                    steps: 10,
                    label: "Flip: inflation sensitivity to reduce real burden"
                }
            }));
        }
    }

    // uniq by input hash
    const uniq = [];
    const seen = new Set();
    for (const s of out) {
        const h = JSON.stringify(s.input_data || {});
        if (seen.has(h)) continue;
        seen.add(h);
        uniq.push(s);
    }
    return uniq;
}



function buildDerivedMetrics(calc) {
    const type = String(calc?.calculator_type || "");
    const i = calc?.input_data || {};
    const r = calc?.result_data || {};

    const dm = {
        type,
        keyNumbers: {},
        metrics: {},
        missingChecklist: []
    };

    // -------------------------
    // MORTGAGE
    // -------------------------
    if (type === "mortgage") {
        const price = nz(i.price);
        const down = nz(i.down);
        const ratePercent = n(i.ratePercent);
        const termYears = n(i.termYears);

        const monthlyPayment = nz(r.monthlyPayment);
        const totalPayment = nz(r.totalPayment);
        const totalInterest = nz(r.totalInterest);

        const loan = Math.max(0, price - down);

        dm.keyNumbers = { price, down, loan, ratePercent, termYears, monthlyPayment, totalPayment, totalInterest };

        dm.metrics.downPaymentPercent = pct(down, price);
        dm.metrics.interestToLoanPercent = pct(totalInterest, loan);
        dm.metrics.interestToPricePercent = pct(totalInterest, price);
        dm.metrics.totalPaidPerDollarBorrowed = ratio(totalPayment, loan);
        dm.metrics.monthlyPaymentToLoanPercent = pct(monthlyPayment, loan);
        dm.metrics.monthlyPaymentToPricePercent = pct(monthlyPayment, price);

        const hasIncome = hasRentOrIncomeFromInput(i);

        if (hasIncome) {
            // инвест-логика (как у тебя)
            dm.missingChecklist = [
                `Target monthly rent/income to cover $${Math.round(monthlyPayment)} payment`,
                "Recurring operating costs (tax/insurance/HOA/maintenance) to test cashflow",
                `Expected appreciation / exit plan to justify $${Math.round(totalInterest)} total interest`
            ];
        } else {
            // жильё / affordability-логика
            dm.missingChecklist = [
                "Monthly net income (after tax) to test payment-to-income ratio",
                "Property tax + insurance + HOA estimate (monthly) to test real all-in payment",
                "Emergency buffer (how many months of payments you can cover if income drops)"
            ];
        }

        return dm;
    }

    // -------------------------
    // MORTGAGE_OVERPAYMENT
    // -------------------------
    if (type === "mortgage_overpayment") {
        const loan = nz(i.loan);
        const rate = n(i.rate);
        const years = n(i.years);
        const inflation = n(i.inflation);

        const monthlyPayment = nz(r.monthlyPayment);
        const nominalOverpayment = nz(r.nominalOverpayment);
        const realOverpayment = nz(r.realOverpayment);
        const realInterestRate = n(r.realInterestRate);

        const totalPaidNominal = loan + nominalOverpayment;

        dm.keyNumbers = {
            loan, rate, years, inflation,
            monthlyPayment, nominalOverpayment, realOverpayment, realInterestRate,
            totalPaidNominal
        };

        dm.metrics.nominalOverpaymentToLoanPercent = pct(nominalOverpayment, loan);
        dm.metrics.realOverpaymentToLoanPercent = pct(realOverpayment, loan);
        dm.metrics.totalPaidPerDollarBorrowed = ratio(totalPaidNominal, loan);

        dm.metrics.nominalOverpaymentPerYear = years > 0 ? round2(nominalOverpayment / years) : null;
        dm.metrics.realOverpaymentPerYear = years > 0 ? round2(realOverpayment / years) : null;

        // real-vs-nominal gap
        dm.metrics.inflationRelief = round2(nominalOverpayment - realOverpayment);

        // payment burden proxy (monthly payment vs loan)
        dm.metrics.monthlyPaymentToLoanPercent = pct(monthlyPayment, loan);

        // missing checklist (premium)
        dm.missingChecklist = [
            "Refinance target rate (what rate you can realistically get today)",
            "Prepayment plan (extra payment amount) if you want to reduce overpayment faster",
            "Holding horizon: how long you actually expect to keep the loan/property"
        ];

        return dm;
    }

    // -------------------------
    // OWNERSHIP_COST
    // -------------------------
    // -------------------------
    // OWNERSHIP_COST
    // -------------------------
    if (type === "ownership_cost") {
        const price = nz(i.price);
        const years = nz(i.years);

        const taxPercent = n(i.taxPercent);
        const maintenance = nz(i.maintenance);
        const inflation = n(i.inflation);

        // canonical results (preferred) + compat
        const rawTotalOwnershipCost = nz(r.totalOwnershipCost ?? r.totalCost);
        const rawTotalOwnershipCostPV = nz(r.totalOwnershipCostPV ?? r.totalCostPV);
        const looksLegacyWithPrincipal = price > 0 && rawTotalOwnershipCost >= price * 0.95;
        const totalOwnershipCost = looksLegacyWithPrincipal
            ? Math.max(0, rawTotalOwnershipCost - price)
            : rawTotalOwnershipCost;
        const totalOwnershipCostPV = looksLegacyWithPrincipal
            ? Math.max(0, rawTotalOwnershipCostPV - price)
            : rawTotalOwnershipCostPV;

        const inputPct = Number(r.costAsPercentOfPrice);
        const costAsPercentOfPrice = Number.isFinite(inputPct) && inputPct >= 0 && inputPct < 90
            ? inputPct
            : (price > 0 ? round2((totalOwnershipCost / price) * 100) : null);

        dm.keyNumbers = {
            price, years, taxPercent, maintenance, inflation,
            totalOwnershipCost: round2(totalOwnershipCost),
            totalOwnershipCostPV: round2(totalOwnershipCostPV),
            costAsPercentOfPrice: round2(costAsPercentOfPrice)
        };

        dm.metrics.totalCostToPricePercent =
            (price > 0) ? round2((totalOwnershipCost / price) * 100) : null;

        dm.metrics.totalRealCostToPricePercent =
            (price > 0) ? round2((totalOwnershipCostPV / price) * 100) : null;

        dm.metrics.avgAnnualCost =
            (years > 0) ? round2(totalOwnershipCost / years) : null;

        dm.metrics.avgAnnualCostPV =
            (years > 0) ? round2(totalOwnershipCostPV / years) : null;

        dm.metrics.avgMonthlyCost =
            (years > 0) ? round2(totalOwnershipCost / (years * 12)) : null;

        dm.metrics.avgMonthlyCostPV =
            (years > 0) ? round2(totalOwnershipCostPV / (years * 12)) : null;

        dm.missingChecklist = [
            "Confirm property tax base and whether taxPercent applies to assessed value or purchase price",
            "Confirm maintenance is annual fixed $ (not monthly) and includes a realistic reserve",
            "If you want more realism, add separate fields for insurance/HOA/fees and their growth"
        ];

        return dm;
    }



    // -------------------------
    // RENT_VS_BUY
    // -------------------------
    if (type === "rent_vs_buy") {
        const rent = nz(i.rent);
        const mortgage = nz(i.mortgage);
        const years = nz(i.years);
        const propertyValue = nz(i.propertyValue);
        const rentGrowth = n(i.rentGrowth);
        const mortgageRate = n(i.mortgageRate);
        const propertyGrowth = n(i.propertyGrowth);
        const inflation = n(i.inflation);

        const rentTotal = nz(r.rentTotal);
        const mortgagePaid = nz(r.mortgagePaid);
        const buyNetCostNum = n(r.buyNetCost);
        const buyNetCost = buyNetCostNum === null ? 0 : buyNetCostNum;
        const winner = String(r.winner || "");

        const diff = round2(rentTotal - buyNetCost); // + => buy cheaper (если так у тебя в логике)

        function estimateBreakEvenYear(input, result) {
            const yrs = Number(input?.years || 0);
            if (!(yrs > 0)) return null;

            const w = String(result?.winner || "").toLowerCase();
            const rt = Number(result?.rentTotal || 0);
            const bc = Number(result?.buyNetCost);
            if (!(rt > 0 && Number.isFinite(bc) && bc > 0)) return null;

            const d = rt - bc;
            if (w !== "buy" || d <= 0) return null;

            const k = bc / rt; // <1 если buy дешевле
            const be = yrs * k;
            if (!Number.isFinite(be) || be <= 0 || be >= yrs) return null;

            return round2(be);
        }

        dm.keyNumbers = {
            rent, mortgage, years, propertyValue, rentGrowth, mortgageRate, propertyGrowth, inflation,
            rentTotal, mortgagePaid, buyNetCost, winner
        };

        dm.metrics.rentMinusBuyNet = diff;
        dm.metrics.buyNetAsPercentOfRentTotal = pct(buyNetCost, rentTotal);
        dm.metrics.mortgagePaidAsPercentOfRentTotal = pct(mortgagePaid, rentTotal);

        const breakEvenYear = estimateBreakEvenYear(i, r);

        const conf = (() => {
            if (!(rentTotal > 0 && Number.isFinite(buyNetCost))) return null;
            const pctGap = Math.abs((rentTotal - buyNetCost) / Math.max(Math.abs(rentTotal), 1));
            return Math.max(0, Math.min(100, Math.round((pctGap / 0.20) * 90)));
        })();

        dm.metrics.breakEvenYearApprox = breakEvenYear;
        dm.metrics.confidenceScore = conf;

        dm.missingChecklist = [
            "Buying one-time costs (closing costs) if not included",
            "Ongoing ownership costs (tax/insurance/maintenance/HOA) if not included",
            "Move probability / horizon realism (years) — biggest driver in Rent vs Buy"
        ];

        return dm;
    }

// BREAK-EVEN
    if (type === "break_even") {
        const price = nz(i.price);
        const downPayment = nz(i.downPayment);
        const marketRent = nz(i.marketRent);
        const mortgage = nz(i.mortgage);
        const expenses = nz(i.expenses);
        const taxes = nz(i.taxes);
        const vacancy = n(i.vacancy);

        const breakEvenRent = nz(r.breakEvenRent);
        const breakEvenPrice = nz(r.breakEvenPrice);
        const winner = String(r.winner || "");

        const gap = round2(marketRent - breakEvenRent);
        const gapPct = (breakEvenRent > 0) ? round2((gap / breakEvenRent) * 100) : null;
        const requiredRentUpPct = (marketRent > 0 && breakEvenRent > marketRent)
            ? round2(((breakEvenRent - marketRent) / marketRent) * 100)
            : 0;

        dm.keyNumbers = {
            price, downPayment, marketRent, mortgage, expenses, taxes, vacancy,
            breakEvenRent, breakEvenPrice, winner
        };

        dm.metrics.marketRentToPricePercentPerMonth = pct(marketRent, price);
        dm.metrics.breakEvenRentToPricePercentPerMonth = pct(breakEvenRent, price);

        dm.metrics.marketVsBreakEvenRent = gap;              // $/mo
        dm.metrics.marketVsBreakEvenRentPercent = gapPct;    // %
        dm.metrics.requiredRentIncreasePercent = requiredRentUpPct;

        dm.missingChecklist = [
            "Vacancy assumption (local average %) — affects break-even rent directly",
            "Mortgage detail (if mortgage is simplified, include true P&I + escrow)",
            "Expense realism (repairs reserve / capex / management fee if applicable)"
        ];

        return dm;
    }


    // -------------------------
    // CASH_FLOW
    // -------------------------
    if (type === "cash_flow") {
        const rent = nz(i.rent);
        const vacancy = n(i.vacancy);
        const mortgage = nz(i.mortgage);
        const expenses = nz(i.expenses);
        const taxes = n(i.taxes);
        const inflation = n(i.inflation);

        const netIncome = nz(r.netIncome);
        const totalExpenses = nz(r.totalExpenses);
        const cashFlowMonth = nz(r.cashFlowMonth);
        const cashFlowYear = nz(r.cashFlowYear);
        const realCashFlowMonth = nz(r.realCashFlowMonth);
        const realCashFlowYear = nz(r.realCashFlowYear);
        const stressCashFlow = nz(r.stressCashFlow);
        const status = String(r.status || ""); 
        const breakEvenRent = (Number.isFinite(rent) && Number.isFinite(cashFlowMonth))
            ? round2(rent - cashFlowMonth)
            : null;

        dm.keyNumbers = {
            rent, vacancy, mortgage, expenses, taxes, inflation,
            netIncome, totalExpenses, cashFlowMonth, cashFlowYear,
            realCashFlowMonth, realCashFlowYear, stressCashFlow, status
        };

        dm.metrics.cashFlowMarginPercent = pct(cashFlowMonth, rent);
        dm.metrics.realCashFlowMarginPercent = pct(realCashFlowMonth, rent);
        dm.metrics.expenseRatioPercent = pct(totalExpenses, rent);
        dm.metrics.stressDrop = round2(cashFlowMonth - stressCashFlow);

       

        dm.metrics.breakEvenRentMonthly = breakEvenRent; // сколько rent нужно, чтобы CF=0
        dm.metrics.breakEvenRentDelta = (breakEvenRent !== null) ? round2(breakEvenRent - rent) : null; // +сколько не хватает

        dm.missingChecklist = [
            "Management fee (if you will outsource) — impacts totalExpenses directly",
            "CapEx reserve (repairs/turnover) — prevents false 'positive' cash flow",
            "Rent growth & expense growth assumptions (if you plan multi-year view)"
        ];


        return dm;
    }

    // -------------------------
    // PROPERTY_IRR
    // -------------------------
    if (type === "property_irr") {
        const price = nz(i.price);
        const downPayment = nz(i.downPayment);
        const purchaseCosts = nz(i.purchaseCosts);
        const renovation = nz(i.renovation);
        const rent = nz(i.rent);
        const vacancy = n(i.vacancy);
        const expenses = nz(i.expenses);
        const mortgage = nz(i.mortgage);
        const years = nz(i.years);
        const growth = n(i.growth);
        const saleTax = n(i.saleTax);
        const inflation = n(i.inflation);

        const cashFlow = nz(r.cashFlow);
        const roi = n(r.roi);
        const irr = n(r.irr);
        const realIRR = n(r.realIRR);
        const paybackYears = n(r.paybackYears);

        const equityInvested = downPayment + purchaseCosts + renovation;

        dm.keyNumbers = {
            price, downPayment, purchaseCosts, renovation, rent, vacancy, expenses, mortgage,
            years, growth, saleTax, inflation,
            cashFlow, roi, irr, realIRR, paybackYears,
            equityInvested
        };

        dm.metrics.equityInvested = round2(equityInvested);
        dm.metrics.cashOnCashPercent = equityInvested > 0 ? round2((cashFlow / equityInvested) * 100) : null;
        dm.metrics.paybackMinusHorizonYears = (paybackYears !== null && years) ? round2(paybackYears - years) : null;

        dm.metrics.equityInvested = round2(equityInvested);

        dm.metrics.irrMinusRealIrr = (irr !== null && realIRR !== null) ? round2(irr - realIRR) : null;

        dm.metrics.expensesToRentPercent = rent > 0 ? round2((expenses / rent) * 100) : null;
        dm.metrics.mortgageToRentPercent = rent > 0 ? round2((mortgage / rent) * 100) : null;

        dm.metrics.paybackMinusHorizonYears = (paybackYears !== null && years)
            ? round2(paybackYears - years)
            : null;


        dm.missingChecklist = [
            "Clarify cashFlow definition (annual vs total) if you compare deals side-by-side",
            "Exit price logic: confirm growth rate or provide explicit sale price scenario",
            "One-time reserves (capex/turnover) if expenses are simplified"
        ];

        return dm;
    }

    // -------------------------
    // RENOVATION_ROI
    // -------------------------
    if (type === "renovation_roi") {
        const priceBefore = nz(i.priceBefore);
        const rentBefore = nz(i.rentBefore);
        const renovationCost = nz(i.renovationCost);
        const priceIncrease = n(i.priceIncrease);
        const rentIncrease = n(i.rentIncrease);
        const agentFee = n(i.agentFee);
        const saleTax = n(i.saleTax);
        const years = nz(i.years);
        const discountRate = n(i.discountRate);
        const inflationRate = n(i.inflationRate);

        const priceAfter = nz(r.priceAfter);
        const rentAfter = nz(r.rentAfter);
        const totalExtraRent = nz(r.totalExtraRent);
        const totalExtraRentPV = nz(r.totalExtraRentPV);
        const saleProfit = nz(r.saleProfit);
        const netProfit = nz(r.netProfit);
        const netProfitPV = nz(r.netProfitPV);
        const roi = n(r.roi);
        const roiPV = n(r.roiPV);
        const payback = n(r.payback);

        const valueUplift = priceAfter - priceBefore;
        const rentUplift = rentAfter - rentBefore;
        const annualExtraRent = rentUplift * 12;

        dm.keyNumbers = {
            priceBefore, rentBefore, renovationCost, priceIncrease, rentIncrease,
            agentFee, saleTax, years, discountRate, inflationRate,
            priceAfter, rentAfter, totalExtraRent, totalExtraRentPV, saleProfit,
            netProfit, netProfitPV, roi, roiPV, payback
        };

        dm.metrics.valueUplift = round2(valueUplift);
        dm.metrics.rentUpliftMonthly = round2(rentUplift);
        dm.metrics.annualExtraRent = round2(annualExtraRent);
        dm.metrics.valueUpliftToRenovationRatio = ratio(valueUplift, renovationCost);
        dm.metrics.netProfitToRenovationRatio = ratio(netProfit, renovationCost);
        dm.metrics.netProfitPVToRenovationRatio = ratio(netProfitPV, renovationCost);
        dm.metrics.profitPerDollarRenovation = renovationCost > 0 ? round2(netProfit / renovationCost) : null;
        dm.metrics.profitPVPerDollarRenovation = renovationCost > 0 ? round2(netProfitPV / renovationCost) : null;

        // break-even value uplift considering sale costs (agentFee + saleTax if used as % of sale price)
        let breakevenUplift = null;
        if (renovationCost > 0 && Number.isFinite(priceAfter) && priceAfter > 0) {
            const feePct = Number.isFinite(agentFee) ? agentFee / 100 : 0;
            const taxPct = Number.isFinite(saleTax) ? saleTax / 100 : 0;
            const saleCost = priceAfter * (feePct + taxPct);
            breakevenUplift = round2(renovationCost + saleCost); // required uplift dollars vs 0 baseline
        }
        dm.metrics.breakEvenRequiredValueCreated = breakevenUplift;


        dm.missingChecklist = [
            "Renovation duration / lost rent during works (if applicable)",
            "Contingency buffer on renovation cost (5–15%)",
            "Comparable sales/rents to validate price/rent increase assumptions"
        ];

        return dm;
    }

    // -------------------------
    // PROPERTY_SALE
    // -------------------------
    if (type === "property_sale") {
        const buyPrice = nz(i.buyPrice);
        const sellPrice = nz(i.sellPrice);
        const years = nz(i.years);
        const tax = n(i.tax);
        const commission = n(i.commission);
        const inflation = n(i.inflation);
        const renovation = nz(i.renovation);

        const taxAmount = nz(r.taxAmount);
        const commissionAmount = nz(r.commissionAmount);
        const netProfit = nz(r.netProfit);
        const annualReturn = n(r.annualReturn);
        const realReturn = n(r.realReturn);

        const grossProfit = sellPrice - buyPrice;
        const totalExplicitCosts = taxAmount + commissionAmount + renovation;

        dm.keyNumbers = {
            buyPrice, sellPrice, years, tax, commission, inflation, renovation,
            taxAmount, commissionAmount, netProfit, annualReturn, realReturn
        };

        dm.metrics.grossProfit = round2(grossProfit);
        dm.metrics.totalExplicitCosts = round2(totalExplicitCosts);
        dm.metrics.netProfitMarginToBuyPricePercent = pct(netProfit, buyPrice);
        dm.metrics.costsToGrossProfitPercent = pct(totalExplicitCosts, grossProfit);

        dm.metrics.netProfitMarginToSellPricePercent = pct(netProfit, sellPrice);
        dm.metrics.costsToSellPricePercent = pct(totalExplicitCosts, sellPrice);

        const feeDrag = grossProfit > 0 ? round2(((taxAmount + commissionAmount) / grossProfit) * 100) : null;
        dm.metrics.feeDragPercentOfGrossProfit = feeDrag;

        // Break-even sell price approximation using input % rates (tax+commission) + renovation
        // netProfit ≈ sellPrice*(1 - tax% - commission%) - buyPrice - renovation
        const t = Number.isFinite(tax) ? (tax / 100) : 0;
        const c = Number.isFinite(commission) ? (commission / 100) : 0;
        const denom = (1 - t - c);
        dm.metrics.breakEvenSellPrice = denom > 0 ? round2((buyPrice + renovation) / denom) : null;

        dm.missingChecklist = [
            "Confirm tax base and whether it applies to gross profit or sale price (varies by jurisdiction)",
            "Other closing costs (escrow/title/legal) if applicable",
            "Timing: when renovation spend occurs vs sale (affects real return)"
        ];


        return dm;
    }

    // -------------------------
    // PROPERTY_TAXES
    // -------------------------
    if (type === "property_taxes") {
        const price = nz(i.price);
        const rent = nz(i.rent);
        const years = nz(i.years);
        const priceGrowth = n(i.priceGrowth);
        const propertyTax = n(i.propertyTax);
        const rentTax = n(i.rentTax);
        const annualFees = nz(i.annualFees);
        const feeGrowth = n(i.feeGrowth);
        const saleTax = n(i.saleTax);
        const agentFee = n(i.agentFee);
        const inflationRate = n(i.inflationRate);

        const totalTaxes = nz(r.totalTaxes);
        const totalFees = nz(r.totalFees);
        const totalRentNet = nz(r.totalRentNet);
        const finalProfit = nz(r.finalProfit);
        const finalProfitPV = nz(r.finalProfitPV);
        const simpleROI = n(r.simpleROI);
        const realROI = n(r.realROI);
        const taxBurdenPercent = n(r.taxBurdenPercent);

        dm.keyNumbers = {
            price, rent, years, priceGrowth, propertyTax, rentTax, annualFees, feeGrowth, saleTax, agentFee, inflationRate,
            totalTaxes, totalFees, totalRentNet, finalProfit, finalProfitPV, simpleROI, realROI, taxBurdenPercent
        };

        dm.metrics.taxesPlusFees = round2(totalTaxes + totalFees);
        dm.metrics.taxesToFeesRatio = ratio(totalTaxes, totalFees);
        dm.metrics.avgAnnualNetRent = years > 0 ? round2(totalRentNet / years) : null;
        dm.metrics.avgAnnualTaxes = years > 0 ? round2(totalTaxes / years) : null;

        // Premium ratios
        dm.metrics.feesAsPercentOfTaxes = pct(totalFees, totalTaxes); // насколько fees доминируют
        dm.metrics.taxesPlusFeesAsPercentOfPrice = pct((totalTaxes + totalFees), price);
        dm.metrics.netRentAsPercentOfTaxesPlusFees = pct(totalRentNet, (totalTaxes + totalFees));

        // Simple “where is the pain”
        dm.metrics.taxBurdenPercent = taxBurdenPercent; // уже в keyNumbers, но как metric тоже удобно

        // Breakeven: сколько tax+fees можно “переварить”, чтобы finalProfitPV == 0
        // Это приблизительно: allowableDrag ≈ finalProfitPV + (totalTaxes+totalFees)
        // (т.е. если убрать/уменьшить налоги/fees на эту величину, выйдем в ноль)
        dm.metrics.allowableTaxesPlusFeesToBreakEvenPV = round2(finalProfitPV + (totalTaxes + totalFees));

        dm.missingChecklist = [
            "Confirm effective property tax base (assessed value vs purchase price)",
            "Confirm whether rent tax applies to gross rent or net rent",
            "Exit costs realism: agent fee + sale tax + holding period assumptions"
        ];


        return dm;
    }

    // -------------------------
    // ALTERNATIVE_INVESTMENT
    // -------------------------
    if (type === "alternative_investment") {
        const propertyInitial = nz(i.propertyInitial);
        const propertyCashflow = nz(i.propertyCashflow);
        const propertyGrowth = n(i.propertyGrowth);
        const propertyInflation = n(i.propertyInflation);
        const propertyTaxRate = n(i.propertyTaxRate);

        const altReturn = n(i.altReturn);
        const altContribution = nz(i.altContribution);
        const altInflation = n(i.altInflation);
        const altTaxRate = n(i.altTaxRate);

        const years = nz(i.years);

        const propertyValue = nz(r.propertyValue);
        const alternativeValue = nz(r.alternativeValue);
        const propertyRealReturnPercent = n(r.propertyRealReturnPercent);
        const alternativeRealReturnPercent = n(r.alternativeRealReturnPercent);
        const difference = nz(r.difference);
        const winner = String(r.winner || "");

        dm.keyNumbers = {
            propertyInitial, propertyCashflow, propertyGrowth, propertyInflation, propertyTaxRate,
            altReturn, altContribution, altInflation, altTaxRate,
            years,
            propertyValue, alternativeValue, propertyRealReturnPercent, alternativeRealReturnPercent,
            difference, winner
        };

        const totalContributed = propertyInitial + (altContribution * years);
        const gain = alternativeValue - totalContributed;
        const outperformance = alternativeValue - propertyValue;
        const outperformancePercent = propertyValue > 0 ? ((alternativeValue / propertyValue - 1) * 100) : null;

        dm.keyNumbers.finalValue = round2(alternativeValue);
        dm.keyNumbers.totalContributed = round2(totalContributed);
        dm.keyNumbers.gain = round2(gain);
        dm.keyNumbers.totalFeesPaid = null;

        dm.metrics.simpleROI = (totalContributed > 0) ? round2((gain / totalContributed) * 100) : null;
        dm.metrics.feeDragPercentOfFinal = null;
        dm.metrics.outperformance = round2(outperformance);
        dm.metrics.outperformancePercent = round2(outperformancePercent);

        

        dm.metrics.differenceToPropertyInitialPercent = pct(difference, propertyInitial);
        dm.metrics.differenceToAltFinalPercent = pct(difference, alternativeValue);
        dm.metrics.realReturnGap = (propertyRealReturnPercent !== null && alternativeRealReturnPercent !== null)
            ? round2(propertyRealReturnPercent - alternativeRealReturnPercent)
            : null;

        dm.missingChecklist = [
            "Confirm altReturn / propertyGrowth are annual rates (not monthly)",
            "Confirm contribution schedule: altContribution and propertyCashflow are annual amounts",
            "Validate tax-rate assumptions (altTaxRate and propertyTaxRate) for your jurisdiction",
            "Scenario-test inflation assumptions (propertyInflation vs altInflation) for robustness"
        ];

        return dm;
    }

    // -------------------------
    // fallback
    // -------------------------
    dm.keyNumbers = { ...i, ...r };
    dm.missingChecklist = ["Add derived_metrics per calculator type as needed."];
    return dm;
}

const TYPE_RULES = {
    mortgage: `
Important:
- If calculator_type is "mortgage": do NOT judge "investment suitability" unless rent/income exists in payload.
  Instead judge COST efficiency and give optimization steps (rate/down/term) and what they change (monthly vs total cost).

Important (mortgage rules):
- NEVER use words: investment, ROI, profitability, cash flow positive/negative unless payload has rent/income fields.
- Always quantify cost using at least ONE:
  - derived_metrics.metrics.interestToLoanPercent
  - derived_metrics.metrics.totalPaidPerDollarBorrowed
  - derived_metrics.metrics.monthlyPaymentToLoanPercent
- For mortgage scenario ideas, keep termYears realistic: 10, 15, 20, 25, 30 (unless payload.input_data.termYears is already < 10).
- If payload.deltas_vs_baseline exists and monthlyPayment is lower vs baseline, never imply "strain" or "worse affordability". Describe monthly relief + total-cost trade-off if any.
- If rent/income is missing, explicitly say affordability cannot be judged and list it in Missing checklist.
`.trim(),

    rent_vs_buy: `
Important (rent_vs_buy rules):
- Focus on total cost comparison and horizon sensitivity.
- You MUST reference at least one of:
  - payload.result_data.rentTotal
  - payload.result_data.buyNetCost
  - payload.derived_metrics.metrics.rentMinusBuyNet
  - payload.derived_metrics.metrics.buyNetAsPercentOfRentTotal
  - payload.derived_metrics.metrics.breakEvenYearApprox (if exists)
- Never invent ownership costs, closing costs, or market assumptions.
- If the result is close (|rentMinusBuyNet| small relative to rentTotal), say it’s a close call and suggest which single input is most worth refining.
- Next runs inside the app MUST be:
  - Scenario A (Short horizon): reduce years (field: years)
  - Scenario B (Rate shock): change mortgageRate (field: mortgageRate) realistically
  - Scenario C (Growth swing): change propertyGrowth or rentGrowth
`.trim(),

    break_even: `
Important (break_even rules):
- Compare input_data.marketRent vs result_data.breakEvenRent and quantify the gap ($ and %).
- If winner is "rent" or marketRent < breakEvenRent: label it as cash-flow negative under these assumptions (no shame words).
- Provide 3 levers: marketRent, expenses/taxes, mortgage; plus one "price negotiation" lever if price is present.
- Next runs inside the app MUST be:
  - Scenario A: Raise marketRent (field: marketRent) to reach breakEvenRent.
  - Scenario B: Reduce expenses OR taxes (field: expenses or taxes) to reduce breakEvenRent.
  - Scenario C: Stress test vacancy +5% (field: vacancy) and explain fragility.
`.trim(),

    cash_flow: `
Important (cash_flow rules):
- Focus on stability: monthly cash flow, real cash flow, and stress test.
- You MUST reference at least one of:
  - payload.result_data.cashFlowMonth
  - payload.result_data.realCashFlowMonth
  - payload.result_data.stressCashFlow
  - payload.derived_metrics.metrics.cashFlowMarginPercent
  - payload.derived_metrics.metrics.expenseRatioPercent
  - payload.derived_metrics.metrics.breakEvenRentMonthly (if exists)
- If stressCashFlow < 0: label as "fails stress test" and propose which single input most effectively fixes it.
- Never invent utilities, repairs, insurance, HOA, or management fees. If missing, put into Missing checklist.
- Next runs inside the app MUST be:
  - Scenario A (Income): increase rent (field: rent).
  - Scenario B (Costs): reduce expenses (field: expenses) OR reduce mortgage (field: mortgage).
  - Scenario C (Risk): vacancy +5% (field: vacancy) to show fragility.
`.trim(),

    property_irr: `
Important (property_irr rules):
- Focus on return quality: payload.result_data.realIRR and irr, and explain the gap (inflation drag).
- You MUST reference at least one of:
  - payload.result_data.realIRR
  - payload.result_data.irr
  - payload.derived_metrics.metrics.cashOnCashPercent (if present)
  - payload.derived_metrics.metrics.expensesToRentPercent or mortgageToRentPercent (if present)
  - payload.derived_metrics.metrics.paybackMinusHorizonYears (if present)
- If realIRR <= 0: label as "loses value after inflation" and give 3 levers (rent, expenses, purchase price/exit).
- Next runs inside the app MUST be:
  - Scenario A (Income): increase rent (field: rent).
  - Scenario B (Costs): reduce expenses (field: expenses) or improve financing (field: mortgage).
  - Scenario C (Exit): increase growth (field: growth) OR reduce saleTax (field: saleTax).
`.trim(),

    renovation_roi: `
Important (renovation_roi rules):
- Focus on value creation vs renovationCost, and on discounted (PV) outcomes.
- You MUST reference at least one of:
  - payload.result_data.netProfitPV or payload.result_data.roiPV
  - payload.result_data.netProfit or payload.result_data.roi
  - payload.result_data.payback
  - payload.derived_metrics.metrics.valueUpliftToRenovationRatio
  - payload.derived_metrics.metrics.profitPVPerDollarRenovation (if present)
- If netProfitPV <= 0 or roiPV <= 0: label as "not worth it after discounting".
- Next runs inside the app MUST be:
  - Scenario A (Cost control): reduce renovationCost (field: renovationCost).
  - Scenario B (Value): increase priceIncrease (field: priceIncrease).
  - Scenario C (Risk): renovationCost +10% (field: renovationCost).
`.trim(),

    property_sale: `
Important (property_sale rules):
- Focus on net profit, annualReturn vs realReturn (inflation-adjusted), and explicit costs.
- You MUST reference at least one of:
  - payload.result_data.netProfit
  - payload.result_data.realReturn
  - payload.derived_metrics.metrics.costsToGrossProfitPercent
  - payload.derived_metrics.metrics.breakEvenSellPrice (if present)
- If realReturn <= 0 OR netProfit <= 0: verdict must be negative.
- Next runs inside the app MUST be:
  - Scenario A (Exit price): increase sellPrice (field: sellPrice).
  - Scenario B (Cost drag): reduce commission OR tax (field: commission or tax).
  - Scenario C (Stress): sellPrice -5% (field: sellPrice).
`.trim(),

    property_taxes: `
Important (property_taxes rules):
- Focus on real profitability after taxes/fees/inflation.
- You MUST reference at least one of:
  - payload.result_data.finalProfitPV
  - payload.result_data.realROI
  - payload.result_data.taxBurdenPercent
  - payload.derived_metrics.metrics.taxesPlusFees
- If finalProfitPV <= 0 OR realROI <= 0: verdict must be negative.
- Next runs inside the app MUST be:
  - Scenario A (Tax relief): decrease propertyTax (field: propertyTax).
  - Scenario B (Exit cost): decrease agentFee or saleTax (field: agentFee or saleTax).
  - Scenario C (Stress): increase propertyTax +1% OR feeGrowth +2% (field: propertyTax or feeGrowth).
`.trim(),

    ownership_cost: `
Important (ownership_cost rules):
- Focus on total ownership cost and sensitivity to taxes/maintenance/inflation/horizon.
- You MUST reference at least one:
  - payload.result_data.totalOwnershipCost (or totalCost)
  - payload.result_data.totalOwnershipCostPV (or totalCostPV)
  - payload.derived_metrics.keyNumbers.costAsPercentOfPrice
  - payload.derived_metrics.metrics.avgAnnualCost or avgMonthlyCost (if present)
- If costAsPercentOfPrice > 85%: verdict must be negative.
- Next runs MUST be:
  - Scenario A: decrease taxPercent (field: taxPercent).
  - Scenario B: reduce maintenance (field: maintenance).
  - Scenario C: inflation +2% (field: inflation).
`.trim(),

    alternative_investment: `
Important (alternative_investment rules):
- Explain compounding outcome vs property alternative.
- You MUST reference at least one:
  - payload.result_data.alternativeValue
  - payload.result_data.propertyValue
  - payload.result_data.alternativeRealReturnPercent
  - payload.result_data.propertyRealReturnPercent
  - payload.derived_metrics.keyNumbers.totalContributed
  - payload.derived_metrics.keyNumbers.gain
  - payload.derived_metrics.metrics.outperformance
  - payload.derived_metrics.metrics.outperformancePercent
- If alternativeRealReturnPercent <= propertyRealReturnPercent: verdict should be negative or cautious.
- Next runs MUST be:
  - Scenario A: altReturn ±2%
  - Scenario B: altTaxRate ±1%
  - Scenario C: altContribution increase +10%
`.trim(),

    mortgage_overpayment: `
Important (mortgage_overpayment rules):
- Focus on total overpayment and the inflation-adjusted (real) burden.
- You MUST reference at least one:
  - payload.result_data.nominalOverpayment
  - payload.result_data.realOverpayment
  - payload.derived_metrics.metrics.realOverpaymentToLoanPercent
  - payload.derived_metrics.metrics.totalPaidPerDollarBorrowed
  - payload.result_data.realInterestRate (if present)
- If realOverpaymentToLoanPercent > 60%: verdict must be negative.
- Next runs inside the app MUST be:
  - Scenario A: increase years OR lower rate slightly (field: rate or years).
  - Scenario B: lower rate more OR shorten term (field: rate or years).
  - Scenario C: rate +1% (field: rate).
`.trim()
};

function getRulesForType(type) {
    return TYPE_RULES[String(type || "")] || "";
}



async function generateVerdict(payload) {
    const type =String(payload.calculator_type || "");
    const TYPE_ONLY = getRulesForType(type);
    const SYSTEM = `
You are PropertyCost "Full Analysis" engine.

Hard constraints:
- The icon MUST match payload.mini_verdict.icon exactly (✅/⚠️/❌/ℹ️).
- You may be equally or more conservative than mini_verdict, never more optimistic.
- Never contradict payload.mini_verdict.text.

- If payload.deltas_vs_baseline exists and deltas_vs_baseline.monthlyPayment is negative (monthly got cheaper), do NOT claim affordability strain.
- If monthlyPayment decreases but totalInterest/totalPayment increases, clearly label it as a trade-off: "monthly relief" vs "higher total cost".

Data integrity:
- Use ONLY numbers present in payload JSON (including derived_metrics).
- Never invent taxes, insurance, HOA, vacancy, rent, market facts, salary, or income.
- If something is missing, list it under "Missing checklist".

Style:
- Be concise but premium. No fluff. No disclaimers.
- Every bullet must cite at least one number OR a named payload field.
- Give the user an action plan: what to change, why, and what metric improves.
- Focus on THIS calculator_type only.

Output must match the exact structure requested.
`.trim();

    const USER = `
Write a premium "Full Analysis" that feels worth paying for.

Language: English. Max 650 tokens.

${TYPE_ONLY}

For "Next runs inside the app" output 3 scenario ideas in this generic pattern:
- Scenario A (Primary lever): one change that most directly improves the main metric for this calculator type.
- Scenario B (Trade-off lever): one realistic alternative with a different trade-off profile.
- Scenario C (Constraint / stress): one constrained or stress case that tests robustness.
Each scenario must mention exact field names to change.

If payload.context.isInvestment is false (no rent/income):
- Do NOT mention ROI/profitability/cash flow.
- Use wording: "monthly affordability" and "total cost".
If payload.context.isInvestment is true:
- You may mention rent/income coverage and cash flow.

When you mention down payment %, use payload.derived_metrics.metrics.downPaymentPercent

Output EXACTLY this structure:

Verdict: <icon> <one sentence matching mini_verdict and referencing at least 1 payload number>

Why this verdict (3 bullets, each must cite a payload number or derived metric):
- ...
- ...
- ...

Key numbers (4–6 bullets):
- ...

Missing checklist (2–5 bullets):
- Use payload.derived_metrics.missingChecklist if available.

What to do to improve the result (3 bullets):
- Each bullet: which input to change + expected effect + which metric improves.

Sensitivity quick test (3 bullets):
- Each bullet: one change + directional impact (monthly vs total interest).

Next runs inside the app (3 scenarios):
- Scenario A: ...
- Scenario B: ...
- Scenario C: ...

Payload JSON:
${JSON.stringify(payload)}
`.trim();

    const text = await aiChatCompletion({
        model: "gpt-4o-mini",
        temperature: 0.25,
        max_tokens: 700,
        messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: USER }
        ]
    });
    return aiEnsureUsefulVerdict(String(text).trim(), payload);
}


const SCENARIO_TYPE_RULES = {
    mortgage: `
Focus on: monthlyPayment, totalPayment, totalInterest.
Use payload.deltas_vs_baseline.monthlyPayment/totalPayment/totalInterest if present.
If monthlyPayment goes down but totalPayment/totalInterest goes up: call it a trade-off explicitly.
Mention the lever changed (ratePercent / termYears / down) using payload.input_changes.
`.trim(),

    rent_vs_buy: `
Focus on: rentTotal vs buyNetCost and rentMinusBuyNet (if present).
Horizon (years) is the #1 driver — mention it if changed.
If close call (small difference), say it is sensitive.
`.trim(),

    break_even: `
Focus on: marketRent vs breakEvenRent, and the gap (delta).
Mention the single best lever: rent, expenses/taxes, vacancy, price.
`.trim(),

    cash_flow: `
Focus on: cashFlowMonth, realCashFlowMonth, stressCashFlow.
If stressCashFlow < 0 => "fails stress test".
Mention which lever changed: rent / vacancy / expenses / mortgage.
`.trim(),

    property_irr: `
Focus on: realIRR and irr + paybackYears (if present).
Mention rent/expenses/growth/saleTax levers if they changed.
`.trim(),

    renovation_roi: `
Focus on: netProfitPV or roiPV + payback.
Mention renovationCost / priceIncrease / rentIncrease changes.
`.trim(),

    property_sale: `
Focus on: netProfit and realReturn.
Mention sellPrice / commission / tax / inflation changes.
`.trim(),

    property_taxes: `
Focus on: finalProfitPV, realROI, taxBurdenPercent.
Mention propertyTax / rentTax / annualFees / feeGrowth / agentFee / saleTax changes.
`.trim(),

    ownership_cost: `
Focus on: totalOwnershipCostPV (or totalCostPV), and costAsPercentOfPrice.
Mention taxPercent / maintenance / inflation / years changes.
`.trim(),

    alternative_investment: `
Focus on: alternativeValue vs propertyValue, real-return gap, gain, totalContributed.
Mention altReturn / altTaxRate / altContribution / propertyGrowth changes.
`.trim(),

    mortgage_overpayment: `
Focus on: realOverpayment, nominalOverpayment, totalPaidPerDollarBorrowed if present.
Mention rate / years / inflation changes.
`.trim()
};

function getScenarioRulesForType(type) {
    return SCENARIO_TYPE_RULES[String(type || "")] || "";
}

function toNumOrNull(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
        const x = Number(v.replace(/,/g, "").trim());
        return Number.isFinite(x) ? x : null;
    }
    return null;
}

function valuesEqualLoosely(a, b) {
    // treat "1000" and 1000 as equal
    const na = toNumOrNull(a);
    const nb = toNumOrNull(b);
    if (na !== null && nb !== null) return na === nb;
    return String(a) === String(b);
}

function diffInputData(baseInput, curInput, limit = 6) {
    const base = baseInput || {};
    const cur = curInput || {};
    const keys = new Set([...Object.keys(base), ...Object.keys(cur)]);
    const out = [];

    for (const k of keys) {
        if (!(k in base) || !(k in cur)) continue;
        if (valuesEqualLoosely(base[k], cur[k])) continue;

        out.push({
            field: k,
            from: base[k],
            to: cur[k]
        });

        if (out.length >= limit) break;
    }

    return out;
}

async function generateScenarioVerdict(payload) {
    const type = String(payload?.calculator_type || "");
    const TYPE_ONLY = getScenarioRulesForType(type);

    const SYSTEM = `
You are PropertyCost "Scenario Analysis" engine.

Hard constraints:
- The icon MUST match payload.mini_verdict.icon exactly (✅/⚠️/❌/ℹ️).
- Be consistent with payload.mini_verdict level (same or more conservative), never more optimistic.
- Use ONLY numbers present in payload JSON (including input_changes, result_data, baseline_result, deltas_vs_baseline, derived_metrics).
- Do NOT output "Next runs inside the app" (user already sees scenario buttons).
- MUST mention:
  - at least 2 concrete numbers
  - at least 1 delta vs baseline (prefer payload.deltas_vs_baseline)
- Even if icon/level stays unchanged, explicitly say whether this scenario is better, worse, or low-impact vs baseline.
- If all deltas are tiny, explicitly call it a "low-impact scenario".

Style:
- Short, premium, actionable. No fluff.
- Prefer explicit deltas: "(−$120/mo vs base)" / "(+1.2% vs base)".
- If there is a trade-off, label it explicitly.
`.trim();

    // keep scenario payload small (helps model stay specific and unique)
    const payloadLite = {
        calculator_type: payload.calculator_type,
        scenario_label: payload.scenario_label,
        context: payload.context,
        mini_verdict: payload.mini_verdict,
        input_changes: payload.input_changes,
        // baseline vs current
        baseline_input_data: payload.baseline_input_data,
        input_data: payload.input_data,
        baseline_result: payload.baseline_result,
        result_data: payload.result_data,
        deltas_vs_baseline: payload.deltas_vs_baseline,
        derived_metrics: payload.derived_metrics
    };

    const USER = `
Language: English. Max 320 tokens.

${TYPE_ONLY}

Hard requirements:
- You MUST explicitly mention payload.scenario_tag.
- You MUST mention payload.main_driver (field + from→to OR metric delta).
- You MUST include at least 2 concrete numbers and at least 1 delta vs baseline.
- You MUST explicitly include one phrase: "better vs baseline" OR "worse vs baseline" OR "low-impact vs baseline".

Output EXACTLY this structure:

Scenario: <scenario_label>

Verdict: <icon> <one sentence consistent with mini verdict, cite 1 key number + 1 delta vs baseline>

Tag:
- <payload.scenario_tag>

Main driver:
- <payload.main_driver>

What changed (inputs you control):
- <field>: <from> → <to>
- ... (2–5 bullets)

Impact vs baseline (numbers):
- ... (2–4 bullets)

Trade-off / note:
- ... (1 bullet)

Recommendation:
- ... (1 bullet)

Payload JSON:
${JSON.stringify(payloadLite)}
`.trim();

    const text = await aiChatCompletion({
        model: "gpt-4o-mini",
        temperature: 0.35,
        max_tokens: 420,
        messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: USER }
        ]
    });
    return aiEnsureUsefulScenario(String(text).trim(), payload);
}



function extractJsonPayloadFromText(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    if (s.startsWith("{") || s.startsWith("[")) return s;

    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) return fenced[1].trim();

    const i = s.indexOf("{");
    const j = s.lastIndexOf("}");
    if (i >= 0 && j > i) return s.slice(i, j + 1);
    return null;
}

function parseScenarioBatchResponse(rawText) {
    const jsonText = extractJsonPayloadFromText(rawText);
    if (!jsonText) return [];

    let parsed = null;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        return [];
    }

    const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.items) ? parsed.items : [];

    return items
        .map((x) => ({
            idx: Number(x?.idx),
            verdict_text: String(x?.verdict_text || x?.content || "").trim()
        }))
        .filter((x) => Number.isInteger(x.idx) && x.idx >= 0 && x.verdict_text);
}

function buildScenarioBatchChatRequest(payloads) {
    const src = Array.isArray(payloads) ? payloads : [];
    if (!src.length) return null;

    const lite = src.map((p, idx) => ({
        idx,
        calculator_type: p?.calculator_type,
        scenario_label: p?.scenario_label,
        mini_verdict: p?.mini_verdict,
        input_changes: p?.input_changes,
        scenario_tag: p?.scenario_tag,
        main_driver: p?.main_driver,
        baseline_result: p?.baseline_result,
        result_data: p?.result_data,
        deltas_vs_baseline: p?.deltas_vs_baseline
    }));

    const SYSTEM = `
You are PropertyCost "Scenario Batch Analysis" engine.

Goal:
- Analyze all scenarios in ONE response.
- Stay consistent with each scenario mini_verdict icon/level.
- Use ONLY numbers provided in payload.
- Keep each scenario concise and useful (80-120 words each).

Output:
- Return STRICT JSON only (no markdown, no commentary).
- Format: { "items": [ { "idx": 0, "verdict_text": "..." }, ... ] }.
- Include all idx values from payload exactly once.
- Each verdict_text must follow this structure:
  Scenario: ...
  Verdict: ...
  Tag:
  - ...
  Main driver:
  - ...
  What changed (inputs you control):
  - ...
  Impact vs baseline (numbers):
  - ...
  Trade-off / note:
  - ...
  Recommendation:
  - ...
`.trim();

    const USER = `
Language: English.

Hard constraints:
- Each verdict_text includes at least 2 numbers and at least 1 explicit delta vs baseline.
- Must include one exact phrase: "better vs baseline" OR "worse vs baseline" OR "low-impact vs baseline".
- Must explicitly mention scenario_tag and main_driver.
- Do not invent fields.

Payload JSON:
${JSON.stringify({ items: lite })}
`.trim();

    return {
        messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: USER }
        ],
        max_tokens: Math.min(2200, 420 + src.length * 190),
        dedupKey: `scenario-batch:${hashJson({ items: lite }).slice(0, 24)}`
    };
}

async function generateScenarioVerdictsBatch(payloads) {
    const reqData = buildScenarioBatchChatRequest(payloads);
    if (!reqData) return [];

    const text = await aiChatCompletion({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: reqData.max_tokens,
        messages: reqData.messages,
        dedupKey: reqData.dedupKey
    });

    const rows = parseScenarioBatchResponse(text);
    if (!rows.length) throw new Error("SCENARIO_BATCH_PARSE_FAILED");
    return rows;
}

function buildScenarioOutFromBatch(preparedAll, batchRows = []) {
    const prepared = Array.isArray(preparedAll) ? preparedAll : [];
    const validPrepared = prepared.filter((x) => !x.error && x.payload);
    const out = [];

    prepared
        .filter((x) => x.error)
        .forEach((x) => out.push({ idx: x.idx, ...x.scenarioBaseItem, error: x.error }));

    const byLocalIdx = new Map(
        (Array.isArray(batchRows) ? batchRows : [])
            .map((x) => [Number(x?.idx), String(x?.verdict_text || "").trim()])
            .filter((x) => Number.isInteger(x[0]) && x[0] >= 0)
    );

    validPrepared.forEach((entry, localIdx) => {
        let verdict_text = byLocalIdx.get(localIdx) || "";
        if (!verdict_text) {
            verdict_text = aiFallbackScenario(entry.payload);
        }
        verdict_text = aiEnsureUsefulScenario(verdict_text, entry.payload);
        if (entry.payload.calculator_type === "mortgage") {
            verdict_text = sanitizeMortgageVerdict(verdict_text, entry.payload);
        }
        out.push({ idx: entry.idx, ...entry.scenarioBaseItem, verdict_text });
    });

    out.sort((a, b) => Number(a.idx || 0) - Number(b.idx || 0));
    return out;
}

async function saveScenarioAnalysisRun(userId, calculationId, calculatorType, cost, items) {
    const safeItems = Array.isArray(items) ? items : [];
    const requested_count = safeItems.length;
    const generated_count = safeItems.length;

    await db.query(
        `insert into scenario_analyses
   (user_id, calculation_id, calculator_type, requested_count, generated_count, cost, items)
   values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
            userId,
            calculationId,
            calculatorType,
            requested_count,
            generated_count,
            cost,
            JSON.stringify(safeItems)
        ]
    );

    await db.query(
        `delete from scenario_analyses
   where id in (
     select id from scenario_analyses
     where user_id=$1 and calculation_id=$2
     order by created_at desc
     offset 5
   )`,
        [userId, calculationId]
    );
}

async function canUseVerdict(userId) {
    const r = await db.query(
        "select free_used, credits from verdict_wallets where user_id=$1",
        [userId]
    );

    if (!r.rowCount) return "free";
    if (!r.rows[0].free_used) return "free";
    if (r.rows[0].credits > 0) return "credit";
    return null;
}
async function spend(userId, mode) {
    if (mode === "free") {
        await db.query(
            `insert into verdict_wallets(user_id, free_used)
       values($1,true)
       on conflict (user_id)
       do update set free_used=true`,
            [userId]
        );
    } else {
        const r = await db.query(
            "update verdict_wallets set credits = credits - 1 where user_id=$1 and credits > 0",
            [userId]
        );
        if (!r.rowCount) throw new Error("NO_CREDITS");
    }
}
async function getCachedVerdict(userId, calculationId) {
    const r = await db.query(
        `select id, content, mode, created_at
     from verdicts
     where user_id=$1 and calculation_id=$2
     order by id desc
     limit 1`,
        [userId, calculationId]
    );
    return r.rowCount ? r.rows[0] : null;
}
// лимит паралелльности 
async function mapLimit(items, limit, worker) {
    const arr = Array.isArray(items) ? items : [];
    const out = new Array(arr.length);

    let i = 0;

    async function runOne() {
        while (true) {
            const idx = i++;
            if (idx >= arr.length) return;
            out[idx] = await worker(arr[idx], idx);
        }
    }

    const workers = [];
    const n = Math.max(1, Math.min(limit || 1, arr.length || 1));
    for (let k = 0; k < n; k++) workers.push(runOne());

    await Promise.all(workers);
    return out;
}

function scenarioCost(count) {
    if (count === 3) return 2;
    if (count === 5) return 3;
    if (count === 10) return 6;
    // fallback: если придёт другое число — можно 1 кредит за 1 сценарий
    return Math.max(1, Math.ceil(count * 0.6));
}

const MAX_SCENARIO_COMPUTE_ITEMS = (() => {
    const n = Number(process.env.MAX_SCENARIO_COMPUTE_ITEMS);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
    return 220;
})();

function primaryMetricByType(type) {
    if (type === "mortgage") return { key: "monthlyPayment", better: "min" };
    if (type === "cash_flow") return { key: "stressCashFlow", better: "max" };
    if (type === "property_irr") return { key: "realIRR", better: "max" };
    if (type === "break_even") return { key: "breakEvenRent", better: "min" };
    if (type === "property_taxes") return { key: "finalProfitPV", better: "max" };
    if (type === "property_sale") return { key: "netProfit", better: "max" };
    if (type === "renovation_roi") return { key: "netProfitPV", better: "max" };
    if (type === "alternative_investment") return { key: "alternativeRealReturnPercent", better: "max" };
    if (type === "rent_vs_buy") return { key: "buyNetCost", better: "min" }; 
    if (type === "ownership_cost") return { key: "totalOwnershipCostPV", better: "min" };
    if (type === "mortgage_overpayment") return { key: "realOverpayment", better: "min" }; 
    // меньше = выгоднее покупать
    return { key: null, better: "max" };
}

function metricValue(res, key) {
    if (!res || !key) return NaN;
    if (key === "totalOwnershipCostPV") return toNum(res.totalOwnershipCostPV ?? res.totalCostPV, NaN);
    if (key === "alternativeRealReturnPercent") {
        return toNum(
            res.alternativeRealReturnPercent ??
            res.altRealReturnPercent ??
            res.realReturnPercent,
            NaN
        );
    }
    const v = res ? res[key] : undefined;
    return toNum(v, NaN);
}

const STALE_CHECK_KEYS_BY_TYPE = {
    mortgage: ["monthlyPayment", "totalPayment", "totalInterest"],
    rent_vs_buy: ["rentTotal", "buyNetCost", "mortgagePaid"],
    break_even: ["breakEvenRent", "breakEvenPrice"],
    cash_flow: ["cashFlowMonth", "realCashFlowMonth", "stressCashFlow"],
    property_irr: ["realIRR", "irr", "paybackYears"],
    renovation_roi: ["netProfitPV", "roiPV", "payback"],
    property_sale: ["netProfit", "realReturn", "annualReturn"],
    property_taxes: ["finalProfitPV", "realROI", "taxBurdenPercent"],
    ownership_cost: ["totalOwnershipCostPV", "totalOwnershipCost"],
    alternative_investment: ["alternativeValue", "propertyValue", "difference"],
    mortgage_overpayment: ["realOverpayment", "nominalOverpayment", "monthlyPayment"]
};

function numericDrifted(a, b) {
    const av = toNum(a, NaN);
    const bv = toNum(b, NaN);
    if (!Number.isFinite(av) && !Number.isFinite(bv)) return false;
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return true;
    const tol = Math.max(0.5, Math.abs(bv) * 0.001); // 0.1% or $0.5
    return Math.abs(av - bv) > tol;
}

function calcResultStaleCheck(calcType, inputData, storedResult) {
    const canonical = computeResultByType(calcType, inputData);
    const saved = (storedResult && typeof storedResult === "object") ? storedResult : {};
    if (!canonical || typeof canonical !== "object") {
        return { stale: false, canonical: saved };
    }

    const keys = STALE_CHECK_KEYS_BY_TYPE[String(calcType || "")] || [];
    const fallbackKey = primaryMetricByType(calcType)?.key;
    const checkKeys = keys.length ? keys : (fallbackKey ? [fallbackKey] : []);

    let compared = 0;
    for (const k of checkKeys) {
        const a = metricValue(saved, k);
        const b = metricValue(canonical, k);
        if (!Number.isFinite(a) && !Number.isFinite(b)) continue;
        compared++;
        if (numericDrifted(a, b)) return { stale: true, canonical };
    }

    // If we had nothing comparable but canonical has meaningful data, prefer canonical.
    if (compared === 0) {
        const hasSavedNums = Object.values(saved).some((x) => Number.isFinite(Number(x)));
        const hasCanonNums = Object.values(canonical).some((x) => Number.isFinite(Number(x)));
        if (!hasSavedNums && hasCanonNums) return { stale: true, canonical };
    }

    return { stale: false, canonical };
}

async function normalizeCalcResultData(calcRow, userId) {
    const row = calcRow || {};
    const type = String(row.calculator_type || "");
    const input = (row.input_data && typeof row.input_data === "object") ? row.input_data : {};
    const stored = (row.result_data && typeof row.result_data === "object") ? row.result_data : {};

    const check = calcResultStaleCheck(type, input, stored);
    let canonicalResult = (check.canonical && typeof check.canonical === "object")
        ? { ...check.canonical }
        : check.canonical;

    const storedCanonTs = (stored && typeof stored.__pcCanonTs === "string") ? stored.__pcCanonTs : "";
    if (check.stale) {
        if (canonicalResult && typeof canonicalResult === "object") {
            canonicalResult.__pcCanonTs = new Date().toISOString();
        }
    } else if (storedCanonTs && canonicalResult && typeof canonicalResult === "object" && !canonicalResult.__pcCanonTs) {
        canonicalResult.__pcCanonTs = storedCanonTs;
    }

    const out = { ...row, result_data: canonicalResult };

    if (check.stale && Number(row.id) > 0 && Number(userId) > 0) {
        try {
            await db.query(
                `update calculations
                 set result_data=$1
                 where id=$2 and user_id=$3`,
                [canonicalResult, row.id, userId]
            );
        } catch (e) {
            console.error("CALC_CANONICALIZE_FAILED:", e);
        }
    }

    return { calc: out, stale: check.stale };
}

function calcCanonTsMs(calcLike) {
    const ts = Date.parse(String(calcLike?.result_data?.__pcCanonTs || ""));
    return Number.isFinite(ts) ? ts : null;
}

function isCacheOlderThanCalc(calcLike, cacheCreatedAt) {
    const calcTs = calcCanonTsMs(calcLike);
    if (!Number.isFinite(calcTs)) return false;
    const cacheTs = Date.parse(String(cacheCreatedAt || ""));
    if (!Number.isFinite(cacheTs)) return false;
    return cacheTs <= calcTs;
}

function isBetter(a, b, better) {
    if (!Number.isFinite(a)) return false;
    if (!Number.isFinite(b)) return true;
    return better === "min" ? a < b : a > b;
}

function compareLeversByType(type, input) {
    // levers, которые юзер реально может “выбить” (negotiation)
    if (type === "mortgage") return ["price", "ratePercent", "down", "termYears"];
    if (type === "cash_flow") return ["rent", "expenses", "mortgage", "vacancy", "taxes"];
    if (type === "property_irr") return ["price", "rent", "expenses", "growth", "saleTax"];
    if (type === "break_even") return ["marketRent", "expenses", "taxes", "mortgage", "vacancy", "price"];
    if (type === "property_taxes") return ["propertyTax", "rentTax", "annualFees", "feeGrowth", "agentFee", "saleTax", "priceGrowth", "inflationRate"];
    if (type === "property_sale") return ["sellPrice", "commission", "tax", "renovation", "years", "buyPrice"];
    if (type === "renovation_roi") return ["renovationCost", "priceIncrease", "rentIncrease", "agentFee", "saleTax", "discountRate"];
    if (type === "alternative_investment") return ["altReturn", "altContribution", "altTaxRate", "propertyGrowth", "propertyCashflow", "propertyTaxRate"];
    if (type === "rent_vs_buy") return ["years", "mortgageRate", "propertyGrowth", "rentGrowth", "rent", "mortgage"];
    if (type === "ownership_cost") return ["taxPercent", "maintenance", "inflation", "years"];
    if (type === "mortgage_overpayment") return ["rate", "years", "inflation", "loan"];


    return ["price", "rent", "expenses"];
}

function inferCalcTypeFromInput(baseInput) {
    const i = baseInput || {};
    if ("marketRent" in i && "downPayment" in i && "taxes" in i) return "break_even";
    if ("propertyValue" in i && "mortgageRate" in i && "rentGrowth" in i) return "rent_vs_buy";
    if ("loan" in i && ("rate" in i || "ratePercent" in i) && "inflation" in i) return "mortgage_overpayment";
    if ("price" in i && "taxPercent" in i && "maintenance" in i) return "ownership_cost";
    if ("buyPrice" in i && "sellPrice" in i && "commission" in i) return "property_sale";
    if ("rent" in i && "vacancy" in i && "mortgage" in i && "expenses" in i && "taxes" in i) return "cash_flow";
    if ("propertyTax" in i && "rentTax" in i && "annualFees" in i) return "property_taxes";
    if ("priceBefore" in i && "renovationCost" in i) return "renovation_roi";
    if ("propertyInitial" in i && "altReturn" in i) return "alternative_investment";
    if ("growth" in i && "saleTax" in i && "rent" in i) return "property_irr";
    if ("price" in i && "down" in i && "ratePercent" in i) return "mortgage";
    return "";
}

function leverRange(field, baseInput) {
    const v = toNum(baseInput[field], NaN);
    if (!Number.isFinite(v)) return null;
    const inferredType = inferCalcTypeFromInput(baseInput);

    const clampRange = (lo, hi) => ({ lo, hi, prefer: "down" });
    const pctRange = (x, lo, hi, down = true) => ({
        lo: Math.max(lo, x - Math.max(1.5, Math.abs(x) * 0.35)),
        hi: Math.min(hi, x + Math.max(1.0, Math.abs(x) * 0.25)),
        prefer: down ? "down" : "up"
    });

    if (field === "price") return { lo: Math.max(1, v * 0.6), hi: Math.max(1, v * 1.05), prefer: "down" };
    if (field === "buyPrice") return { lo: Math.max(1, v * 0.75), hi: Math.max(1, v * 1.05), prefer: "down" };
    if (field === "sellPrice") return { lo: Math.max(1, v * 0.85), hi: Math.max(1, v * 1.35), prefer: "up" };
    if (field === "propertyInitial" || field === "propertyValue") return { lo: Math.max(1, v * 0.8), hi: Math.max(1, v * 1.2), prefer: "down" };

    if (field === "rent" || field === "marketRent") return { lo: Math.max(0, v * 0.7), hi: Math.max(1, v * 1.8), prefer: "up" };
    if (field === "expenses") return { lo: Math.max(0, v * 0.5), hi: Math.max(1, v * 1.3), prefer: "down" };
    if (field === "annualFees" || field === "maintenance" || field === "renovation" || field === "renovationCost") {
        return { lo: Math.max(0, v * 0.55), hi: Math.max(1, v * 1.35), prefer: "down" };
    }
    if (field === "mortgage") return { lo: Math.max(0, v * 0.7), hi: Math.max(1, v * 1.2), prefer: "down" };
    if (field === "loan") return { lo: Math.max(1, v * 0.75), hi: Math.max(1, v * 1.1), prefer: "down" };
    if (field === "down") {
        const price = toNum(baseInput?.price, NaN);
        const hi = Number.isFinite(price) ? Math.max(0, Math.min(price - 1, v + price * 0.35)) : Math.max(v + 1000, v * 1.8);
        return { lo: Math.max(0, v), hi, prefer: "up" };
    }
    if (field === "altContribution") return { lo: Math.max(0, v * 0.7), hi: Math.max(1, v * 1.8), prefer: "up" };
    if (field === "propertyCashflow") {
        const spread = Math.max(500, Math.abs(v) * 0.5);
        return { lo: v - spread, hi: v + spread, prefer: "up" };
    }

    if (field === "ratePercent") return { lo: Math.max(0, v - 3.0), hi: Math.min(70, v + 1.5), prefer: "down" };
    if (field === "rate") return { lo: Math.max(0.1, v - 3.0), hi: Math.min(70, v + 2.0), prefer: "down" };
    if (field === "mortgageRate") return { lo: Math.max(0, v - 3.0), hi: Math.min(100, v + 2.5), prefer: "down" };
    if (field === "growth") return { lo: Math.max(-99, v - 6), hi: Math.min(2000, v + 6), prefer: "up" };
    if (field === "propertyGrowth") {
        if (inferredType === "rent_vs_buy") {
            return { lo: Math.max(0, v - 4), hi: Math.min(50, v + 6), prefer: "up" };
        }
        return { lo: Math.max(-99, v - 4), hi: Math.min(2000, v + 6), prefer: "up" };
    }
    if (field === "priceIncrease" || field === "rentIncrease" || field === "altReturn") return { lo: Math.max(-100, v - 6), hi: Math.min(2000, v + 10), prefer: "up" };
    if (field === "rentGrowth") return { lo: Math.max(0, v - 3), hi: Math.min(50, v + 3), prefer: "down" };

    if (field === "taxes") {
        if (inferredType === "break_even") {
            return {
                lo: Math.max(0, v * 0.5),
                hi: Math.min(100_000_000, Math.max(v + 500, v * 1.5)),
                prefer: "down"
            };
        }
        return pctRange(v, 0, 70, true);
    }
    if (field === "tax" || field === "propertyTax" || field === "rentTax" || field === "taxPercent") return pctRange(v, 0, 70, true);
    if (field === "saleTax") return pctRange(v, 0, 60, true);
    if (field === "commission") return pctRange(v, 0, 40, true);
    if (field === "agentFee") return pctRange(v, 0, 50, true);
    if (field === "altTaxRate" || field === "propertyTaxRate") return pctRange(v, 0, 100, true);
    if (field === "feeGrowth") return pctRange(v, 0, 50, true);
    if (field === "inflation") {
        if (inferredType === "rent_vs_buy") return pctRange(v, 0, 20, true);
        if (inferredType === "mortgage_overpayment") return pctRange(v, 0, 50, true);
        if (inferredType === "ownership_cost" || inferredType === "cash_flow") return pctRange(v, -5, 40, true);
        if (inferredType === "property_sale") return pctRange(v, -10, 50, true);
        return pctRange(v, -10, 50, true);
    }
    if (field === "discountRate" || field === "inflationRate" || field === "propertyInflation" || field === "altInflation") {
        const lo = (field === "inflationRate") ? -5 : 0;
        const hi = (field === "inflationRate") ? 30 : 100;
        return pctRange(v, lo, hi, true);
    }
    if (field === "vacancy") {
        const maxVacancy = inferredType === "break_even" ? 95 : 99;
        return pctRange(v, 0, maxVacancy, true);
    }

    if (field === "termYears") return { lo: Math.max(1, v), hi: Math.min(70, v + 12), prefer: "up" };
    if (field === "years") {
        const cap = yearsCapFromInput(baseInput);
        return { lo: Math.max(1, v * 0.6), hi: Math.min(cap, v * 1.5), prefer: "down" };
    }

    return clampRange(v * 0.8, v * 1.2);
}

function yearsCapFromInput(baseInput) {
    const i = baseInput || {};
    if ("propertyValue" in i && "mortgageRate" in i) return 50;          // rent_vs_buy
    if ("loan" in i && ("rate" in i || "ratePercent" in i)) return 70;   // mortgage_overpayment
    if ("buyPrice" in i && "sellPrice" in i) return 70;                   // property_sale
    if ("priceBefore" in i && "renovationCost" in i) return 70;           // renovation_roi
    if ("propertyInitial" in i && "altReturn" in i) return 80;            // alternative_investment
    if ("propertyTax" in i && "rentTax" in i) return 70;                  // property_taxes
    if ("growth" in i && "saleTax" in i) return 100;                      // property_irr
    return 100;
}

function normalizeLeverValueForField(field, value, baseInput) {
    if (!Number.isFinite(Number(value))) return null;
    let v = Number(value);
    const inferredType = inferCalcTypeFromInput(baseInput);

    const intFields = new Set([
        "years", "termYears", "price", "buyPrice", "sellPrice", "propertyValue",
        "propertyInitial", "rent", "marketRent", "expenses", "mortgage", "loan",
        "annualFees", "maintenance", "renovation", "renovationCost", "altContribution",
        "propertyCashflow", "down"
    ]);

    if (intFields.has(field)) v = Math.round(v);
    else v = Math.round(v * 10) / 10;

    if (field === "down") {
        const price = toNum(baseInput?.price, NaN);
        if (Number.isFinite(price)) v = Math.min(v, Math.max(0, Math.round(price - 1)));
        return Math.max(0, v);
    }
    if (field === "price" || field === "buyPrice" || field === "sellPrice" || field === "propertyValue" || field === "propertyInitial") return Math.max(1, v);
    if (field === "ratePercent") return clampNum(v, 0, 70);
    if (field === "rate") return clampNum(v, 0.1, 70);
    if (field === "mortgageRate") return clampNum(v, 0, 100);
    if (field === "rentGrowth") return clampNum(v, 0, 50);
    if (field === "growth") return clampNum(v, -99, 2000);
    if (field === "propertyGrowth") {
        if (inferredType === "rent_vs_buy") return clampNum(v, 0, 50);
        return clampNum(v, -99, 2000);
    }
    if (field === "priceIncrease" || field === "rentIncrease") return clampNum(v, -100, 2000);
    if (field === "altReturn") return clampNum(v, -99, 2000);
    if (field === "altTaxRate" || field === "propertyTaxRate") return clampNum(v, 0, 100);
    if (field === "tax" || field === "propertyTax" || field === "rentTax" || field === "taxPercent") return clampNum(v, 0, 70);
    if (field === "commission") return clampNum(v, 0, 40);
    if (field === "saleTax") return clampNum(v, 0, 60);
    if (field === "agentFee") return clampNum(v, 0, 50);
    if (field === "taxes") {
        if (inferredType === "break_even") return clampNum(v, 0, 100_000_000);
        return clampNum(v, 0, 70);
    }
    if (field === "feeGrowth") return clampNum(v, 0, 50);
    if (field === "vacancy") {
        const maxVacancy = inferredType === "break_even" ? 95 : 99;
        return clampNum(v, 0, maxVacancy);
    }
    if (field === "inflation") {
        if (inferredType === "rent_vs_buy") return clampNum(v, 0, 20);
        if (inferredType === "mortgage_overpayment") return clampNum(v, 0, 50);
        if (inferredType === "ownership_cost" || inferredType === "cash_flow") return clampNum(v, -5, 40);
        if (inferredType === "property_sale") return clampNum(v, -10, 50);
        return clampNum(v, -10, 50);
    }
    if (field === "inflationRate") return clampNum(v, -5, 30);
    if (field === "propertyInflation" || field === "altInflation") return clampNum(v, 0, 100);
    if (field === "discountRate") return clampNum(v, 0, 100);
    if (field === "termYears") return clampNum(v, 1, 70);
    if (field === "years") return clampNum(v, 1, yearsCapFromInput(baseInput));
    if (field === "loan") return Math.max(1, v);
    if (field === "rent" || field === "marketRent" || field === "expenses" || field === "mortgage" || field === "annualFees" || field === "maintenance" || field === "renovation" || field === "renovationCost" || field === "altContribution") {
        return Math.max(0, v);
    }

    return v;
}

function deltaCostSimple(baseInput, candInput) {
    // простая “цена” изменений: сумма относительных изменений
    const fields = new Set([...Object.keys(baseInput || {}), ...Object.keys(candInput || {})]);
    let cost = 0;
    for (const f of fields) {
        if (!(f in baseInput) || !(f in candInput)) continue;
        const a = toNum(baseInput[f], NaN);
        const b = toNum(candInput[f], NaN);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) continue;
        cost += Math.abs((b - a) / a);
    }
    return cost;
}

function findFlipThreshold1D({ type, baseInput, targetScore, metricKey, better, leverField, computeResultByType }) {
    const rng = leverRange(leverField, baseInput);
    if (!rng) return null;

    // binary search for threshold where score meets target
    let lo = rng.lo;
    let hi = rng.hi;
    let best = null;

    for (let it = 0; it < 18; it++) {
        const mid = (lo + hi) / 2;
        const leverValue = normalizeLeverValueForField(leverField, mid, baseInput);
        if (!Number.isFinite(leverValue)) continue;

        const input = { ...baseInput, [leverField]: leverValue };
        const res = computeResultByType(type, input);
        if (!res) continue;

        const val = metricValue(res, metricKey);
        if (!Number.isFinite(val)) continue;

        const meets = better === "min" ? val <= targetScore : val >= targetScore;

        if (meets) {
            best = { field: leverField, value: input[leverField], metric: val, input, result: res };
            // tighten in direction that keeps meeting
            if (rng.prefer === "down") hi = mid; else lo = mid;
        } else {
            if (rng.prefer === "down") lo = mid; else hi = mid;
        }
    }

    if (!best) return null;

    const baseV = toNum(baseInput[leverField], NaN);
    const rel = (Number.isFinite(baseV) && baseV !== 0) ? (best.value - baseV) / baseV : null;

    return {
        field: leverField,
        threshold: best.value,
        rel_change: rel,
        metric_at_threshold: best.metric
    };
}

app.post("/api/deals/compare", rl.byUser({ limit: 60, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);

    const aId = Number(req.body?.aId);
    const bId = Number(req.body?.bId);
    const force = !!req.body?.force;

    if (!aId || !bId || aId === bId) return res.status(400).json({ error: "BAD_INPUT" });

    const pair = [aId, bId].sort((x, y) => x - y);
    const [leftId, rightId] = pair;
    const hash = hashJson({ pair });

    // load calcs
    const rr = await db.query(
        `select id, calculator_type, input_data, result_data
     from calculations
     where user_id=$1 and id = any($2::bigint[])`,
        [req.session.userId, pair]
    );
    if ((rr.rows || []).length !== 2) return res.status(404).json({ error: "CALC_NOT_FOUND" });

    let A = rr.rows.find(x => Number(x.id) === leftId);
    let B = rr.rows.find(x => Number(x.id) === rightId);
    if (!A || !B) return res.status(404).json({ error: "CALC_NOT_FOUND" });

    const nA = await normalizeCalcResultData(A, req.session.userId);
    const nB = await normalizeCalcResultData(B, req.session.userId);
    A = nA.calc;
    B = nB.calc;
    const anyStale = !!(nA.stale || nB.stale);

    if (!force && !anyStale) {
        const cached = await db.query(
            `select content, created_at from deal_comparisons
       where user_id=$1 and hash=$2
       limit 1`,
            [req.session.userId, hash]
        );
        if (
            cached.rowCount &&
            !isCacheOlderThanCalc(A, cached.rows[0].created_at) &&
            !isCacheOlderThanCalc(B, cached.rows[0].created_at)
        ) {
            const wallet = await getWallet(req.session.userId);
            return res.json({ mode: "cached", content: cached.rows[0].content, wallet });
        }
    }

    let dedupKey = force ? "" : `compare:${req.session.userId}:${hash}`;
    const wantsAsync = asyncProcessingEnabled() && !toBool(req.body?.sync);
    if (wantsAsync && dedupKey) {
        const predictedJobId = aiJobIdFromDedupKey(dedupKey);
        if (predictedJobId) {
            const existing = await aiJobGet(req.session.userId, predictedJobId);
            if (existing && existing.status !== "failed" && existing.status !== "done") {
                const wallet = await getWallet(req.session.userId);
                return res.status(202).json(aiQueueAcceptedBody({
                    jobId: predictedJobId,
                    type: "compare",
                    wallet,
                    message: "Compare queued. Poll /api/ai/jobs/:jobId"
                }));
            }
            if (existing?.status === "done") {
                dedupKey = "";
            }
        }
    }

    // Need credits pre-check
    const w0 = await getWallet(req.session.userId);
    if ((w0.credits || 0) < 2) {
        return res.status(402).json({ error: "NO_CREDITS", action: { type: "BUY_CREDITS", suggested: "Starter" } });
    }

     if (String(A.calculator_type) !== String(B.calculator_type)) {
         return res.status(400).json({ error: "TYPE_MISMATCH", message: "Please compare two deals of the same calculator type." });
     }

    const type = String(A.calculator_type);
    const { key: metricKey, better } = primaryMetricByType(type);
    if (!metricKey) return res.status(400).json({ error: "UNSUPPORTED_TYPE" });

    const aVal = metricValue(A.result_data, metricKey);
    const bVal = metricValue(B.result_data, metricKey);

    const winner = isBetter(aVal, bVal, better) ? "A" : "B";
    const loser = winner === "A" ? "B" : "A";

    const winnerCalc = winner === "A" ? A : B;
    const loserCalc = loser === "A" ? A : B;

    const targetScore = metricValue(winnerCalc.result_data, metricKey);

    // try flip thresholds for loser on key levers
    const levers = compareLeversByType(type, loserCalc.input_data);
    const flips = [];
    for (const f of levers) {
        const x = findFlipThreshold1D({
            type,
            baseInput: loserCalc.input_data,
            targetScore,
            metricKey,
            better,
            leverField: f,
            computeResultByType
        });
        if (x) flips.push(x);
    }

    // pick the “easiest” flip (smallest abs rel change)
    flips.sort((p, q) => {
        const ap = (p.rel_change == null) ? 1e9 : Math.abs(p.rel_change);
        const aq = (q.rel_change == null) ? 1e9 : Math.abs(q.rel_change);
        return ap - aq;
    });
    const bestFlip = flips[0] || null;

    const payload = {
        calculator_type: type,
        primary_metric: { key: metricKey, better },
        A: {
            id: A.id,
            mini_verdict: miniVerdictUniversal(A),
            derived_metrics: buildDerivedMetrics(A),
            input_data: A.input_data,
            result_data: A.result_data
        },
        B: {
            id: B.id,
            mini_verdict: miniVerdictUniversal(B),
            derived_metrics: buildDerivedMetrics(B),
            input_data: B.input_data,
            result_data: B.result_data
        },
        winner,
        bestFlip,
        flips: flips.slice(0, 3)
    };
    const promptPayload = buildComparePromptPayload(payload);

    const SYSTEM = `
You are PropertyCost "Compare 2 deals".
Rules:
- Winner MUST be based on payload.primary_metric only.
- State confidence as LOW/MEDIUM/HIGH using payload.primary_metric.relGapPct.
- LOW if relGapPct < 2, MEDIUM if 2-8, HIGH if > 8.
- Every bullet must include numbers or exact field names from payload.
- For money and large values, always use formatted fields ending with "Fmt".
- Never output raw long numbers like 1707533.57 when a "*Fmt" value exists.
- If non-primary metrics disagree with winner, call out the trade-off explicitly.
- In "What assumption flips it" use payload.bestFlip when available.
- Final line must be one actionable next run label.
`.trim();

    const USER = `
Language: English. Max 420 tokens.

Output EXACTLY:

Winner:
- <A or B> because <primary metric> is <formatted value vs formatted value>

Confidence:
- <LOW/MEDIUM/HIGH> confidence because rel gap is <payload.primary_metric.relGapPctFmt>. Mention if this is a close call.

Key differences:
- <3-5 bullets with formatted numbers (prefer key_differences[*].aFmt/bFmt/absGapFmt). Include at least one trade-off bullet if metrics conflict>

What assumption flips it:
- <If payload.bestFlip exists: show field + threshold + % change needed>
- <Else: say it is not flippable in realistic range and name best lever to test>

Recommended next run:
- <one button label with one short reason in same bullet>

Payload JSON:
${JSON.stringify(promptPayload)}
`.trim();

    let reserved = 0;
    try {
        await reserveCreditsOrThrow(req.session.userId, 2);
        reserved = 2;

        if (wantsAsync) {
            const queued = await enqueueOpenAiChat({
                model: "gpt-4o-mini",
                temperature: 0.2,
                max_tokens: 520,
                messages: [
                    { role: "system", content: SYSTEM },
                    { role: "user", content: USER }
                ]
            }, dedupKey ? { dedupKey } : undefined);

            await aiJobInsert({
                userId: req.session.userId,
                jobId: queued.jobId,
                kind: "compare",
                status: "queued",
                reservedCredits: reserved,
                payload: {
                    hash,
                    leftId,
                    rightId,
                    winner,
                    bestFlip,
                    compare_payload: payload
                }
            });

            const wallet = await getWallet(req.session.userId);
            return res.status(202).json(aiQueueAcceptedBody({
                jobId: queued.jobId,
                type: "compare",
                wallet,
                message: "Compare queued. Poll /api/ai/jobs/:jobId"
            }));
        }

        const contentRaw = await aiChatCompletion({
            model: "gpt-4o-mini",
            temperature: 0.2,
            max_tokens: 520,
            messages: [
                { role: "system", content: SYSTEM },
                { role: "user", content: USER }
            ],
            dedupKey
        });
        if (!contentRaw) throw new Error("EMPTY");
        const content = aiEnsureUsefulCompare(contentRaw, payload);

        await db.query(
            `insert into deal_comparisons(user_id, hash, a_id, b_id, content)
       values($1,$2,$3,$4,$5)
       on conflict (user_id, hash) do update set content=excluded.content`,
            [req.session.userId, hash, leftId, rightId, content]
        );

        const wallet = await getWallet(req.session.userId);
        return res.json({ mode: "credit", content, payloadLite: { winner, bestFlip }, wallet });
    } catch (e) {
        if (reserved) {
            try { await refundCredits(req.session.userId, reserved); }
            catch (refundErr) { console.error("COMPARE_REFUND_FAILED:", refundErr); }
        }
        if (String(e.message) === "NO_CREDITS" || e?.code === "NO_CREDITS") {
            return res.status(402).json(noCreditsPayload("Starter"));
        }
        return sendAiError(res, e);
    }
});





app.post("/api/verdict",
    rl.byUser({ limit: 60, windowSec: 600 }),
    async (req, res) => {
        if (!req.session?.userId) return res.sendStatus(401);

        const calculationId = Number(req.body?.calculationId);
        if (!calculationId) return res.status(400).json({ error: "calculationId required" });
        const force = !!req.body?.force;

        // 1) достаём калькуляцию только этого юзера
        const cr = await db.query(
            `SELECT id, calculator_type, created_at, input_data, result_data
       FROM calculations
       WHERE id=$1 AND user_id=$2`,
            [calculationId, req.session.userId]
        );
        if (!cr.rowCount) return res.status(404).json({ error: "Calculation not found" });

        let calc = cr.rows[0];
        const normalized = await normalizeCalcResultData(calc, req.session.userId);
        calc = normalized.calc;
        const calcResultWasStale = normalized.stale;

        const miniServer = miniVerdictUniversal({
            calculator_type: calc.calculator_type,
            input_data: calc.input_data,
            result_data: calc.result_data
        });
        const miniClient = normalizeMini(req.body?.mini_verdict);

        const mini_verdict = miniServer;

        // (опционально) можно логировать несоответствие клиент/сервер
        if (miniClient && (miniClient.icon !== miniServer.icon || miniClient.level !== miniServer.level)) {
            console.warn("mini mismatch client/server", { miniClient, miniServer });
        }
        

        const cached = await getCachedVerdict(req.session.userId, calculationId);
        const staleCachedVerdict = !!(
            cached &&
            (calcResultWasStale || isCacheOlderThanCalc(calc, cached.created_at))
        );

        let cachedOutText = "";
        if (cached) {
            cachedOutText = String(cached.content || "");
            if (calc.calculator_type === "mortgage") {
                const payloadLite = {
                    calculator_type: "mortgage",
                    input_data: calc.input_data,
                    mini_verdict // already computed above
                };
                cachedOutText = sanitizeMortgageVerdict(cachedOutText, payloadLite);
            }
        }

        if (cached && !force && !staleCachedVerdict) {
            const wallet = await getWallet(req.session.userId);
            return res.json({ mode: "cached", verdict: cachedOutText, wallet });
        }

        // If only stale cached analysis exists and user has no credits/free run left,
        // still allow read-only access to previously saved text.
        if (cached && !force && staleCachedVerdict) {
            const modeForFreshRun = await canUseVerdict(req.session.userId);
            if (!modeForFreshRun) {
                const wallet = await getWallet(req.session.userId);
                return res.json({ mode: "cached_old", stale: true, verdict: cachedOutText, wallet });
            }
        }

        let mode = null;
        let reserved = 0;

        const derived_metrics = buildDerivedMetrics(calc);

        const result_data = enrichResultDataForUI(
            calc.calculator_type,
            calc.input_data,
            calc.result_data,
            derived_metrics
        );

        const isInvestment = hasRentOrIncomeFromInput(calc.input_data);
    

        // 3) делаем payload строго из БД
        const payload = {
            calculator_type: calc.calculator_type,
            created_at: calc.created_at,
            input_data: calc.input_data,
            result_data: result_data,
            derived_metrics,
            mini_verdict,
            context: { isInvestment },
            user_goal: "Explain results and how to improve them without contradicting mini verdict."
        };

        const payloadHash = hashJson({
            calculationId,
            force,
            calculator_type: calc.calculator_type,
            input_data: calc.input_data,
            result_data: calc.result_data
        }).slice(0, 24);
        let dedupKey = `verdict:${req.session.userId}:${calculationId}:${force ? 1 : 0}:${payloadHash}`;
        const wantsAsync = asyncProcessingEnabled() && !toBool(req.body?.sync);



        try {
            if (wantsAsync) {
                const predictedJobId = aiJobIdFromDedupKey(dedupKey);
                if (predictedJobId) {
                    const existing = await aiJobGet(req.session.userId, predictedJobId);
                    if (!force && existing?.status === "done" && existing?.result) {
                        return res.json(existing.result);
                    }
                    if (existing && existing.status !== "failed" && existing.status !== "done") {
                        const wallet = await getWallet(req.session.userId);
                        return res.status(202).json(aiQueueAcceptedBody({
                            jobId: predictedJobId,
                            type: "verdict",
                            wallet,
                            message: "Full analysis queued. Poll /api/ai/jobs/:jobId"
                        }));
                    }
                    if (force && existing?.status === "done") {
                        dedupKey = "";
                    }
                }
            }

            // 2) проверяем доступ: free или credit
            mode = await canUseVerdict(req.session.userId);
            if (!mode) return res.status(402).json(noCreditsPayload("Basic"));
            if (mode === "credit") {
                const left = await reserveCredits(req.session.userId, 1);
                if (left === null) return res.status(402).json(noCreditsPayload("Basic"));
                reserved = 1;
            }

            if (wantsAsync) {
                const queued = await enqueueOpenAiChat({
                    model: "gpt-4o-mini",
                    temperature: 0.25,
                    max_tokens: 700,
                    messages: [
                        {
                            role: "system",
                            content: `
You are PropertyCost "Full Analysis" engine.

Hard constraints:
- The icon MUST match payload.mini_verdict.icon exactly (✅/⚠️/❌/ℹ️).
- You may be equally or more conservative than mini_verdict, never more optimistic.
- Never contradict payload.mini_verdict.text.

- If payload.deltas_vs_baseline exists and deltas_vs_baseline.monthlyPayment is negative (monthly got cheaper), do NOT claim affordability strain.
- If monthlyPayment decreases but totalInterest/totalPayment increases, clearly label it as a trade-off: "monthly relief" vs "higher total cost".

Data integrity:
- Use ONLY numbers present in payload JSON (including derived_metrics).
- Never invent taxes, insurance, HOA, vacancy, rent, market facts, salary, or income.
- If something is missing, list it under "Missing checklist".

Style:
- Be concise but premium. No fluff. No disclaimers.
- Every bullet must cite at least one number OR a named payload field.
- Give the user an action plan: what to change, why, and what metric improves.
- Focus on THIS calculator_type only.

Output must match the exact structure requested.
`.trim()
                        },
                        {
                            role: "user",
                            content: `
Write a premium "Full Analysis" that feels worth paying for.

Language: English. Max 650 tokens.

${getRulesForType(String(payload.calculator_type || ""))}

For "Next runs inside the app" output 3 scenario ideas in this generic pattern:
- Scenario A (Primary lever): one change that most directly improves the main metric for this calculator type.
- Scenario B (Trade-off lever): one realistic alternative with a different trade-off profile.
- Scenario C (Constraint / stress): one constrained or stress case that tests robustness.
Each scenario must mention exact field names to change.

If payload.context.isInvestment is false (no rent/income):
- Do NOT mention ROI/profitability/cash flow.
- Use wording: "monthly affordability" and "total cost".
If payload.context.isInvestment is true:
- You may mention rent/income coverage and cash flow.

When you mention down payment %, use payload.derived_metrics.metrics.downPaymentPercent

Output EXACTLY this structure:

Verdict: <icon> <one sentence matching mini_verdict and referencing at least 1 payload number>

Why this verdict (3 bullets, each must cite a payload number or derived metric):
- ...
- ...
- ...

Key numbers (4–6 bullets):
- ...

Missing checklist (2–5 bullets):
- Use payload.derived_metrics.missingChecklist if available.

What to do to improve the result (3 bullets):
- Each bullet: which input to change + expected effect + which metric improves.

Sensitivity quick test (3 bullets):
- Each bullet: one change + directional impact (monthly vs total interest).

Next runs inside the app (3 scenarios):
- Scenario A: ...
- Scenario B: ...
- Scenario C: ...

Payload JSON:
${JSON.stringify(payload)}
`.trim()
                        }
                    ]
                }, dedupKey ? { dedupKey } : undefined);

                await aiJobInsert({
                    userId: req.session.userId,
                    jobId: queued.jobId,
                    kind: "verdict",
                    status: "queued",
                    reservedCredits: reserved,
                    payload: {
                        calculationId,
                        mode,
                        verdict_payload: payload
                    }
                });

                const wallet = await getWallet(req.session.userId);
                return res.status(202).json(aiQueueAcceptedBody({
                    jobId: queued.jobId,
                    type: "verdict",
                    wallet,
                    message: "Full analysis queued. Poll /api/ai/jobs/:jobId"
                }));
            }

            let verdict = await generateVerdict(payload);
            if (mode === "free") await spend(req.session.userId, "free");
            if (payload.calculator_type === "mortgage") {
                verdict = sanitizeMortgageVerdict(verdict, payload);
            }

            await db.query(
                `INSERT INTO verdicts(user_id, calculation_id, mode, content)
         VALUES($1,$2,$3,$4)`,
                [req.session.userId, calculationId, mode, verdict]
            );

            const wr = await db.query(
                "select free_used, credits from verdict_wallets where user_id=$1",
                [req.session.userId]
            );

            const wallet = wr.rowCount
                ? { free_used: !!wr.rows[0].free_used, credits: Number(wr.rows[0].credits || 0) }
                : { free_used: false, credits: 0 };

            return res.json({ mode, verdict, wallet });
        } catch (e) {
            if (reserved) await refundCredits(req.session.userId, reserved);
            return sendAiError(res, e);
        }
    }
);

function enrichResultDataForUI(calcType, inputData, resultData, derivedMetrics) {
    const r = resultData || {};
    const dm = derivedMetrics || {};
    const out = { ...r };

    if (calcType === "ownership_cost") {
        // years (UI helper)
        out.years = Number(out.years ?? inputData?.years ?? 0);

        // canonical keys
        out.totalOwnershipCost = Number(out.totalOwnershipCost ?? out.totalCost ?? null);
        out.totalOwnershipCostPV = Number(out.totalOwnershipCostPV ?? out.totalCostPV ?? null);

        // optional fields: keep null if missing (do NOT force 0)
        if (out.totalTaxes === undefined || out.totalTaxes === null) out.totalTaxes = null;
        else out.totalTaxes = Number(out.totalTaxes);

        if (out.totalMaintenance === undefined || out.totalMaintenance === null) out.totalMaintenance = null;
        else out.totalMaintenance = Number(out.totalMaintenance);

        // from derived metrics (safe)
        out.costAsPercentOfPrice =
            Number.isFinite(out.costAsPercentOfPrice) ? out.costAsPercentOfPrice
                : Number(dm?.keyNumbers?.costAsPercentOfPrice ?? null);

        // backward compat
        out.totalCost = out.totalOwnershipCost;
        out.totalCostPV = out.totalOwnershipCostPV;
    }

    return out;
}


const PACKS = {
    basic10: {
        credits: 10,
        amount: "6.99",
        currency: "USD",
        label: "10 Full verdicts",
        paddlePriceEnv: "PADDLE_PRICE_BASIC10"
    },
    plus30: {
        credits: 30,
        amount: "4.99",
        currency: "USD",
        label: "30 Full verdicts",
        paddlePriceEnv: "PADDLE_PRICE_PLUS30"
    },
    premium50: {
        credits: 50,
        amount: "7.99",
        currency: "USD",
        label: "50 Full verdicts",
        paddlePriceEnv: "PADDLE_PRICE_PREMIUM50"
    },
    business150: {
        credits: 150,
        amount: "19.99",
        currency: "USD",
        label: "150 Full verdicts",
        paddlePriceEnv: "PADDLE_PRICE_BUSINESS150"
    },
};

function getPack(key) {
    const pack = PACKS[key];
    if (!pack) return null;
    return {
        ...pack,
        key: String(key),
        paddlePriceId: String(process.env[pack.paddlePriceEnv] || "").trim()
    };
}

function packKeyByPaddlePriceId(priceId) {
    const needle = String(priceId || "").trim();
    if (!needle) return "";
    for (const [key, pack] of Object.entries(PACKS)) {
        const envKey = String(pack?.paddlePriceEnv || "");
        const configuredPriceId = String(process.env[envKey] || "").trim();
        if (configuredPriceId && configuredPriceId === needle) return key;
    }
    return "";
}

async function addWalletCredits(userId, credits) {
    await db.query(
        `insert into verdict_wallets(user_id, credits)
         values($1,$2)
         on conflict (user_id)
         do update set credits = GREATEST(COALESCE(verdict_wallets.credits, 0), 0) + EXCLUDED.credits`,
        [userId, credits]
    );
}

async function readWalletSnapshot(userId) {
    const wr = await db.query(
        "select free_used, credits from verdict_wallets where user_id=$1",
        [userId]
    );
    return wr.rowCount
        ? { free_used: !!wr.rows[0].free_used, credits: Number(wr.rows[0].credits || 0) }
        : { free_used: false, credits: 0 };
}

app.post("/api/nowpayments/create-checkout", rl.byUser({ limit: 20, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);

    const packKey = String(req.body?.pack || "basic10");
    const pack = getPack(packKey);
    if (!pack) return res.status(400).json({ error: "BAD_PACK" });

    const callbackUrl = String(
        process.env.NOWPAYMENTS_IPN_URL || buildAppUrl("/api/webhooks/nowpayments")
    ).trim();
    const orderId = generateNowPaymentsOrderId(req.session.userId);
    const successUrlBase = String(
        process.env.NOWPAYMENTS_SUCCESS_URL || buildAppUrl("/account/")
    ).trim();
    const successUrlHadTxn = /[?&]txn=/.test(successUrlBase);
    const successUrlHadPaidFlag = /[?&]np_paid=/.test(successUrlBase);
    let successUrl = appendQueryParam(successUrlBase, "np_paid", "1");
    successUrl = appendQueryParam(successUrl, "provider", "nowpayments");
    successUrl = appendQueryParam(successUrl, "txn", orderId);
    const cancelUrl = String(
        process.env.NOWPAYMENTS_CANCEL_URL || buildAppUrl("/pricing/?np_cancelled=1")
    ).trim();

    if (!isHttpUrl(callbackUrl)) return res.status(500).json({ error: "NOWPAYMENTS_IPN_URL_INVALID" });
    if (!isHttpUrl(successUrl)) return res.status(500).json({ error: "NOWPAYMENTS_SUCCESS_URL_INVALID" });
    if (!isHttpUrl(cancelUrl)) return res.status(500).json({ error: "NOWPAYMENTS_CANCEL_URL_INVALID" });

    const hasTxnInSuccessUrl = /[?&]txn=/.test(successUrl);
    if (String(process.env.NOWPAYMENTS_SUCCESS_URL || "").trim() && (!successUrlHadTxn || !successUrlHadPaidFlag)) {
        console.warn("NOWPayments create-checkout success_url normalized missing markers", {
            userId: req.session.userId,
            orderId,
            fromEnv: !!String(process.env.NOWPAYMENTS_SUCCESS_URL || "").trim(),
            successUrlBase,
            successUrl
        });
    }

    const fixedRate = parseBoolEnv(process.env.NOWPAYMENTS_FIXED_RATE, true);
    const feePaidByUser = parseBoolEnv(process.env.NOWPAYMENTS_FEE_PAID_BY_USER, false);
    const forcedPayCurrency = String(process.env.NOWPAYMENTS_PAY_CURRENCY || "").trim().toLowerCase();
    const requestPayload = {
        price_amount: Number(pack.amount),
        price_currency: String(pack.currency || "USD").trim().toLowerCase(),
        order_id: orderId,
        order_description: `PropertyCost ${pack.label}`,
        ipn_callback_url: callbackUrl,
        success_url: successUrl,
        cancel_url: cancelUrl,
        is_fixed_rate: fixedRate,
        is_fee_paid_by_user: feePaidByUser
    };
    if (forcedPayCurrency) requestPayload.pay_currency = forcedPayCurrency;

    const response = await nowPaymentsApiRequest("/invoice", {
        method: "POST",
        body: JSON.stringify(requestPayload)
    });
    if (!response.ok) {
        console.error("NOWPayments create-checkout failed", {
            status: response.status,
            userId: req.session.userId,
            packKey,
            nowpayments: response.body
        });
        return res.status(400).json({ error: "CREATE_CHECKOUT_FAILED", data: response.body });
    }

    const tx = (response.body?.data && typeof response.body.data === "object")
        ? response.body.data
        : (response.body || {});
    const providerInvoiceId = String(tx?.id || tx?.invoice_id || "").trim();
    const checkoutUrl = String(tx?.invoice_url || tx?.payment_url || tx?.pay_url || tx?.url || "").trim();
    if (!checkoutUrl) {
        return res.status(502).json({
            error: "CHECKOUT_URL_MISSING",
            data: response.body
        });
    }

    await ensureNowPaymentsTables();
    await db.query(
        `insert into nowpayments_transactions(
            transaction_id, provider_invoice_id, user_id, credits, status, pack_key, amount_usd, price_currency, pay_currency, last_payload, updated_at
         )
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,now())
         on conflict (transaction_id) do update
         set provider_invoice_id=excluded.provider_invoice_id,
             user_id=excluded.user_id,
             credits=excluded.credits,
             status=excluded.status,
             pack_key=excluded.pack_key,
             amount_usd=excluded.amount_usd,
             price_currency=excluded.price_currency,
             pay_currency=excluded.pay_currency,
             last_payload=excluded.last_payload,
             updated_at=now()`,
        [
            orderId,
            providerInvoiceId || null,
            req.session.userId,
            Number(pack.credits),
            String(tx?.payment_status || tx?.status || "created").toLowerCase(),
            pack.key,
            Number(pack.amount),
            String(pack.currency || "USD").trim().toLowerCase(),
            forcedPayCurrency || null,
            JSON.stringify({
                request: requestPayload,
                response: tx
            })
        ]
    );

    nowpDiag("create_checkout_ok", {
        userId: req.session.userId,
        orderId,
        providerInvoiceId,
        packKey: pack.key,
        amountUsd: Number(pack.amount),
        callbackUrl,
        successUrl,
        cancelUrl,
        hasTxnInSuccessUrl,
        payCurrency: forcedPayCurrency || null
    });

    return res.json({
        ok: true,
        provider: "nowpayments",
        transactionId: orderId,
        checkoutUrl
    });
});

app.get("/api/nowpayments/transaction-status", rl.byUser({ limit: 180, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);
    const txn = String(req.query?.txn || "").trim();
    if (!txn) return res.status(400).json({ error: "TXN_REQUIRED" });

    await ensureNowPaymentsTables();
    const tr = await db.query(
        `select transaction_id, status, credits
         from nowpayments_transactions
         where transaction_id=$1 and user_id=$2
         limit 1`,
        [txn, req.session.userId]
    );
    const wallet = await readWalletSnapshot(req.session.userId);

    if (!tr.rowCount) {
        nowpDiag("txn_status_not_found", {
            userId: req.session.userId,
            txn
        });
        return res.status(404).json({ error: "TRANSACTION_NOT_FOUND", wallet });
    }

    nowpDiag("txn_status_ok", {
        userId: req.session.userId,
        txn,
        status: String(tr.rows[0].status || ""),
        creditsPack: Number(tr.rows[0].credits || 0),
        walletCredits: Number(wallet?.credits || 0)
    });

    return res.json({
        ok: true,
        provider: "nowpayments",
        transactionId: String(tr.rows[0].transaction_id || txn),
        status: String(tr.rows[0].status || ""),
        credits: Number(tr.rows[0].credits || 0),
        wallet
    });
});

app.post("/api/webhooks/nowpayments", rl.byIp({ limit: 900, windowSec: 600, prefix: "rl:nowpayments:webhook" }), async (req, res) => {
    const signature = String(req.headers["x-nowpayments-sig"] || "").trim();
    const secret = nowPaymentsIpnSecret();
    const payload = (req.body && typeof req.body === "object") ? req.body : {};
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString("utf8") : "";
    const rawBodyBytes = Buffer.isBuffer(req.rawBody) ? req.rawBody.length : 0;
    const payloadKeys = Object.keys(payload || {});
    const ingressOrderId = String(payload?.order_id || "").trim();
    const ingressInvoiceId = String(payload?.invoice_id || "").trim();
    const ingressPaymentId = String(payload?.payment_id || "").trim();
    const ingressStatus = String(payload?.payment_status || payload?.status || "").trim().toLowerCase();

    nowpDiag("webhook_ingress", {
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
        cfRay: String(req.headers["cf-ray"] || ""),
        xForwardedFor: String(req.headers["x-forwarded-for"] || ""),
        signatureLen: signature.length,
        hasSecret: !!secret,
        contentType: String(req.headers["content-type"] || ""),
        rawBodyBytes,
        orderId: ingressOrderId,
        invoiceId: ingressInvoiceId,
        paymentId: ingressPaymentId,
        paymentStatus: ingressStatus,
        payloadKeys
    });

    if (!signature || !secret) {
        console.warn("NOWPayments webhook rejected: missing signature/secret", {
            hasSignature: !!signature,
            hasSecret: !!secret,
            signatureLen: signature.length,
            ip: req.ip,
            contentType: String(req.headers["content-type"] || ""),
            rawBodyBytes,
            payloadKeys
        });
        return res.sendStatus(400);
    }

    if (!verifyNowPaymentsWebhookSignature(payload, signature, secret, rawBody)) {
        const sortedPayload = nowPaymentsTopLevelSortedJson(payload);
        const expectedSortedSig = hmacSha512Hex(secret, sortedPayload);
        const expectedRawSig = rawBody ? hmacSha512Hex(secret, rawBody) : "";
        console.warn("NOWPayments webhook rejected: signature mismatch", {
            ip: req.ip,
            signature: shortHex(signature),
            expectedSortedSig: shortHex(expectedSortedSig),
            expectedRawSig: shortHex(expectedRawSig),
            orderId: String(payload?.order_id || ""),
            invoiceId: String(payload?.invoice_id || ""),
            paymentId: String(payload?.payment_id || ""),
            paymentStatus: String(payload?.payment_status || payload?.status || "").trim().toLowerCase(),
            contentType: String(req.headers["content-type"] || ""),
            rawBodyBytes,
            payloadKeys
        });
        return res.sendStatus(400);
    }

    await ensureNowPaymentsTables();

    const paymentStatus = String(payload?.payment_status || payload?.status || "").trim().toLowerCase();
    const orderId = String(payload?.order_id || "").trim();
    const invoiceId = String(payload?.invoice_id || "").trim();
    const paymentId = String(payload?.payment_id || "").trim();
    const priceCurrency = String(payload?.price_currency || "").trim().toLowerCase();
    const paidCurrency = String(payload?.pay_currency || "").trim().toLowerCase();
    const outcomeCurrency = String(payload?.outcome_currency || "").trim().toLowerCase();
    const priceAmount = roundMoney2(payload?.price_amount);
    const paidPriceAmount = Number.isFinite(Number(payload?.pay_amount)) ? Number(payload?.pay_amount) : null;
    const actuallyPaid = Number.isFinite(Number(payload?.actually_paid)) ? Number(payload?.actually_paid) : null;
    const outcomeAmount = Number.isFinite(Number(payload?.outcome_amount)) ? Number(payload?.outcome_amount) : null;

    const eventHash = sha256Hex(jsonStableStringify(payload));
    const evIns = await db.query(
        `insert into nowpayments_webhook_events(event_hash, payment_id, order_id, invoice_id, status, signature, payload)
         values($1,$2,$3,$4,$5,$6,$7::jsonb)
         on conflict (event_hash) do nothing`,
        [
            eventHash,
            paymentId || null,
            orderId || null,
            invoiceId || null,
            paymentStatus || null,
            signature,
            JSON.stringify(payload)
        ]
    );
    nowpDiag("webhook_event_recorded", {
        orderId,
        invoiceId,
        paymentId,
        paymentStatus,
        inserted: evIns.rowCount > 0
    });

    let tr = null;
    if (orderId) {
        tr = await db.query(
            `select transaction_id, user_id, credits, status, amount_usd, price_currency
             from nowpayments_transactions
             where transaction_id=$1
             limit 1`,
            [orderId]
        );
    }
    if ((!tr || !tr.rowCount) && invoiceId) {
        tr = await db.query(
            `select transaction_id, user_id, credits, status, amount_usd, price_currency
             from nowpayments_transactions
             where provider_invoice_id=$1
             order by created_at desc
             limit 1`,
            [invoiceId]
        );
    }
    if (!tr || !tr.rowCount) {
        const fallbackUserId = userIdFromNowPaymentsOrderId(orderId);
        console.error("NOWPayments webhook unmatched transaction", {
            orderId,
            invoiceId,
            paymentId,
            paymentStatus,
            fallbackUserId
        });
        return res.sendStatus(200);
    }

    const row = tr.rows[0];
    const transactionId = String(row.transaction_id || orderId || "").trim();
    if (!transactionId) return res.sendStatus(200);

    nowpDiag("webhook_transaction_matched", {
        transactionId,
        rowStatus: String(row.status || ""),
        userId: Number(row.user_id || 0),
        credits: Number(row.credits || 0)
    });

    await db.query(
        `update nowpayments_transactions
         set status=case when status='paid' then status else $2 end,
             provider_invoice_id=coalesce($3, provider_invoice_id),
             provider_payment_id=coalesce($4, provider_payment_id),
             pay_currency=coalesce($5, pay_currency),
             paid_price_amount=coalesce($6, paid_price_amount),
             paid_currency=coalesce($7, paid_currency),
             actually_paid=coalesce($8, actually_paid),
             outcome_amount=coalesce($9, outcome_amount),
             outcome_currency=coalesce($10, outcome_currency),
             webhook_count=webhook_count + 1,
             last_webhook_event_hash=$11,
             last_payload=$12::jsonb,
             last_ipn_at=now(),
             updated_at=now()
         where transaction_id=$1`,
        [
            transactionId,
            paymentStatus || "updated",
            invoiceId || null,
            paymentId || null,
            paidCurrency || null,
            paidPriceAmount,
            paidCurrency || null,
            actuallyPaid,
            outcomeAmount,
            outcomeCurrency || null,
            eventHash,
            JSON.stringify(payload)
        ]
    );

    if (!NOWPAYMENTS_PAID_STATUSES.has(paymentStatus)) {
        nowpDiag("webhook_non_paid_status", {
            transactionId,
            paymentStatus
        });
        return res.sendStatus(200);
    }
    if (String(row.status || "").toLowerCase() === "paid") {
        nowpDiag("webhook_already_paid_skip", {
            transactionId
        });
        return res.sendStatus(200);
    }

    const expectedAmount = roundMoney2(row.amount_usd);
    const expectedCurrency = String(row.price_currency || "usd").trim().toLowerCase();
    const amountMatches = expectedAmount !== null && priceAmount !== null && almostEqualMoney(priceAmount, expectedAmount, 0.01);
    const currencyMatches = !!priceCurrency && priceCurrency === expectedCurrency;
    if (!amountMatches || !currencyMatches) {
        await db.query(
            `update nowpayments_transactions
             set status=case when status='paid' then status else 'mismatch' end,
                 updated_at=now()
             where transaction_id=$1`,
            [transactionId]
        );
        console.error("NOWPayments paid webhook mismatch", {
            transactionId,
            orderId,
            invoiceId,
            expectedAmount,
            expectedCurrency,
            payloadPriceAmount: priceAmount,
            payloadPriceCurrency: priceCurrency
        });
        return res.sendStatus(200);
    }

    const upd = await db.query(
        `update nowpayments_transactions
         set status='paid',
             paid_at=coalesce(paid_at, now()),
             updated_at=now()
         where transaction_id=$1 and status <> 'paid'
         returning user_id, credits`,
        [transactionId]
    );

    if (upd.rowCount) {
        const userId = Number(upd.rows[0].user_id || 0);
        const creditsToAdd = Number(upd.rows[0].credits || 0);
        if (userId > 0 && creditsToAdd > 0) {
            await addWalletCredits(userId, creditsToAdd);
            nowpDiag("webhook_credits_added", {
                transactionId,
                userId,
                creditsToAdd
            });
        }
    }

    return res.sendStatus(200);
});

app.get("/api/paddle/config", (req, res) => {
    const clientToken = paddleClientToken();
    if (!clientToken) return res.status(503).json({ error: "PADDLE_CLIENT_TOKEN_MISSING" });
    return res.json({
        env: String(process.env.PADDLE_ENV || "sandbox").trim().toLowerCase() === "live" ? "live" : "sandbox",
        clientToken
    });
});

app.post("/api/paddle/create-checkout", rl.byUser({ limit: 20, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);

    const packKey = String(req.body?.pack || "basic10");
    const pack = getPack(packKey);
    if (!pack) return res.status(400).json({ error: "BAD_PACK" });
    if (!pack.paddlePriceId) {
        return res.status(500).json({
            error: "PADDLE_PRICE_NOT_CONFIGURED",
            message: `Missing ${pack.paddlePriceEnv} for pack ${packKey}`
        });
    }

    const checkoutBase = String(
        process.env.PADDLE_CHECKOUT_URL ||
        `${String(process.env.APP_URL || "").replace(/\/+$/, "")}/checkout/paddle/`
    ).trim();
    if (!/^https?:\/\//i.test(checkoutBase)) {
        return res.status(500).json({ error: "PADDLE_CHECKOUT_URL_INVALID" });
    }

    const response = await paddleApiRequest("/transactions?include=checkout", {
        method: "POST",
        body: JSON.stringify({
            items: [{ price_id: pack.paddlePriceId, quantity: 1 }],
            collection_mode: "automatic",
            custom_data: {
                user_id: String(req.session.userId),
                pack_key: pack.key,
                credits: Number(pack.credits)
            },
            checkout: {
                url: checkoutBase
            }
        })
    });

    if (!response.ok) {
        console.error("Paddle create-checkout failed", {
            status: response.status,
            env: process.env.PADDLE_ENV || "sandbox",
            userId: req.session.userId,
            packKey,
            paddle: response.body
        });
        return res.status(400).json({ error: "CREATE_CHECKOUT_FAILED", data: response.body });
    }

    const tx = response.body?.data || {};
    const transactionId = String(tx?.id || "").trim();
    const checkoutUrl = String(tx?.checkout?.url || "").trim();
    if (!transactionId || !checkoutUrl) {
        return res.status(502).json({
            error: "CHECKOUT_URL_MISSING",
            data: response.body
        });
    }

    await ensurePaddleTransactionsTable();
    await db.query(
        `insert into paddle_transactions(transaction_id, user_id, credits, status, pack_key, price_id, amount_usd, custom_data, updated_at)
         values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now())
         on conflict (transaction_id) do update
         set user_id=excluded.user_id,
             credits=excluded.credits,
             pack_key=excluded.pack_key,
             price_id=excluded.price_id,
             amount_usd=excluded.amount_usd,
             custom_data=excluded.custom_data,
             updated_at=now()`,
        [
            transactionId,
            req.session.userId,
            pack.credits,
            String(tx?.status || "created"),
            pack.key,
            pack.paddlePriceId,
            Number(pack.amount),
            JSON.stringify({
                user_id: String(req.session.userId),
                pack_key: pack.key,
                credits: Number(pack.credits)
            })
        ]
    );

    return res.json({
        ok: true,
        transactionId,
        checkoutUrl
    });
});

app.get("/api/paddle/transaction-status", rl.byUser({ limit: 180, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);
    const txn = String(req.query?.txn || "").trim();
    if (!txn) return res.status(400).json({ error: "TXN_REQUIRED" });

    await ensurePaddleTransactionsTable();
    const tr = await db.query(
        `select transaction_id, status, credits
         from paddle_transactions
         where transaction_id=$1 and user_id=$2
         limit 1`,
        [txn, req.session.userId]
    );
    const wr = await db.query(
        "select free_used, credits from verdict_wallets where user_id=$1",
        [req.session.userId]
    );

    const wallet = wr.rowCount
        ? { free_used: !!wr.rows[0].free_used, credits: Number(wr.rows[0].credits || 0) }
        : { free_used: false, credits: 0 };

    if (!tr.rowCount) {
        return res.status(404).json({ error: "TRANSACTION_NOT_FOUND", wallet });
    }

    return res.json({
        ok: true,
        transactionId: String(tr.rows[0].transaction_id || txn),
        status: String(tr.rows[0].status || ""),
        credits: Number(tr.rows[0].credits || 0),
        wallet
    });
});

app.post("/api/webhooks/paddle", rl.byIp({ limit: 600, windowSec: 600, prefix: "rl:paddle:webhook" }), async (req, res) => {
    const signature = String(req.headers["paddle-signature"] || "");
    const secret = paddleWebhookSecret();
    if (!signature || !secret || !req.rawBody) return res.sendStatus(400);
    if (!verifyPaddleWebhookSignature(req.rawBody, signature, secret, 300)) return res.sendStatus(400);

    const event = req.body || {};
    const eventType = String(event?.event_type || "").trim().toLowerCase();
    const data = (event?.data && typeof event.data === "object") ? event.data : {};
    const transactionId = String(data?.id || "").trim();
    if (!transactionId) return res.sendStatus(200);

    await ensurePaddleTransactionsTable();

    const payloadStatus = String(data?.status || "").trim().toLowerCase();
    const eventIsPaid =
        eventType === "transaction.paid" ||
        eventType === "transaction.completed" ||
        (eventType === "transaction.updated" && payloadStatus === "completed");

    const customData = (data?.custom_data && typeof data.custom_data === "object") ? data.custom_data : {};
    const fromPayloadUserId = Number(customData?.user_id || 0);
    const fromPayloadPackKey = String(customData?.pack_key || "").trim();
    const fromPayloadCredits = Number(customData?.credits || 0);
    const itemPriceId =
        String(data?.items?.[0]?.price?.id || "").trim();

    const fallbackPackKey = fromPayloadPackKey || packKeyByPaddlePriceId(itemPriceId);
    const fallbackPack = fallbackPackKey ? PACKS[fallbackPackKey] : null;

    const tr = await db.query(
        `select user_id, credits, status
         from paddle_transactions
         where transaction_id=$1
         limit 1`,
        [transactionId]
    );

    let userId = tr.rowCount ? Number(tr.rows[0].user_id || 0) : fromPayloadUserId;
    let creditsToAdd = tr.rowCount ? Number(tr.rows[0].credits || 0) : 0;
    if (!creditsToAdd && Number.isFinite(fromPayloadCredits) && fromPayloadCredits > 0) {
        creditsToAdd = Math.trunc(fromPayloadCredits);
    }
    if (!creditsToAdd && fallbackPack?.credits) {
        creditsToAdd = Number(fallbackPack.credits);
    }

    const mergedStatus = eventIsPaid
        ? "paid"
        : (payloadStatus || String(eventType || "updated"));

    if (!tr.rowCount && userId > 0 && creditsToAdd > 0) {
        await db.query(
            `insert into paddle_transactions(transaction_id, user_id, credits, status, pack_key, price_id, amount_usd, custom_data, updated_at)
             values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now())
             on conflict (transaction_id) do nothing`,
            [
                transactionId,
                userId,
                creditsToAdd,
                "created",
                fallbackPackKey || null,
                itemPriceId || null,
                fallbackPack ? Number(fallbackPack.amount) : null,
                JSON.stringify(customData || {})
            ]
        );
    } else if (!tr.rowCount) {
        console.error("Paddle webhook unmatched transaction", {
            eventType,
            transactionId,
            payloadStatus,
            fromPayloadUserId,
            fromPayloadPackKey,
            itemPriceId
        });
    }

    if (!eventIsPaid) {
        await db.query(
            `update paddle_transactions
             set status=$2, updated_at=now()
             where transaction_id=$1`,
            [transactionId, mergedStatus]
        );
        return res.sendStatus(200);
    }

    const upd = await db.query(
        `update paddle_transactions
         set status='paid', updated_at=now()
         where transaction_id=$1 and status <> 'paid'
         returning user_id, credits`,
        [transactionId]
    );

    if (upd.rowCount) {
        userId = Number(upd.rows[0].user_id || userId || 0);
        creditsToAdd = Number(upd.rows[0].credits || creditsToAdd || 0);
        if (userId > 0 && creditsToAdd > 0) {
            await addWalletCredits(userId, creditsToAdd);
        }
    }

    return res.sendStatus(200);
});

function miniVerdictUniversal(calc) {
    const type = calc?.calculator_type;
    const r = calc?.result_data || {};
    const i = calc?.input_data || {};

    if (type === "mortgage") {
        const m = mortgageCostMetrics(i, r);
        if (!m) {
            const level = "info";
            return { level, icon: "ℹ️", text: MINI_TEXT.mortgage[level] };
        }

        const level = mortgageMiniLevel(m);
        const icon = iconForMiniLevel(level);
        return { level, icon, text: MINI_TEXT.mortgage[level] };
    }

    if (type === "rent_vs_buy") {
        const m = rentVsBuyMetrics(i, r);
        if (!m) {
            const level = "info";
            return { level, icon: "ℹ️", text: MINI_TEXT.rent_vs_buy[level] };
        }

        const level = rentVsBuyMiniLevel(m, r?.winner);
        const icon = iconForMiniLevel(level);
        return { level, icon, text: MINI_TEXT.rent_vs_buy[level] };
    }

    if (type === "break_even") {
        const m = breakEvenMetrics(i, r);
        if (!m) {
            const level = "info";
            return { level, icon: "ℹ️", text: MINI_TEXT.break_even[level] };
        }
        const level = breakEvenMiniLevel(m);
        const icon = iconForMiniLevel(level);
        return { level, icon, text: MINI_TEXT.break_even[level] };
    }

    if (type === "cash_flow") {
        const m = cashFlowMetrics(i, r);
        if (!m) {
            const level = "info";
            return { level, icon: "ℹ️", text: MINI_TEXT.cash_flow[level] };
        }
        const level = cashFlowMiniLevel(m);
        const icon = iconForMiniLevel(level);
        return { level, icon, text: MINI_TEXT.cash_flow[level] };
    }

    if (type === "property_irr") {
        const m = irrMetrics(i, r);
        if (!m) {
            const level = "info";
            return { level, icon: "ℹ️", text: MINI_TEXT.property_irr[level] };
        }
        const level = irrMiniLevel(m);
        const icon = iconForMiniLevel(level);
        return { level, icon, text: MINI_TEXT.property_irr[level] };
    }

    if (type === "renovation_roi") {
        const m = renoMetrics(i, r);
        if (!m) {
            const level = "info";
            return { level, icon: "ℹ️", text: MINI_TEXT.renovation_roi[level] };
        }
        const level = renoMiniLevel(m);
        const icon = iconForMiniLevel(level);
        return { level, icon, text: MINI_TEXT.renovation_roi[level] };
    }

    if (type === "property_sale") {
        const m = saleMetrics(i, r);
        if (!m) {
            const level = "info";
            return { level, icon: "ℹ️", text: MINI_TEXT.property_sale[level] };
        }
        const level = saleMiniLevel(m);
        const icon = iconForMiniLevel(level);
        return { level, icon, text: MINI_TEXT.property_sale[level] };
    }

    if (type === "property_taxes") {
        const m = taxesMetrics(i, r);
        if (!m) {
            const level = "info";
            return { level, icon: "ℹ️", text: MINI_TEXT.property_taxes[level] };
        }
        const level = taxesMiniLevel(m);
        const icon = iconForMiniLevel(level);
        return { level, icon, text: MINI_TEXT.property_taxes[level] };
    }

    if (type === "ownership_cost") {
        const m = ownershipCostMetrics(i, r);
        if (!m) {
            const level = "info";
            return { level, icon: "ℹ️", text: MINI_TEXT.ownership_cost[level] };
        }
        const level = ownershipCostMiniLevel(m);
        const icon = iconForMiniLevel(level);
        return { level, icon, text: MINI_TEXT.ownership_cost[level] };
    }

    if (type === "alternative_investment") {
        const m = alternativeInvestmentMetrics(i, r);
        if (!m) {
            const level = "info";
            return { level, icon: "ℹ️", text: MINI_TEXT.alternative_investment[level] };
        }
        const level = alternativeInvestmentMiniLevel(m);
        const icon = iconForMiniLevel(level);
        return { level, icon, text: MINI_TEXT.alternative_investment[level] };
    }

    if (type === "mortgage_overpayment") {
        const m = mortgageOverpaymentMetrics(i, r);
        if (!m) {
            const level = "info";
            return { level, icon: "ℹ️", text: MINI_TEXT.mortgage_overpayment[level] };
        }
        const level = mortgageOverpaymentMiniLevel(m);
        const icon = iconForMiniLevel(level);
        return { level, icon, text: MINI_TEXT.mortgage_overpayment[level] };
    }

}

function mortgageCostMetrics(i, r) {
    const price = Number(i?.price || 0);
    const down = Number(i?.down || 0);
    const loan = price - down;

    const rate = Number(i?.ratePercent || 0);
    const termYears = Number(i?.termYears || 0);

    const ti = Number(r?.totalInterest || 0);
    const tp = Number(r?.totalPayment || 0);
    const mp = Number(r?.monthlyPayment || 0);

    if (!(price > 0 && loan > 0 && termYears > 0 && mp > 0 && tp > 0 && ti >= 0)) return null;

    const interestToLoan = ti / loan;          // 0.70 = 70%
    const totalPaidPerDollar = tp / loan;      // 1.70 = 1.7x borrowed
    const downPct = down / price;              // 0.20 = 20%

    return { price, down, loan, rate, termYears, mp, tp, ti, interestToLoan, totalPaidPerDollar, downPct };
}
function mortgageMiniLevel(m) {
    // hard "bad"
    if (m.rate >= 11 || m.termYears >= 40 || m.interestToLoan >= 1.25 || m.totalPaidPerDollar >= 2.25) return "bad";

    // warn band
    if (m.rate >= 7.5 || m.termYears >= 30 || m.interestToLoan >= 0.65 || m.totalPaidPerDollar >= 1.65) return "warn";

    // extra safeguard: супер маленький down часто риск (но не ❌)
    if (m.downPct < 0.10 && (m.rate >= 6.5 || m.termYears >= 25)) return "warn";

    return "good";
}

function rentVsBuyMetrics(i, r) {
    const rentTotal = Number(r?.rentTotal || 0);
    const buyNetCost = Number(r?.buyNetCost);
    const years = Number(i?.years || 0);

    if (!(rentTotal > 0 && Number.isFinite(buyNetCost) && years > 0)) return null;

    const diff = rentTotal - buyNetCost; // + => buy cheaper (по твоей логике)
    const diffPct = diff / Math.max(Math.abs(rentTotal), 1);    // normalized gap
    const perYear = diff / years;

    return { rentTotal, buyNetCost, years, diff, diffPct, perYear };
}

function rentVsBuyMiniLevel(m, winnerRaw) {
    let w = String(winnerRaw || "").toLowerCase();
    if (w !== "buy" && w !== "rent") {
        w = m.diff >= 0 ? "buy" : "rent";
    }

    // close call: меньше 3% от total rent
    if (Math.abs(m.diffPct) < 0.03) return "info";

    // явный winner
    if (w === "buy") {
        if (m.diffPct >= 0.10) return "good";   // buy сильно дешевле
        return "warn";                           // buy чуть дешевле, но чувствительно
    }

    if (w === "rent") {
        if (m.diffPct <= -0.10) return "bad";   // buy сильно хуже → rent wins big
        return "warn";                           // rent wins, но может перевернуться
    }

    return "info";
}

function breakEvenMetrics(i, r) {
    const price = Number(i?.price || 0);
    const marketRent = Number(i?.marketRent || 0);
    const vacancy = Number(i?.vacancy ?? 0);

    const breakEvenRent = Number(r?.breakEvenRent || 0);
    const breakEvenPrice = Number(r?.breakEvenPrice || 0);

    if (!(price > 0 && marketRent >= 0 && breakEvenRent > 0)) return null;

    const gap = marketRent - breakEvenRent;             // $/mo
    const gapPct = breakEvenRent ? (gap / breakEvenRent) : 0; // ratio
    const rentToPricePct = price ? (marketRent / price) : null; // monthly ratio

    return {
        price, marketRent, breakEvenRent, breakEvenPrice, vacancy,
        gap, gapPct, rentToPricePct
    };
}

function breakEvenMiniLevel(m) {
    // bad: rent below break-even by >5%
    if (m.gapPct <= -0.05) return "bad";

    // warn: within ±5% band (knife-edge) OR high vacancy
    if (Math.abs(m.gapPct) < 0.05) return "warn";
    if (Number.isFinite(m.vacancy) && m.vacancy > 15) return "warn";

    // good: rent above break-even by >=5%
    return "good";
}

function iconForMiniLevel(level) {
    if (level === "good") return "✅";
    if (level === "warn") return "⚠️";
    if (level === "bad") return "❌";
    return "ℹ️";
}

function cashFlowMetrics(i, r) {
    const rent = Number(i?.rent || 0);
    const vacancy = Number(i?.vacancy ?? 0);
    const mortgage = Number(i?.mortgage || 0);
    const expenses = Number(i?.expenses || 0);
    const taxes = Number(i?.taxes ?? 0);
    const inflation = Number(i?.inflation ?? 0);

    const cashFlowMonth = Number(r?.cashFlowMonth ?? r?.cashFlow ?? 0); // на всякий
    const realCashFlowMonth = Number(r?.realCashFlowMonth ?? 0);
    const stressCashFlow = Number(r?.stressCashFlow ?? 0);
    const totalExpenses = Number(r?.totalExpenses ?? 0);
    const netIncome = Number(r?.netIncome ?? 0);

    if (!(rent > 0)) return null;

    const marginPct = rent ? (cashFlowMonth / rent) : null;
    const expenseRatio = rent ? (totalExpenses / rent) : null;

    return {
        rent, vacancy, mortgage, expenses, taxes, inflation,
        cashFlowMonth, realCashFlowMonth, stressCashFlow,
        totalExpenses, netIncome,
        marginPct, expenseRatio
    };
}

function cashFlowMiniLevel(m) {
    // ❌ отрицательный реальный cash flow
    if (Number.isFinite(m.realCashFlowMonth) && m.realCashFlowMonth < 0) return "bad";

    // ❌ stress test не выдержан
    if (Number.isFinite(m.stressCashFlow) && m.stressCashFlow < 0) return "bad";

    // ⚠️ cashflow положительный, но маржа маленькая / высокая вакансия / близко к нулю
    if (Number.isFinite(m.cashFlowMonth) && m.cashFlowMonth < m.rent * 0.05) return "warn";
    if (Number.isFinite(m.marginPct) && m.marginPct < 0.08) return "warn";
    if (Number.isFinite(m.vacancy) && m.vacancy > 15) return "warn";

    // ✅ сильный cash flow + запас
    if (Number.isFinite(m.marginPct) && m.marginPct >= 0.10) return "good";

    return "warn";
}

function irrMetrics(i, r) {
    const price = Number(i?.price || 0);
    const downPayment = Number(i?.downPayment || 0);
    const purchaseCosts = Number(i?.purchaseCosts || 0);
    const renovation = Number(i?.renovation || 0);
    const rent = Number(i?.rent || 0);
    const vacancy = Number(i?.vacancy ?? 0);
    const expenses = Number(i?.expenses || 0);
    const mortgage = Number(i?.mortgage || 0);
    const years = Number(i?.years || 0);
    const growth = Number(i?.growth ?? 0);
    const saleTax = Number(i?.saleTax ?? 0);
    const inflation = Number(i?.inflation ?? 0);

    const irr = Number(r?.irr ?? null);
    const realIRR = Number(r?.realIRR ?? null);
    const cashFlow = Number(r?.cashFlow ?? 0);
    const roi = Number(r?.roi ?? null);
    const paybackYears = Number(r?.paybackYears ?? null);

    const equityInvested = downPayment + purchaseCosts + renovation;

    if (!(price > 0 && years > 0 && Number.isFinite(irr) && Number.isFinite(realIRR))) return null;

    // cash-on-cash proxy (если cashFlow у тебя годовой/суммарный — мы НЕ выдумываем интерпретацию)
    // Используем только то, что есть: cashFlow и equityInvested, но назовём это safely.
    const cashFlowToEquityPct = (equityInvested > 0 && Number.isFinite(cashFlow))
        ? (cashFlow / equityInvested) * 100
        : null;

    return {
        price, downPayment, purchaseCosts, renovation, rent, vacancy, expenses, mortgage,
        years, growth, saleTax, inflation,
        irr, realIRR, cashFlow, roi, paybackYears,
        equityInvested,
        cashFlowToEquityPct
    };
}

function irrMiniLevel(m) {
    // ❌ real IRR <= 0 — теряешь покупательную способность
    if (m.realIRR <= 0) return "bad";

    // ⚠️ слабая реальная доходность
    if (m.realIRR > 0 && m.realIRR < 5) return "warn";

    // дополнительные warning flags: высокий vacancy, payback > horizon
    if (Number.isFinite(m.vacancy) && m.vacancy > 15) return "warn";
    if (Number.isFinite(m.paybackYears) && Number.isFinite(m.years) && m.paybackYears > m.years) return "warn";

    // ✅ strong
    if (m.realIRR >= 8) return "good";

    return "warn";
}

function renoMetrics(i, r) {
    const priceBefore = Number(i?.priceBefore || 0);
    const rentBefore = Number(i?.rentBefore || 0);
    const renovationCost = Number(i?.renovationCost || 0);
    const priceIncrease = Number(i?.priceIncrease ?? 0);
    const rentIncrease = Number(i?.rentIncrease ?? 0);
    const agentFee = Number(i?.agentFee ?? 0);
    const saleTax = Number(i?.saleTax ?? 0);
    const years = Number(i?.years || 0);
    const discountRate = Number(i?.discountRate ?? 0);
    const inflationRate = Number(i?.inflationRate ?? 0);

    const priceAfter = Number(r?.priceAfter || 0);
    const rentAfter = Number(r?.rentAfter || 0);
    const netProfit = Number(r?.netProfit ?? 0);
    const netProfitPV = Number(r?.netProfitPV ?? 0);
    const roi = (r?.roi == null) ? null : Number(r.roi);
    const roiPV = (r?.roiPV == null) ? null : Number(r.roiPV);
    const payback = (r?.payback == null) ? null : Number(r.payback);
    const valueUplift = priceAfter - priceBefore;
    const rentUplift = rentAfter - rentBefore;

    if (!(renovationCost > 0)) return null;

    return {
        priceBefore, rentBefore, renovationCost, priceIncrease, rentIncrease,
        agentFee, saleTax, years, discountRate, inflationRate,
        priceAfter, rentAfter, netProfit, netProfitPV, roi, roiPV, payback,
        valueUplift, rentUplift
    };
}

function renoMiniLevel(m) {
    // ❌ если PV профит <= 0 или roiPV <= 0 — реально плохо
    if ((Number.isFinite(m.netProfitPV) && m.netProfitPV <= 0) ||
        (Number.isFinite(m.roiPV) && m.roiPV <= 0)) return "bad";

    // ⚠️ номинально ок, но PV слабый / payback слишком долгий
    if ((Number.isFinite(m.netProfit) && m.netProfit <= 0) ||
        (Number.isFinite(m.roi) && m.roi <= 0)) return "warn";

    if (Number.isFinite(m.payback) && Number.isFinite(m.years) && m.payback > m.years) return "warn";

    // ✅ сильная сделка: roiPV >= 15% или payback <= 3y (настрой по вкусу)
    if (Number.isFinite(m.roiPV) && m.roiPV >= 15) return "good";
    if (Number.isFinite(m.payback) && m.payback > 0 && m.payback <= 3) return "good";

    return "warn";
}

function saleMetrics(i, r) {
    const buyPrice = Number(i?.buyPrice || 0);
    const sellPrice = Number(i?.sellPrice || 0);
    const years = Number(i?.years || 0);
    const tax = Number(i?.tax ?? null);
    const commission = Number(i?.commission ?? null);
    const inflation = Number(i?.inflation ?? null);
    const renovation = Number(i?.renovation || 0);

    const taxAmount = Number(r?.taxAmount ?? 0);
    const commissionAmount = Number(r?.commissionAmount ?? 0);
    const netProfit = Number(r?.netProfit ?? 0);
    const annualReturn = Number(r?.annualReturn ?? null);
    const realReturn = Number(r?.realReturn ?? null);

    if (!(buyPrice > 0 && sellPrice > 0 && years > 0)) return null;

    const grossProfit = sellPrice - buyPrice;
    const totalExplicitCosts = taxAmount + commissionAmount + renovation;

    return {
        buyPrice, sellPrice, years, tax, commission, inflation, renovation,
        taxAmount, commissionAmount, netProfit, annualReturn, realReturn,
        grossProfit, totalExplicitCosts
    };
}

function saleMiniLevel(m) {
    // ❌ если реально минус или netProfit <= 0
    if ((Number.isFinite(m.realReturn) && m.realReturn <= 0) || m.netProfit <= 0) return "bad";

    // ⚠️ низкий realReturn или прибыль очень маленькая относительно цены покупки
    const profitToBuy = m.buyPrice > 0 ? (m.netProfit / m.buyPrice) : 0;
    if ((Number.isFinite(m.realReturn) && m.realReturn < 3) || profitToBuy < 0.03) return "warn";

    // ✅ хорошо: realReturn >= 5 или profit >= 10% от buyPrice
    if ((Number.isFinite(m.realReturn) && m.realReturn >= 5) || profitToBuy >= 0.10) return "good";

    return "warn";
}

function taxesMetrics(i, r) {
    const price = Number(i?.price || 0);
    const rent = Number(i?.rent || 0);
    const years = Number(i?.years || 0);

    const priceGrowth = Number(i?.priceGrowth ?? null);
    const propertyTax = Number(i?.propertyTax ?? null);
    const rentTax = Number(i?.rentTax ?? null);

    const annualFees = Number(i?.annualFees || 0);
    const feeGrowth = Number(i?.feeGrowth ?? null);

    const saleTax = Number(i?.saleTax ?? null);
    const agentFee = Number(i?.agentFee ?? null);
    const inflationRate = Number(i?.inflationRate ?? null);

    const totalTaxes = Number(r?.totalTaxes ?? 0);
    const totalFees = Number(r?.totalFees ?? 0);
    const totalRentNet = Number(r?.totalRentNet ?? 0);
    const finalProfit = Number(r?.finalProfit ?? 0);
    const finalProfitPV = Number(r?.finalProfitPV ?? 0);
    const simpleROI = Number(r?.simpleROI ?? null);
    const realROI = Number(r?.realROI ?? null);
    const taxBurdenPercent = Number(r?.taxBurdenPercent ?? null);

    if (!(price > 0 && years > 0)) return null;

    const taxesPlusFees = totalTaxes + totalFees;
    const burn = (price > 0) ? (taxesPlusFees / price) : null; // lifetime drag vs price

    return {
        price, rent, years,
        priceGrowth, propertyTax, rentTax,
        annualFees, feeGrowth, saleTax, agentFee, inflationRate,
        totalTaxes, totalFees, totalRentNet,
        finalProfit, finalProfitPV, simpleROI, realROI,
        taxBurdenPercent,
        taxesPlusFees,
        burnPercentOfPrice: (burn !== null) ? (burn * 100) : null
    };
}

function taxesMiniLevel(m) {
    // ❌: реальная прибыль/ROI <= 0
    if ((Number.isFinite(m.realROI) && m.realROI <= 0) || m.finalProfitPV <= 0) return "bad";

    // ⚠️: налоговая нагрузка высокая или realROI низкий
    if ((Number.isFinite(m.taxBurdenPercent) && m.taxBurdenPercent >= 55) ||
        (Number.isFinite(m.realROI) && m.realROI < 4) ||
        (Number.isFinite(m.burnPercentOfPrice) && m.burnPercentOfPrice > 45)) {
        return "warn";
    }

    // ✅: realROI крепкий и burden умеренный
    if ((Number.isFinite(m.realROI) && m.realROI >= 6) &&
        (!Number.isFinite(m.taxBurdenPercent) || m.taxBurdenPercent < 45)) {
        return "good";
    }

    return "warn";
}

function ownershipCostMetrics(i, r) {
    const price = Number(i?.price || 0);
    const years = Number(i?.years || 0);

    // new ownership_cost inputs
    const taxPercent = Number(i?.taxPercent ?? 0);
    const maintenance = Number(i?.maintenance || 0);
    const inflation = Number(i?.inflation ?? 0);

    // canonical results (with backward compat)
    const rawTotalOwnershipCost = Number(r?.totalOwnershipCost ?? r?.totalCost ?? 0);
    const rawTotalOwnershipCostPV = Number(r?.totalOwnershipCostPV ?? r?.totalCostPV ?? 0);

    if (!(price > 0 && years > 0 && rawTotalOwnershipCost >= 0)) return null;

    // Backward compat: old records may include purchase price in totalOwnershipCost.
    const looksLegacyWithPrincipal = rawTotalOwnershipCost >= price * 0.95;
    const totalOwnershipCost = looksLegacyWithPrincipal
        ? Math.max(0, rawTotalOwnershipCost - price)
        : rawTotalOwnershipCost;
    const totalOwnershipCostPV = looksLegacyWithPrincipal
        ? Math.max(0, rawTotalOwnershipCostPV - price)
        : rawTotalOwnershipCostPV;

    const inputPct = Number(r?.costAsPercentOfPrice);
    const costAsPercentOfPrice = Number.isFinite(inputPct) && inputPct >= 0 && inputPct < 90
        ? inputPct
        : ((price > 0) ? (totalOwnershipCost / price) * 100 : null);

    return {
        price, years,
        taxPercent, maintenance, inflation,
        totalOwnershipCost,
        totalOwnershipCostPV,
        costAsPercentOfPrice: (costAsPercentOfPrice !== null) ? costAsPercentOfPrice : null
    };
}

function ownershipCostMiniLevel(m) {
    // Primary signal: cumulative carrying cost vs purchase price.
    // Heuristics tuned to avoid systematically pessimistic verdicts.
    const p = Number.isFinite(m?.costAsPercentOfPrice) ? Number(m.costAsPercentOfPrice) : null;

    if (p !== null) {
        if (p > 85) return "bad";
        if (p <= 35) return "good";
        return "warn";
    }

    // Fallback 1: compute percent from totalOwnershipCost if available
    const price = Number(m?.price || 0);
    const total = Number(m?.totalOwnershipCost || 0);

    if (price > 0 && total > 0) {
        const pct = (total / price) * 100;
        if (pct > 85) return "bad";
        if (pct <= 35) return "good";
        return "warn";
    }

    // Fallback 2: compute avg monthly cost and compare to price/12
    // (very rough, only if years+total exist)
    const years = Number(m?.years || 0);
    if (price > 0 && years > 0 && total > 0) {
        const mAvg = total / (years * 12);
        // heuristic: if avg monthly ownership cost > 1% of monthly "price scale"
        // (keep your old conservative idea)
        if (mAvg > 0.01 * (price / 12)) return "warn";
        return "warn";
    }

    // No reliable info → conservative
    return "warn";
}


function alternativeInvestmentMetrics(i, r) {
    const years = Number(i?.years || 0);
    if (!(years > 0)) return null;

    const propertyInitial = Number(i?.propertyInitial || 0);
    const propertyCashflow = Number(i?.propertyCashflow || 0);
    const propertyGrowth = Number(i?.propertyGrowth ?? 0);
    const propertyInflation = Number(i?.propertyInflation ?? 0);
    const propertyTaxRate = Number(i?.propertyTaxRate ?? 0);

    const altReturn = Number(i?.altReturn ?? 0);
    const altContribution = Number(i?.altContribution ?? 0);
    const altInflation = Number(i?.altInflation ?? 0);
    const altTaxRate = Number(i?.altTaxRate ?? 0);

    const propertyValue = Number(r?.propertyValue ?? 0);
    const alternativeValue = Number(r?.alternativeValue ?? 0);
    const propertyRealReturnPercent = Number(r?.propertyRealReturnPercent ?? 0);
    const alternativeRealReturnPercent = Number(r?.alternativeRealReturnPercent ?? 0);
    const difference = Number(r?.difference ?? (propertyValue - alternativeValue)); // property - alternative

    const totalContributed = propertyInitial + (altContribution * years);
    const gain = alternativeValue - totalContributed;
    const outperformance = alternativeValue - propertyValue;
    const outperformancePercent = propertyValue > 0 ? ((alternativeValue / propertyValue - 1) * 100) : null;
    const feeDragPercentOfFinal = null;

    return {
        years,
        propertyInitial,
        propertyCashflow,
        propertyGrowth,
        propertyInflation,
        propertyTaxRate,
        altReturn,
        altContribution,
        altInflation,
        altTaxRate,
        propertyValue,
        alternativeValue,
        propertyRealReturnPercent,
        alternativeRealReturnPercent,
        difference,
        totalContributed,
        gain,
        totalFeesPaid: null,
        feeDragPercentOfFinal,
        outperformance,
        outperformancePercent
    };
}

function alternativeInvestmentMiniLevel(m) {
    const altRR = Number(m?.alternativeRealReturnPercent);
    const propRR = Number(m?.propertyRealReturnPercent);
    if (Number.isFinite(altRR) && Number.isFinite(propRR)) {
        const gap = altRR - propRR;
        if (gap <= 0) return "bad";
        if (gap >= 1.5) return "good";
        return "warn";
    }

    // If real returns are not available, compare final values.
    if (Number.isFinite(m.outperformance) && Number.isFinite(m.outperformancePercent)) {
        if (m.outperformance <= 0) return "bad";
        if (m.outperformancePercent >= 8) return "good";
        return "warn";
    }

    // Last fallback: gain vs contributed.
    const contributed = Number(m.totalContributed || 0);
    if (contributed > 0) {
        const roi = (m.gain / contributed) * 100; // simple, not annualized
        if (roi <= 0) return "bad";
        if (roi >= 30) return "good";
        return "warn";
    }

    return "warn";
}

function mortgageOverpaymentMetrics(i, r) {
    const loan = Number(i?.loan || 0);
    const rate = Number(i?.rate ?? i?.ratePercent ?? 0);
    const years = Number(i?.years || 0);
    const inflation = Number(i?.inflation ?? 0);

    const monthlyPayment = Number(r?.monthlyPayment || 0);
    const nominalOverpayment = Number(r?.nominalOverpayment || 0);
    const realOverpayment = Number(r?.realOverpayment || 0);
    const realInterestRate = Number(r?.realInterestRate ?? 0);

    if (!(loan > 0 && years > 0 && monthlyPayment > 0)) return null;

    const nominalPct = (loan > 0) ? (nominalOverpayment / loan) * 100 : null;
    const realPct = (loan > 0) ? (realOverpayment / loan) * 100 : null;

    const totalPaidNominal = loan + nominalOverpayment;
    const totalPaidPerDollar = (loan > 0) ? (totalPaidNominal / loan) : null;

    return {
        loan, rate, years, inflation,
        monthlyPayment,
        nominalOverpayment, realOverpayment, realInterestRate,
        nominalPct, realPct,
        totalPaidNominal,
        totalPaidPerDollar
    };
}

function mortgageOverpaymentMiniLevel(m) {
    // primary: real overpayment ratio
    if (Number.isFinite(m.realPct)) {
        if (m.realPct > 60) return "bad";
        if (m.realPct > 30) return "warn";
        return "good";
    }

    // fallback: nominal ratio
    if (Number.isFinite(m.nominalPct)) {
        if (m.nominalPct > 80) return "bad";
        if (m.nominalPct > 45) return "warn";
        return "good";
    }

    return "warn";
}





app.post("/api/scenarios/build", rl.byUser({ limit: 60, windowSec: 400 }), async (req, res) => { 
    if (!req.session?.userId) return res.sendStatus(401);

    const calculationId = Number(req.body?.calculationId);
    const pack = String(req.body?.pack || "quick");
    const count = Math.max(1, Math.min(10, Number(req.body?.count || 3)));
    if (!calculationId) return res.status(400).json({ error: "BAD_INPUT" });
    const candidateCount =
        pack === "deep" ? 180 :
            pack === "optimize" ? 90 :
                40;

    const cr = await db.query(
        `SELECT id, calculator_type, input_data
     FROM calculations
     WHERE id=$1 AND user_id=$2`,
        [calculationId, req.session.userId]
    );
    if (!cr.rowCount) return res.status(404).json({ error: "NOT_FOUND" });

    const baseCalc = cr.rows[0];

    if(baseCalc.calculator_type==="mortgage"){
        const scenarios = buildMortgageScenarios(
        baseCalc.input_data,
         candidateCount);
        return res.json({ calculator_type: baseCalc.calculator_type, scenarios });
    }

    if (baseCalc.calculator_type === "rent_vs_buy") {
        const scenarios = buildRentVsBuyScenarios(baseCalc.input_data, candidateCount);
        return res.json({ calculator_type: baseCalc.calculator_type, scenarios });
    }

    if (baseCalc.calculator_type === "break_even") {
        const scenarios = buildBreakEvenScenarios(baseCalc.input_data, candidateCount);
        return res.json({ calculator_type: baseCalc.calculator_type, scenarios });
    }

    if (baseCalc.calculator_type === "cash_flow") {
        const scenarios = buildCashFlowScenarios(baseCalc.input_data, candidateCount);
        return res.json({ calculator_type: baseCalc.calculator_type, scenarios });
    }

    if (baseCalc.calculator_type === "property_irr") {
        const scenarios = buildIRRScenarios(baseCalc.input_data, candidateCount);
        return res.json({ calculator_type: baseCalc.calculator_type, scenarios });
    }

    if (baseCalc.calculator_type === "renovation_roi") {
        const scenarios = buildRenovationRoiScenarios(baseCalc.input_data, candidateCount);
        return res.json({ calculator_type: baseCalc.calculator_type, scenarios });
    }

    if (baseCalc.calculator_type === "property_sale") {
        const scenarios = buildPropertySaleScenarios(baseCalc.input_data, candidateCount);
        return res.json({ calculator_type: baseCalc.calculator_type, scenarios });
    }

    if (baseCalc.calculator_type === "property_taxes") {
        const scenarios = buildPropertyTaxesScenarios(baseCalc.input_data, candidateCount);
        return res.json({ calculator_type: baseCalc.calculator_type, scenarios });
    }

    if (baseCalc.calculator_type === "ownership_cost") {
        const scenarios = buildOwnershipCostScenarios(baseCalc.input_data, candidateCount);
        return res.json({ calculator_type: baseCalc.calculator_type, scenarios });
    }

    if (baseCalc.calculator_type === "alternative_investment") {
        const scenarios = buildAlternativeInvestmentScenarios(baseCalc.input_data, candidateCount);
        return res.json({ calculator_type: baseCalc.calculator_type, scenarios });
    }

    if (baseCalc.calculator_type === "mortgage_overpayment") {
        const scenarios = buildMortgageOverpaymentScenarios(baseCalc.input_data, candidateCount);
        return res.json({ calculator_type: baseCalc.calculator_type, scenarios });
    }





    // buildScenarios должен возвращать [{label, input_data}]
     const scenarios = buildScenarios({
        calculator_type: baseCalc.calculator_type,
        input_data: baseCalc.input_data,
        CALC_FORMATS
     }, candidateCount);

    return res.json({ calculator_type: baseCalc.calculator_type, scenarios });
});

function miniRank(level) {
    if (level === "good") return 3;
    if (level === "warn") return 2;
    if (level === "info") return 1;
    return 0;
}

function miniFor(type, input_data, result_data) {
    try {
        return miniVerdictUniversal({ calculator_type: type, input_data, result_data });
    } catch {
        return null;
    }
}



app.post("/api/scenarios/compute", rl.byUser({ limit: 60, windowSec: 400 }), async (req, res) => { 
    if (!req.session?.userId) return res.sendStatus(401);

    const calculationId = Number(req.body?.calculationId);
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    const desired = Math.max(1, Math.min(10, Number(req.body?.count || 3)));
    const rerun = !!req.body?.rerun;

    function stableStringify(value) {
        if (value === null || value === undefined) return "null";
        if (typeof value !== "object") return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
        const keys = Object.keys(value).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
    }

    function inputHash(input) {
        return crypto.createHash("sha256").update(stableStringify(input || {})).digest("hex");
    }

    if (!calculationId || !items?.length) {
        return res.status(400).json({ error: "BAD_INPUT" });
    }
    if (items.length > MAX_SCENARIO_COMPUTE_ITEMS) {
        return res.status(400).json({ error: "TOO_MANY_ITEMS", max: MAX_SCENARIO_COMPUTE_ITEMS });
    }

    const cr = await db.query(
        `SELECT id, calculator_type, input_data, result_data
     FROM calculations
     WHERE id=$1 AND user_id=$2`,
        [calculationId, req.session.userId]
    );
    if (!cr.rowCount) return res.status(404).json({ error: "NOT_FOUND" });

    const normalizedBase = await normalizeCalcResultData(cr.rows[0], req.session.userId);
    const baseCalc = normalizedBase.calc;
    const type = baseCalc.calculator_type;
    const previousInputHashes = new Set();

    if (rerun) {
        try {
            const history = await db.query(
                `select items
           from scenario_analyses
           where user_id=$1 and calculation_id=$2
           order by created_at desc
           limit 5`,
                [req.session.userId, calculationId]
            );

            for (const row of history.rows || []) {
                const savedItems = Array.isArray(row.items) ? row.items : [];
                for (const it of savedItems) {
                    if (it?.input_data && typeof it.input_data === "object") {
                        previousInputHashes.add(inputHash(it.input_data));
                    }
                }
            }
        } catch (e) {
            console.error("SCENARIO_RERUN_HISTORY_FAILED:", e);
        }
    }

    function pickBestScenariosByType(type, computedItems, baseInput, baseResult, count) {
        const safeNum = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };


        function metricSpec(type) {
            // primary = what we optimize, mode says direction
            switch (type) {
                case "mortgage":
                    return { mode: "min", primaryKey: "monthlyPayment", secondaryKey: "totalPayment" };

                case "rent_vs_buy":
                    return { mode: "min", primaryKey: "buyNetCost", secondaryKey: "rentTotal" };

                case "break_even":
                    return { mode: "min", primaryKey: "breakEvenRent", secondaryKey: "breakEvenPrice" };

                case "cash_flow":
                    return { mode: "max", primaryKey: "stressCashFlow", secondaryKey: "realCashFlowMonth" };

                case "property_irr":
                    return { mode: "max", primaryKey: "realIRR", secondaryKey: "irr" };

                case "renovation_roi":
                    return { mode: "max", primaryKey: "netProfitPV", secondaryKey: "roiPV" };

                case "property_sale":
                    return { mode: "max", primaryKey: "netProfit", secondaryKey: "realReturn" };

                case "property_taxes":
                    return { mode: "max", primaryKey: "finalProfitPV", secondaryKey: "realROI" };

                case "ownership_cost":
                    return { mode: "min", primaryKey: "totalOwnershipCostPV", secondaryKey: "totalOwnershipCost" };

                case "alternative_investment":
                    return { mode: "max", primaryKey: "alternativeValue", secondaryKey: "alternativeRealReturnPercent" };

                case "mortgage_overpayment":
                    return { mode: "min", primaryKey: "realOverpayment", secondaryKey: "nominalOverpayment" };

                default:
                    return { mode: "min", primaryKey: null, secondaryKey: null };
            }
        }

        function getMetric(r, key) {
            if (!key) return null;
            if (!r) return null;

            // compat keys
            if (key === "totalOwnershipCostPV") return safeNum(r.totalOwnershipCostPV ?? r.totalCostPV);
            if (key === "totalOwnershipCost") return safeNum(r.totalOwnershipCost ?? r.totalCost);

            if (key === "finalValue") return safeNum(r.finalValue ?? r.futureValue ?? r.endingBalance);
            if (key === "outperformance") return safeNum((r.alternativeValue ?? NaN) - (r.propertyValue ?? NaN));

            return safeNum(r[key]);
        }

        function countChangedFields(base, cur) {
            const b = base || {};
            const c = cur || {};
            const keys = new Set([...Object.keys(b), ...Object.keys(c)]);
            let n = 0;
            for (const k of keys) {
                if (!(k in b) || !(k in c)) continue;
                // loose compare for numeric strings
                const nb = Number(b[k]);
                const nc = Number(c[k]);
                const bothNum = Number.isFinite(nb) && Number.isFinite(nc);
                const eq = bothNum ? (nb === nc) : (String(b[k]) === String(c[k]));
                if (!eq) n++;
            }
            return n;
        }

        function changeMagnitudeScore(base, cur) {
            const b = base || {};
            const c = cur || {};
            const keys = new Set([...Object.keys(b), ...Object.keys(c)]);
            const mags = [];

            for (const k of keys) {
                if (!(k in b) || !(k in c)) continue;
                const nb = Number(b[k]);
                const nc = Number(c[k]);
                if (!Number.isFinite(nb) || !Number.isFinite(nc)) continue;
                if (nb === nc) continue;
                const rel = Math.abs((nc - nb) / (Math.abs(nb) + 1));
                mags.push(Math.min(rel, 3));
            }

            if (!mags.length) return 0;
            mags.sort((a, b) => b - a);
            return mags.slice(0, 3).reduce((s, x) => s + x, 0);
        }

        const baseMini = miniFor(type, baseInput, baseResult);
        const baseMiniRank = miniRank(baseMini?.level);

        const spec = metricSpec(type);
        const basePrimary = getMetric(baseResult, spec.primaryKey);
        const baseSecondary = getMetric(baseResult, spec.secondaryKey);

        const scored = (computedItems || [])
            .filter(x => x && x.result_data && !x.error)
            .map(x => {
                const r = x.result_data || {};
                const mv = miniFor(type, x.input_data, r);
                const rank = miniRank(mv?.level);
                const rankDelta = rank - baseMiniRank;

                const primary = getMetric(r, spec.primaryKey);
                const secondary = getMetric(r, spec.secondaryKey);

                const changedCount = countChangedFields(baseInput, x.input_data);
                const changeMag = changeMagnitudeScore(baseInput, x.input_data);
                const label = String(x.label || "");

                const isStress = /stress|bad market|shock|nightmare/i.test(label);
                const isSimpleLever = changedCount <= 1; // 1 рычаг = продаётся лучше
                const isLowImpact = changeMag < 0.03;

                // improvement: positive means better than baseline (when baseline exists)
                let improvement = null;
                if (primary !== null && basePrimary !== null) {
                    improvement = (spec.mode === "max") ? (primary - basePrimary) : (basePrimary - primary);
                }

                return {
                    ...x,
                    mini_verdict: mv || undefined,
                    _rank : rank,
                    _rankDelta: rankDelta,
                    _primary: primary,
                    _secondary: secondary,
                    _improvement: improvement,
                    _changedCount: changedCount,
                    _changeMag: changeMag,
                    _isStress: isStress,
                    _isSimpleLever: isSimpleLever,
                    _isLowImpact: isLowImpact
                };
            });

        if (!scored.length) return [];

        const out = [];
        const seen = new Set();
        const pushUnique = (it) => {
            if (!it) return;
            const k = JSON.stringify(it.input_data || {});
            if (seen.has(k)) return;
            seen.add(k);
            out.push(it);
        };

        // BEST: highest rankDelta, then best improvement, then best primary
        const bestOverall = scored.slice().sort((a, b) => {
            if ((b._rankDelta ?? 0) !== (a._rankDelta ?? 0)) return (b._rankDelta ?? 0) - (a._rankDelta ?? 0);

            const ai = (a._improvement ?? -Infinity);
            const bi = (b._improvement ?? -Infinity);
            if (bi !== ai) return bi - ai;

            // fallback: primary itself
            const ap = (a._primary ?? (spec.mode === "max" ? -Infinity : Infinity));
            const bp = (b._primary ?? (spec.mode === "max" ? -Infinity : Infinity));
            return (spec.mode === "max") ? (bp - ap) : (ap - bp);
        })[0];

        // SIMPLE LEVER: best among 1-change (or 2-change if no 1-change)
        let bestSimple = scored
            .filter(s => s._isSimpleLever)
            .sort((a, b) => {
                if ((b._rankDelta ?? 0) !== (a._rankDelta ?? 0)) return (b._rankDelta ?? 0) - (a._rankDelta ?? 0);
                if ((b._improvement ?? -Infinity) !== (a._improvement ?? -Infinity)) return (b._improvement ?? -Infinity) - (a._improvement ?? -Infinity);
                return (b._changeMag ?? 0) - (a._changeMag ?? 0);
            })[0];

        if (!bestSimple) {
            bestSimple = scored
                .filter(s => (s._changedCount ?? 999) <= 2)
                .sort((a, b) => {
                    if ((b._rankDelta ?? 0) !== (a._rankDelta ?? 0)) return (b._rankDelta ?? 0) - (a._rankDelta ?? 0);
                    if ((b._improvement ?? -Infinity) !== (a._improvement ?? -Infinity)) return (b._improvement ?? -Infinity) - (a._improvement ?? -Infinity);
                    return (b._changeMag ?? 0) - (a._changeMag ?? 0);
                })[0];
        }

        // STRESS: pick worst from stress-labeled (or worst overall by improvement)
        let stressCase = scored
            .filter(s => s._isStress)
            .sort((a, b) => (a._improvement ?? Infinity) - (b._improvement ?? Infinity))[0];

        if (!stressCase) {
            stressCase = scored
                .slice()
                .sort((a, b) => (a._improvement ?? Infinity) - (b._improvement ?? Infinity))[0];
        }

        // SECONDARY BEST: best secondary metric (if exists)
        const bestSecondary = scored
            .filter(s => s._secondary !== null && baseSecondary !== null)
            .sort((a, b) => {
                const aImp = (spec.mode === "max") ? (a._secondary - baseSecondary) : (baseSecondary - a._secondary);
                const bImp = (spec.mode === "max") ? (b._secondary - baseSecondary) : (baseSecondary - b._secondary);
                return bImp - aImp;
            })[0];

        const bestHighImpact = scored
            .slice()
            .sort((a, b) => {
                if ((b._rankDelta ?? 0) !== (a._rankDelta ?? 0)) return (b._rankDelta ?? 0) - (a._rankDelta ?? 0);
                if ((b._changeMag ?? 0) !== (a._changeMag ?? 0)) return (b._changeMag ?? 0) - (a._changeMag ?? 0);
                return (b._improvement ?? -Infinity) - (a._improvement ?? -Infinity);
            })[0];

        pushUnique(bestSimple);
        pushUnique(bestOverall);
        const includeStress = count >= 5 || baseMiniRank >= 2;
        if (includeStress) pushUnique(stressCase);
        else if (out.length < count) pushUnique(bestHighImpact);
        if (out.length < count) pushUnique(bestSecondary);

        // Fill rest: sort by rankDelta then improvement
        const rest = scored.slice().sort((a, b) => {
            if ((b._rankDelta ?? 0) !== (a._rankDelta ?? 0)) return (b._rankDelta ?? 0) - (a._rankDelta ?? 0);
            if ((b._improvement ?? -Infinity) !== (a._improvement ?? -Infinity)) return (b._improvement ?? -Infinity) - (a._improvement ?? -Infinity);
            return (b._changeMag ?? 0) - (a._changeMag ?? 0);
        });

        for (const it of rest) {
            if (out.length >= count) break;
            pushUnique(it);
        }

        // remove internals
        return out.slice(0, count).map(({ _rank, _rankDelta, _primary, _secondary, _improvement, _changedCount, _changeMag, _isStress, _isSimpleLever, _isLowImpact, ...clean }) => clean);
    }

    // --- baseline (ensure exists) ---
    const baseInput = baseCalc.input_data;
    const baseResult = baseCalc.result_data || computeResultByType(type, baseInput);

    // --- server goal scenarios (flip/required/boundary) ---
    const serverGoals = buildServerGoalScenarios(type, baseInput, baseResult, computeResultByType);

    // 1) compute results for ALL incoming items + include server goals already computed
    const computed = [];

    // push server goals first (already have result_data)
    for (const sg of serverGoals) {
        computed.push({
            idx: -1,
            label: sg.label,
            input_data: sg.input_data,
            result_data: sg.result_data,
            mini_verdict: sg.mini_verdict,
            meta: sg.meta
        });
    }

    // then compute client items
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const input_data = it?.input_data || null;

        if (!input_data || typeof input_data !== "object") {
            computed.push({ idx: i, label: String(it?.label || `Scenario ${i + 1}`), input_data, error: "BAD_SCENARIO_INPUT" });
            continue;
        }

        const result_data = computeResultByType(type, input_data);
        if (!result_data) {
            computed.push({ idx: i, label: String(it?.label || `Scenario ${i + 1}`), input_data, error: "COMPUTE_FAILED" });
            continue;
        }

        computed.push({ idx: i, label: String(it?.label || `Scenario ${i + 1}`), input_data, result_data, meta: it?.meta });
    }

    // attach mini verdict if missing
    for (const x of computed) {
        if (!x || x.error || !x.result_data) continue;
        if (!x.mini_verdict) {
            x.mini_verdict = miniVerdictUniversal({ calculator_type: type, input_data: x.input_data, result_data: x.result_data });
        }
    }

    // ✅ NEW: dedupe by OUTCOME
    let computedDedup = computed.filter(x => x && x.result_data && !x.error);
    computedDedup = dedupeByOutcome(type, computedDedup, baseInput);

    // rerun: first try scenarios not seen in recent paid runs for this calculation
    let selectionPool = computedDedup;
    const hasHistory = rerun && previousInputHashes.size > 0;
    if (hasHistory) {
        const unseenPool = computedDedup.filter(it => !previousInputHashes.has(inputHash(it?.input_data)));
        if (unseenPool.length) selectionPool = unseenPool;
    }

    // then pick best
    const best = pickBestScenariosByType(type, selectionPool, baseInput, baseResult, desired);
    let finalItems = best?.length ? best : selectionPool.slice(0, desired);

    // if rerun pool was too small, fill rest from remaining deduped candidates
    if (finalItems.length < desired && selectionPool !== computedDedup) {
        const picked = new Set(finalItems.map(it => inputHash(it?.input_data)));
        const remainPool = computedDedup.filter(it => !picked.has(inputHash(it?.input_data)));
        if (remainPool.length) {
            const need = desired - finalItems.length;
            const fallbackBest = pickBestScenariosByType(type, remainPool, baseInput, baseResult, need);
            const fallback = fallbackBest?.length ? fallbackBest : remainPool.slice(0, need);
            for (const it of fallback) {
                const h = inputHash(it?.input_data);
                if (picked.has(h)) continue;
                picked.add(h);
                finalItems.push(it);
                if (finalItems.length >= desired) break;
            }
        }
    }

    return res.json({ calculator_type: type, items: finalItems });
});

function aggregatePortfolio(calcs) {
    const byType = {};
    const verdictCounts = { good: 0, warn: 0, info: 0 };
    const missing = {};

    for (const c of calcs) {
        const type = String(c.calculator_type);
        byType[type] = byType[type] || { count: 0, samples: [] };
        byType[type].count++;

        const mini = miniVerdictUniversal(c);
        verdictCounts[String(mini?.level || "info")] = (verdictCounts[String(mini?.level || "info")] || 0) + 1;

        const derived = buildDerivedMetrics(c);
        (derived?.missingChecklist || []).forEach(x => {
            const k = String(x || "");
            if (!k) return;
            missing[k] = (missing[k] || 0) + 1;
        });

        // Keep tiny sample metrics
        byType[type].samples.push({
            mini_verdict: mini,
            result_data: c.result_data
        });
    }

    const missingTop = Object.entries(missing)
        .sort((a, b) => (b[1] - a[1]))
        .slice(0, 8)
        .map(([k, v]) => ({ item: k, count: v }));

    return { byType, verdictCounts, missingTop };
}

app.get("/api/portfolio/summary/latest", rl.byUser({ limit: 120, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);

    const latest = await db.query(
        `select content, created_at
         from portfolio_summaries
         where user_id=$1
         order by created_at desc
         limit 1`,
        [req.session.userId]
    );

    if (!latest.rowCount) return res.status(404).json({ error: "NO_SAVED_SUMMARY" });

    const wallet = await getWallet(req.session.userId);
    return res.json({
        mode: "saved",
        content: String(latest.rows[0].content || ""),
        created_at: latest.rows[0].created_at,
        wallet
    });
});

app.post("/api/portfolio/summary", rl.byUser({ limit: 60, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);
    const force = !!req.body?.force;

    const limit = clamp(req.body?.limit || 20, 5, 20);
    const rows = await db.query(
        `select id, calculator_type, input_data, result_data, created_at
     from calculations
     where user_id=$1
     order by created_at desc
     limit $2`,
        [req.session.userId, limit]
    );

    const calcs = rows.rows || [];
    if (calcs.length < 5) {
        return res.status(400).json({ error: "NOT_ENOUGH_DATA", message: "Need at least 5 calculations." });
    }

    const hash = hashJson({ ids: calcs.map(x => x.id) });

    if (!force) {
        const cached = await db.query(
            `select content from portfolio_summaries where user_id=$1 and hash=$2 limit 1`,
            [req.session.userId, hash]
        );
        if (cached.rowCount) {
            const wallet = await getWallet(req.session.userId);
            return res.json({ mode: "cached", content: cached.rows[0].content, wallet });
        }
    }

    const agg = aggregatePortfolio(calcs);

    const payload = {
        count: calcs.length,
        recent_ids: calcs.map(c => c.id),
        verdictCounts: agg.verdictCounts,
        byTypeCounts: Object.fromEntries(Object.entries(agg.byType).map(([k, v]) => [k, v.count])),
        missingTop: agg.missingTop,
        samples: calcs.slice(0, 12).map(c => ({
            id: c.id,
            calculator_type: c.calculator_type,
            mini_verdict: miniVerdictUniversal(c),
            derived_metrics: buildDerivedMetrics(c),
            result_data: c.result_data
        }))
    };

    const SYSTEM = `
You are PropertyCost "Portfolio Summary".
Rules:
- Provide risks AND opportunities.
- Cite numbers where possible.
- Output must end with 3 "Next runs" buttons that spend credits naturally.
`.trim();

    const USER = `
Language: English. 650–900 tokens.

Output EXACTLY:

Portfolio snapshot:
- <counts by type and verdict level>

Top risks:
- <3-5 bullets>

Top opportunities:
- <3-5 bullets>

Missing assumptions (most common):
- <list payload.missingTop>

What I would do next (in order):
1) <button label + why>
2) <button label + why>
3) <button label + why>

Payload JSON:
${JSON.stringify(payload)}
`.trim();

    let dedupKey = force ? "" : `portfolio:${req.session.userId}:${hash}`;
    const wantsAsync = asyncProcessingEnabled() && !toBool(req.body?.sync);
    if (wantsAsync && dedupKey) {
        const predictedJobId = aiJobIdFromDedupKey(dedupKey);
        if (predictedJobId) {
            const existing = await aiJobGet(req.session.userId, predictedJobId);
            if (existing && existing.status !== "failed" && existing.status !== "done") {
                const wallet = await getWallet(req.session.userId);
                return res.status(202).json(aiQueueAcceptedBody({
                    jobId: predictedJobId,
                    type: "portfolio_summary",
                    wallet,
                    message: "Portfolio summary queued. Poll /api/ai/jobs/:jobId"
                }));
            }
            if (existing?.status === "done") {
                dedupKey = "";
            }
        }
    }

    const w0 = await getWallet(req.session.userId);
    if ((w0.credits || 0) < 6) {
        return res.status(402).json({ error: "NO_CREDITS", action: { type: "BUY_CREDITS", suggested: "Value" } });
    }

    let reserved = 0;
    try {
        await reserveCreditsOrThrow(req.session.userId, 6);
        reserved = 6;

        if (wantsAsync) {
            const queued = await enqueueOpenAiChat({
                model: "gpt-4o-mini",
                temperature: 0.25,
                max_tokens: 1200,
                messages: [
                    { role: "system", content: SYSTEM },
                    { role: "user", content: USER }
                ]
            }, dedupKey ? { dedupKey } : undefined);

            await aiJobInsert({
                userId: req.session.userId,
                jobId: queued.jobId,
                kind: "portfolio_summary",
                status: "queued",
                reservedCredits: reserved,
                payload: {
                    hash,
                    portfolio_payload: payload
                }
            });

            const wallet = await getWallet(req.session.userId);
            return res.status(202).json(aiQueueAcceptedBody({
                jobId: queued.jobId,
                type: "portfolio_summary",
                wallet,
                message: "Portfolio summary queued. Poll /api/ai/jobs/:jobId"
            }));
        }

        const contentRaw = await aiChatCompletion({
            model: "gpt-4o-mini",
            temperature: 0.25,
            max_tokens: 1200,
            messages: [
                { role: "system", content: SYSTEM },
                { role: "user", content: USER }
            ],
            dedupKey
        });
        if (!contentRaw) throw new Error("EMPTY");
        const content = aiEnsureUsefulPortfolio(contentRaw, payload);

        await db.query(
            `insert into portfolio_summaries(user_id, hash, content)
       values($1,$2,$3)
       on conflict (user_id, hash) do update set content=excluded.content`,
            [req.session.userId, hash, content]
        );

        const wallet = await getWallet(req.session.userId);
        return res.json({ mode: "credit", content, wallet });
    } catch (e) {
        if (reserved) {
            try { await refundCredits(req.session.userId, reserved); }
            catch (refundErr) { console.error("PORTFOLIO_REFUND_FAILED:", refundErr); }
        }
        if (String(e.message) === "NO_CREDITS" || e?.code === "NO_CREDITS") {
            return res.status(402).json({ error: "NO_CREDITS", action: { type: "BUY_CREDITS", suggested: "Value" } });
        }
        return sendAiError(res, e);
    }
});

function optimizerCost(mode) {
    if (mode === "quick") return 8;
    if (mode === "deep") return 15;
    return 10;
}

function evalGoal(goal, result) {
    const key = String(goal?.metric || "");
    const op = String(goal?.op || "");
    const target = toNum(goal?.value, NaN);

    const val = metricValue(result, key);
    if (!Number.isFinite(val) || !Number.isFinite(target)) {
        return { ok: false, distance: Infinity, val };
    }

    const dist = (() => {
        if (op === ">=") return target - val;      // <=0 means ok
        if (op === ">") return (target + 1e-9) - val;
        if (op === "<=") return val - target;
        if (op === "<") return val - (target - 1e-9);
        return Infinity;
    })();

    const ok = dist <= 0;
    return { ok, distance: dist, val };
}

function objectiveMetricByType(type) {
    if (type === "mortgage") return { key: "monthlyPayment", better: "min" };
    if (type === "cash_flow") return { key: "stressCashFlow", better: "max" };
    if (type === "property_irr") return { key: "realIRR", better: "max" };
    if (type === "property_taxes") return { key: "finalProfitPV", better: "max" };
    return primaryMetricByType(type);
}

function optimizerMetricCatalogByType(type) {
    const map = {
        mortgage: [
            { key: "monthlyPayment", better: "min" },
            { key: "totalInterest", better: "min" },
            { key: "totalPayment", better: "min" }
        ],
        cash_flow: [
            { key: "stressCashFlow", better: "max" },
            { key: "realCashFlowMonth", better: "max" },
            { key: "cashFlowMonth", better: "max" }
        ],
        property_irr: [
            { key: "realIRR", better: "max" },
            { key: "irr", better: "max" },
            { key: "paybackYears", better: "min" }
        ],
        property_taxes: [
            { key: "finalProfitPV", better: "max" },
            { key: "realROI", better: "max" },
            { key: "totalTaxes", better: "min" }
        ],
        break_even: [
            { key: "breakEvenRent", better: "min" },
            { key: "breakEvenPrice", better: "min" }
        ],
        rent_vs_buy: [
            { key: "buyNetCost", better: "min" },
            { key: "rentTotal", better: "min" },
            { key: "mortgagePaid", better: "min" }
        ],
        ownership_cost: [
            { key: "totalOwnershipCostPV", better: "min" },
            { key: "totalOwnershipCost", better: "min" },
            { key: "costAsPercentOfPrice", better: "min" }
        ],
        property_sale: [
            { key: "netProfit", better: "max" },
            { key: "realReturn", better: "max" },
            { key: "annualReturn", better: "max" }
        ],
        renovation_roi: [
            { key: "netProfitPV", better: "max" },
            { key: "roiPV", better: "max" },
            { key: "payback", better: "min" }
        ],
        alternative_investment: [
            { key: "difference", better: "max" },
            { key: "alternativeRealReturnPercent", better: "max" },
            { key: "alternativeValue", better: "max" }
        ],
        mortgage_overpayment: [
            { key: "realOverpayment", better: "min" },
            { key: "nominalOverpayment", better: "min" },
            { key: "monthlyPayment", better: "min" }
        ]
    };
    return map[String(type || "")] || [];
}

function resolveOptimizerObjective(type, goal) {
    const fallback = objectiveMetricByType(type);
    const key = String(goal?.metric || "");
    const byType = optimizerMetricCatalogByType(type);
    const matched = byType.find((x) => x.key === key);

    const op = String(goal?.op || "");
    const opBetter = (op === "<=" || op === "<") ? "min" : ((op === ">=" || op === ">") ? "max" : null);

    if (matched) return { key: matched.key, better: opBetter || matched.better || fallback.better };
    return fallback;
}

function optimizerLevers(type, baseInput) {
    const fieldPresetByType = {
        mortgage: ["price", "ratePercent", "down", "termYears"],
        cash_flow: ["rent", "expenses", "mortgage", "vacancy", "taxes"],
        property_irr: ["price", "rent", "expenses", "growth", "saleTax"],
        break_even: ["marketRent", "expenses", "taxes", "mortgage", "vacancy"],
        rent_vs_buy: ["years", "mortgageRate", "propertyGrowth", "rentGrowth", "rent", "mortgage"],
        renovation_roi: ["renovationCost", "priceIncrease", "rentIncrease", "agentFee", "saleTax"],
        property_sale: ["sellPrice", "commission", "tax", "renovation", "years"],
        property_taxes: ["propertyTax", "rentTax", "annualFees", "feeGrowth", "agentFee", "saleTax", "priceGrowth", "inflationRate"],
        ownership_cost: ["taxPercent", "maintenance", "inflation", "years"],
        alternative_investment: ["altReturn", "altContribution", "altTaxRate", "propertyGrowth", "propertyCashflow", "propertyTaxRate"],
        mortgage_overpayment: ["rate", "years", "inflation", "loan"]
    };

    const fields = fieldPresetByType[type] || compareLeversByType(type, baseInput);
    const levers = [];

    for (let idx = 0; idx < fields.length; idx++) {
        const field = fields[idx];
        const rng = leverRange(field, baseInput);
        if (!rng || !Number.isFinite(rng.lo) || !Number.isFinite(rng.hi) || rng.hi <= rng.lo) continue;

        const weight = Math.max(0.35, 1.25 - idx * 0.12);
        const steps = idx < 2 ? 11 : (idx < 5 ? 9 : 7);
        levers.push({ field, lo: rng.lo, hi: rng.hi, steps, weight });
    }

    return levers;
}

function sampleValues(lever, baseInput) {
    const { lo, hi, steps } = lever;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo || steps <= 1) return [];
    const out = [];
    for (let i = 0; i < steps; i++) {
        const t = i / (steps - 1);
        const raw = lo + (hi - lo) * t;
        const v = normalizeLeverValueForField(lever.field, raw, baseInput);
        if (!Number.isFinite(v)) continue;
        out.push(v);
    }
    return Array.from(new Set(out));
}

function pickNegotiation(baseInput, candInput, type) {
    const out = [];
    const fields = compareLeversByType(type, baseInput);
    for (const f of fields) {
        if (!(f in baseInput) || !(f in candInput)) continue;
        const a = toNum(baseInput[f], NaN);
        const b = toNum(candInput[f], NaN);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
        const rel = pctChange(a, b);
        const relAbs = Number.isFinite(rel) ? Math.abs(rel) : 0;
        const absDiff = Math.abs(b - a);
        // Ignore tiny numeric jitter so recommendations don't look random.
        if (relAbs < 0.001 && absDiff < 1) continue;
        const dir = b > a ? "increase" : "decrease";
        out.push({ field: f, from: a, to: b, dir, rel });
    }
    out.sort((x, y) => Math.abs(toNum(y.rel, 0)) - Math.abs(toNum(x.rel, 0)));
    return out.slice(0, 6);
}

function optimizerStrategyMetaFromNegotiation(negotiation = []) {
    const rows = Array.isArray(negotiation) ? negotiation : [];
    if (!rows.length) {
        return {
            dominant_field: null,
            dominant_dir: null,
            strategy_key: "_none_",
            changed_fields: 0,
            max_rel_change: 0,
            max_rel_change_pct: 0,
            feasibility: "high",
            note: "No material input changes required."
        };
    }

    const rels = rows
        .map((x) => Math.abs(toNum(x?.rel, NaN)))
        .filter((x) => Number.isFinite(x));
    const maxRel = rels.length ? Math.max(...rels) : 0;
    let feasibility = "high";
    if (maxRel > 0.22) feasibility = "low";
    else if (maxRel > 0.10) feasibility = "medium";

    const dominant = rows[0];
    const domField = String(dominant?.field || "").trim() || null;
    const dir = String(dominant?.dir || "").toLowerCase() === "increase" ? "increase" : "decrease";
    const fieldLabel = aiHumanizeField(domField || "primary lever");
    const pctTxt = `${aiFmtNum(maxRel * 100, 1)}%`;
    const strategyKey = `${domField || "_none_"}:${dir}`;

    return {
        dominant_field: domField,
        dominant_dir: dir,
        strategy_key: strategyKey,
        changed_fields: rows.length,
        max_rel_change: maxRel,
        max_rel_change_pct: round2(maxRel * 100),
        feasibility,
        note: `${fieldLabel}: ${dir} around ${pctTxt} from base.`
    };
}

function selectOptimizerCandidates(candidatePool, baseInput, type, goal, mode, count = 3, directionHints = {}) {
    const src = Array.isArray(candidatePool) ? candidatePool : [];
    const unique = [];
    const seen = new Set();
    const ctx = {
        type,
        goalMetric: goal?.metric,
        directionHints: optimizerNormalizeDirectionHints(directionHints)
    };

    for (const c of src) {
        if (!c?.input || !c?.result) continue;
        const hash = JSON.stringify(c.input);
        if (seen.has(hash)) continue;
        seen.add(hash);

        const rawNegotiation = pickNegotiation(baseInput, c.input, type);
        const filteredNegotiation = optimizerNegotiationRowsForOutput(rawNegotiation, ctx);
        const negotiation = filteredNegotiation.length ? filteredNegotiation : rawNegotiation;
        const strategy = optimizerStrategyMetaFromNegotiation(negotiation);
        unique.push({
            ...c,
            _hash: hash,
            _idx: unique.length,
            hasChanges: rawNegotiation.length > 0,
            rawNegotiation,
            negotiation,
            strategy,
            dominantKey: String(strategy?.strategy_key || "_none_:none")
        });
    }

    const profile = optimizerModeSelectionProfile(mode);
    const desired = Math.max(1, Math.trunc(Number(count) || 3));
    const minDistinctDominant = Math.max(1, Math.min(desired, Number(profile?.minDistinctDominant || 1)));
    const maxPerDominant = Math.max(1, Number(profile?.maxPerDominant || desired));
    const chosen = [];
    const chosenHash = new Set();
    const usedDominant = new Set();
    const countByDominant = new Map();
    const usedNovelty = new Set();

    const sorted = [...unique].sort((a, b) => {
        const aOk = !!a?.goal?.ok ? 1 : 0;
        const bOk = !!b?.goal?.ok ? 1 : 0;
        if (aOk !== bOk) return bOk - aOk;

        const aDist = toNum(a?.goal?.distance, Infinity);
        const bDist = toNum(b?.goal?.distance, Infinity);
        const aDistScore = Number.isFinite(aDist) ? Math.abs(aDist) : Infinity;
        const bDistScore = Number.isFinite(bDist) ? Math.abs(bDist) : Infinity;
        const aCost = toNum(a?.rank?.cost, Infinity);
        const bCost = toNum(b?.rank?.cost, Infinity);
        if (aCost !== bCost) return aCost - bCost;

        // When both already hit goal, prioritize practicality (cost) before closeness to boundary.
        if (!aOk && aDistScore !== bDistScore) return aDistScore - bDistScore;

        const better = String(a?.obj?.better || b?.obj?.better || "min");
        const aObj = toNum(a?.obj?.val, NaN);
        const bObj = toNum(b?.obj?.val, NaN);
        if (Number.isFinite(aObj) && Number.isFinite(bObj) && aObj !== bObj) {
            return better === "min" ? aObj - bObj : bObj - aObj;
        }
        if (aDistScore !== bDistScore) return aDistScore - bDistScore;
        return Number(a?._idx || 0) - Number(b?._idx || 0);
    });

    const noveltyKeyOf = (c) => {
        const dom = String(c?.dominantKey || "_none_");
        const relBin = Math.round(toNum(c?.strategy?.max_rel_change_pct, 0) / 2);
        const changed = Number(c?.strategy?.changed_fields || 0);
        return `${dom}|r${relBin}|c${changed}`;
    };

    const addCandidate = (c, opts = {}) => {
        if (!c || chosen.length >= desired) return false;
        if (chosenHash.has(c._hash)) return false;

        const force = !!opts.force;
        const requireDistinctDominant = !!opts.requireDistinctDominant;
        if (!force) {
            if (requireDistinctDominant && usedDominant.has(c.dominantKey)) return false;
            const domCount = Number(countByDominant.get(c.dominantKey) || 0);
            if (domCount >= maxPerDominant) return false;
            const novelty = noveltyKeyOf(c);
            if (usedNovelty.has(novelty) && !opts.allowSameNovelty) return false;
        }

        chosen.push(c);
        chosenHash.add(c._hash);
        usedDominant.add(c.dominantKey);
        countByDominant.set(c.dominantKey, Number(countByDominant.get(c.dominantKey) || 0) + 1);
        usedNovelty.add(noveltyKeyOf(c));
        return true;
    };

    // 1) Anchor: strongest achieved candidate with real changes.
    addCandidate(sorted.find((c) => !!c?.goal?.ok && c.hasChanges), { force: true });
    if (!chosen.length) addCandidate(sorted.find((c) => c.hasChanges), { force: true });
    if (!chosen.length) addCandidate(sorted[0], { force: true });

    // 2) Diversity pass: prefer achieved candidates with distinct dominant lever.
    for (const c of sorted) {
        if (chosen.length >= desired) break;
        if (usedDominant.size >= minDistinctDominant) break;
        if (!c.hasChanges || !c?.goal?.ok) continue;
        addCandidate(c, { requireDistinctDominant: true });
    }

    // 3) If still not diverse enough, allow near-miss candidates for strategy variety.
    if (profile.allowNearMissForDiversity && usedDominant.size < minDistinctDominant) {
        for (const c of sorted) {
            if (chosen.length >= desired) break;
            if (usedDominant.size >= minDistinctDominant) break;
            if (!c.hasChanges) continue;
            addCandidate(c, { requireDistinctDominant: true });
        }
    }

    // 4) Fill with best achieved candidates (still respecting caps and novelty).
    for (const c of sorted) {
        if (chosen.length >= desired) break;
        if (!c?.goal?.ok || !c.hasChanges) continue;
        addCandidate(c);
    }

    // 5) Fill with best remaining changed candidates.
    for (const c of sorted) {
        if (chosen.length >= desired) break;
        if (!c.hasChanges) continue;
        addCandidate(c);
    }

    // 6) Final fill: relax novelty cap first, then all constraints except dedupe.
    for (const c of sorted) {
        if (chosen.length >= desired) break;
        addCandidate(c, { allowSameNovelty: true });
    }
    for (const c of sorted) {
        if (chosen.length >= desired) break;
        addCandidate(c, { force: true });
    }

    return chosen.slice(0, desired);
}

function optimizerCounterproductivePenalty({ type, goal, baseInput, candInput, directionHints = null }) {
    const hints = optimizerNormalizeDirectionHints(directionHints);
    const fields = Array.from(new Set([
        ...compareLeversByType(type, baseInput),
        ...Object.keys(hints)
    ]));
    if (!fields.length) return 0;

    const indexByField = new Map();
    fields.forEach((f, idx) => indexByField.set(String(f), idx));
    let penalty = 0;

    for (const [field, direction] of Object.entries(hints)) {
        const a = toNum(baseInput?.[field], NaN);
        const b = toNum(candInput?.[field], NaN);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;

        const delta = b - a;
        const relAbs = Math.abs(delta / Math.max(Math.abs(a), 1));
        if (relAbs < 0.002) continue;

        const isCounter = (direction === "down" && delta > 0) || (direction === "up" && delta < 0);
        if (!isCounter) continue;

        const idx = Number(indexByField.get(String(field)));
        const priorityWeight = Number.isFinite(idx)
            ? Math.max(0.8, 1.9 - idx * 0.12)
            : 1;
        const kindWeight = aiIsPercentField(field)
            ? 1.2
            : (aiIsMoneyField(field) ? 1.1 : 1);
        penalty += priorityWeight * kindWeight * (0.9 + relAbs * 3.4);
    }

    return penalty;
}

function candidateRank({ type, goal, baseInput, candInput, goalEval, objVal, objBetter, leverWeights, directionHints }) {
    // 1) goal ok first
    // 2) минимальная “цена изменений”
    // 3) лучше objective
    let cost = 0;
    for (const lv of leverWeights) {
        const f = lv.field;
        if (!(f in baseInput) || !(f in candInput)) continue;
        const a = toNum(baseInput[f], NaN);
        const b = toNum(candInput[f], NaN);
        if (!Number.isFinite(a) || a === 0 || !Number.isFinite(b)) continue;
        cost += (lv.weight || 1.0) * Math.abs((b - a) / a);
    }
    cost += optimizerCounterproductivePenalty({ type, goal, baseInput, candInput, directionHints });

    const objScore = Number.isFinite(objVal) ? objVal : (objBetter === "min" ? Infinity : -Infinity);

    return { ok: !!goalEval.ok, cost, objScore };
}

function betterCandidate(a, b, objBetter) {
    if (a.ok !== b.ok) return a.ok; // ok wins
    if (a.cost !== b.cost) return a.cost < b.cost;
    return objBetter === "min" ? a.objScore < b.objScore : a.objScore > b.objScore;
}

function optimizerSearch(type, baseInput, goal, mode) {
    const levers = optimizerLevers(type, baseInput);
    const { key: objKey, better: objBetter } = resolveOptimizerObjective(type, goal);
    const directionHints = optimizerDirectionHints(type, goal, baseInput, null);

    const budget = mode === "deep" ? 2600 : (mode === "quick" ? 650 : 1200);

    const valuesByLever = levers.map(lv => ({ ...lv, values: sampleValues(lv, baseInput) }));
    const candidates = [];

    function evalInput(input) {
        const res = computeResultByType(type, input);
        if (!res) return null;

        const g = evalGoal(goal, res);
        const objVal = metricValue(res, objKey);

        const rank = candidateRank({
            type,
            goal,
            baseInput,
            candInput: input,
            goalEval: g,
            objVal,
            objBetter,
            leverWeights: levers,
            directionHints
        });

        return { input, result: res, goal: g, obj: { key: objKey, val: objVal, better: objBetter }, rank };
    }

    // Always evaluate base (for “not achievable” messaging)
    const baseEval = evalInput({ ...baseInput });

    // 1D sweeps
    for (const lv of valuesByLever) {
        for (const v of lv.values) {
            const input = { ...baseInput, [lv.field]: v };
            const e = evalInput(input);
            if (e) candidates.push(e);
        }
    }

    // 2D grid on top 2 “important” levers
    const top = [...valuesByLever].sort((a, b) => (b.weight || 1) - (a.weight || 1)).slice(0, 2);
    if (top.length === 2) {
        for (const v1 of top[0].values.slice(0, 7)) {
            for (const v2 of top[1].values.slice(0, 7)) {
                const input = { ...baseInput, [top[0].field]: v1, [top[1].field]: v2 };
                const e = evalInput(input);
                if (e) candidates.push(e);
            }
        }
    }

    // random sampling for remaining budget
    function randBetween(a, b) { return a + Math.random() * (b - a); }
    let used = candidates.length;
    while (used < budget) {
        let input = { ...baseInput };
        for (const lv of valuesByLever) {
            if (Math.random() < 0.55 && Number.isFinite(lv.lo) && Number.isFinite(lv.hi) && lv.hi > lv.lo) {
                const v = normalizeLeverValueForField(lv.field, randBetween(lv.lo, lv.hi), baseInput);
                if (Number.isFinite(v)) input[lv.field] = v;
            }
        }
        const e = evalInput(input);
        if (e) candidates.push(e);
        used++;
    }

    // Dedupe candidates by input to avoid noisy near-clones.
    const seen = new Set();
    const deduped = [];
    for (const c of candidates) {
        const h = JSON.stringify(c?.input || {});
        if (seen.has(h)) continue;
        seen.add(h);
        deduped.push(c);
    }

    // choose best satisfying candidates
    deduped.sort((x, y) => {
        const a = x.rank, b = y.rank;
        if (a.ok !== b.ok) return a.ok ? -1 : 1;
        if (a.cost !== b.cost) return a.cost - b.cost;
        return objBetter === "min" ? (a.objScore - b.objScore) : (b.objScore - a.objScore);
    });

    const bestOk = deduped.filter(c => c.rank.ok).slice(0, 3);
    const bestNear = deduped.filter(c => !c.rank.ok).slice(0, 3);

    return { baseEval, bestOk, bestNear, levers, objKey, objBetter, ranked: deduped, directionHints };
}

app.post("/api/optimizer/run", rl.byUser({ limit: 60, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);

    const calculationId = Number(req.body?.calculationId);
    const rawGoal = req.body?.goal || null;
    const mode = String(req.body?.mode || "standard"); // quick | standard | deep
    const force = !!req.body?.force;

    const goalMetric = String(rawGoal?.metric || "").trim();
    const goalOp = String(rawGoal?.op || "").trim();
    const goalValue = toNum(rawGoal?.value, NaN);
    if (!calculationId || !goalMetric || !goalOp || !Number.isFinite(goalValue)) {
        return res.status(400).json({ error: "BAD_INPUT" });
    }
    if (!["<=", ">=", "<", ">"].includes(goalOp)) {
        return res.status(400).json({ error: "BAD_GOAL_OPERATOR" });
    }

    const cost = optimizerCost(mode);

    const cr = await db.query(
        `select id, calculator_type, input_data, result_data
     from calculations
     where id=$1 and user_id=$2`,
        [calculationId, req.session.userId]
    );
    if (!cr.rowCount) return res.status(404).json({ error: "CALC_NOT_FOUND" });

    let base = cr.rows[0];
    const normalizedBase = await normalizeCalcResultData(base, req.session.userId);
    base = normalizedBase.calc;
    const calcResultWasStale = normalizedBase.stale;
    const type = String(base.calculator_type);
    const allowedMetrics = optimizerMetricCatalogByType(type);
    if (allowedMetrics.length && !allowedMetrics.some((x) => x.key === goalMetric)) {
        return res.status(400).json({
            error: "BAD_GOAL_METRIC",
            allowed: allowedMetrics.map((x) => x.key)
        });
    }

    const goal = { metric: goalMetric, op: goalOp, value: goalValue };

    const optimizerEngineVersion = 8;
    const hash = hashJson({ calculationId, goal, mode, optimizerEngineVersion });
    let dedupKey = force ? "" : `optimizer:${req.session.userId}:${hash}`;
    const wantsAsync = asyncProcessingEnabled() && !toBool(req.body?.sync);
    if (wantsAsync && dedupKey) {
        const predictedJobId = aiJobIdFromDedupKey(dedupKey);
        if (predictedJobId) {
            const existing = await aiJobGet(req.session.userId, predictedJobId);
            if (existing && existing.status !== "failed" && existing.status !== "done") {
                const wallet = await getWallet(req.session.userId);
                return res.status(202).json(aiQueueAcceptedBody({
                    jobId: predictedJobId,
                    type: "optimizer",
                    wallet,
                    message: "Optimizer queued. Poll /api/ai/jobs/:jobId"
                }));
            }
            if (existing?.status === "done") {
                dedupKey = "";
            }
        }
    }

    const w0 = await getWallet(req.session.userId);
    if ((w0.credits || 0) < cost) {
        return res.status(402).json({ error: "NO_CREDITS", action: { type: "BUY_CREDITS", suggested: "OptimizerPack" } });
    }

    if (!force && !calcResultWasStale) {
        const cached = await db.query(
            `select content, candidates, created_at
             from optimizer_runs
             where user_id=$1 and hash=$2
             limit 1`,
            [req.session.userId, hash]
        );
        if (cached.rowCount && !isCacheOlderThanCalc(base, cached.rows[0].created_at)) {
            const wallet = await getWallet(req.session.userId);
            return res.json({
                mode: "cached",
                content: cached.rows[0].content,
                candidates: cached.rows[0].candidates,
                wallet
            });
        }
    }

    // deterministic search
    const search = optimizerSearch(type, base.input_data, goal, mode);
    const hasGoalMetricInSearch = [search.baseEval, ...(search.ranked || [])]
        .some((c) => Number.isFinite(metricValue(c?.result || {}, goal.metric)));
    if (!hasGoalMetricInSearch) {
        return res.status(400).json({ error: "GOAL_METRIC_NOT_AVAILABLE" });
    }

    const candidatePool = [];
    candidatePool.push(...search.bestOk, ...search.bestNear, ...(search.ranked || []));
    if (search.baseEval) candidatePool.push(search.baseEval);

    const directionHints = optimizerNormalizeDirectionHints(search?.directionHints);
    const topCandidates = selectOptimizerCandidates(candidatePool, base.input_data, type, goal, mode, 3, directionHints);

    const candidates = topCandidates.map((c) => {
        const rawNegotiation = Array.isArray(c?.rawNegotiation)
            ? c.rawNegotiation
            : pickNegotiation(base.input_data, c.input, type);
        const negotiation = Array.isArray(c?.negotiation) && c.negotiation.length
            ? c.negotiation
            : optimizerNegotiationRowsForOutput(rawNegotiation, { type, goalMetric: goal.metric, directionHints });
        const strategy = c?.strategy || optimizerStrategyMetaFromNegotiation(negotiation);
        return {
            input_data: c.input,
            result_data: c.result,
            goal: c.goal,
            objective: c.obj,
            negotiation,
            strategy
        };
    }).slice(0, 3);

    const achieved = search.bestOk.length > 0;
    const selectionProfile = optimizerModeSelectionProfile(mode);
    const dominantLevers = Array.from(new Set(
        candidates
            .map((c) => String(c?.strategy?.dominant_field || "").trim())
            .filter(Boolean)
    ));

    const payload = {
        calculator_type: type,
        optimizer_engine_version: optimizerEngineVersion,
        mode,
        cost,
        goal,
        achieved,
        base: {
            input_data: base.input_data,
            result_data: base.result_data,
            mini_verdict: miniVerdictUniversal(base),
            derived_metrics: buildDerivedMetrics(base)
        },
        direction_hints: directionHints,
        candidates,
        selection: {
            requested: 3,
            returned: candidates.length,
            dominant_levers: dominantLevers,
            diversity_score: dominantLevers.length,
            target_distinct_dominant: Number(selectionProfile?.minDistinctDominant || 1),
            diversity_ok: dominantLevers.length >= Number(selectionProfile?.minDistinctDominant || 1),
            deep_diversity_target: mode === "deep"
                ? "Prefer distinct dominant levers across options when feasible."
                : "Best rank with realistic adjustments."
        }
    };
    const promptPayload = buildOptimizerPromptPayload(payload);

    const SYSTEM = `
You are PropertyCost "Optimizer".
Rules:
- Do not invent numbers: use only payload.
- Prefer formatted values from fields ending with Fmt.
- Never output placeholder labels like "field:".
- Must produce exactly 3 configurations even if goal is not achieved (then show closest).
- Every configuration must include: Strategy, Trade-off, Must negotiate, Feasibility.
- In each "Must negotiate" block list all bullet lines from candidate.must_negotiate_bullets when provided.
- Feasibility line in each option must follow candidate.strategy.feasibility_line.
- Trade-off line should follow candidate.tradeoff_hint.
- Include per-option goal status using candidate.goal_ok (Achieved / Closest above target).
- For deep mode: maximize diversity of dominant levers across 3 options using payload.candidates[].strategy.
- In "Feasibility / realism", use payload.selection.diversity_ok and payload.selection.target_distinct_dominant when explaining diversity constraints.
- "Feasibility / realism" bullets must align with payload.feasibility_reality_bullets.
- Recommended next action must follow payload.next_action_hint with range and step when step exists.
`.trim();

    const USER = `
Language: English. 700–950 tokens.

Output EXACTLY:

Goal:
- <metric op value>
Status:
- <Achieved / Not achieved (closest found)>

Top 3 configurations:
1) <title + 2-3 key numbers + why it works>
   - Goal status: <Achieved or Closest above target>
   - Strategy: <dominant lever + direction + approx change from base>
   - Trade-off: <use candidate.tradeoff_hint>
   Must negotiate:
   - <list all concrete bullets from payload candidate.must_negotiate_bullets if present>
   - <use candidate.strategy.feasibility_line exactly>
2) ...
3) ...

Main driver:
- <2-3 bullets>

Risks / checks:
- <3 bullets>

Feasibility / realism:
- <follow payload.feasibility_reality_bullets with same option ordering and conclusions>

Recommended next action:
- <use payload.next_action_hint.bullet exactly>

Payload JSON:
${JSON.stringify(promptPayload)}
`.trim();

    let reserved = 0;
    try {
        await reserveCreditsOrThrow(req.session.userId, cost);
        reserved = cost;

        if (wantsAsync) {
            const queued = await enqueueOpenAiChat({
                model: "gpt-4o-mini",
                temperature: 0.25,
                max_tokens: 1400,
                messages: [
                    { role: "system", content: SYSTEM },
                    { role: "user", content: USER }
                ]
            }, dedupKey ? { dedupKey } : undefined);

            await aiJobInsert({
                userId: req.session.userId,
                jobId: queued.jobId,
                kind: "optimizer",
                status: "queued",
                reservedCredits: reserved,
                payload: {
                    hash,
                    calculationId,
                    goal,
                    mode,
                    candidates,
                    optimizer_payload: payload
                }
            });

            const wallet = await getWallet(req.session.userId);
            return res.status(202).json(aiQueueAcceptedBody({
                jobId: queued.jobId,
                type: "optimizer",
                wallet,
                message: "Optimizer queued. Poll /api/ai/jobs/:jobId"
            }));
        }

        const contentRaw = await aiChatCompletion({
            model: "gpt-4o-mini",
            temperature: 0.25,
            max_tokens: 1400,
            messages: [
                { role: "system", content: SYSTEM },
                { role: "user", content: USER }
            ],
            dedupKey
        });
        if (!contentRaw) throw new Error("EMPTY");
        const content = aiEnsureUsefulOptimizer(contentRaw, payload);

        await db.query(
            `insert into optimizer_runs(user_id, hash, calculation_id, goal, mode, candidates, content)
       values($1,$2,$3,$4,$5,$6,$7)
       on conflict (user_id, hash) do update
       set candidates=excluded.candidates, content=excluded.content`,
            [req.session.userId, hash, calculationId, goal, mode, JSON.stringify(candidates), content]
        );

        const wallet = await getWallet(req.session.userId);
        return res.json({ mode: "credit", content, candidates, wallet });
    } catch (e) {
        if (reserved) {
            try { await refundCredits(req.session.userId, reserved); }
            catch (refundErr) { console.error("OPTIMIZER_REFUND_FAILED:", refundErr); }
        }
        if (String(e.message) === "NO_CREDITS" || e?.code === "NO_CREDITS") {
            return res.status(402).json({ error: "NO_CREDITS", action: { type: "BUY_CREDITS", suggested: "OptimizerPack" } });
        }
        return sendAiError(res, e);
    }
});



function pdfSectionTitle(doc, text) {
    doc.moveDown(0.6);
    doc.fontSize(13).fillColor("#0f172a").text(text, { underline: true });
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor("#111827");
}

function pdfPlainText(input, options = {}) {
    const multiline = !!options.multiline;
    let out = String(input ?? "");
    out = stripEmojiVS(out)
        .replace(/✅/g, "[OK]")
        .replace(/⚠/g, "[!]")
        .replace(/❌/g, "[X]")
        .replace(/ℹ/g, "[i]")
        .replace(/[“”]/g, "\"")
        .replace(/[‘’]/g, "'")
        .replace(/[−–—]/g, "-")
        .replace(/→/g, "->")
        .replace(/…/g, "...")
        .replace(/\u00A0/g, " ");

    if (multiline) {
        out = out
            .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        return out;
    }

    out = out
        .replace(/[^\x20-\x7E]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return out;
}

function pdfVerdictToken(miniLike) {
    const level = String(miniLike?.level || "").toLowerCase();
    if (level === "good") return "[OK]";
    if (level === "warn") return "[!]";
    if (level === "bad") return "[X]";

    const icon = normalizeVerdictIcon(miniLike?.icon);
    if (icon === "✅") return "[OK]";
    if (icon === "⚠️") return "[!]";
    if (icon === "❌") return "[X]";
    if (icon === "ℹ️") return "[i]";
    return "[i]";
}

function pdfCleanMiniCandidate(raw) {
    let out = pdfPlainText(raw || "");
    out = out
        .replace(/^\[(OK|!|X|i)\]\s*/i, "")
        .replace(/^Verdict:\s*/i, "")
        .replace(/^[`"'.,:;|\\/\-\s]+/, "")
        .replace(/[`"'\s]+$/, "")
        .replace(/\s+/g, " ")
        .trim();
    // avoid lone punctuation like "'" in headers
    if (/^[^A-Za-z0-9]+$/.test(out)) return "";
    return out;
}

function pdfMiniText(miniLike) {
    const candidates = [
        miniLike?.text,
        miniLike?.title,
        miniLike?.subtitle
    ];
    for (const c of candidates) {
        const clean = pdfCleanMiniCandidate(c);
        if (clean) return clean;
    }
    const level = String(miniLike?.level || "").toLowerCase();
    if (level === "good") return "Result looks favorable for these terms.";
    if (level === "warn") return "Result is mixed and needs caution.";
    if (level === "bad") return "Result looks unfavorable under current assumptions.";
    return "";
}

function pdfScenarioVerdictSnippet(text) {
    const rawMulti = pdfPlainText(String(text || ""), { multiline: true });
    if (!rawMulti) return "";

    const verdictLine = rawMulti.match(/^\s*Verdict:\s*(.+)$/im);
    let best = verdictLine?.[1] || rawMulti.split("\n").map((x) => x.trim()).find(Boolean) || "";
    best = pdfCleanMiniCandidate(best);

    // If the first extracted line is too weak, keep a short safe fallback from the body.
    if (!best || best.length < 8) {
        const oneLine = pdfPlainText(rawMulti.replace(/\s+/g, " "));
        best = pdfCleanMiniCandidate(oneLine);
    }
    return best;
}

function pdfHumanizeKey(key) {
    const s = String(key || "")
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim();
    if (!s) return "Field";
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function pdfHasValue(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v === "string") return pdfPlainText(v).length > 0;
    if (Array.isArray(v)) return v.some(pdfHasValue);
    if (typeof v === "object") {
        return Object.keys(v).some((k) => pdfHasValue(v[k]));
    }
    return true;
}

function pdfFormatInline(v) {
    if (!pdfHasValue(v)) return "";
    if (typeof v === "number") {
        const abs = Math.abs(v);
        const opts = abs >= 1000
            ? { maximumFractionDigits: 0 }
            : { maximumFractionDigits: 2 };
        return v.toLocaleString(undefined, opts);
    }
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (typeof v === "string") return pdfPlainText(v);
    if (Array.isArray(v)) {
        return v.filter(pdfHasValue).map(pdfFormatInline).join(", ");
    }
    if (typeof v === "object") {
        const pairs = Object.entries(v)
            .filter(([, x]) => pdfHasValue(x))
            .slice(0, 6)
            .map(([k, x]) => `${pdfHumanizeKey(k)}: ${pdfFormatInline(x)}`);
        const extra = Object.keys(v).filter((k) => pdfHasValue(v[k])).length - pairs.length;
        return extra > 0 ? `${pairs.join("; ")}; +${extra} more` : pairs.join("; ");
    }
    return String(v);
}

function pdfKeyVals(doc, obj, keys, labelMap = {}, options = {}) {
    const o = (obj && typeof obj === "object") ? obj : {};
    const list = (Array.isArray(keys) && keys.length) ? keys : Object.keys(o);
    const maxItems = Number.isFinite(options?.maxItems) ? Math.max(1, Number(options.maxItems)) : 24;
    const childLimit = Number.isFinite(options?.childLimit) ? Math.max(1, Number(options.childLimit)) : 8;
    const visibleKeys = list.filter((k) => Object.prototype.hasOwnProperty.call(o, k) && pdfHasValue(o[k]));

    let printed = 0;
    for (const k of visibleKeys) {
        if (printed >= maxItems) break;
        const v = o[k];

        const label = labelMap[k] || pdfHumanizeKey(k);
        if (Array.isArray(v)) {
            const rows = v.filter(pdfHasValue);
            doc.font("Helvetica-Bold").text(`${label}:`);
            rows.slice(0, childLimit).forEach((item) => {
                doc.font("Helvetica").text(`  - ${pdfFormatInline(item)}`);
            });
            if (rows.length > childLimit) {
                doc.font("Helvetica").text(`  - ... +${rows.length - childLimit} more`);
            }
        } else if (typeof v === "object") {
            const innerKeys = Object.keys(v).filter((inner) => pdfHasValue(v[inner]));
            doc.font("Helvetica-Bold").text(`${label}:`);
            innerKeys.slice(0, childLimit).forEach((inner) => {
                doc
                    .font("Helvetica")
                    .text(`  - ${pdfHumanizeKey(inner)}: ${pdfFormatInline(v[inner])}`);
            });
            if (innerKeys.length > childLimit) {
                doc.font("Helvetica").text(`  - ... +${innerKeys.length - childLimit} more fields`);
            }
        } else {
            doc.font("Helvetica-Bold").text(`${label}: `, { continued: true });
            doc.font("Helvetica").text(pdfFormatInline(v));
        }
        printed++;
    }

    if (!printed) {
        doc.font("Helvetica").fillColor("#64748b").text("No data available.");
        doc.fillColor("#111827");
    }

    if (visibleKeys.length > maxItems) {
        doc.font("Helvetica").fillColor("#64748b").text(`... +${visibleKeys.length - maxItems} more fields`);
        doc.fillColor("#111827");
    }
}

function buildPdfHighlights(calc, derived, mini) {
    const type = String(calc?.calculator_type || "");
    const pm = primaryMetricByType(type);
    const metricKey = String(pm?.key || "");
    const metricVal = metricValue(calc?.result_data || {}, metricKey);

    const primaryMetric = (metricKey && Number.isFinite(metricVal))
        ? `${pdfHumanizeKey(metricKey)}: ${pdfFormatInline(metricVal)} (${pm?.better === "min" ? "lower is better" : "higher is better"})`
        : null;

    const metrics = (derived?.metrics && typeof derived.metrics === "object") ? derived.metrics : {};
    const secondary = Object.entries(metrics).find(([k, v]) => k !== metricKey && pdfHasValue(v));
    const secondaryMetric = secondary
        ? `${pdfHumanizeKey(secondary[0])}: ${pdfFormatInline(secondary[1])}`
        : null;

    const contextLine = pdfMiniText(mini) || pdfPlainText(mini?.subtitle || "") || null;
    const missingChecklist = Array.isArray(derived?.missingChecklist) ? derived.missingChecklist : [];

    return { primaryMetric, secondaryMetric, contextLine, missingChecklist };
}

function collectPdfBuffer(buildFn) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: "A4", margin: 48 });
        const chunks = [];
        doc.on("data", d => chunks.push(d));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);
        buildFn(doc);
        doc.end();
    });
}

app.post("/api/report/pdf", rl.byUser({ limit: 50, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);

    const calculationId = Number(req.body?.calculationId);
    if (!calculationId) return res.status(400).json({ error: "BAD_INPUT" });

    const bodyTimeZone = normalizeTimeZone(req.body?.timeZone);
    const cookieTimeZone = normalizeTimeZone(getCookie(req, "tz"));
    const userTimeZone = bodyTimeZone || cookieTimeZone || "";
    const userLocale = String(req.body?.locale || "").trim();

    // pre-check credits
    const w0 = await getWallet(req.session.userId);
    if ((w0.credits || 0) < 1) return res.status(402).json(noCreditsPayload("Basic"));

    const cr = await db.query(
        `select id, calculator_type, input_data, result_data, created_at
     from calculations
     where id=$1 and user_id=$2`,
        [calculationId, req.session.userId]
    );
    if (!cr.rowCount) return res.status(404).json({ error: "CALC_NOT_FOUND" });

    let calc = cr.rows[0];
    const normalized = await normalizeCalcResultData(calc, req.session.userId);
    calc = normalized.calc;
    const calcResultWasStale = normalized.stale;

    const pr = await db.query(
        `select seq, total
         from (
           select id,
                  row_number() over (order by created_at asc, id asc)::int as seq,
                  count(*) over()::int as total
           from calculations
           where user_id=$1
         ) q
         where id=$2
         limit 1`,
        [req.session.userId, calc.id]
    );
    const userCalcSeq = pr.rowCount ? Number(pr.rows[0].seq || 0) : 0;
    const userCalcTotal = pr.rowCount ? Number(pr.rows[0].total || 0) : 0;

    const ar = await db.query(
        `select content, created_at
         from verdicts
         where user_id=$1 and calculation_id=$2
         order by created_at desc
         limit 1`,
        [req.session.userId, calculationId]
    );
    let analysis = ar.rowCount ? String(ar.rows[0].content || "") : "";
    if (ar.rowCount && isCacheOlderThanCalc(calc, ar.rows[0].created_at)) {
        analysis = "";
    }

    const sr = await db.query(
        `select items, created_at
         from scenario_analyses
         where user_id=$1 and calculation_id=$2
         order by created_at desc
         limit 1`,
        [req.session.userId, calculationId]
    );
    let scenarios = sr.rowCount ? (sr.rows[0].items || []) : [];
    if (sr.rowCount && isCacheOlderThanCalc(calc, sr.rows[0].created_at)) {
        scenarios = [];
    }

    // Avoid mixing old AI cache text with newly canonicalized math.
    if (calcResultWasStale) {
        analysis = "";
        scenarios = [];
    }

    const mini = miniVerdictUniversal(calc);
    const derived = buildDerivedMetrics(calc);

    let reserved = 0;
    try {
        await reserveCreditsOrThrow(req.session.userId, 1);
        reserved = 1;

        const pdf = await collectPdfBuffer((doc) => {
            const highlights = buildPdfHighlights(calc, derived, mini);
            const calcType = pdfHumanizeKey(calc.calculator_type);
            const verdictToken = pdfVerdictToken(mini);
            const verdictTitle = pdfMiniText(mini);
            const createdAtText =
                formatDateTimeForPdf(calc.created_at, userTimeZone, userLocale) ||
                formatDateTimeForPdf(calc.created_at, "", userLocale) ||
                formatDateTimeForPdf(calc.created_at, "");
            const generatedAtText =
                formatDateTimeForPdf(new Date(), userTimeZone, userLocale) ||
                formatDateTimeForPdf(new Date(), "", userLocale) ||
                formatDateTimeForPdf(new Date(), "");
            const counterLabel = userCalcSeq > 0
                ? `Your calculation #${userCalcSeq}${userCalcTotal > 0 ? ` of ${userCalcTotal}` : ""}`
                : "Your calculation";
            const tzLabel = userTimeZone ? ` (${userTimeZone})` : "";

            doc.font("Helvetica-Bold").fontSize(18).fillColor("#0f172a").text("PropertyCost Report", { align: "left" });
            doc.font("Helvetica").fontSize(10).fillColor("#334155")
                .text(`${counterLabel} • ${calcType} • ${createdAtText}${tzLabel}`);
            doc.fontSize(9).text(`Generated: ${generatedAtText}${tzLabel}`);
            doc.moveDown(0.5);

            doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827")
                .text(`Verdict: ${verdictToken}${verdictTitle ? ` ${verdictTitle}` : ""}`);
            const subtitle = pdfPlainText(mini.subtitle || "");
            if (subtitle) {
                doc.font("Helvetica").fontSize(10).fillColor("#334155").text(subtitle);
            }
            doc.moveDown(0.4);

            pdfSectionTitle(doc, "Key highlights");
            pdfKeyVals(doc, highlights, ["primaryMetric", "secondaryMetric", "contextLine", "missingChecklist"], {
                primaryMetric: "Primary metric",
                secondaryMetric: "Secondary metric",
                contextLine: "Context",
                missingChecklist: "Checklist to verify"
            }, { childLimit: 6 });

            pdfSectionTitle(doc, "Inputs");
            const inputObj = (calc.input_data && typeof calc.input_data === "object") ? calc.input_data : {};
            pdfKeyVals(doc, inputObj, Object.keys(inputObj), {}, { maxItems: 40, childLimit: 6 });

            pdfSectionTitle(doc, "Results");
            const resultObj = (calc.result_data && typeof calc.result_data === "object") ? calc.result_data : {};
            pdfKeyVals(doc, resultObj, Object.keys(resultObj), {}, { maxItems: 40, childLimit: 6 });

            if (analysis) {
                const cleanAnalysis = pdfPlainText(String(analysis)
                    .replace(/\r\n/g, "\n")
                    .replace(/\t/g, " ")
                    .replace(/\bundefined\b/gi, "N/A")
                    .trim(), { multiline: true });
                if (cleanAnalysis) {
                    pdfSectionTitle(doc, "Full verdict");
                    doc.font("Helvetica").fontSize(9).fillColor("#111827").text(cleanAnalysis.slice(0, 6000));
                }
            }

            if (scenarios.length) {
                pdfSectionTitle(doc, "Top scenarios");
                const top = scenarios.slice(0, 6);
                top.forEach((s, i) => {
                    const label = pdfPlainText(String(s?.label || `Scenario ${i + 1}`)) || `Scenario ${i + 1}`;
                    doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a").text(`${i + 1}. ${label}`);

                    const sv = (s?.mini_verdict && typeof s.mini_verdict === "object") ? s.mini_verdict : {};
                    const svToken = pdfVerdictToken(sv);
                    const svTitle = pdfMiniText(sv);
                    const svLine = `${svToken}${svTitle ? ` ${svTitle}` : ""}`.trim();
                    if (svLine) {
                        doc.font("Helvetica").fontSize(9).fillColor("#111827").text(svLine);
                    }

                    const shortVerdict = pdfScenarioVerdictSnippet(s?.verdict_text);
                    if (shortVerdict) {
                        const clipped = shortVerdict.length > 280 ? `${shortVerdict.slice(0, 280)}...` : shortVerdict;
                        doc.font("Helvetica").fontSize(8).fillColor("#334155").text(clipped);
                    }

                    doc.font("Helvetica-Bold").fontSize(9).fillColor("#111827").text("Changed inputs:");
                    const sInput = (s?.input_data && typeof s.input_data === "object") ? s.input_data : {};
                    pdfKeyVals(doc, sInput, Object.keys(sInput), {}, { maxItems: 6, childLimit: 4 });

                    doc.font("Helvetica-Bold").fontSize(9).fillColor("#111827").text("Key results:");
                    const sResult = (s?.result_data && typeof s.result_data === "object") ? s.result_data : {};
                    pdfKeyVals(doc, sResult, Object.keys(sResult), {}, { maxItems: 6, childLimit: 4 });
                    doc.moveDown(0.35);
                });

                if (scenarios.length > top.length) {
                    doc.font("Helvetica").fontSize(8).fillColor("#64748b")
                        .text(`... ${scenarios.length - top.length} more scenarios were omitted from the PDF.`);
                }
            }

            doc.moveDown(0.6);
            doc.font("Helvetica").fontSize(8).fillColor("#475569").text("Generated by PropertyCost.");
        });

        const typeSlug = String(calc.calculator_type || "calculation")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "") || "calculation";
        const fileCounter = userCalcSeq > 0 ? String(userCalcSeq) : "calc";
        const fileName = `propertycost_report_${typeSlug}_${fileCounter}.pdf`;

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.status(200).send(pdf);
    } catch (e) {
        if (reserved) {
            try { await refundCredits(req.session.userId, reserved); }
            catch (refundErr) { console.error("PDF_REFUND_FAILED:", refundErr); }
        }
        if (String(e.message) === "NO_CREDITS" || e?.code === "NO_CREDITS") {
            return res.status(402).json(noCreditsPayload("Basic"));
        }
        return res.status(502).json({ error: "PDF_FAILED", message: String(e.message || e) });
    }
});



app.get("/api/calculations/item", rl.byUser({ limit: 240, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);
    const calculationId = Number(req.query?.calculationId || req.query?.id);
    if (!Number.isFinite(calculationId) || calculationId <= 0) {
        return res.status(400).json({ error: "BAD_INPUT" });
    }

    const c = await db.query(
        `select id, calculator_type, created_at, input_data, result_data
         from calculations
         where id=$1 and user_id=$2
         limit 1`,
        [calculationId, req.session.userId]
    );
    if (!c.rowCount) return res.status(404).json({ error: "NOT_FOUND" });

    const normalized = await normalizeCalcResultData(c.rows[0], req.session.userId);
    return res.json({ ok: true, calc: normalized.calc, stale: normalized.stale });
});

app.get("/api/calculations/list", rl.byUser({ limit: 120, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);
    const userId = req.session.userId;

    const limit = Math.min(50, Math.max(5, Number(req.query?.limit || 20)));

    // Подстрой под свои колонки:
    // - table: calculations
    // - поля: id, calculator_type, created_at, result_data (optional)
    const rr = await db.query(
        `select id, calculator_type, created_at, result_data
     from calculations
     where user_id=$1
     order by created_at desc
     limit $2`,
        [userId, limit]
    );

    const items = rr.rows.map(r => {
        const id = Number(r.id);
        const type = String(r.calculator_type || "deal");
        const createdAt = r.created_at;

        // делаем короткий title, без сложной логики:
        let title = `#${id} · ${type}`;
        try {
            const derived = r.result_data?.derived || r.result_data?.metrics || null;
            if (derived?.monthlyPayment != null) title += ` · $${Math.round(Number(derived.monthlyPayment))}/mo`;
            if (derived?.realIRR != null) title += ` · IRR ${Math.round(Number(derived.realIRR) * 1000) / 10}%`;
        } catch { }

        return { id, type, createdAt };
    });

    res.json({ items });
});

app.get("/api/account/wallet", rl.byUser({ limit: 180, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);
    const wallet = await getWallet(req.session.userId);
    res.set("Cache-Control", "no-store");
    return res.json({ wallet });
});

app.get("/api/optimizer/cached", rl.byUser({ limit: 120, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);

    const calculationId = Number(req.query?.calculationId);
    if (!calculationId) return res.status(400).json({ error: "BAD_INPUT" });

    try {
        const c = await db.query(
            `select id, calculator_type, input_data, result_data
             from calculations
             where id=$1 and user_id=$2
             limit 1`,
            [calculationId, req.session.userId]
        );
        if (!c.rowCount) return res.json({ ok: true, has: false });
        const normalized = await normalizeCalcResultData(c.rows[0], req.session.userId);

        const r = await db.query(
            `select content, candidates, goal, mode, created_at
       from optimizer_runs
       where user_id=$1 and calculation_id=$2
       order by created_at desc
       limit 1`,
            [req.session.userId, calculationId]
        );

        if (!r.rowCount) return res.json({ ok: true, has: false });
        const stale = !!(
            normalized.stale ||
            isCacheOlderThanCalc(normalized.calc, r.rows[0].created_at)
        );

        return res.json({
            ok: true,
            has: true,
            content: r.rows[0].content,
            candidates: r.rows[0].candidates,
            goal: r.rows[0].goal,
            mode: r.rows[0].mode,
            createdAt: r.rows[0].created_at,
            stale
        });
    } catch (e) {
        console.error("OPTIMIZER_CACHED_FAILED:", e);
        return res.status(500).json({ error: "FAILED" });
    }
});

app.get("/api/deals/compare/cached", rl.byUser({ limit: 120, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);

    const calculationId = Number(req.query?.calculationId);
    if (!calculationId) return res.status(400).json({ error: "BAD_INPUT" });

    try {
        const c = await db.query(
            `select id, calculator_type, input_data, result_data
             from calculations
             where id=$1 and user_id=$2
             limit 1`,
            [calculationId, req.session.userId]
        );
        if (!c.rowCount) return res.json({ ok: true, has: false });
        const normalized = await normalizeCalcResultData(c.rows[0], req.session.userId);

        const r = await db.query(
            `select content, a_id, b_id, created_at
       from deal_comparisons
       where user_id=$1 and (a_id=$2 or b_id=$2)
       order by created_at desc
       limit 1`,
            [req.session.userId, calculationId]
        );

        if (!r.rowCount) return res.json({ ok: true, has: false });
        let stale = !!(
            normalized.stale ||
            isCacheOlderThanCalc(normalized.calc, r.rows[0].created_at)
        );

        const aId = Number(r.rows[0].a_id || 0);
        const bId = Number(r.rows[0].b_id || 0);
        if (aId > 0 && bId > 0) {
            const pair = await db.query(
                `select id, calculator_type, input_data, result_data
                 from calculations
                 where user_id=$1 and id = any($2::bigint[])`,
                [req.session.userId, [aId, bId]]
            );
            if (pair.rowCount !== 2) return res.json({ ok: true, has: false });
            const p1 = await normalizeCalcResultData(pair.rows[0], req.session.userId);
            const p2 = await normalizeCalcResultData(pair.rows[1], req.session.userId);
            stale = stale || p1.stale || p2.stale;
            stale = stale ||
                isCacheOlderThanCalc(p1.calc, r.rows[0].created_at) ||
                isCacheOlderThanCalc(p2.calc, r.rows[0].created_at);
        }

        return res.json({
            ok: true,
            has: true,
            content: r.rows[0].content,
            aId: Number(r.rows[0].a_id),
            bId: Number(r.rows[0].b_id),
            createdAt: r.rows[0].created_at,
            stale
        });
    } catch (e) {
        console.error("COMPARE_CACHED_FAILED:", e);
        return res.status(500).json({ error: "FAILED" });
    }
});



app.get("/api/scenarios/cached", rl.byUser({ limit: 120, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);

    const calculationId = Number(req.query?.calculationId);
    if (!calculationId) return res.status(400).json({ error: "BAD_INPUT" });

    try {
        const c = await db.query(
            `select id, calculator_type, input_data, result_data
             from calculations
             where id=$1 and user_id=$2
             limit 1`,
            [calculationId, req.session.userId]
        );
        if (!c.rowCount) return res.json({ ok: true, has: false });
        const normalized = await normalizeCalcResultData(c.rows[0], req.session.userId);

        const r = await db.query(
            `select requested_count, generated_count, items, created_at
       from scenario_analyses
       where user_id=$1 and calculation_id=$2
       order by created_at desc
       limit 1`,
            [req.session.userId, calculationId]
        );

        if (!r.rowCount) return res.json({ ok: true, has: false });
        const stale = !!(
            normalized.stale ||
            isCacheOlderThanCalc(normalized.calc, r.rows[0].created_at)
        );

        return res.json({
            ok: true,
            has: true,
            requestedCount: Number(r.rows[0].requested_count),
            generatedCount: Number(r.rows[0].generated_count),
            items: r.rows[0].items,
            createdAt: r.rows[0].created_at,
            stale
        });
    } catch (e) {
        console.error("SCENARIO_CACHED_FAILED:", e);
        return res.status(500).json({ error: "FAILED" });
    }
});

app.get("/api/scenarios/deep_dive/cached", rl.byUser({ limit: 120, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);

    const calculationId = Number(req.query?.calculationId);
    if (!calculationId) return res.status(400).json({ error: "BAD_INPUT" });

    try {
        const c = await db.query(
            `select id, calculator_type, input_data, result_data
             from calculations
             where id=$1 and user_id=$2
             limit 1`,
            [calculationId, req.session.userId]
        );
        if (!c.rowCount) return res.json({ ok: true, has: false, count: 0, items: [] });
        const normalized = await normalizeCalcResultData(c.rows[0], req.session.userId);
        let stale = !!normalized.stale;

        const sr = await db.query(
            `select items, created_at
       from scenario_analyses
       where user_id=$1 and calculation_id=$2
       order by created_at desc
       limit 1`,
            [req.session.userId, calculationId]
        );
        if (!sr.rowCount) return res.json({ ok: true, has: false, count: 0, items: [] });
        stale = stale || isCacheOlderThanCalc(normalized.calc, sr.rows[0].created_at);

        const scenarios = Array.isArray(sr.rows[0].items) ? sr.rows[0].items : [];
        if (!scenarios.length) return res.json({ ok: true, has: false, count: 0, items: [] });

        const dr = await db.query(
            `select scenario_hash, content, created_at
       from scenario_deep_dives
       where user_id=$1 and calculation_id=$2
       order by created_at desc
       limit 100`,
            [req.session.userId, calculationId]
        );
        if (!dr.rowCount) return res.json({ ok: true, has: false, count: 0, items: [] });

        const byHash = new Map();
        for (const row of dr.rows) {
            const h = String(row.scenario_hash || "");
            if (!h || byHash.has(h)) continue;
            stale = stale || isCacheOlderThanCalc(normalized.calc, row.created_at);
            byHash.set(h, { content: row.content, createdAt: row.created_at });
        }

        const out = [];
        scenarios.forEach((it, idx) => {
            const h = hashScenario(it);
            const cached = byHash.get(h);
            if (!cached) return;
            out.push({
                idx,
                content: cached.content,
                createdAt: cached.createdAt
            });
        });

        return res.json({ ok: true, has: out.length > 0, count: out.length, items: out, stale });
    } catch (e) {
        console.error("SCENARIO_DEEP_CACHED_FAILED:", e);
        return res.status(500).json({ error: "FAILED" });
    }
});

app.post("/api/scenarios/analyze", rl.byUser({ limit: 60, windowSec: 400 }), async (req, res) => { 
    if (!req.session?.userId) return res.sendStatus(401);

    const calculationId = Number(req.body?.calculationId);
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : null;

    if (!calculationId || !rawItems?.length) {
        return res.status(400).json({ error: "BAD_INPUT" });
    }

    const requestedRaw = Number(req.body?.requestedCount);
    const requestedCount = [3, 5, 10].includes(requestedRaw)
        ? requestedRaw
        : Math.max(1, Math.min(10, Number.isFinite(requestedRaw) ? Math.trunc(requestedRaw) : rawItems.length));
    const items = rawItems.slice(0, requestedCount);
    const cost = scenarioCost(items.length);

    const cr = await db.query(
        `SELECT id, calculator_type, input_data, result_data
     FROM calculations
     WHERE id=$1 AND user_id=$2`,
        [calculationId, req.session.userId]
    );
    if (!cr.rowCount) return res.status(404).json({ error: "NOT_FOUND" });

    const normalizedBase = await normalizeCalcResultData(cr.rows[0], req.session.userId);
    const baseCalc = normalizedBase.calc;

    let reserved = 0;

    let out;
    try {
        const baseline_input_data = baseCalc?.input_data || null;
        const baseline_result = baseCalc?.result_data || null;

        function deltasByType(type, baseR, curR) {
            const b = baseR || {};
            const c = curR || {};
            const num = (v) => (v === null || v === undefined) ? null : Number(v);
            const safe = (v) => (Number.isFinite(v) ? v : null);

            const d = (field) => {
                const bv = safe(num(b[field]));
                const cv = safe(num(c[field]));
                return (bv !== null && cv !== null) ? (cv - bv) : null;
            };

            if (type === "mortgage") return { monthlyPayment: d("monthlyPayment"), totalPayment: d("totalPayment"), totalInterest: d("totalInterest") };
            if (type === "ownership_cost") return { totalOwnershipCostPV: d("totalOwnershipCostPV") ?? d("totalCostPV"), totalOwnershipCost: d("totalOwnershipCost") ?? d("totalCost"), costAsPercentOfPrice: d("costAsPercentOfPrice") };
            if (type === "rent_vs_buy") {
                const baseGap = (safe(num(b.rentTotal)) !== null && safe(num(b.buyNetCost)) !== null) ? (safe(num(b.rentTotal)) - safe(num(b.buyNetCost))) : null;
                const curGap = (safe(num(c.rentTotal)) !== null && safe(num(c.buyNetCost)) !== null) ? (safe(num(c.rentTotal)) - safe(num(c.buyNetCost))) : null;
                const gapDelta = (baseGap !== null && curGap !== null) ? (curGap - baseGap) : null;
                return { rentTotal: d("rentTotal"), buyNetCost: d("buyNetCost"), rentMinusBuyNet: gapDelta };
            }
            if (type === "break_even") return { breakEvenRent: d("breakEvenRent"), breakEvenPrice: d("breakEvenPrice") };
            if (type === "cash_flow") return { cashFlowMonth: d("cashFlowMonth"), realCashFlowMonth: d("realCashFlowMonth"), stressCashFlow: d("stressCashFlow") };
            if (type === "property_irr") return { irr: d("irr"), realIRR: d("realIRR"), roi: d("roi") };
            if (type === "renovation_roi") return { netProfitPV: d("netProfitPV"), roiPV: d("roiPV"), payback: d("payback") };
            if (type === "property_sale") return { netProfit: d("netProfit"), realReturn: d("realReturn"), annualReturn: d("annualReturn") };
            if (type === "property_taxes") return { finalProfitPV: d("finalProfitPV"), realROI: d("realROI"), taxBurdenPercent: d("taxBurdenPercent") };
            if (type === "alternative_investment") return { alternativeValue: d("alternativeValue"), propertyValue: d("propertyValue"), alternativeRealReturnPercent: d("alternativeRealReturnPercent"), propertyRealReturnPercent: d("propertyRealReturnPercent"), difference: d("difference") };
            if (type === "mortgage_overpayment") return { realOverpayment: d("realOverpayment"), nominalOverpayment: d("nominalOverpayment"), monthlyPayment: d("monthlyPayment") };
            return {};
        }

        function fmtDelta(v) {
            const n = Number(v);
            if (!Number.isFinite(n)) return "n/a";
            return `${n > 0 ? "+" : ""}${Math.round(n * 100) / 100}`;
        }

        function buildScenarioTag(type, deltas) {
            const d = deltas || {};
            if (type === "mortgage") {
                const dm = Number(d.monthlyPayment ?? 0);
                const dt = Number(d.totalPayment ?? 0);
                if (dm < 0 && dt > 0) return "Trade-off: monthly relief vs higher total cost";
                if (dm < 0 && dt < 0) return "Win-win: monthly and total cost down";
                if (dm > 0 && dt < 0) return "Trade-off: higher monthly vs lower total cost";
                if (dm > 0 && dt > 0) return "Worse: monthly and total cost up";
            }
            if (type === "rent_vs_buy") {
                const db = Number(d.buyNetCost ?? NaN);
                const dd = Number(d.rentMinusBuyNet ?? NaN);
                if (Number.isFinite(dd) && dd > 0) return "Buy advantage improved";
                if (Number.isFinite(dd) && dd < 0) return "Rent advantage improved";
                if (Number.isFinite(db) && db < 0) return "Buy cost down vs baseline";
                if (Number.isFinite(db) && db > 0) return "Buy cost up vs baseline";
            }
            if (type === "break_even") {
                const dr = Number(d.breakEvenRent ?? NaN);
                if (Number.isFinite(dr) && dr < 0) return "Break-even easier (required rent down)";
                if (Number.isFinite(dr) && dr > 0) return "Break-even harder (required rent up)";
            }
            if (type === "cash_flow") {
                const s = Number(d.stressCashFlow ?? 0);
                const rcf = Number(d.realCashFlowMonth ?? NaN);
                if (s < 0) return "Stress failed / fragility up";
                if (Number.isFinite(rcf) && rcf > 0) return "Resilience up (real cash flow improved)";
                return "Stability improving";
            }
            if (type === "property_irr") {
                const r = Number(d.realIRR ?? NaN);
                if (Number.isFinite(r) && r > 0) return "Real return quality up";
                if (Number.isFinite(r) && r < 0) return "Real return quality down";
            }
            if (type === "renovation_roi") {
                const n = Number(d.netProfitPV ?? NaN);
                if (Number.isFinite(n) && n > 0) return "PV value creation improved";
                if (Number.isFinite(n) && n < 0) return "PV value creation worsened";
            }
            if (type === "property_sale") {
                const r = Number(d.realReturn ?? NaN);
                if (Number.isFinite(r) && r > 0) return "Real exit return improved";
                if (Number.isFinite(r) && r < 0) return "Real exit return worsened";
            }
            if (type === "property_taxes") {
                const p = Number(d.finalProfitPV ?? NaN);
                const r = Number(d.realROI ?? NaN);
                if ((Number.isFinite(p) && p > 0) || (Number.isFinite(r) && r > 0)) return "Tax drag reduced / real outcome improved";
                if ((Number.isFinite(p) && p < 0) || (Number.isFinite(r) && r < 0)) return "Tax drag increased / real outcome worsened";
            }
            if (type === "ownership_cost") {
                const p = Number(d.totalOwnershipCostPV ?? NaN);
                if (Number.isFinite(p) && p < 0) return "Ownership cost efficiency improved";
                if (Number.isFinite(p) && p > 0) return "Ownership cost drag increased";
            }
            if (type === "alternative_investment") {
                const ar = Number(d.alternativeRealReturnPercent ?? NaN);
                const pr = Number(d.propertyRealReturnPercent ?? NaN);
                const av = Number(d.alternativeValue ?? NaN);
                const pv = Number(d.propertyValue ?? NaN);
                if ((Number.isFinite(ar) && Number.isFinite(pr) && ar > pr) || (Number.isFinite(av) && Number.isFinite(pv) && av > pv)) return "Alternative outcome improved";
                if ((Number.isFinite(ar) && Number.isFinite(pr) && ar < pr) || (Number.isFinite(av) && Number.isFinite(pv) && av < pv)) return "Alternative outcome worsened";
            }
            if (type === "mortgage_overpayment") {
                const r = Number(d.realOverpayment ?? NaN);
                if (Number.isFinite(r) && r < 0) return "Real overpayment reduced";
                if (Number.isFinite(r) && r > 0) return "Real overpayment increased";
            }
            return "Scenario impact vs baseline";
        }

        function pickMainDriver(calcType, input_changes, deltas) {
            const priorityByType = {
                mortgage: ["monthlyPayment", "totalPayment", "totalInterest"],
                rent_vs_buy: ["rentMinusBuyNet", "buyNetCost", "rentTotal"],
                break_even: ["breakEvenRent", "breakEvenPrice"],
                cash_flow: ["stressCashFlow", "realCashFlowMonth", "cashFlowMonth"],
                property_irr: ["realIRR", "irr", "roi"],
                renovation_roi: ["netProfitPV", "roiPV", "payback"],
                property_sale: ["realReturn", "netProfit", "annualReturn"],
                property_taxes: ["finalProfitPV", "realROI", "taxBurdenPercent"],
                ownership_cost: ["totalOwnershipCostPV", "totalOwnershipCost", "costAsPercentOfPrice"],
                alternative_investment: ["alternativeRealReturnPercent", "alternativeValue", "difference"],
                mortgage_overpayment: ["realOverpayment", "nominalOverpayment", "monthlyPayment"]
            };

            const d = deltas || {};
            const order = priorityByType[String(calcType || "")] || Object.keys(d);
            for (const k of order) {
                const v = Number(d[k]);
                if (Number.isFinite(v) && Math.abs(v) > 0) return `${k}: ${fmtDelta(v)} vs baseline`;
            }

            const ch = Array.isArray(input_changes) ? input_changes : [];
            if (ch.length) {
                const ranked = ch
                    .map(x => {
                        const a = Number(x.from);
                        const b = Number(x.to);
                        const rel = (Number.isFinite(a) && Number.isFinite(b))
                            ? Math.abs((b - a) / (Math.abs(a) + 1))
                            : 0;
                        return { ...x, rel };
                    })
                    .sort((a, b) => b.rel - a.rel);
                const top = ranked[0];
                return `${top.field}: ${top.from} -> ${top.to}`;
            }

            return "No dominant driver (low-impact scenario)";
        }

        const prepared = items.map((it, idx) => {
            const inputData = it?.input_data;
            let resultData = null;

            if (inputData && typeof inputData === "object") {
                resultData = computeResultByType(baseCalc.calculator_type, inputData);
            }
            if (!resultData && it?.result_data && typeof it.result_data === "object") {
                resultData = it.result_data;
            }

            if (!resultData || typeof resultData !== "object") {
                return { idx, scenarioBaseItem: { ...it, input_data: inputData }, error: "MISSING_RESULT_DATA" };
            }

            const scenarioBaseItem = {
                ...it,
                input_data: inputData,
                result_data: resultData
            };

            const fakeCalc = {
                calculator_type: baseCalc.calculator_type,
                input_data: inputData,
                result_data: resultData
            };

            const derived_metrics = buildDerivedMetrics(fakeCalc);
            const mini_verdict = miniVerdictUniversal(fakeCalc);
            const isInvestment = hasRentOrIncomeFromInput(inputData);
            const deltas = deltasByType(baseCalc.calculator_type, baseline_result, resultData);
            const input_changes = diffInputData(baseline_input_data, inputData, 6);
            const scenario_tag = buildScenarioTag(baseCalc.calculator_type, deltas);
            const main_driver = pickMainDriver(baseCalc.calculator_type, input_changes, deltas);

            const payload = {
                calculator_type: baseCalc.calculator_type,
                input_data: inputData,
                baseline_input_data,
                input_changes,
                result_data: resultData,
                derived_metrics,
                mini_verdict,
                scenario_label: String(it?.label || `Scenario ${idx + 1}`),
                baseline_result,
                deltas_vs_baseline: deltas,
                context: { isInvestment },
                scenario_tag,
                main_driver
            };

            return { idx, scenarioBaseItem, payload };
        });

        const validPrepared = prepared.filter((x) => !x.error && x.payload);

        const wantsAsync = asyncProcessingEnabled() && !toBool(req.body?.sync);
        if (wantsAsync && validPrepared.length) {
            const batchReq = buildScenarioBatchChatRequest(validPrepared.map((x) => x.payload));
            if (!batchReq) throw new Error("SCENARIO_BATCH_PREPARE_FAILED");

            const dedupKey = `scenarios:${req.session.userId}:${calculationId}:${cost}:${batchReq.dedupKey}`;
            const predictedJobId = aiJobIdFromDedupKey(dedupKey);
            if (!predictedJobId) throw new Error("SCENARIO_JOB_ID_FAILED");

            const existing = await aiJobGet(req.session.userId, predictedJobId);
            if (existing?.status === "done" && existing?.result) {
                return res.json(existing.result);
            }
            if (existing && existing.status !== "failed") {
                const wallet = await getWallet(req.session.userId);
                return res.status(202).json(aiQueueAcceptedBody({
                    jobId: predictedJobId,
                    type: "scenarios_analyze",
                    wallet,
                    message: "Scenario analysis queued. Poll /api/ai/jobs/:jobId"
                }));
            }

            const pendingPayload = {
                calculationId,
                calculator_type: baseCalc.calculator_type,
                requestedCount: items.length,
                cost,
                prepared
            };

            const claimed = await aiJobInsertIfAbsent({
                userId: req.session.userId,
                jobId: predictedJobId,
                kind: "scenarios_analyze",
                status: "preparing",
                payload: pendingPayload,
                reservedCredits: 0
            });

            let ownsJob = claimed;
            if (!ownsJob) {
                const latest = await aiJobGet(req.session.userId, predictedJobId);
                if (latest?.status === "done" && latest?.result) {
                    return res.json(latest.result);
                }
                if (latest && latest.status !== "failed") {
                    const wallet = await getWallet(req.session.userId);
                    return res.status(202).json(aiQueueAcceptedBody({
                        jobId: predictedJobId,
                        type: "scenarios_analyze",
                        wallet,
                        message: "Scenario analysis queued. Poll /api/ai/jobs/:jobId"
                    }));
                }
                if (latest?.status === "failed") {
                    const revived = await aiJobTryTransition(req.session.userId, predictedJobId, ["failed"], "preparing");
                    if (revived) {
                        await aiJobUpdate(req.session.userId, predictedJobId, {
                            payload: pendingPayload,
                            error: null,
                            reserved_credits: 0
                        });
                        ownsJob = true;
                    } else {
                        const wallet = await getWallet(req.session.userId);
                        return res.status(202).json(aiQueueAcceptedBody({
                            jobId: predictedJobId,
                            type: "scenarios_analyze",
                            wallet,
                            message: "Scenario analysis queued. Poll /api/ai/jobs/:jobId"
                        }));
                    }
                }
            }
            if (!ownsJob) {
                const wallet = await getWallet(req.session.userId);
                return res.status(202).json(aiQueueAcceptedBody({
                    jobId: predictedJobId,
                    type: "scenarios_analyze",
                    wallet,
                    message: "Scenario analysis queued. Poll /api/ai/jobs/:jobId"
                }));
            }

            const left = await reserveCredits(req.session.userId, cost);
            if (left === null) {
                await aiJobUpdate(req.session.userId, predictedJobId, {
                    status: "failed",
                    error: "NO_CREDITS",
                    reserved_credits: 0
                });
                return res.status(402).json(noCreditsPayload(suggestedPackByCost(cost)));
            }
            reserved = cost;

            try {
                const queued = await enqueueOpenAiChat({
                    model: "gpt-4o-mini",
                    temperature: 0.2,
                    max_tokens: batchReq.max_tokens,
                    messages: batchReq.messages
                }, { dedupKey });

                await aiJobUpdate(req.session.userId, predictedJobId, {
                    status: "queued",
                    payload: pendingPayload,
                    reserved_credits: reserved,
                    error: null
                });

                const queuedWallet = await getWallet(req.session.userId);
                return res.status(202).json({
                    ok: true,
                    status: "queued",
                    jobId: queued.jobId,
                    type: "scenarios_analyze",
                    message: "Scenario analysis queued. Poll /api/ai/jobs/:jobId",
                    wallet: queuedWallet
                });
            } catch (queueErr) {
                if (reserved) {
                    await refundCredits(req.session.userId, reserved);
                    reserved = 0;
                }
                await aiJobUpdate(req.session.userId, predictedJobId, {
                    status: "failed",
                    error: String(queueErr?.message || queueErr),
                    reserved_credits: 0
                });
                throw queueErr;
            }
        }

        const left = await reserveCredits(req.session.userId, cost);
        if (left === null) return res.status(402).json(noCreditsPayload(suggestedPackByCost(cost)));
        reserved = cost;

        let batchRows = [];
        if (validPrepared.length) {
            try {
                batchRows = await generateScenarioVerdictsBatch(validPrepared.map((x) => x.payload));
            } catch (e) {
                console.error("SCENARIO_BATCH_FAILED:", e);
                batchRows = [];
            }
        }

        out = buildScenarioOutFromBatch(prepared, batchRows);

        const successCount = out.filter(x => x?.verdict_text && !x.error).length;

        // если всё сломалось — вернём деньги (супер “premium fairness”)
        if (successCount === 0) {
            await refundCredits(req.session.userId, reserved);
            reserved = 0;
            return sendAiError(res, new Error("No scenario analyses generated."));
        }
    } catch (e) {
        if (reserved) await refundCredits(req.session.userId, reserved);
        return sendAiError(res, e);
    }

    const wr = await db.query(
        "select free_used, credits from verdict_wallets where user_id=$1",
        [req.session.userId]
    );
    const wallet = wr.rowCount
        ? { free_used: !!wr.rows[0].free_used, credits: Number(wr.rows[0].credits || 0) }
        : { free_used: false, credits: 0 };

    // ✅ SAVE
    try {
        await saveScenarioAnalysisRun(req.session.userId, calculationId, baseCalc.calculator_type, cost, out);
    } catch (e) {
        console.error("SCENARIO_SAVE_FAILED:", e);
    }

    return res.json({
        requestedCount: items.length,
        generatedCount: out.length,
        items: out,
        wallet
    });
});


function hashScenario(it) {
    const s = JSON.stringify({ label: it?.label, input_data: it?.input_data, result_data: it?.result_data });
    return crypto.createHash("sha256").update(s).digest("hex");
}

function hashJson(obj) {
    const s = JSON.stringify(obj || {});
    return crypto.createHash("sha256").update(s).digest("hex");
}

async function getWallet(userId) {
    const wr = await db.query("select free_used, credits from verdict_wallets where user_id=$1", [userId]);
    return wr.rowCount
        ? { free_used: !!wr.rows[0].free_used, credits: Number(wr.rows[0].credits || 0) }
        : { free_used: false, credits: 0 };
}

function toNum(x, fallback = NaN) {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(x, a, b) {
    const n = toNum(x, a);
    return Math.max(a, Math.min(b, n));
}

function pctChange(from, to) {
    const f = toNum(from, NaN);
    const t = toNum(to, NaN);
    if (!Number.isFinite(f) || f === 0 || !Number.isFinite(t)) return null;
    return (t - f) / f;
}

function detectQaLanguage(question) {
    const q = String(question || "");
    if (/[А-Яа-яЁёІіЇїЄє]/.test(q)) return "Russian";
    return "English";
}

function qaAlphaChars(text) {
    return String(text || "").match(/[A-Za-zА-Яа-яЁёІіЇїЄє]/g) || [];
}

function qaTokenize(text) {
    return String(text || "")
        .toLowerCase()
        .split(/[\s,.;:!?()[\]{}"'`~<>@#$%^&*_+=/\\|-]+/g)
        .filter(Boolean);
}

function isLowSignalQaQuestion(question) {
    const q = String(question || "").trim();
    if (!q) return true;

    const alpha = qaAlphaChars(q);
    if (alpha.length < 3) return true;

    const words = qaTokenize(q);
    const meaningfulWords = words.filter((w) => qaAlphaChars(w).length >= 2);
    if (!meaningfulWords.length) return true;

    // Single very short token like "ldlld" / "ok" / "??" is usually low-signal noise.
    if (meaningfulWords.length === 1 && alpha.length < 6) return true;

    const lettersOnly = q.toLowerCase().replace(/[^A-Za-zА-Яа-яЁёІіЇїЄє]/g, "");
    if (lettersOnly.length >= 5 && /^([A-Za-zА-Яа-яЁёІіЇїЄє])\1+$/.test(lettersOnly)) return true;

    const uniqRatio = new Set(alpha.map((c) => c.toLowerCase())).size / alpha.length;
    if (alpha.length >= 7 && uniqRatio < 0.3) return true;

    return false;
}

const QA_SCOPE_NOTICE_RE = /(question seems unrelated|please ask about specific aspects|ask about this calculation|вопрос.*не относится|задайте вопрос.*расчет)/i;

function isScopeNoticeAnswer(answer) {
    return QA_SCOPE_NOTICE_RE.test(String(answer || ""));
}

function buildQaExamples(calculatorType, language = "English") {
    const t = String(calculatorType || "");
    const ru = language === "Russian";

    if (t === "rent_vs_buy") {
        return ru
            ? [
                "Как изменение mortgageRate на 1% повлияет на Buy Net Cost?",
                "Какой один параметр сильнее всего улучшит результат в этом расчете?",
                "Почему здесь winner = buy, а не rent?"
            ]
            : [
                "How would a 1% mortgageRate change impact Buy Net Cost here?",
                "Which single input change gives the biggest improvement in this result?",
                "Why is winner = buy in this calculation?"
            ];
    }

    if (t === "mortgage") {
        return ru
            ? [
                "Что сильнее снизит monthlyPayment в моем расчете: ставка или срок?",
                "Какой trade-off между monthlyPayment и totalInterest у моих данных?",
                "На сколько лет менять termYears, чтобы платеж стал комфортнее?"
            ]
            : [
                "What lowers monthlyPayment more in my case: rate or term?",
                "What is the trade-off between monthlyPayment and totalInterest here?",
                "How many years should I change termYears to improve affordability?"
            ];
    }

    return ru
        ? [
            "Как изменить этот расчет, чтобы улучшить главный показатель?",
            "Какой риск в этом результате самый важный?",
            "Какие 2 параметра лучше проверить следующими и почему?"
        ]
        : [
            "What should I change first to improve the main metric in this calculation?",
            "What is the biggest risk in this specific result?",
            "Which 2 inputs should I test next and why?"
        ];
}

function badQaQuestionPayload(calculatorType, language = "English") {
    const ru = language === "Russian";
    return {
        error: "BAD_QUESTION",
        message: ru
            ? "Похоже, вопрос слишком случайный или не по этому расчету. Спроси про inputs/results/verdict этого кейса."
            : "This question looks too random or not tied to this calculation. Ask about this case's inputs/results/verdict.",
        examples: buildQaExamples(calculatorType, language)
    };
}

function outOfScopeQaPayload(calculatorType, language = "English") {
    const ru = language === "Russian";
    return {
        error: "QUESTION_OUT_OF_SCOPE",
        message: ru
            ? "Вопрос вне контекста этого расчета. Задай вопрос по текущим числам, рискам или параметрам."
            : "The question is outside this calculation context. Ask about current numbers, risks, or input changes.",
        examples: buildQaExamples(calculatorType, language)
    };
}


async function getQaRemaining(userId, calculationId) {
    const pr = await db.query(
        `select remaining
     from verdict_qa_packs
     where user_id=$1 and calculation_id=$2
     order by created_at desc
     limit 1`,
        [userId, calculationId]
    );
    return pr.rowCount ? Number(pr.rows[0].remaining || 0) : 0;
}

async function reserveQaSlot(userId, calculationId) {
    // 1) try reserve one slot from existing pack
    const ur = await db.query(
        `update verdict_qa_packs
     set remaining = remaining - 1
     where id = (
       select id from verdict_qa_packs
       where user_id=$1 and calculation_id=$2 and remaining > 0
       order by created_at desc
       limit 1
     )
     returning id, remaining`,
        [userId, calculationId]
    );
    if (ur.rowCount) {
        return {
            kind: "pack",
            packId: Number(ur.rows[0].id),
            remaining: Number(ur.rows[0].remaining || 0)
        };
    }

    // 2) no pack -> reserve 1 credit now, create pack only after successful AI
    await reserveCreditsOrThrow(userId, 1);
    return { kind: "credit" };
}

async function finalizeQaReservation(userId, calculationId, reservation, queryable = db) {
    if (!reservation || !reservation.kind) throw new Error("BAD_QA_RESERVATION");

    if (reservation.kind === "pack") {
        return { usedCredit: false, remaining: Number(reservation.remaining || 0) };
    }

    if (reservation.kind === "credit") {
        const ir = await queryable.query(
            `insert into verdict_qa_packs(user_id, calculation_id, remaining)
       values ($1,$2,$3)
       returning remaining`,
            [userId, calculationId, 2]
        );
        return { usedCredit: true, remaining: Number(ir.rows[0].remaining || 0) };
    }

    throw new Error("BAD_QA_RESERVATION_KIND");
}

async function persistQaAnswerWithReservation({ userId, calculationId, question, answer, reservation }) {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const pack = await finalizeQaReservation(userId, calculationId, reservation, client);
        await client.query(
            `insert into verdict_questions(user_id, calculation_id, question, answer)
       values ($1,$2,$3,$4)`,
            [userId, calculationId, question, answer]
        );
        await client.query("COMMIT");
        return pack;
    } catch (e) {
        try { await client.query("ROLLBACK"); } catch { }
        throw e;
    } finally {
        client.release();
    }
}

async function rollbackQaReservation(userId, calculationId, reservation) {
    if (!reservation || !reservation.kind) return;

    if (reservation.kind === "pack" && Number.isFinite(reservation.packId)) {
        await db.query(
            `update verdict_qa_packs
       set remaining = remaining + 1
       where id=$1 and user_id=$2 and calculation_id=$3`,
            [reservation.packId, userId, calculationId]
        );
        return;
    }

    if (reservation.kind === "credit") {
        await refundCredits(userId, 1);
    }
}

async function rollbackAiJobReservation(userId, jobRecord) {
    const rec = jobRecord || {};
    const kind = String(rec.kind || "");

    if (kind === "verdict_qa") {
        const payload = (rec.payload && typeof rec.payload === "object")
            ? { ...rec.payload }
            : {};
        const calculationId = Number(payload.calculationId || 0);
        const reservation = payload.reservation || null;

        if (calculationId > 0 && reservation?.kind) {
            await rollbackQaReservation(userId, calculationId, reservation);
        }
        payload.reservation = null;
        return { payload };
    }

    const reserved = Number(rec.reserved_credits || 0);
    if (reserved > 0) {
        await refundCredits(userId, reserved);
    }
    return {};
}

app.get("/api/verdict/qa/history", rl.byUser({ limit: 60, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);
    const calculationId = Number(req.query?.calculationId);
    if (!calculationId) return res.status(400).json({ error: "BAD_INPUT" });

    const rows = await db.query(
        `select question, answer, created_at
     from verdict_questions
     where user_id=$1 and calculation_id=$2
     order by created_at asc
     limit 50`,
        [req.session.userId, calculationId]
    );

    const remaining = await getQaRemaining(req.session.userId, calculationId);
    const wallet = await getWallet(req.session.userId);

    const items = (rows.rows || []).filter((it) => {
        const q = String(it?.question || "");
        const a = String(it?.answer || "");
        if (isLowSignalQaQuestion(q)) return false;
        if (isScopeNoticeAnswer(a)) return false;
        return true;
    });

    res.json({ items, remaining, wallet });
});

app.post("/api/verdict/qa", rl.byUser({ limit: 40, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);

    const calculationId = Number(req.body?.calculationId);
    const question = String(req.body?.question || "").trim();
    const force = !!req.body?.force;

    if (!calculationId || question.length < 3) return res.status(400).json({ error: "BAD_INPUT" });
    if (question.length > 600) return res.status(400).json({ error: "QUESTION_TOO_LONG" });

    // load calc
    const cr = await db.query(
        `select id, calculator_type, input_data, result_data
     from calculations
     where id=$1 and user_id=$2`,
        [calculationId, req.session.userId]
    );
    if (!cr.rowCount) return res.status(404).json({ error: "CALC_NOT_FOUND" });

    const normalized = await normalizeCalcResultData(cr.rows[0], req.session.userId);
    const calc = normalized.calc;
    const answerLanguage = detectQaLanguage(question);

    // Reject random/gibberish questions before any credit/pack reservation.
    if (isLowSignalQaQuestion(question)) {
        const wallet = await getWallet(req.session.userId);
        return res.status(400).json({ ...badQaQuestionPayload(calc.calculator_type, answerLanguage), wallet });
    }

    // last full verdict analysis (optional, if you have verdict_analyses)
    const ar = await db.query(
        `select content
     from verdicts
     where user_id=$1 and calculation_id=$2
     order by created_at desc
     limit 1`,
        [req.session.userId, calculationId]
    );
    const lastAnalysis = ar.rowCount ? String(ar.rows[0].content || "") : "";

    const derived = buildDerivedMetrics(calc);
    const mini = miniVerdictUniversal(calc);

    // Build payload after pre-check; slot/credit reservation happens before AI call.
    const payload = {
        calculator_type: calc.calculator_type,
        input_data: calc.input_data,
        result_data: calc.result_data,
        mini_verdict: mini,
        derived_metrics: derived,
        last_analysis: lastAnalysis ? lastAnalysis.slice(0, 4000) : "",
        question
    };

    const SYSTEM = `
You are PropertyCost "Ask the Analyst".

Primary goal:
- Answer the user's ACTUAL question, using ONLY this calculation context and payload numbers.

Scope policy:
- If question is about this calculation (inputs, outputs, verdict, assumptions, sensitivity, scenarios, compare, optimizer), answer it directly.
- If question is unrelated to this calculation, do NOT improvise. Reply with a short scope notice and 2-3 examples of valid calculation-specific questions.

Quality rules:
- No rigid template or boilerplate sections.
- Start with a direct answer in 1-2 lines.
- Use concrete numbers from payload whenever relevant.
- If user asks what to change, name the exact input field(s) and direction, with numeric target when possible.
- If data is missing for a precise answer, say exactly what is missing.
`.trim();

    const USER = `
Language: ${answerLanguage}. Max 260 tokens.

User question:
${question}

Output style:
- Natural concise answer (not a fixed form).
- Use short bullets only if they improve clarity.
- Do not repeat generic advice that is not tied to this payload.

Payload JSON:
${JSON.stringify(payload)}
`.trim();

    const wantsAsync = asyncProcessingEnabled() && !toBool(req.body?.sync);
    const dedupHash = hashJson({
        calculationId,
        calculator_type: calc.calculator_type,
        question: question.toLowerCase(),
        input_data: calc.input_data,
        result_data: calc.result_data
    }).slice(0, 24);
    const dedupKey = force ? "" : `qa:${req.session.userId}:${calculationId}:${dedupHash}`;

    if (wantsAsync && dedupKey) {
        const predictedJobId = aiJobIdFromDedupKey(dedupKey);
        if (predictedJobId) {
            const existing = await aiJobGet(req.session.userId, predictedJobId);
            if (existing?.status === "done" && existing?.result) {
                return res.json(existing.result);
            }
            if (existing && existing.status !== "failed") {
                const wallet = await getWallet(req.session.userId);
                return res.status(202).json(aiQueueAcceptedBody({
                    jobId: predictedJobId,
                    type: "verdict_qa",
                    wallet,
                    message: "Ask queued. Poll /api/ai/jobs/:jobId"
                }));
            }
        }
    }

    // quick eligibility: pack OR credits
    const remainingBefore = await getQaRemaining(req.session.userId, calculationId);
    const walletBefore = await getWallet(req.session.userId);
    if (remainingBefore <= 0 && (walletBefore.credits || 0) < 1) {
        return res.status(402).json({
            error: "NO_CREDITS",
            action: { type: "BUY_CREDITS", suggested: "Basic" }
        });
    }

    let reservation = null;
    let finalized = false;
    try {
        reservation = await reserveQaSlot(req.session.userId, calculationId);

        if (wantsAsync) {
            const queued = await enqueueOpenAiChat({
                model: "gpt-4o-mini",
                temperature: 0.2,
                max_tokens: 420,
                messages: [
                    { role: "system", content: SYSTEM },
                    { role: "user", content: USER }
                ]
            }, dedupKey ? { dedupKey } : undefined);

            await aiJobInsert({
                userId: req.session.userId,
                jobId: queued.jobId,
                kind: "verdict_qa",
                status: "queued",
                reservedCredits: 0,
                payload: {
                    calculationId,
                    calculator_type: calc.calculator_type,
                    question,
                    answerLanguage,
                    reservation,
                    qa_payload: payload
                }
            });
            finalized = true;

            const wallet = await getWallet(req.session.userId);
            const remainingNow = await getQaRemaining(req.session.userId, calculationId);
            return res.status(202).json({
                ...aiQueueAcceptedBody({
                    jobId: queued.jobId,
                    type: "verdict_qa",
                    wallet,
                    message: "Ask queued. Poll /api/ai/jobs/:jobId"
                }),
                remaining: remainingNow
            });
        }

        const answer = String(await aiChatCompletion({
            model: "gpt-4o-mini",
            temperature: 0.2,
            max_tokens: 420,
            messages: [
                { role: "system", content: SYSTEM },
                { role: "user", content: USER }
            ]
        })).trim();
        if (!answer) throw new Error("EMPTY_ANSWER");

        // If model returned a scope warning, do not save it in history and do not charge.
        if (isScopeNoticeAnswer(answer)) {
            if (reservation) {
                await rollbackQaReservation(req.session.userId, calculationId, reservation);
            }
            finalized = true;
            const wallet = await getWallet(req.session.userId);
            const remainingNow = await getQaRemaining(req.session.userId, calculationId);
            return res.status(422).json({
                ...outOfScopeQaPayload(calc.calculator_type, answerLanguage),
                remaining: remainingNow,
                wallet
            });
        }

        const pack = await persistQaAnswerWithReservation({
            userId: req.session.userId,
            calculationId,
            question,
            answer,
            reservation
        });
        finalized = true;

        const wallet = await getWallet(req.session.userId);

        return res.json({
            answer,
            pack: { remaining: pack.remaining, usedCredit: pack.usedCredit },
            wallet
        });
    } catch (e) {
        if (reservation && !finalized) {
            try {
                await rollbackQaReservation(req.session.userId, calculationId, reservation);
            } catch (rollbackErr) {
                console.error("QA_ROLLBACK_FAILED:", rollbackErr);
            }
        }
        if (String(e.message) === "NO_CREDITS" || e?.code === "NO_CREDITS") {
            return res.status(402).json(noCreditsPayload("Basic"));
        }
        console.error("[QA FAIL]", e?.stack || e);
        return sendAiError(res, e);
    }
});




app.post("/api/scenarios/deep_dive", rl.byUser({ limit: 60, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);

    const calculationId = Number(req.body?.calculationId);
    const idx = Number(req.body?.idx);
    const force = !!req.body?.force;

    if (!calculationId || !Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: "BAD_INPUT" });

    // Load latest scenario analysis
    const sr = await db.query(
        `select items, created_at
     from scenario_analyses
     where user_id=$1 and calculation_id=$2
     order by created_at desc
     limit 1`,
        [req.session.userId, calculationId]
    );
    if (!sr.rowCount) return res.status(404).json({ error: "NO_SCENARIOS" });

    const items = sr.rows[0].items || [];
    const it = items[idx];
    if (!it || !it.input_data || !it.result_data) return res.status(404).json({ error: "SCENARIO_NOT_FOUND" });

    const br = await db.query(
        `select calculator_type, input_data, result_data
     from calculations
     where id=$1 and user_id=$2`,
        [calculationId, req.session.userId]
    );
    if (!br.rowCount) return res.status(404).json({ error: "CALC_NOT_FOUND" });
    const normalizedBase = await normalizeCalcResultData(br.rows[0], req.session.userId);
    if (normalizedBase.stale) {
        return res.status(409).json({ error: "SCENARIOS_STALE", message: "Please regenerate scenarios for this calculation." });
    }
    const baseCalc = normalizedBase.calc;
    if (isCacheOlderThanCalc(baseCalc, sr.rows[0].created_at)) {
        return res.status(409).json({ error: "SCENARIOS_STALE", message: "Please regenerate scenarios for this calculation." });
    }

    const deepDiveEngineVersion = 2;
    const scenario_hash = `${hashScenario(it)}:v${deepDiveEngineVersion}`;

    // cache
    if (!force) {
        const cr = await db.query(
            `select content, created_at
       from scenario_deep_dives
       where user_id=$1 and calculation_id=$2 and scenario_hash=$3
       limit 1`,
            [req.session.userId, calculationId, scenario_hash]
        );
        if (cr.rowCount) {
            if (isCacheOlderThanCalc(baseCalc, cr.rows[0].created_at)) {
                // cached deep-dive predates canonicalized baseline; regenerate
            } else {
            const wr = await db.query("select free_used, credits from verdict_wallets where user_id=$1", [req.session.userId]);
            const wallet = wr.rowCount ? { free_used: !!wr.rows[0].free_used, credits: Number(wr.rows[0].credits || 0) } : { free_used: false, credits: 0 };
            return res.json({ mode: "cached", content: cr.rows[0].content, wallet });
            }
        }
    }

    const scenarioResultData = computeResultByType(baseCalc.calculator_type, it.input_data) || it.result_data;
    const fakeCalc = { calculator_type: baseCalc.calculator_type, input_data: it.input_data, result_data: scenarioResultData };
    const derived_metrics = buildDerivedMetrics(fakeCalc);
    const mini_verdict = miniVerdictUniversal(fakeCalc);

    const payload = {
        calculator_type: baseCalc.calculator_type,
        deep_dive_engine_version: deepDiveEngineVersion,
        scenario_label: String(it.label || `Scenario ${idx + 1}`),
        baseline_input_data: baseCalc.input_data,
        baseline_result: baseCalc.result_data,
        input_data: it.input_data,
        result_data: scenarioResultData,
        derived_metrics,
        mini_verdict
    };

    const SYSTEM = `
You are PropertyCost "Scenario Deep Dive" engine.

Hard constraints:
- Icon MUST match payload.mini_verdict.icon exactly.
- Use ONLY numbers from payload.
- Premium: find the main driver, hidden risk, and the best next lever.
`.trim();

    const USER = `
Language: English. 700–900 tokens.

Output EXACTLY this structure:

Scenario: <scenario_label>

Verdict: <icon> <1 sentence consistent with mini verdict, cite 1 number>

Main driver (what moved the outcome):
- <2–3 bullets with numbers/deltas vs baseline>

Risk & fragility (stress points):
- <3 bullets, cite numbers where possible>

Missing assumptions checklist:
- <use derived_metrics.missingChecklist + add 1–2 if truly missing>

Best next lever (highest ROI change):
- <3 bullets: what to change, why, which metric improves>

If you had to negotiate ONE thing (price/rent/fees):
- <1 bullet with required direction + number target if derivable>

Payload JSON:
${JSON.stringify(payload)}
`.trim();

    const wantsAsync = asyncProcessingEnabled() && !toBool(req.body?.sync);
    const dedupKey = force ? "" : `deep:${req.session.userId}:${calculationId}:${scenario_hash}`;

    if (wantsAsync && dedupKey) {
        const predictedJobId = aiJobIdFromDedupKey(dedupKey);
        if (predictedJobId) {
            const existing = await aiJobGet(req.session.userId, predictedJobId);
            if (existing?.status === "done" && existing?.result) {
                return res.json(existing.result);
            }
            if (existing && existing.status !== "failed") {
                const wallet = await getWallet(req.session.userId);
                return res.status(202).json(aiQueueAcceptedBody({
                    jobId: predictedJobId,
                    type: "deep_dive",
                    wallet,
                    message: "Deep dive queued. Poll /api/ai/jobs/:jobId"
                }));
            }
        }
    }

    // credits pre-check to avoid paid generation when wallet is empty
    const w0 = await getWallet(req.session.userId);
    if ((w0.credits || 0) < 2) {
        return res.status(402).json(noCreditsPayload("Starter"));
    }

    let reserved = 0;
    try {
        await reserveCreditsOrThrow(req.session.userId, 2);
        reserved = 2;

        if (wantsAsync) {
            const queued = await enqueueOpenAiChat({
                model: "gpt-4o-mini",
                temperature: 0.25,
                max_tokens: 1100,
                messages: [
                    { role: "system", content: SYSTEM },
                    { role: "user", content: USER }
                ]
            }, dedupKey ? { dedupKey } : undefined);

            await aiJobInsert({
                userId: req.session.userId,
                jobId: queued.jobId,
                kind: "deep_dive",
                status: "queued",
                reservedCredits: reserved,
                payload: {
                    calculationId,
                    scenario_hash,
                    deep_payload: payload
                }
            });

            const wallet = await getWallet(req.session.userId);
            return res.status(202).json(aiQueueAcceptedBody({
                jobId: queued.jobId,
                type: "deep_dive",
                wallet,
                message: "Deep dive queued. Poll /api/ai/jobs/:jobId"
            }));
        }

        const contentRaw = await aiChatCompletion({
            model: "gpt-4o-mini",
            temperature: 0.25,
            max_tokens: 1100,
            messages: [
                { role: "system", content: SYSTEM },
                { role: "user", content: USER }
            ],
            dedupKey: dedupKey || undefined
        });
        if (!contentRaw) throw new Error("EMPTY");
        const content = aiEnsureUsefulDeepDive(contentRaw, payload);

        // charge already reserved above; here we only persist successful output

        await db.query(
            `insert into scenario_deep_dives(user_id, calculation_id, scenario_hash, content)
       values($1,$2,$3,$4)
       on conflict (user_id, calculation_id, scenario_hash) do update set content=excluded.content`,
            [req.session.userId, calculationId, scenario_hash, content]
        );

        const wr = await db.query("select free_used, credits from verdict_wallets where user_id=$1", [req.session.userId]);
        const wallet = wr.rowCount ? { free_used: !!wr.rows[0].free_used, credits: Number(wr.rows[0].credits || 0) } : { free_used: false, credits: 0 };

        return res.json({ mode: "credit", content, wallet });
    } catch (e) {
        if (reserved) {
            try { await refundCredits(req.session.userId, reserved); }
            catch (refundErr) { console.error("DEEP_DIVE_REFUND_FAILED:", refundErr); }
        }
        if (String(e.message) === "NO_CREDITS" || e?.code === "NO_CREDITS") {
            return res.status(402).json(noCreditsPayload("Starter"));
        }
        return sendAiError(res, e);
    }
});

app.get("/api/ai/jobs/:jobId", rl.byUser({ limit: 180, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);
    const jobId = String(req.params?.jobId || "").trim();
    if (!jobId) return res.status(400).json({ error: "BAD_JOB_ID" });

    try {
        const rec = await aiJobGet(req.session.userId, jobId);
        if (!rec) return res.status(404).json({ error: "JOB_NOT_FOUND" });

        if (rec.status === "done") {
            return res.json({ ok: true, status: "done", result: rec.result || null });
        }
        if (rec.status === "failed") {
            return res.json({
                ok: true,
                status: "failed",
                error: String(rec.error || "FAILED"),
                result: rec.result || null
            });
        }

        const failJob = async (errorMessage, result = null) => {
            const safeError = String(errorMessage || "AI_FAILED");
            let rollbackPatch = {};
            try {
                rollbackPatch = await rollbackAiJobReservation(req.session.userId, rec);
            } catch (rollbackErr) {
                console.error("AI_JOB_ROLLBACK_FAILED:", rollbackErr);
            }

            const patch = {
                status: "failed",
                error: safeError,
                reserved_credits: 0
            };
            if (result !== null) patch.result = result;
            if (rollbackPatch?.payload) patch.payload = rollbackPatch.payload;

            await aiJobUpdate(req.session.userId, jobId, patch);
            return res.json({
                ok: true,
                status: "failed",
                error: safeError,
                result: result || null
            });
        };

        const q = await getOpenAiJobStatus(jobId);
        const queueState = String(q?.state || "unknown");

        if (!q?.exists || queueState === "missing") {
            return failJob("AI_JOB_MISSING");
        }

        if (queueState === "failed") {
            return failJob(String(q?.failedReason || "AI_FAILED"));
        }

        if (queueState !== "completed") {
            const mapped = queueState === "active" ? "processing" : "queued";
            await aiJobUpdate(req.session.userId, jobId, { status: mapped });
            return res.json({
                ok: true,
                status: mapped,
                queueState
            });
        }

        // completed
        const locked = await aiJobTryTransition(req.session.userId, jobId, ["queued", "processing"], "finalizing");
        if (!locked) {
            const latest = await aiJobGet(req.session.userId, jobId);
            if (latest?.status === "done") {
                return res.json({ ok: true, status: "done", result: latest.result || null });
            }
            if (latest?.status === "failed") {
                return res.json({
                    ok: true,
                    status: "failed",
                    error: String(latest.error || "FAILED"),
                    result: latest.result || null
                });
            }
            return res.json({ ok: true, status: "processing", queueState: "finalizing" });
        }

        try {
            const queueText = String(q?.returnvalue?.text || "").trim();
            const payload = rec.payload || {};
            let result = null;
            let payloadPatch = undefined;

            if (rec.kind === "scenarios_analyze") {
                const prepared = Array.isArray(payload?.prepared) ? payload.prepared : [];
                const batchRows = parseScenarioBatchResponse(queueText);
                const out = buildScenarioOutFromBatch(prepared, batchRows);
                const successCount = out.filter((x) => x?.verdict_text && !x.error).length;

                if (successCount === 0) {
                    return failJob("No scenario analyses generated.");
                }

                try {
                    await saveScenarioAnalysisRun(
                        req.session.userId,
                        Number(payload.calculationId),
                        String(payload.calculator_type || ""),
                        Number(payload.cost || 0),
                        out
                    );
                } catch (e) {
                    console.error("SCENARIO_SAVE_ASYNC_FAILED:", e);
                }

                const wallet = await getWallet(req.session.userId);
                result = {
                    requestedCount: Number(payload.requestedCount || out.length),
                    generatedCount: out.length,
                    items: out,
                    wallet
                };
            } else if (rec.kind === "verdict") {
                const verdictPayload = payload?.verdict_payload || {};
                const calculationId = Number(payload?.calculationId || 0);
                const mode = String(payload?.mode || "credit");
                if (!calculationId) throw new Error("BAD_VERDICT_JOB_PAYLOAD");
                if (!queueText) throw new Error("EMPTY_VERDICT");

                let verdict = aiEnsureUsefulVerdict(queueText, verdictPayload);
                if (String(verdictPayload?.calculator_type || "") === "mortgage") {
                    verdict = sanitizeMortgageVerdict(verdict, verdictPayload);
                }

                await db.query(
                    `INSERT INTO verdicts(user_id, calculation_id, mode, content)
                     VALUES($1,$2,$3,$4)`,
                    [req.session.userId, calculationId, mode, verdict]
                );

                if (mode === "free") {
                    await spend(req.session.userId, "free");
                }

                const wallet = await getWallet(req.session.userId);
                result = { mode, verdict, wallet };
            } else if (rec.kind === "compare") {
                const comparePayload = payload?.compare_payload || {};
                const leftId = Number(payload?.leftId || 0);
                const rightId = Number(payload?.rightId || 0);
                const hash = String(
                    payload?.hash ||
                    hashJson({ pair: [leftId, rightId].filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b) })
                );
                if (!leftId || !rightId || !hash) throw new Error("BAD_COMPARE_JOB_PAYLOAD");
                if (!queueText) throw new Error("EMPTY_COMPARE");

                const content = aiEnsureUsefulCompare(queueText, comparePayload);
                await db.query(
                    `insert into deal_comparisons(user_id, hash, a_id, b_id, content)
                     values($1,$2,$3,$4,$5)
                     on conflict (user_id, hash) do update set content=excluded.content`,
                    [req.session.userId, hash, leftId, rightId, content]
                );

                const wallet = await getWallet(req.session.userId);
                result = {
                    mode: "credit",
                    content,
                    payloadLite: {
                        winner: payload?.winner ?? comparePayload?.winner ?? null,
                        bestFlip: payload?.bestFlip ?? comparePayload?.bestFlip ?? null
                    },
                    wallet
                };
            } else if (rec.kind === "portfolio_summary") {
                const portfolioPayload = payload?.portfolio_payload || {};
                const hash = String(payload?.hash || hashJson({ recent_ids: portfolioPayload?.recent_ids || [] }));
                if (!hash) throw new Error("BAD_PORTFOLIO_JOB_PAYLOAD");
                if (!queueText) throw new Error("EMPTY_PORTFOLIO");

                const content = aiEnsureUsefulPortfolio(queueText, portfolioPayload);
                await db.query(
                    `insert into portfolio_summaries(user_id, hash, content)
                     values($1,$2,$3)
                     on conflict (user_id, hash) do update set content=excluded.content`,
                    [req.session.userId, hash, content]
                );

                const wallet = await getWallet(req.session.userId);
                result = { mode: "credit", content, wallet };
            } else if (rec.kind === "optimizer") {
                const optimizerPayload = payload?.optimizer_payload || {};
                const calculationId = Number(payload?.calculationId || 0);
                const goal = payload?.goal || optimizerPayload?.goal || null;
                const mode = String(payload?.mode || optimizerPayload?.mode || "standard");
                const candidates = Array.isArray(payload?.candidates)
                    ? payload.candidates
                    : (Array.isArray(optimizerPayload?.candidates) ? optimizerPayload.candidates : []);
                const hash = String(payload?.hash || hashJson({ calculationId, goal, mode }));
                if (!calculationId || !hash) throw new Error("BAD_OPTIMIZER_JOB_PAYLOAD");
                if (!queueText) throw new Error("EMPTY_OPTIMIZER");

                const content = aiEnsureUsefulOptimizer(queueText, optimizerPayload);
                await db.query(
                    `insert into optimizer_runs(user_id, hash, calculation_id, goal, mode, candidates, content)
                     values($1,$2,$3,$4,$5,$6,$7)
                     on conflict (user_id, hash) do update
                     set candidates=excluded.candidates, content=excluded.content`,
                    [req.session.userId, hash, calculationId, goal, mode, JSON.stringify(candidates), content]
                );

                const wallet = await getWallet(req.session.userId);
                result = { mode: "credit", content, candidates, wallet };
            } else if (rec.kind === "deep_dive") {
                const deepPayload = payload?.deep_payload || {};
                const calculationId = Number(payload?.calculationId || 0);
                const scenario_hash = String(payload?.scenario_hash || "").trim();
                if (!calculationId || !scenario_hash) throw new Error("BAD_DEEP_DIVE_JOB_PAYLOAD");
                if (!queueText) throw new Error("EMPTY_DEEP_DIVE");

                let content = aiEnsureUsefulDeepDive(queueText, deepPayload);
                if (String(deepPayload?.calculator_type || "") === "mortgage") {
                    content = sanitizeMortgageVerdict(content, deepPayload);
                }

                await db.query(
                    `insert into scenario_deep_dives(user_id, calculation_id, scenario_hash, content)
                     values($1,$2,$3,$4)
                     on conflict (user_id, calculation_id, scenario_hash) do update set content=excluded.content`,
                    [req.session.userId, calculationId, scenario_hash, content]
                );

                const wallet = await getWallet(req.session.userId);
                result = { mode: "credit", content, wallet };
            } else if (rec.kind === "verdict_qa") {
                const calculationId = Number(payload?.calculationId || 0);
                const question = String(payload?.question || "").trim();
                const answerLanguage = String(payload?.answerLanguage || "English");
                const calculatorType = String(payload?.calculator_type || payload?.qa_payload?.calculator_type || "");
                const reservation = payload?.reservation || null;
                const answer = queueText;

                if (!calculationId || !question) throw new Error("BAD_QA_JOB_PAYLOAD");
                if (!answer) throw new Error("EMPTY_ANSWER");

                if (isScopeNoticeAnswer(answer)) {
                    if (reservation?.kind) {
                        await rollbackQaReservation(req.session.userId, calculationId, reservation);
                    }
                    payloadPatch = { ...payload, reservation: null };
                    rec.payload = payloadPatch;
                    const wallet = await getWallet(req.session.userId);
                    const remainingNow = await getQaRemaining(req.session.userId, calculationId);
                    result = {
                        ...outOfScopeQaPayload(calculatorType, answerLanguage),
                        remaining: remainingNow,
                        wallet
                    };
                } else {
                    const pack = await persistQaAnswerWithReservation({
                        userId: req.session.userId,
                        calculationId,
                        question,
                        answer,
                        reservation
                    });
                    payloadPatch = { ...payload, reservation: null };
                    rec.payload = payloadPatch;
                    const wallet = await getWallet(req.session.userId);
                    result = {
                        answer,
                        pack: { remaining: pack.remaining, usedCredit: pack.usedCredit },
                        wallet
                    };
                }
            } else {
                result = q?.returnvalue || null;
            }

            const donePatch = {
                status: "done",
                result,
                reserved_credits: 0,
                error: null
            };
            if (payloadPatch !== undefined) donePatch.payload = payloadPatch;

            await aiJobUpdate(req.session.userId, jobId, donePatch);
            return res.json({
                ok: true,
                status: "done",
                result
            });
        } catch (finalizeErr) {
            return failJob(String(finalizeErr?.message || finalizeErr));
        }
    } catch (e) {
        return res.status(500).json({
            ok: false,
            error: "JOB_STATUS_FAILED",
            message: String(e?.message || e)
        });
    }
});

app.get("/api/ai/queue/stats", rl.byUser({ limit: 120, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);
    try {
        const stats = await getOpenAiQueueStats();
        return res.json({
            ok: true,
            ...stats,
            ts: new Date().toISOString()
        });
    } catch (e) {
        return res.status(500).json({
            ok: false,
            error: "QUEUE_STATS_FAILED",
            message: String(e?.message || e)
        });
    }
});

function parseAiMetricsHours(rawHours) {
    const raw = String(rawHours || "").trim();
    if (!raw) return [1, 24];

    const vals = raw
        .split(",")
        .map((x) => Number(String(x || "").trim()))
        .filter((x) => Number.isFinite(x))
        .map((x) => Math.trunc(x))
        .filter((x) => x >= 1 && x <= 168);

    const uniq = [...new Set(vals)];
    if (!uniq.length) return [1, 24];
    return uniq.slice(0, 4).sort((a, b) => a - b);
}

function numOrZero(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function round2(n) {
    return Math.round((numOrZero(n) + Number.EPSILON) * 100) / 100;
}

async function getAiMetricsWindow(hours) {
    const h = Math.max(1, Math.min(168, Math.trunc(Number(hours) || 24)));
    const sinceExpr = `now() - ($1::text || ' hours')::interval`;

    const summarySql = `
      with base as (
        select
          status,
          extract(epoch from (updated_at - created_at)) as latency_sec
        from ai_jobs
        where created_at >= ${sinceExpr}
      )
      select
        count(*)::int as total,
        count(*) filter (where status='done')::int as done,
        count(*) filter (where status='failed')::int as failed,
        count(*) filter (where status='queued')::int as queued,
        count(*) filter (where status='processing')::int as processing,
        count(*) filter (where status='finalizing')::int as finalizing,
        coalesce(avg(latency_sec) filter (where status in ('done','failed')), 0) as avg_sec,
        coalesce(percentile_cont(0.5) within group (order by latency_sec)
          filter (where status in ('done','failed')), 0) as p50_sec,
        coalesce(percentile_cont(0.95) within group (order by latency_sec)
          filter (where status in ('done','failed')), 0) as p95_sec
      from base
    `;

    const byKindSql = `
      with base as (
        select
          kind,
          status,
          extract(epoch from (updated_at - created_at)) as latency_sec
        from ai_jobs
        where created_at >= ${sinceExpr}
      )
      select
        kind,
        count(*)::int as total,
        count(*) filter (where status='done')::int as done,
        count(*) filter (where status='failed')::int as failed,
        count(*) filter (where status='queued')::int as queued,
        count(*) filter (where status='processing')::int as processing,
        count(*) filter (where status='finalizing')::int as finalizing,
        coalesce(avg(latency_sec) filter (where status in ('done','failed')), 0) as avg_sec,
        coalesce(percentile_cont(0.5) within group (order by latency_sec)
          filter (where status in ('done','failed')), 0) as p50_sec,
        coalesce(percentile_cont(0.95) within group (order by latency_sec)
          filter (where status in ('done','failed')), 0) as p95_sec
      from base
      group by kind
      order by total desc, kind asc
    `;

    const topErrorsSql = `
      select
        coalesce(nullif(trim(error), ''), 'UNKNOWN') as error,
        count(*)::int as total
      from ai_jobs
      where created_at >= ${sinceExpr}
        and status='failed'
      group by 1
      order by total desc, error asc
      limit 8
    `;

    const [summaryR, byKindR, topErrorsR] = await Promise.all([
        db.query(summarySql, [String(h)]),
        db.query(byKindSql, [String(h)]),
        db.query(topErrorsSql, [String(h)])
    ]);

    const s = summaryR.rowCount ? summaryR.rows[0] : {};
    const total = numOrZero(s.total);
    const failed = numOrZero(s.failed);
    const done = numOrZero(s.done);

    return {
        hours: h,
        total,
        done,
        failed,
        queued: numOrZero(s.queued),
        processing: numOrZero(s.processing),
        finalizing: numOrZero(s.finalizing),
        failPct: total > 0 ? round2((failed * 100) / total) : 0,
        donePct: total > 0 ? round2((done * 100) / total) : 0,
        latencySec: {
            avg: round2(s.avg_sec),
            p50: round2(s.p50_sec),
            p95: round2(s.p95_sec)
        },
        byKind: (byKindR.rows || []).map((r) => {
            const kTotal = numOrZero(r.total);
            const kFailed = numOrZero(r.failed);
            const kDone = numOrZero(r.done);
            return {
                kind: String(r.kind || "unknown"),
                total: kTotal,
                done: kDone,
                failed: kFailed,
                queued: numOrZero(r.queued),
                processing: numOrZero(r.processing),
                finalizing: numOrZero(r.finalizing),
                failPct: kTotal > 0 ? round2((kFailed * 100) / kTotal) : 0,
                donePct: kTotal > 0 ? round2((kDone * 100) / kTotal) : 0,
                latencySec: {
                    avg: round2(r.avg_sec),
                    p50: round2(r.p50_sec),
                    p95: round2(r.p95_sec)
                }
            };
        }),
        topErrors: (topErrorsR.rows || []).map((r) => ({
            error: String(r.error || "UNKNOWN"),
            total: numOrZero(r.total)
        }))
    };
}

app.get("/api/ai/metrics", rl.byUser({ limit: 120, windowSec: 600 }), async (req, res) => {
    if (!req.session?.userId) return res.sendStatus(401);

    try {
        await ensureAiJobsTable();
        const hoursList = parseAiMetricsHours(req.query?.hours);
        const windowsArr = await Promise.all(hoursList.map((h) => getAiMetricsWindow(h)));

        const windows = {};
        for (const w of windowsArr) {
            windows[`${w.hours}h`] = w;
        }

        return res.json({
            ok: true,
            windows,
            ts: new Date().toISOString()
        });
    } catch (e) {
        return res.status(500).json({
            ok: false,
            error: "AI_METRICS_FAILED",
            message: String(e?.message || e)
        });
    }
});





// app.use(express.static(path.join(__dirname, "..", "html" )));
app.use(express.static(HTML_ROOT, { index: false }));

// Подключаем маршруты
authRoutes(app);
calcRoutes(app);
// registerFacebookRoutes(app);
registerGoogleRoutes(app);
app.use("/api/contact", rl.byIp({ limit: 8, windowSec: 300, prefix: "rl:contact" }));
app.use(contactRoutes);
// registerAppleRoutes(app);

// app.get("/__redis_test", (req, res) => {
//     if (!req.session.views) {
//         req.session.views = 1;
//     } else {
//         req.session.views++;
//     }

//     res.json({
//         sessionID: req.sessionID,
//         views: req.session.views
//     });
// });
const pages = [
    { url: "/", changefreq: "daily", priority: 1.0 },
    { url: "/about/", changefreq: "monthly", priority: 0.8 },
    { url: "/contact/", changefreq: "monthly", priority: 0.8 },
    { url: "/calculators/", changefreq: "weekly", priority: 0.9 },
    { url: "/terms/", changefreq: "yearly", priority: 0.5 },
    { url: "/privacy/", changefreq: "yearly", priority: 0.5 },
];

app.get("/sitemap.xml", (req, res) => {
    res.header("Content-Type", "application/xml");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
            .map(
                (page) => `
  <url>
    <loc>https://mypropertycost.com${page.url}</loc>
    <lastmod>${new Date().toISOString().split("T")[0]}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`
            )
            .join("")}
</urlset>`;

    res.send(xml);
});






app.get("/ads.txt", (req, res) => {
    res.type("text/plain");
    res.send("google.com, pub-4041439086297277, DIRECT, f08c47fec0942fa0");
});

app.get("/robots.txt", (req, res) => {
    res.type("text/plain");

    res.send(`# robots.txt for PropertyCost.com

User-agent: *
Disallow: /admin/
Disallow: /login/
Disallow: /register/
Disallow: /account/
Allow: /

Sitemap: https://mypropertycost.com/sitemap.xml
`);
});

app.use((err, req, res, next) => {
    console.error("EXPRESS ERROR:", err);
    res.status(500).end();
});

process.on("uncaughtException", err => {
    console.error("UNCAUGHT EXCEPTION", err);
});

process.on("unhandledRejection", err => {
    console.error("UNHANDLED PROMISE", err);
});

function startScenarioCleanupJob() {
    const KEEP_DAYS = Number(process.env.SCENARIO_KEEP_DAYS || 90);

    async function cleanupOnce() {
        try {
            const r = await db.query(
                `delete from scenario_analyses
         where created_at < now() - ($1::text || ' days')::interval`,
                [String(KEEP_DAYS)]
            );
            if (r?.rowCount) console.log("scenario_analyses cleanup deleted:", r.rowCount);
        } catch (e) {
            console.error("scenario_analyses cleanup failed:", e);
        }
    }

    // при старте + дальше раз в 12 часов
    cleanupOnce();
    setInterval(cleanupOnce, 12 * 60 * 60 * 1000).unref();
}



app.listen(PORT, HOST, () =>{
    console.log(`Server on ${HOST}:${PORT}`);
    //startScenarioCleanupJob();
});


