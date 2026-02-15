// middlewares/rateLimit.js
module.exports = function makeRateLimit(redis) {
    const localBuckets = new Map();

    function normalizePath(path) {
        const raw = String(path || "").split("?")[0] || "";
        if (!raw) return "*";
        return raw
            .replace(/\b\d+\b/g, ":id")
            .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi, ":uuid")
            .replace(/\/+$/, "") || "/";
    }

    function resolveScope(req, scope) {
        if (typeof scope === "function") {
            try {
                const out = scope(req);
                if (out) return String(out);
            } catch {
                // ignore custom scope errors and fallback to path-based scope
            }
        }
        if (typeof scope === "string" && scope.trim()) return scope.trim();
        const method = String(req?.method || "GET").toUpperCase();
        const path = normalizePath(req?.path || req?.originalUrl || "");
        return `${method}:${path}`;
    }

    function localHit(key, limit = 20, windowSec = 60) {
        const now = Date.now();
        const windowMs = Math.max(1, Number(windowSec) * 1000);
        const max = Math.max(1, Number(limit) || 1);

        const cur = localBuckets.get(key);
        if (!cur || cur.resetAt <= now) {
            localBuckets.set(key, { count: 1, resetAt: now + windowMs });
            return true;
        }

        cur.count += 1;

        // occasional cleanup to avoid unbounded growth in long-lived processes
        if (localBuckets.size > 5000 && cur.count % 20 === 0) {
            for (const [k, v] of localBuckets) {
                if (!v || v.resetAt <= now) localBuckets.delete(k);
            }
        }

        return cur.count <= max;
    }

    async function hit(key, limit = 20, windowSec = 60) {
        try {
            const v = await redis.incr(key);
            if (v === 1) await redis.expire(key, windowSec);
            return v <= limit;
        } catch {
            // degraded mode: keep rate-limiting locally instead of fail-open
            return localHit(key, limit, windowSec);
        }
    }

    function byIp({ limit = 30, windowSec = 60, prefix = "rl:ip", scope } = {}) {
        return async (req, res, next) => {
            const ip = String(req.ip || "").trim();
            const keyScope = resolveScope(req, scope);
            const ok = await hit(`${prefix}:${ip}:${keyScope}`, limit, windowSec);
            if (!ok) return res.status(429).json({ error: "Too many requests" });
            next();
        };
    }

    function byUser({ limit = 20, windowSec = 60, prefix = "rl:user", scope } = {}) {
        return async (req, res, next) => {
            const uid = req.session?.userId;
            if (!uid) return res.sendStatus(401);
            const keyScope = resolveScope(req, scope);
            const ok = await hit(`${prefix}:${uid}:${keyScope}`, limit, windowSec);
            if (!ok) return res.status(429).json({ error: "Too many requests" });
            next();
        };
    }

    return { byIp, byUser };
};
