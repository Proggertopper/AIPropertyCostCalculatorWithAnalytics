const test = require("node:test");
const assert = require("node:assert/strict");

const makeRateLimit = require("../jsForAuth/rateLimit");

function createRedisStub({ throwOnIncr = false } = {}) {
    const counters = new Map();
    return {
        async incr(key) {
            if (throwOnIncr) throw new Error("redis down");
            const next = Number(counters.get(key) || 0) + 1;
            counters.set(key, next);
            return next;
        },
        async expire() {
            return 1;
        }
    };
}

async function runMiddleware(mw, req) {
    const state = { nextCalled: false, statusCode: null, body: null };
    const res = {
        status(code) {
            state.statusCode = Number(code);
            return this;
        },
        json(payload) {
            state.body = payload;
            return this;
        },
        sendStatus(code) {
            state.statusCode = Number(code);
            return this;
        }
    };

    await mw(req, res, () => {
        state.nextCalled = true;
    });

    return state;
}

test("byIp: enforces redis-backed limit", async () => {
    const rl = makeRateLimit(createRedisStub());
    const mw = rl.byIp({ limit: 2, windowSec: 60, prefix: "t:ip" });
    const req = { ip: "127.0.0.1" };

    const a = await runMiddleware(mw, req);
    const b = await runMiddleware(mw, req);
    const c = await runMiddleware(mw, req);

    assert.equal(a.nextCalled, true);
    assert.equal(b.nextCalled, true);
    assert.equal(c.statusCode, 429);
    assert.equal(c.body?.error, "Too many requests");
});

test("byIp: falls back to local limiter if redis fails (no fail-open)", async () => {
    const rl = makeRateLimit(createRedisStub({ throwOnIncr: true }));
    const mw = rl.byIp({ limit: 2, windowSec: 60, prefix: "t:ip:fallback" });
    const req = { ip: "10.0.0.2" };

    const a = await runMiddleware(mw, req);
    const b = await runMiddleware(mw, req);
    const c = await runMiddleware(mw, req);

    assert.equal(a.nextCalled, true);
    assert.equal(b.nextCalled, true);
    assert.equal(c.statusCode, 429);
    assert.equal(c.body?.error, "Too many requests");
});

test("byUser: returns 401 when session user is missing", async () => {
    const rl = makeRateLimit(createRedisStub());
    const mw = rl.byUser({ limit: 1, windowSec: 60, prefix: "t:user:auth" });

    const res = await runMiddleware(mw, { session: {} });
    assert.equal(res.statusCode, 401);
});

test("byUser: local fallback also enforces limits when redis fails", async () => {
    const rl = makeRateLimit(createRedisStub({ throwOnIncr: true }));
    const mw = rl.byUser({ limit: 1, windowSec: 60, prefix: "t:user:fallback" });
    const req = { session: { userId: 123 } };

    const a = await runMiddleware(mw, req);
    const b = await runMiddleware(mw, req);

    assert.equal(a.nextCalled, true);
    assert.equal(b.statusCode, 429);
});

