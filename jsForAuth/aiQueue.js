const crypto = require("crypto");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";

let cachedBull = null;
let bullLoadTried = false;
let producerQueue = null;
let producerEvents = null;
let producerReadyPromise = null;

function toInt(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toBool(v, fallback = false) {
    if (v === undefined || v === null || v === "") return fallback;
    const s = String(v).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
    return fallback;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function queueName() {
    return String(process.env.AI_QUEUE_NAME || "ai-openai");
}

function queuePrefix() {
    return String(process.env.AI_QUEUE_PREFIX || "pc");
}

function queueEnabled() {
    const raw = String(process.env.AI_QUEUE_ENABLED || "1").trim().toLowerCase();
    return !(raw === "0" || raw === "false" || raw === "off");
}

function isTransientQueueError(err) {
    const code = String(err?.code || "").toUpperCase();
    const msg = String(err?.message || err || "").toLowerCase();
    if (["EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) {
        return true;
    }
    return (
        msg.includes("eai_again") ||
        msg.includes("timed out") ||
        msg.includes("timeout") ||
        msg.includes("connection is closed") ||
        msg.includes("connection closed") ||
        msg.includes("connect etimedout")
    );
}

function queueRetryConfig() {
    return {
        attempts: Math.max(1, toInt(process.env.AI_QUEUE_RETRY_ATTEMPTS, 4)),
        baseMs: Math.max(100, toInt(process.env.AI_QUEUE_RETRY_BASE_MS, 300)),
        maxMs: Math.max(300, toInt(process.env.AI_QUEUE_RETRY_MAX_MS, 3500))
    };
}

async function withQueueRetry(work, label) {
    const cfg = queueRetryConfig();
    let lastErr = null;
    for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
        try {
            return await work();
        } catch (e) {
            lastErr = e;
            if (!isTransientQueueError(e) || attempt >= cfg.attempts) {
                throw e;
            }
            const delay = Math.min(cfg.maxMs, cfg.baseMs * Math.pow(2, attempt - 1));
            console.warn(`[AI_QUEUE] ${label} attempt ${attempt}/${cfg.attempts} failed: ${String(e?.message || e)}; retrying in ${delay}ms`);
            await sleep(delay);
        }
    }
    throw lastErr || new Error(`AI_QUEUE_${String(label || "RETRY").toUpperCase()}_FAILED`);
}

function parseRedisConnectionFromUrl(rawUrl) {
    const u = new URL(String(rawUrl || ""));
    const isTls = u.protocol === "rediss:";
    const port = Number(u.port || (isTls ? 6380 : 6379));
    const dbNum = Number((u.pathname || "/0").replace("/", ""));

    const out = {
        host: u.hostname,
        port: Number.isFinite(port) ? port : 6379,
        maxRetriesPerRequest: null,
        connectTimeout: Math.max(1000, toInt(process.env.AI_QUEUE_REDIS_CONNECT_TIMEOUT_MS, 15000)),
        keepAlive: Math.max(0, toInt(process.env.AI_QUEUE_REDIS_KEEPALIVE_MS, 30000))
    };

    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    if (Number.isFinite(dbNum)) out.db = dbNum;
    const family = toInt(process.env.AI_QUEUE_REDIS_FAMILY || process.env.REDIS_FAMILY, 0);
    if (family === 4 || family === 6) out.family = family;

    const retryBaseMs = Math.max(100, toInt(process.env.AI_QUEUE_REDIS_RETRY_BASE_MS, 250));
    const retryMaxMs = Math.max(500, toInt(process.env.AI_QUEUE_REDIS_RETRY_MAX_MS, 6000));
    out.retryStrategy = (times) => Math.min(retryMaxMs, retryBaseMs * Math.pow(2, Math.max(0, Number(times || 1) - 1)));

    if (isTls) {
        out.tls = {
            servername: u.hostname,
            rejectUnauthorized: toBool(process.env.AI_QUEUE_REDIS_TLS_REJECT_UNAUTHORIZED, true)
        };
    }

    return out;
}

function getBullConnectionOptions() {
    if (!process.env.REDIS_URL) {
        throw new Error("REDIS_URL is required for AI queue");
    }
    return parseRedisConnectionFromUrl(process.env.REDIS_URL);
}

function loadBullMQ() {
    if (bullLoadTried) return cachedBull;
    bullLoadTried = true;
    try {
        // optional dependency at runtime; fallback exists if package is absent
        cachedBull = require("bullmq");
    } catch (e) {
        cachedBull = null;
        console.warn("[AI_QUEUE] bullmq is not installed, falling back to direct OpenAI calls.");
    }
    return cachedBull;
}

function stableHash(obj) {
    const s = JSON.stringify(obj || {});
    return crypto.createHash("sha256").update(s).digest("hex");
}

function hashString(s) {
    return crypto.createHash("sha256").update(String(s || "")).digest("hex");
}

function chatJobIdFromDedupKey(dedupKey) {
    const k = String(dedupKey || "").trim();
    if (!k) return "";
    return `chat-${hashString(k)}`;
}

function normalizeMessages(messages) {
    const src = Array.isArray(messages) ? messages : [];
    return src
        .map((m) => {
            const role = String(m?.role || "").trim();
            const content = String(m?.content || "");
            if (!role || !content.trim()) return null;
            return { role, content };
        })
        .filter(Boolean);
}

function estimateTokens(messages, maxTokens) {
    // cheap approximation: ~4 chars/token on average
    const promptChars = normalizeMessages(messages)
        .reduce((sum, m) => sum + String(m.content || "").length, 0);
    const promptTokens = Math.ceil(promptChars / 4);
    const completionTokens = Math.max(1, toInt(maxTokens, 400));
    return promptTokens + completionTokens;
}

async function directOpenAiChat({ model, temperature, max_tokens, messages }) {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is not configured");
    }
    const payload = {
        model: model || DEFAULT_MODEL,
        temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2,
        max_tokens: Math.max(64, toInt(max_tokens, 400)),
        messages: normalizeMessages(messages)
    };

    const r = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `OpenAI failed (${r.status})`);

    const text = String(j?.choices?.[0]?.message?.content || "").trim();
    if (!text) throw new Error("OpenAI returned empty content");

    return {
        text,
        usage: j?.usage || null,
        model: j?.model || payload.model
    };
}

async function ensureProducerReady() {
    if (producerReadyPromise) return producerReadyPromise;

    producerReadyPromise = (async () => {
        const bull = loadBullMQ();
        if (!bull) throw new Error("BULLMQ_NOT_AVAILABLE");

        const { Queue, QueueEvents } = bull;
        const connection = getBullConnectionOptions();

        producerQueue = new Queue(queueName(), {
            connection,
            prefix: queuePrefix(),
            defaultJobOptions: {
                removeOnComplete: toInt(process.env.AI_QUEUE_REMOVE_ON_COMPLETE, 1500),
                removeOnFail: toInt(process.env.AI_QUEUE_REMOVE_ON_FAIL, 2500),
                attempts: toInt(process.env.AI_QUEUE_ATTEMPTS, 3),
                backoff: {
                    type: "exponential",
                    delay: toInt(process.env.AI_QUEUE_BACKOFF_MS, 1500)
                }
            }
        });

        producerEvents = new QueueEvents(queueName(), {
            connection,
            prefix: queuePrefix()
        });

        await Promise.all([
            producerQueue.waitUntilReady(),
            producerEvents.waitUntilReady()
        ]);
    })();

    try {
        await producerReadyPromise;
    } catch (e) {
        producerReadyPromise = null;
        throw e;
    }
}

async function addOrReuseChatJob(jobData, jobId) {
    const opts = jobId ? { jobId } : undefined;
    return withQueueRetry(async () => {
        try {
            return await producerQueue.add("openai.chat", jobData, opts);
        } catch (e) {
            if (jobId) {
                const existing = await producerQueue.getJob(jobId);
                if (existing) return existing;
            }
            throw e;
        }
    }, "queue add");
}

function getJobId(dedupKey, jobData) {
    if (dedupKey) return chatJobIdFromDedupKey(dedupKey);
    const autoDedup = String(process.env.AI_QUEUE_AUTO_DEDUP || "0") === "1";
    if (!autoDedup) return undefined;
    return `chat-${stableHash(jobData)}`;
}

async function runOpenAiChat(jobPayload, options = {}) {
    const payload = {
        model: jobPayload?.model || DEFAULT_MODEL,
        temperature: Number(jobPayload?.temperature ?? 0.2),
        max_tokens: Math.max(64, toInt(jobPayload?.max_tokens, 400)),
        messages: normalizeMessages(jobPayload?.messages)
    };

    if (!queueEnabled()) {
        return directOpenAiChat(payload);
    }

    const waitMs = Math.max(1000, toInt(options.waitMs, toInt(process.env.AI_QUEUE_WAIT_MS, 90000)));
    const fallbackDirect = String(process.env.AI_QUEUE_FALLBACK_DIRECT || "1") !== "0";

    try {
        await withQueueRetry(() => ensureProducerReady(), "producer ready");
        const dedupKey = String(options.dedupKey || "").trim();
        const estimatedTokens = estimateTokens(payload.messages, payload.max_tokens);
        const jobData = { ...payload, estimatedTokens };
        const jobId = getJobId(dedupKey, jobData);

        const job = await addOrReuseChatJob(jobData, jobId);

        if (!job) throw new Error("AI_QUEUE_ADD_FAILED");

        const result = await job.waitUntilFinished(producerEvents, waitMs);
        if (!result?.ok) {
            throw new Error(String(result?.error || "AI_QUEUE_JOB_FAILED"));
        }
        const text = String(result?.text || "").trim();
        if (!text) throw new Error("AI_QUEUE_EMPTY_RESULT");
        return {
            text,
            usage: result?.usage || null,
            model: result?.model || payload.model
        };
    } catch (e) {
        if (!fallbackDirect) throw e;
        console.warn("[AI_QUEUE] fallback to direct OpenAI:", String(e?.message || e));
        return directOpenAiChat(payload);
    }
}

async function enqueueOpenAiChat(jobPayload, options = {}) {
    if (!queueEnabled()) {
        throw new Error("AI_QUEUE_DISABLED");
    }
    await withQueueRetry(() => ensureProducerReady(), "producer ready");

    const payload = {
        model: jobPayload?.model || DEFAULT_MODEL,
        temperature: Number(jobPayload?.temperature ?? 0.2),
        max_tokens: Math.max(64, toInt(jobPayload?.max_tokens, 400)),
        messages: normalizeMessages(jobPayload?.messages)
    };
    const dedupKey = String(options.dedupKey || "").trim();
    const estimatedTokens = estimateTokens(payload.messages, payload.max_tokens);
    const jobData = { ...payload, estimatedTokens };
    const jobId = getJobId(dedupKey, jobData);

    const job = await addOrReuseChatJob(jobData, jobId);
    if (!job) throw new Error("AI_QUEUE_ADD_FAILED");
    return {
        jobId: String(job.id),
        queue: queueName()
    };
}

async function getOpenAiJobStatus(jobId) {
    if (!queueEnabled()) {
        return { exists: false, state: "disabled" };
    }
    await withQueueRetry(() => ensureProducerReady(), "producer ready");

    const id = String(jobId || "").trim();
    if (!id) return { exists: false, state: "missing_id" };

    const job = await producerQueue.getJob(id);
    if (!job) return { exists: false, state: "missing" };

    const state = await job.getState();
    const out = {
        exists: true,
        jobId: id,
        state,
        attemptsMade: Number(job.attemptsMade || 0),
        processedOn: job.processedOn || null,
        finishedOn: job.finishedOn || null
    };

    if (state === "completed") {
        out.returnvalue = job.returnvalue || null;
    }
    if (state === "failed") {
        out.failedReason = String(job.failedReason || "FAILED");
    }
    return out;
}

async function getOpenAiQueueStats() {
    if (!queueEnabled()) {
        return {
            enabled: false,
            queue: queueName(),
            counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 }
        };
    }

    const bull = loadBullMQ();
    if (!bull) {
        return {
            enabled: false,
            queue: queueName(),
            error: "BULLMQ_NOT_AVAILABLE",
            counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 }
        };
    }

    await withQueueRetry(() => ensureProducerReady(), "producer ready");
    const counts = await producerQueue.getJobCounts(
        "waiting",
        "active",
        "completed",
        "failed",
        "delayed",
        "paused"
    );
    return {
        enabled: true,
        queue: queueName(),
        prefix: queuePrefix(),
        counts
    };
}

async function startOpenAiWorkers() {
    const bull = loadBullMQ();
    if (!bull) throw new Error("BullMQ is not installed. Run: npm i bullmq");

    const { Worker } = bull;

    const workerCount = Math.max(1, toInt(process.env.AI_WORKER_COUNT, 3));
    const workerConcurrency = Math.max(1, toInt(process.env.AI_WORKER_CONCURRENCY, 1));
    const globalRpm = Math.max(1, toInt(process.env.AI_WORKER_GLOBAL_RPM, 180));
    const perWorkerRpm = Math.max(1, Math.floor(globalRpm / workerCount));
    const maxTokensCap = Math.max(128, toInt(process.env.AI_WORKER_MAX_TOKENS_CAP, 1500));
    const connection = getBullConnectionOptions();

    const workers = [];
    const closeAll = async () => {
        await Promise.allSettled(workers.map((w) => w.close()));
        process.exit(0);
    };

    for (let i = 0; i < workerCount; i++) {
        const worker = new Worker(
            queueName(),
            async (job) => {
                if (job?.name !== "openai.chat") {
                    throw new Error(`Unknown AI job type: ${String(job?.name || "")}`);
                }

                const data = job?.data || {};
                const model = String(data.model || DEFAULT_MODEL);
                const temperature = Number(data.temperature ?? 0.2);
                const max_tokens = Math.min(maxTokensCap, Math.max(64, toInt(data.max_tokens, 400)));
                const messages = normalizeMessages(data.messages);

                const out = await directOpenAiChat({
                    model,
                    temperature,
                    max_tokens,
                    messages
                });

                return {
                    ok: true,
                    text: out.text,
                    usage: out.usage || null,
                    model: out.model || model
                };
            },
            {
                connection,
                prefix: queuePrefix(),
                concurrency: workerConcurrency,
                limiter: {
                    max: perWorkerRpm,
                    duration: 60_000
                }
            }
        );

        worker.on("ready", () => {
            console.log(`[AI_WORKER ${i + 1}/${workerCount}] ready (concurrency=${workerConcurrency}, rpm=${perWorkerRpm})`);
        });
        worker.on("failed", (job, err) => {
            const jid = job?.id ? String(job.id) : "n/a";
            console.error(`[AI_WORKER ${i + 1}] job ${jid} failed:`, err?.message || err);
        });
        worker.on("error", (err) => {
            console.error(`[AI_WORKER ${i + 1}] worker error:`, err?.message || err);
        });

        workers.push(worker);
    }

    const onSignal = () => { closeAll().catch(() => process.exit(0)); };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    return workers;
}

module.exports = {
    runOpenAiChat,
    startOpenAiWorkers,
    getOpenAiQueueStats,
    enqueueOpenAiChat,
    getOpenAiJobStatus,
    chatJobIdFromDedupKey
};
