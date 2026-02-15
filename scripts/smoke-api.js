#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { computeResultByType } = require("../jsForAuth/compute");

const BASE_URL = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3001";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 15000);

const cookieJar = new Map();

function updateCookieJar(response) {
    let setCookies = [];

    if (typeof response.headers.getSetCookie === "function") {
        setCookies = response.headers.getSetCookie() || [];
    }
    if (!setCookies.length) {
        const single = response.headers.get("set-cookie");
        if (single) setCookies = [single];
    }

    for (const raw of setCookies) {
        const head = String(raw || "").split(";")[0] || "";
        const eq = head.indexOf("=");
        if (eq <= 0) continue;
        const name = head.slice(0, eq).trim();
        const value = head.slice(eq + 1).trim();
        if (!name) continue;
        cookieJar.set(name, value);
    }
}

function cookieHeader() {
    return Array.from(cookieJar.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
}

async function request(path, { method = "GET", json, headers = {} } = {}) {
    const h = new Headers(headers || {});
    const cookie = cookieHeader();
    if (cookie) h.set("Cookie", cookie);

    let body;
    if (json !== undefined) {
        h.set("Content-Type", "application/json");
        body = JSON.stringify(json);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response;
    try {
        response = await fetch(`${BASE_URL}${path}`, {
            method,
            headers: h,
            body,
            redirect: "manual",
            signal: controller.signal
        });
    } finally {
        clearTimeout(timer);
    }

    updateCookieJar(response);

    const text = await response.text();
    let data = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }
    }

    return { response, data, text };
}

function assertStatus(actual, expected, label) {
    assert.equal(actual, expected, `${label}: expected ${expected}, got ${actual}`);
}

async function getCsrf(label) {
    const { response, data } = await request("/api/csrf");
    assertStatus(response.status, 200, label);
    const token = String(data?.csrfToken || "");
    assert.ok(token.length >= 10, `${label}: csrfToken missing`);
    return token;
}

const CALCULATOR_CASES = [
    {
        type: "mortgage",
        inputData: { price: 350000, down: 70000, ratePercent: 6.1, termYears: 30 }
    },
    {
        type: "rent_vs_buy",
        inputData: {
            rent: 2500,
            mortgage: 2400,
            years: 30,
            propertyValue: 400000,
            rentGrowth: 3,
            mortgageRate: 6.5,
            propertyGrowth: 3,
            inflation: 2.5
        }
    },
    {
        type: "break_even",
        inputData: {
            price: 350000,
            downPayment: 70000,
            marketRent: 2600,
            mortgage: 1800,
            expenses: 350,
            taxes: 250,
            vacancy: 6
        }
    },
    {
        type: "cash_flow",
        inputData: {
            rent: 2600,
            vacancy: 6,
            mortgage: 1500,
            expenses: 300,
            taxes: 10,
            inflation: 3
        }
    },
    {
        type: "property_irr",
        inputData: {
            price: 400000,
            downPayment: 80000,
            purchaseCosts: 10000,
            renovation: 15000,
            rent: 2500,
            vacancy: 6,
            expenses: 7000,
            mortgage: 15000,
            years: 15,
            growth: 3,
            saleTax: 10,
            inflation: 2
        }
    },
    {
        type: "renovation_roi",
        inputData: {
            priceBefore: 300000,
            rentBefore: 1800,
            renovationCost: 40000,
            priceIncrease: 12,
            rentIncrease: 8,
            agentFee: 5,
            saleTax: 10,
            years: 8,
            discountRate: 6,
            inflationRate: 2
        }
    },
    {
        type: "property_sale",
        inputData: {
            buyPrice: 300000,
            sellPrice: 420000,
            years: 8,
            tax: 8,
            commission: 4,
            inflation: 3,
            renovation: 25000
        }
    },
    {
        type: "property_taxes",
        inputData: {
            price: 350000,
            rent: 36000,
            years: 10,
            priceGrowth: 3,
            propertyTax: 1.2,
            rentTax: 10,
            annualFees: 2500,
            feeGrowth: 2,
            saleTax: 15,
            agentFee: 5,
            inflationRate: 2
        }
    },
    {
        type: "ownership_cost",
        inputData: {
            price: 350000,
            years: 15,
            taxPercent: 1.2,
            maintenance: 3000,
            inflation: 2
        }
    },
    {
        type: "alternative_investment",
        inputData: {
            propertyInitial: 200000,
            propertyCashflow: 4000,
            propertyGrowth: 4,
            propertyInflation: 2,
            propertyTaxRate: 10,
            altReturn: 7,
            altContribution: 4000,
            altInflation: 2,
            altTaxRate: 12,
            years: 12
        }
    },
    {
        type: "mortgage_overpayment",
        inputData: {
            loan: 300000,
            rate: 6.5,
            years: 30,
            inflation: 2.5
        }
    }
];

async function saveCalculation(type, inputData) {
    const resultData = computeResultByType(type, inputData);
    assert.ok(resultData && typeof resultData === "object", `${type}: computeResultByType returned null`);

    const csrf = await getCsrf(`csrf save ${type}`);
    const saveCalc = await request("/api/app/calculation", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        json: { calculatorType: type, inputData, resultData }
    });
    assertStatus(saveCalc.response.status, 200, `save calculation ${type}`);

    const list = await request("/api/app/calculations");
    assertStatus(list.response.status, 200, `list calculations after save ${type}`);
    assert.ok(Array.isArray(list.data), `list calculations ${type}: expected array`);
    const found = list.data.find((x) => String(x?.calculator_type || "") === type);
    assert.ok(found && Number(found.id) > 0, `list calculations ${type}: could not find saved id`);
    return Number(found.id);
}

async function verifyScenarioPipeline(calculationId, type) {
    const csrfBuild = await getCsrf(`csrf build ${type}`);
    const build = await request("/api/scenarios/build", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfBuild },
        json: { calculationId, count: 3, pack: "quick" }
    });
    assertStatus(build.response.status, 200, `scenarios build ${type}`);
    assert.ok(Array.isArray(build.data?.scenarios), `scenarios build ${type}: missing scenarios array`);
    assert.ok(build.data.scenarios.length > 0, `scenarios build ${type}: expected non-empty scenarios`);

    const items = build.data.scenarios.slice(0, 3).map((s) => ({
        label: String(s?.label || "Scenario"),
        input_data: s?.input_data || {}
    }));

    const csrfCompute = await getCsrf(`csrf compute ${type}`);
    const compute = await request("/api/scenarios/compute", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfCompute },
        json: { calculationId, count: 3, items }
    });
    assertStatus(compute.response.status, 200, `scenarios compute ${type}`);
    assert.ok(Array.isArray(compute.data?.items), `scenarios compute ${type}: missing items array`);
    assert.ok(compute.data.items.length > 0, `scenarios compute ${type}: expected non-empty items`);
    assert.ok(
        compute.data.items.some((x) => x && x.result_data && typeof x.result_data === "object"),
        `scenarios compute ${type}: expected at least one computed result`
    );
}

function assertNoCreditsPayload(data, label) {
    assert.equal(String(data?.error || ""), "NO_CREDITS", `${label}: expected NO_CREDITS`);
    assert.equal(String(data?.action?.type || ""), "BUY_CREDITS", `${label}: expected action BUY_CREDITS`);
}

async function main() {
    const email = `smoke_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;
    const password = "SmokeTest#123";

    console.log(`[smoke] base=${BASE_URL}`);

    const csrf1 = await getCsrf("csrf#1");
    const register = await request("/api/auth/register", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf1 },
        json: { email, password }
    });
    assertStatus(register.response.status, 201, "register");
    assert.equal(Boolean(register.data?.ok), true, "register: body.ok should be true");

    const csrf2 = await getCsrf("csrf#2");
    const login = await request("/api/auth/login", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf2 },
        json: { email, password }
    });
    assertStatus(login.response.status, 200, "login");

    const ids = [];
    for (const c of CALCULATOR_CASES) {
        const id = await saveCalculation(c.type, c.inputData);
        ids.push({ type: c.type, id });
        await verifyScenarioPipeline(id, c.type);
        console.log(`[smoke] calculator OK: ${c.type} (#${id})`);
    }

    const listAccount = await request("/api/calculations/list?limit=30");
    assertStatus(listAccount.response.status, 200, "account calculations list");
    assert.ok(Array.isArray(listAccount.data?.items), "account calculations list: missing items");
    assert.ok(listAccount.data.items.length > 0, "account calculations list: expected at least one item");

    const firstSaved = ids[0];
    const getOne = await request(`/api/app/calculation/${firstSaved.id}`);
    assertStatus(getOne.response.status, 200, "get one calculation");
    assert.equal(String(getOne.data?.calculator_type || ""), firstSaved.type, "get one calculation: type mismatch");

    const optimizerCached = await request(`/api/optimizer/cached?calculationId=${firstSaved.id}`);
    assertStatus(optimizerCached.response.status, 200, "optimizer cached");
    assert.equal(Boolean(optimizerCached.data?.has), false, "optimizer cached: expected has=false");

    const scenariosCached = await request(`/api/scenarios/cached?calculationId=${firstSaved.id}`);
    assertStatus(scenariosCached.response.status, 200, "scenarios cached");
    assert.equal(Boolean(scenariosCached.data?.has), false, "scenarios cached: expected has=false");

    const csrfOpt = await getCsrf("csrf optimizer");
    const optimizerRun = await request("/api/optimizer/run", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfOpt },
        json: {
            calculationId: firstSaved.id,
            mode: "quick",
            goal: { metric: "monthlyPayment", op: "<=", value: 1800 }
        }
    });
    assertStatus(optimizerRun.response.status, 402, "optimizer run (no credits)");
    assertNoCreditsPayload(optimizerRun.data, "optimizer run (no credits)");

    const mortgageA = ids.find((x) => x.type === "mortgage");
    assert.ok(mortgageA && Number(mortgageA.id) > 0, "need mortgage calc for compare");
    const mortgageBId = await saveCalculation("mortgage", {
        price: 365000,
        down: 90000,
        ratePercent: 5.9,
        termYears: 25
    });

    const compareCached = await request(`/api/deals/compare/cached?calculationId=${mortgageA.id}`);
    assertStatus(compareCached.response.status, 200, "compare cached");
    assert.equal(Boolean(compareCached.data?.has), false, "compare cached: expected has=false");

    const csrfCmp = await getCsrf("csrf compare");
    const compareRun = await request("/api/deals/compare", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfCmp },
        json: { aId: mortgageA.id, bId: mortgageBId }
    });
    assertStatus(compareRun.response.status, 402, "compare run (no credits)");
    assertNoCreditsPayload(compareRun.data, "compare run (no credits)");

    const csrfPdf = await getCsrf("csrf pdf");
    const pdf = await request("/api/report/pdf", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfPdf },
        json: { calculationId: firstSaved.id }
    });
    assertStatus(pdf.response.status, 402, "pdf export (no credits)");
    assertNoCreditsPayload(pdf.data, "pdf export (no credits)");

    const csrfDelete = await getCsrf("csrf delete");
    const del = await request(`/api/app/calculation/${firstSaved.id}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": csrfDelete }
    });
    assertStatus(del.response.status, 200, "delete calculation");

    const afterDelete = await request(`/api/app/calculation/${firstSaved.id}`);
    assertStatus(afterDelete.response.status, 404, "deleted calculation should be missing");

    const csrf6 = await getCsrf("csrf#logout");
    const logout = await request("/api/auth/logout", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf6 }
    });
    assertStatus(logout.response.status, 200, "logout");

    const afterLogout = await request("/api/app/calculations");
    assertStatus(afterLogout.response.status, 401, "auth guard after logout");

    console.log("[smoke] OK");
}

main().catch((err) => {
    console.error("[smoke] FAILED:", err?.message || err);
    if (String(err?.message || "").toLowerCase().includes("fetch failed")) {
        console.error("[smoke] Hint: start the app first (example: node jsForAuth/server.js), then rerun npm run smoke:api");
    }
    process.exitCode = 1;
});
