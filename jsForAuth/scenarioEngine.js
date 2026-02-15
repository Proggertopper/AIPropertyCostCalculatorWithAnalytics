// scenarioEngine.js

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

function pctStep(value) {
    const abs = Math.abs(value || 0);
    if (abs <= 2) return 0.5;
    if (abs <= 8) return 1.0;
    return 2.0;
}

function moneyStep(value) {
    const abs = Math.abs(value || 0);
    if (abs <= 1000) return 100;
    if (abs <= 10000) return 500;
    return Math.max(1, Math.round(abs * 0.05));
}

function yearsStep(value) {
    const y = Math.abs(value || 0);
    if (y <= 5) return 1;
    if (y <= 15) return 2;
    return 5;
}

// приоритет “рычагов”
function leverScore(key) {
    const k = String(key).toLowerCase();
    const hits = [
        [/rate|interest/i, 10],
        [/mortgage/i, 7],
        [/growth|inflation/i, 8],
        [/rent/i, 8],
        [/price|value|buy|sell/i, 7],
        [/tax|fee|commission/i, 7],
        [/expense|opex|maintenance|hoa/i, 6],
        [/vacancy/i, 6],
        [/down|payment|loan/i, 5],
        [/years|term/i, 5],
    ];
    let s = 1;
    for (const [re, w] of hits) if (re.test(k)) s += w;
    return s;
}

// ---- schema utils ----
// Поддержка 2 форматов:
// 1) old: { price: "money", years: "years" }
// 2) new: { price: {type:"money",min:0,max:...}, years:{type:"years",min:1,max:70} }
function normalizeFieldSchema(fieldSchema) {
    if (!fieldSchema) return null;

    if (typeof fieldSchema === "string") {
        return { type: fieldSchema, min: null, max: null };
    }

    if (typeof fieldSchema === "object") {
        return {
            type: fieldSchema.type || "number",
            min: Number.isFinite(fieldSchema.min) ? fieldSchema.min : null,
            max: Number.isFinite(fieldSchema.max) ? fieldSchema.max : null
        };
    }

    return null;
}

function inferInputSchema(CALC_FORMATS, calculator_type) {
    return CALC_FORMATS?.[calculator_type]?.input || {};
}

function clampBySchema(value, sch) {
    if (!isNum(value)) return value;

    // defaults if min/max not provided (old schema)
    let min = sch?.min;
    let max = sch?.max;

    if (!Number.isFinite(min)) {
        if (sch?.type === "years") min = 1;
        else if (sch?.type === "percent") min = -99;
        else if (sch?.type === "money") min = 0;
        else min = Number.NEGATIVE_INFINITY;
    }

    if (!Number.isFinite(max)) {
        if (sch?.type === "years") max = 100;
        else if (sch?.type === "percent") max = 2000;
        else if (sch?.type === "money") max = Number.MAX_SAFE_INTEGER;
        else max = Number.POSITIVE_INFINITY;
    }

    return clamp(value, min, max);
}

function proposeChangesForField(key, fieldSchema, baseValue) {
    if (!isNum(baseValue)) return [];

    const sch = normalizeFieldSchema(fieldSchema) || { type: "number", min: null, max: null };
    const type = sch.type || "number";

    if (type === "percent") {
        const step = pctStep(baseValue);
        const down = clampBySchema(baseValue - step, sch);
        const up = clampBySchema(baseValue + step, sch);

        // если clamp не изменил значение — сценарий бессмысленный
        const out = [];
        if (down !== baseValue) out.push({ label: `${key} down`, patch: { [key]: down } });
        if (up !== baseValue) out.push({ label: `${key} up`, patch: { [key]: up } });
        return out;
    }

    if (type === "money") {
        const step = moneyStep(baseValue);
        const down = clampBySchema(baseValue - step, sch);
        const up = clampBySchema(baseValue + step, sch);

        const out = [];
        if (down !== baseValue) out.push({ label: `${key} down`, patch: { [key]: down } });
        if (up !== baseValue) out.push({ label: `${key} up`, patch: { [key]: up } });
        return out;
    }

    if (type === "years") {
        const step = yearsStep(baseValue);
        const down = clampBySchema(baseValue - step, sch);
        const up = clampBySchema(baseValue + step, sch);

        const out = [];
        if (down !== baseValue) out.push({ label: `${key} shorter`, patch: { [key]: down } });
        if (up !== baseValue) out.push({ label: `${key} longer`, patch: { [key]: up } });
        return out;
    }

    // number: ±10%
    const step = Math.max(1, Math.round(Math.abs(baseValue) * 0.1));
    const down = clampBySchema(baseValue - step, sch);
    const up = clampBySchema(baseValue + step, sch);

    const out = [];
    if (down !== baseValue) out.push({ label: `${key} down`, patch: { [key]: down } });
    if (up !== baseValue) out.push({ label: `${key} up`, patch: { [key]: up } });
    return out;
}

function applyPatch(baseInput, patch) {
    return { ...baseInput, ...patch };
}

function buildScenarios({ calculator_type, input_data, CALC_FORMATS }, count) {
    const schema = inferInputSchema(CALC_FORMATS, calculator_type);
    const base = input_data || {};

    const keys = Object.keys(schema)
        .filter(k => isNum(base[k]))
        .sort((a, b) => leverScore(b) - leverScore(a));

    // 1) точечные изменения
    const candidates = [];
    for (const k of keys) {
        const changes = proposeChangesForField(k, schema[k], base[k]);
        for (const c of changes) candidates.push(c);
    }

    // 2) комбо: stress + best (теперь тоже clamp по schema)
    const stressPatch = {};
    const bestPatch = {};

    for (const k of keys) {
        const sch = normalizeFieldSchema(schema[k]) || { type: "number", min: null, max: null };
        const type = sch.type || "number";
        const name = k.toLowerCase();
        const v = base[k];
        if (!isNum(v)) continue;

        const isCostLike = /tax|fee|expense|opex|maintenance|hoa|rate|mortgage|commission|vacancy/.test(name);
        const isIncomeLike = /rent|cashflow|noi/.test(name);
        const isGrowthLike = /growth/.test(name);

        if (type === "percent") {
            const step = pctStep(v);

            // costs up in stress, down in best
            if (isCostLike) {
                stressPatch[k] = clampBySchema(v + step, sch);
                bestPatch[k] = clampBySchema(v - step, sch);
            }

            // income/growth down in stress, up in best
            if (isIncomeLike || isGrowthLike) {
                stressPatch[k] = clampBySchema((stressPatch[k] ?? v) - step, sch);
                bestPatch[k] = clampBySchema((bestPatch[k] ?? v) + step, sch);
            }
        }

        if (type === "money") {
            const step = moneyStep(v);

            if (isCostLike) {
                stressPatch[k] = clampBySchema(v + step, sch);
                bestPatch[k] = clampBySchema(v - step, sch);
            }

            if (isIncomeLike) {
                stressPatch[k] = clampBySchema((stressPatch[k] ?? v) - step, sch);
                bestPatch[k] = clampBySchema((bestPatch[k] ?? v) + step, sch);
            }
        }
    }

    const scenarios = [];

    // добавляем комбо только если реально что-то поменялось
    const changed = (patch) => Object.keys(patch).some(k => patch[k] !== base[k]);

    if (Object.keys(stressPatch).length && changed(stressPatch)) {
        scenarios.push({ label: "Stress test (worse market)", input_data: applyPatch(base, stressPatch) });
    }
    if (Object.keys(bestPatch).length && changed(bestPatch)) {
        scenarios.push({ label: "Best case (better assumptions)", input_data: applyPatch(base, bestPatch) });
    }

    for (const c of candidates) {
        if (scenarios.length >= count) break;
        scenarios.push({ label: c.label, input_data: applyPatch(base, c.patch) });
    }

    // уникальность
    const uniq = [];
    const seen = new Set();
    for (const s of scenarios) {
        const h = JSON.stringify(s.input_data);
        if (!seen.has(h)) { seen.add(h); uniq.push(s); }
        if (uniq.length >= count) break;
    }

    return finalizeScenarios(calculator_type, base, uniq, count);
}

function clampNum(x, min, max) {
    const v = Number(x);
    if (!Number.isFinite(v)) return min;
    return Math.max(min, Math.min(max, v));
}
function roundTo(x, step) {
    return Math.round(x / step) * step;
}
function uniqBy(arr, keyFn) {
    const seen = new Set();
    const out = [];
    for (const it of arr) {
        const k = keyFn(it);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(it);
    }
    return out;
}

function stableHash(input) {
    const sorted = Object.keys(input || {})
        .sort()
        .reduce((acc, k) => ((acc[k] = input[k]), acc), {});
    return JSON.stringify(sorted);
}

function changedFieldCount(base, next) {
    const keys = new Set([
        ...Object.keys(base || {}),
        ...Object.keys(next || {})
    ]);
    let n = 0;
    for (const k of keys) {
        if ((base || {})[k] !== (next || {})[k]) n += 1;
    }
    return n;
}

function clampField(out, key, min, max, { step = null, integer = false } = {}) {
    if (!Number.isFinite(Number(out?.[key]))) return;
    let v = clampNum(Number(out[key]), min, max);
    if (step) v = roundTo(v, step);
    if (integer) v = Math.round(v);
    out[key] = v;
}

function sanitizeScenarioInput(type, input) {
    const out = { ...(input || {}) };

    if (type === "mortgage") {
        clampField(out, "price", 1, 500_000_000, { integer: true });
        clampField(out, "down", 0, 500_000_000, { integer: true });
        if (Number.isFinite(out.price) && Number.isFinite(out.down)) {
            const maxDown = Math.max(0, out.price - 1);
            out.down = Math.min(out.down, maxDown);
        }
        clampField(out, "ratePercent", 0, 70, { step: 0.1 });
        clampField(out, "termYears", 1, 70, { integer: true });
        return out;
    }

    if (type === "rent_vs_buy") {
        clampField(out, "rent", 1, 100_000_000, { integer: true });
        clampField(out, "mortgage", 1, 100_000_000, { integer: true });
        clampField(out, "years", 1, 50, { integer: true });
        clampField(out, "propertyValue", 1, 500_000_000, { integer: true });
        clampField(out, "rentGrowth", 0, 50, { step: 0.1 });
        clampField(out, "mortgageRate", 0, 100, { step: 0.1 });
        clampField(out, "propertyGrowth", 0, 50, { step: 0.1 });
        clampField(out, "inflation", 0, 20, { step: 0.1 });
        return out;
    }

    if (type === "break_even") {
        clampField(out, "price", 1, 500_000_000, { integer: true });
        clampField(out, "downPayment", 0, 500_000_000, { integer: true });
        if (Number.isFinite(out.price) && Number.isFinite(out.downPayment)) out.downPayment = Math.min(out.downPayment, out.price);
        clampField(out, "marketRent", 0, 100_000_000, { integer: true });
        clampField(out, "mortgage", 0, 20_000_000, { integer: true });
        clampField(out, "expenses", 0, 10_000_000, { integer: true });
        clampField(out, "taxes", 0, 100_000_000, { integer: true });
        clampField(out, "vacancy", 0, 95, { step: 0.1 });
        return out;
    }

    if (type === "cash_flow") {
        clampField(out, "rent", 0, 100_000_000, { integer: true });
        clampField(out, "vacancy", 0, 99, { step: 0.1 });
        clampField(out, "mortgage", 0, 10_000_000, { integer: true });
        clampField(out, "expenses", 0, 10_000_000, { integer: true });
        clampField(out, "taxes", 0, 70, { step: 0.1 });
        clampField(out, "inflation", -5, 40, { step: 0.1 });
        return out;
    }

    if (type === "property_irr") {
        clampField(out, "price", 1, 500_000_000, { integer: true });
        clampField(out, "downPayment", 0, 500_000_000, { integer: true });
        if (Number.isFinite(out.price) && Number.isFinite(out.downPayment)) out.downPayment = Math.min(out.downPayment, out.price);
        clampField(out, "purchaseCosts", 0, 10_000_000, { integer: true });
        clampField(out, "renovation", 0, 100_000_000, { integer: true });
        clampField(out, "rent", 0, 10_000_000, { integer: true });
        clampField(out, "vacancy", 0, 99, { step: 0.1 });
        clampField(out, "expenses", 0, 5_000_000, { integer: true });
        clampField(out, "mortgage", 0, 10_000_000, { integer: true });
        clampField(out, "years", 1, 100, { integer: true });
        clampField(out, "growth", -99, 2000, { step: 0.1 });
        clampField(out, "saleTax", 0, 80, { step: 0.1 });
        clampField(out, "inflation", -5, 40, { step: 0.1 });
        return out;
    }

    if (type === "renovation_roi") {
        clampField(out, "priceBefore", 1, 500_000_000, { integer: true });
        clampField(out, "rentBefore", 0, 100_000_000, { integer: true });
        clampField(out, "renovationCost", 0, 100_000_000, { integer: true });
        if (Number.isFinite(out.priceBefore) && Number.isFinite(out.renovationCost)) out.renovationCost = Math.min(out.renovationCost, out.priceBefore);
        clampField(out, "priceIncrease", -100, 2000, { step: 0.1 });
        clampField(out, "rentIncrease", -100, 2000, { step: 0.1 });
        clampField(out, "agentFee", 0, 50, { step: 0.1 });
        clampField(out, "saleTax", 0, 60, { step: 0.1 });
        clampField(out, "years", 1, 70, { integer: true });
        clampField(out, "discountRate", 0, 100, { step: 0.1 });
        clampField(out, "inflationRate", 0, 100, { step: 0.1 });
        return out;
    }

    if (type === "property_sale") {
        clampField(out, "buyPrice", 1, 500_000_000, { integer: true });
        clampField(out, "sellPrice", 1, 500_000_000, { integer: true });
        clampField(out, "years", 1, 70, { integer: true });
        clampField(out, "tax", 0, 70, { step: 0.1 });
        clampField(out, "commission", 0, 40, { step: 0.1 });
        clampField(out, "inflation", -10, 50, { step: 0.1 });
        clampField(out, "renovation", 0, 100_000_000, { integer: true });
        return out;
    }

    if (type === "property_taxes") {
        clampField(out, "price", 1, 500_000_000, { integer: true });
        clampField(out, "rent", 0, 30_000_000, { integer: true });
        clampField(out, "years", 1, 70, { integer: true });
        clampField(out, "priceGrowth", -20, 100, { step: 0.1 });
        clampField(out, "propertyTax", 0, 70, { step: 0.1 });
        clampField(out, "rentTax", 0, 70, { step: 0.1 });
        clampField(out, "annualFees", 0, 10_000_000, { integer: true });
        clampField(out, "feeGrowth", 0, 50, { step: 0.1 });
        clampField(out, "saleTax", 0, 60, { step: 0.1 });
        clampField(out, "agentFee", 0, 50, { step: 0.1 });
        clampField(out, "inflationRate", -5, 30, { step: 0.1 });
        return out;
    }

    if (type === "ownership_cost") {
        clampField(out, "price", 1, 50_000_000, { integer: true });
        clampField(out, "years", 1, 100, { integer: true });
        clampField(out, "taxPercent", 0, 90, { step: 0.1 });
        clampField(out, "maintenance", 0, 10_000_000, { integer: true });
        clampField(out, "inflation", -5, 40, { step: 0.1 });
        return out;
    }

    if (type === "alternative_investment") {
        clampField(out, "propertyInitial", 1, 100_000_000, { integer: true });
        clampField(out, "propertyCashflow", -10_000_000, 10_000_000, { integer: true });
        clampField(out, "propertyGrowth", -99, 2000, { step: 0.1 });
        clampField(out, "propertyInflation", 0, 100, { step: 0.1 });
        clampField(out, "propertyTaxRate", 0, 100, { step: 0.1 });
        clampField(out, "altReturn", -99, 2000, { step: 0.1 });
        clampField(out, "altContribution", 0, 10_000_000, { integer: true });
        clampField(out, "altInflation", 0, 100, { step: 0.1 });
        clampField(out, "altTaxRate", 0, 100, { step: 0.1 });
        clampField(out, "years", 1, 80, { integer: true });
        return out;
    }

    if (type === "mortgage_overpayment") {
        clampField(out, "loan", 1, 100_000_000, { integer: true });
        clampField(out, "rate", 0.1, 70, { step: 0.1 });
        clampField(out, "years", 1, 70, { integer: true });
        clampField(out, "inflation", 0, 50, { step: 0.1 });
        return out;
    }

    return out;
}

function finalizeScenarios(type, baseInput, scenarios, count) {
    const limit = Math.max(1, Math.min(200, Number(count || 3)));
    const uniq = [];
    const seen = new Set();

    for (const s of scenarios || []) {
        const raw = s?.input_data;
        if (!raw || typeof raw !== "object") continue;

        const input = sanitizeScenarioInput(type, raw);
        if (changedFieldCount(baseInput, input) === 0) continue;

        const h = stableHash(input);
        if (seen.has(h)) continue;
        seen.add(h);

        uniq.push({
            label: s?.label || "Scenario",
            input_data: input
        });

        if (uniq.length >= limit) break;
    }

    return uniq;
}

function buildMortgageScenarios(baseInput, count) {
    const price = Number(baseInput.price || 0);
    const down = Number(baseInput.down || 0);
    const rate = Number(baseInput.ratePercent || 0);
    const term = Number(baseInput.termYears || 0);

    if (!(price > 0 && term > 0)) return [];

    // кандидаты: down/rate/term
    const downSteps = [
        down,
        down + 5000,
        down + 10000,
        down + 20000,
        Math.min(price * 0.25, down + 30000),
    ].map(x => roundTo(clampNum(x, 0, price * 0.9), 1000));

    const rateSteps = [
        rate,
        rate - 0.5,
        rate - 1.0,
        rate - 1.5,
        rate + 0.5, // стресс-тест
    ].map(x => roundTo(clampNum(x, 0.0, 20), 0.1));

    const termSteps = uniqBy([
        term,
        15, 20, 25, 30, 35
    ].map(x => clampNum(x, 5, 40)), x => x);

    // objective: “лучше” = меньше totalPayment, а monthly как вторичный фактор
    // (потом на UI ты покажешь оба)
    const candidates = [];

    // 1) quick win set (красивые понятные сценарии)
    const down25 = roundTo(clampNum(Math.max(down, price * 0.25), 0, price * 0.9), 1000);
    const down30 = roundTo(clampNum(Math.max(down, price * 0.30), 0, price * 0.9), 1000);
    const rateDown05 = roundTo(clampNum(rate - 0.5, 0.5, 20), 0.1);
    const rateDown10 = roundTo(clampNum(rate - 1.0, 0.5, 20), 0.1);

    candidates.push({ label: "Refinance: rate −0.5%", input_data: { ...baseInput, ratePercent: rateDown05 } });
    candidates.push({ label: "Refinance: rate −1.0%", input_data: { ...baseInput, ratePercent: rateDown10 } });
    candidates.push({ label: "Down payment to 25%", input_data: { ...baseInput, down: down25 } });
    candidates.push({ label: "Shorter term: 20 years", input_data: { ...baseInput, termYears: 20 } });
    candidates.push({ label: "Lower monthly: 30 years", input_data: { ...baseInput, termYears: 30 } });


    // 2) grid-search (дает “вау”)
    for (const d of downSteps) {
        for (const r of rateSteps) {
            for (const t of termSteps) {
                // не делаем слишком дикие изменения одновременно
                const bigDownJump = Math.abs(d - down) > 30000;
                const bigRateJump = Math.abs(r - rate) > 2.0;
                const bigTermJump = Math.abs(t - term) > 15;
                if ((bigDownJump && bigRateJump) || (bigDownJump && bigTermJump)) continue;

                candidates.push({
                    label: `Search: down ${Math.round(d)} / rate ${r}% / term ${t}y`,
                    input_data: { ...baseInput, down: d, ratePercent: r, termYears: t }
                });
            }
        }
    }

    // уникализация по input
    const unique = uniqBy(candidates, s => {
        const x = s.input_data || {};
        return [x.price, x.down, x.ratePercent, x.termYears].join("|");
    });

    return finalizeScenarios("mortgage", baseInput, unique, count);
}

function buildRentVsBuyScenarios(baseInput, count) {
    const base = baseInput || {};
    const years = Number(base.years || 0);
    const rent = Number(base.rent || 0);
    const mortgageRate = Number(base.mortgageRate || 0);
    const rentGrowth = Number(base.rentGrowth || 0);
    const propertyGrowth = Number(base.propertyGrowth || 0);

    if (!(years > 0 && rent > 0)) return [];

    const clampRate = (x) => clampNum(x, 0, 100);
    const clampGrowth = (x) => clampNum(x, 0, 50);
    const clampYears = (x) => clampNum(x, 1, 50);

    const yShort = clampYears(Math.max(1, Math.round(years * 0.6)));
    const yLong = clampYears(Math.round(years * 1.4));

    const rateUp = roundTo(clampRate(mortgageRate + 1.0), 0.1);
    const rateDown = roundTo(clampRate(mortgageRate - 1.0), 0.1);

    const rgUp = roundTo(clampGrowth(rentGrowth + 1.0), 0.1);
    const rgDown = roundTo(clampGrowth(rentGrowth - 1.0), 0.1);

    const pgUp = roundTo(clampGrowth(propertyGrowth + 1.5), 0.1);
    const pgDown = roundTo(clampGrowth(propertyGrowth - 1.5), 0.1);

    const candidates = [
        // Bucket 1: Horizon (самый сильный рычаг)
        { label: "Short horizon: move sooner", input_data: { ...base, years: yShort } },
        { label: "Long horizon: stay longer", input_data: { ...base, years: yLong } },

        // Bucket 2: Rate shock / refinance
        { label: "Rate shock: mortgageRate +1.0%", input_data: { ...base, mortgageRate: rateUp } },
        { label: "Refinance: mortgageRate −1.0%", input_data: { ...base, mortgageRate: rateDown } },

        // Bucket 3: Growth swing
        { label: "Rent growth higher: rentGrowth +1.0%", input_data: { ...base, rentGrowth: rgUp } },
        { label: "Rent growth lower: rentGrowth −1.0%", input_data: { ...base, rentGrowth: rgDown } },
        { label: "Property growth higher: propertyGrowth +1.5%", input_data: { ...base, propertyGrowth: pgUp } },
        { label: "Property growth lower: propertyGrowth −1.5%", input_data: { ...base, propertyGrowth: pgDown } },
    ];

    // uniq + trim
    const unique = uniqBy(candidates, s => JSON.stringify(s.input_data || {}));
    return finalizeScenarios("rent_vs_buy", base, unique, count);
}

function buildBreakEvenScenarios(baseInput, count) {
    const base = baseInput || {};

    const price = Number(base.price || 0);
    const marketRent = Number(base.marketRent || 0);
    const expenses = Number(base.expenses || 0);
    const taxes = Number(base.taxes || 0);
    const vacancy = Number(base.vacancy ?? 0);
    const mortgage = Number(base.mortgage || 0);

    if (!(price > 0 && marketRent >= 0)) return [];

    const out = [];

    // 1) Rent uplift: +5% and +10%
    if (marketRent > 0) {
        out.push({ label: "Rent +5% (raise income)", input_data: { ...base, marketRent: Math.round(marketRent * 1.05) } });
        out.push({ label: "Rent +10% (raise income)", input_data: { ...base, marketRent: Math.round(marketRent * 1.10) } });
    }

    // 2) Price negotiation: -3% and -7% (improves break-even price logic + deal feasibility)
    out.push({ label: "Negotiate price −3%", input_data: { ...base, price: Math.round(price * 0.97) } });
    out.push({ label: "Negotiate price −7%", input_data: { ...base, price: Math.round(price * 0.93) } });

    // 3) Expense optimization: -10% expenses, -10% taxes
    if (expenses > 0) out.push({ label: "Expenses −10% (optimize opex)", input_data: { ...base, expenses: Math.round(expenses * 0.90) } });
    if (taxes > 0) out.push({ label: "Taxes −10% (reassess tax/insurance)", input_data: { ...base, taxes: Math.round(taxes * 0.90) } });

    // 4) Vacancy realism: +5% stress (worse), -5% best (better) within 0..95
    const vUp = Math.min(95, Math.max(0, vacancy + 5));
    const vDown = Math.min(95, Math.max(0, vacancy - 5));
    if (vUp !== vacancy) out.push({ label: "Stress: vacancy +5%", input_data: { ...base, vacancy: vUp } });
    if (vDown !== vacancy) out.push({ label: "Best: vacancy −5%", input_data: { ...base, vacancy: vDown } });

    // 5) Financing lever if mortgage exists: mortgage −5% (refi / better terms)
    if (mortgage > 0) out.push({ label: "Financing: mortgage −5%", input_data: { ...base, mortgage: Math.round(mortgage * 0.95) } });

    // uniq + trim
    const uniq = [];
    const seen = new Set();
    for (const s of out) {
        const h = JSON.stringify(s.input_data);
        if (seen.has(h)) continue;
        seen.add(h);
        uniq.push(s);
        const limit = Math.max(1, Math.min(200, Number(count || 3)));
        if (uniq.length >= limit) break;
    }

    return finalizeScenarios("break_even", base, uniq, count);
}

function buildCashFlowScenarios(baseInput, count) {
    const base = baseInput || {};

    const rent = Number(base.rent || 0);
    const vacancy = Number(base.vacancy ?? 0);
    const mortgage = Number(base.mortgage || 0);
    const expenses = Number(base.expenses || 0);
    const taxes = Number(base.taxes ?? 0);

    if (!(rent > 0)) return [];

    const out = [];

    // Income lever
    out.push({ label: "Rent +5% (raise income)", input_data: { ...base, rent: Math.round(rent * 1.05) } });
    out.push({ label: "Rent +10% (raise income)", input_data: { ...base, rent: Math.round(rent * 1.10) } });

    // Expense lever
    if (expenses > 0) out.push({ label: "Expenses −10% (optimize opex)", input_data: { ...base, expenses: Math.round(expenses * 0.90) } });

    // Mortgage lever
    if (mortgage > 0) out.push({ label: "Refinance: mortgage −5%", input_data: { ...base, mortgage: Math.round(mortgage * 0.95) } });

    // Vacancy stress / best
    const vUp = Math.min(99, Math.max(0, vacancy + 5));
    const vDown = Math.min(99, Math.max(0, vacancy - 5));
    if (vUp !== vacancy) out.push({ label: "Stress: vacancy +5%", input_data: { ...base, vacancy: vUp } });
    if (vDown !== vacancy) out.push({ label: "Best: vacancy −5%", input_data: { ...base, vacancy: vDown } });

    // Taxes stress (percent)
    if (Number.isFinite(taxes)) {
        const tUp = Math.min(70, Math.max(0, taxes + 2));
        if (tUp !== taxes) out.push({ label: "Stress: taxes +2%", input_data: { ...base, taxes: tUp } });
    }

    // uniq + trim
    const uniq = [];
    const seen = new Set();
    for (const s of out) {
        const h = JSON.stringify(s.input_data);
        if (seen.has(h)) continue;
        seen.add(h);
        uniq.push(s);
        const limit = Math.max(1, Math.min(200, Number(count || 3)));
        if (uniq.length >= limit) break;
    }
    return finalizeScenarios("cash_flow", base, uniq, count);
}

function buildIRRScenarios(baseInput, count) {
    const base = baseInput || {};

    const price = Number(base.price || 0);
    const rent = Number(base.rent || 0);
    const expenses = Number(base.expenses || 0);
    const vacancy = Number(base.vacancy ?? 0);
    const years = Number(base.years || 0);
    const growth = Number(base.growth ?? 0);
    const saleTax = Number(base.saleTax ?? 0);
    const mortgage = Number(base.mortgage || 0);

    if (!(price > 0 && years > 0)) return [];

    const out = [];

    // A) income lever
    if (rent > 0) {
        out.push({ label: "Income: rent +5%", input_data: { ...base, rent: Math.round(rent * 1.05) } });
        out.push({ label: "Income: rent +10%", input_data: { ...base, rent: Math.round(rent * 1.10) } });
    }

    // B) cost lever
    if (expenses > 0) {
        out.push({ label: "Costs: expenses −10%", input_data: { ...base, expenses: Math.round(expenses * 0.90) } });
    }

    // C) exit lever (growth)
    if (Number.isFinite(growth)) {
        const gUp = Math.min(30, growth + 1);
        out.push({ label: "Exit: growth +1%", input_data: { ...base, growth: gUp } });
    }

    // Exit cost lever (sale tax)
    if (Number.isFinite(saleTax) && saleTax > 0) {
        const stDown = Math.max(0, saleTax - 1);
        if (stDown !== saleTax) out.push({ label: "Exit: sale tax −1%", input_data: { ...base, saleTax: stDown } });
    }

    // Price negotiation lever
    out.push({ label: "Deal: price −3% (negotiate)", input_data: { ...base, price: Math.round(price * 0.97) } });

    // Finance lever
    if (mortgage > 0) out.push({ label: "Finance: mortgage −5% (refi)", input_data: { ...base, mortgage: Math.round(mortgage * 0.95) } });

    // Vacancy stress/best
    const vUp = Math.min(99, Math.max(0, vacancy + 5));
    const vDown = Math.min(99, Math.max(0, vacancy - 5));
    if (vUp !== vacancy) out.push({ label: "Stress: vacancy +5%", input_data: { ...base, vacancy: vUp } });
    if (vDown !== vacancy) out.push({ label: "Best: vacancy −5%", input_data: { ...base, vacancy: vDown } });

    // Cost stress
    if (expenses > 0) out.push({ label: "Stress: expenses +10%", input_data: { ...base, expenses: Math.round(expenses * 1.10) } });

    // uniq + trim
    const uniq = [];
    const seen = new Set();
    for (const s of out) {
        const h = JSON.stringify(s.input_data);
        if (seen.has(h)) continue;
        seen.add(h);
        uniq.push(s);
        const limit = Math.max(1, Math.min(200, Number(count || 3)));
        if (uniq.length >= limit) break;
    }
    return finalizeScenarios("property_irr", base, uniq, count);
}

function buildRenovationRoiScenarios(baseInput, count) {
    const base = baseInput || {};

    const renovationCost = Number(base.renovationCost || 0);
    const priceIncrease = Number(base.priceIncrease ?? 0);
    const rentIncrease = Number(base.rentIncrease ?? 0);
    const agentFee = Number(base.agentFee ?? 0);
    const discountRate = Number(base.discountRate ?? 0);
    const inflationRate = Number(base.inflationRate ?? 0);
    const years = Number(base.years || 0);

    if (!(renovationCost > 0)) return [];

    const out = [];

    // Scenario A: win by cost control
    out.push({ label: "Costs: renovation −10%", input_data: { ...base, renovationCost: Math.round(renovationCost * 0.90) } });

    // Scenario B: win by uplift (value)
    if (Number.isFinite(priceIncrease)) {
        out.push({ label: "Value uplift: price increase +2%", input_data: { ...base, priceIncrease: Math.min(200, priceIncrease + 2) } });
    }

    // Scenario C: win by uplift (rent)
    if (Number.isFinite(rentIncrease)) {
        out.push({ label: "Rent uplift: rent increase +1%", input_data: { ...base, rentIncrease: Math.min(200, rentIncrease + 1) } });
    }

    // Stress: renovation overruns
    out.push({ label: "Stress: renovation +10%", input_data: { ...base, renovationCost: Math.round(renovationCost * 1.10) } });

    // Stress: selling costs
    if (Number.isFinite(agentFee)) {
        out.push({ label: "Stress: agent fee +1%", input_data: { ...base, agentFee: Math.min(50, agentFee + 1) } });
    }

    // Stress: discount/inflation up
    if (Number.isFinite(discountRate)) {
        out.push({ label: "Stress: discount rate +1%", input_data: { ...base, discountRate: Math.min(100, discountRate + 1) } });
    }
    if (Number.isFinite(inflationRate)) {
        out.push({ label: "Stress: inflation +1%", input_data: { ...base, inflationRate: Math.min(100, inflationRate + 1) } });
    }

    // Optional horizon
    if (years > 0) out.push({ label: "Horizon: years +2", input_data: { ...base, years: Math.min(70, years + 2) } });

    // uniq + trim
    const uniq = [];
    const seen = new Set();
    for (const s of out) {
        const h = JSON.stringify(s.input_data);
        if (seen.has(h)) continue;
        seen.add(h);
        uniq.push(s);
        const limit = Math.max(1, Math.min(200, Number(count || 3)));
        if (uniq.length >= limit) break;
    }
    return finalizeScenarios("renovation_roi", base, uniq, count);
}

function buildPropertySaleScenarios(baseInput, count) {
    const base = baseInput || {};

    const buyPrice = Number(base.buyPrice || 0);
    const sellPrice = Number(base.sellPrice || 0);
    const years = Number(base.years || 0);
    const tax = Number(base.tax ?? 0);
    const commission = Number(base.commission ?? 0);
    const inflation = Number(base.inflation ?? 0);
    const renovation = Number(base.renovation || 0);

    if (!(buyPrice > 0 && sellPrice > 0 && years > 0)) return [];

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const roundMoney = (v) => Math.round(v);
    const add = (label, patch) => out.push({ label, input_data: { ...base, ...patch } });

    const out = [];

    // --- Exit price (most important driver) ---
    add("Sell price +5% (better exit)", { sellPrice: roundMoney(sellPrice * 1.05) });
    add("Sell price +10% (strong exit)", { sellPrice: roundMoney(sellPrice * 1.10) });
    add("Sell price +15% (very strong exit)", { sellPrice: roundMoney(sellPrice * 1.15) });
    add("Sell price +20% (aggressive upside)", { sellPrice: roundMoney(sellPrice * 1.20) });
    add("Sell price +30% (high-conviction upside)", { sellPrice: roundMoney(sellPrice * 1.30) });
    add("Sell price +50% (break-even hunt)", { sellPrice: roundMoney(sellPrice * 1.50) });
    add("Stress: sell price −5%", { sellPrice: roundMoney(sellPrice * 0.95) });
    add("Stress: sell price −10%", { sellPrice: roundMoney(sellPrice * 0.90) });

    // --- Fees / taxes ---
    add("Commission −1% (optimize agent fee)", { commission: clamp(commission - 1, 0, 40) });
    add("Commission −2% (aggressive negotiation)", { commission: clamp(commission - 2, 0, 40) });
    add("Stress: commission +1% (worse agent deal)", { commission: clamp(commission + 1, 0, 40) });

    add("Stress: tax +1%", { tax: clamp(tax + 1, 0, 70) });
    add("Stress: tax +3%", { tax: clamp(tax + 3, 0, 70) });
    add("Tax −1% (optimization / different jurisdiction)", { tax: clamp(tax - 1, 0, 70) });

    // --- Holding period (affects annualized + real return) ---
    add("Holding period −1 year (faster exit)", { years: clamp(years - 1, 1, 70) });
    add("Holding period +2 years (longer hold)", { years: clamp(years + 2, 1, 70) });

    // --- Inflation (affects real return) ---
    if (Number.isFinite(inflation) && inflation > 0) {
        add("Inflation −1% (easier macro)", { inflation: clamp(inflation - 1, -10, 50) });
        add("Stress: inflation +1% (harder macro)", { inflation: clamp(inflation + 1, -10, 50) });
    } else {
        // если инфляция не задана/0 — всё равно полезно показать стресс
        add("Stress: inflation +2% (harder macro)", { inflation: 2 });
    }

    // --- Renovation sensitivity ---
    if (renovation > 0) {
        add("Renovation −10% (cost control)", { renovation: roundMoney(renovation * 0.90) });
        add("Renovation −20% (strong savings)", { renovation: roundMoney(renovation * 0.80) });
        add("Stress: renovation +10% (overrun)", { renovation: roundMoney(renovation * 1.10) });
        add("Stress: renovation +25% (big overrun)", { renovation: roundMoney(renovation * 1.25) });
    }

    // --- Combo scenarios (usually highest value + ensures uniqueness) ---
    // "Rescue plan": better exit + cost control
    if (renovation > 0) {
        add("Rescue: sell +10% & renovation −10%", {
            sellPrice: roundMoney(sellPrice * 1.10),
            renovation: roundMoney(renovation * 0.90)
        });
    }
    add("Rescue: sell +10% & commission −1%", {
        sellPrice: roundMoney(sellPrice * 1.10),
        commission: clamp(commission - 1, 0, 40)
    });
    add("Rescue: sell +20% & commission −1%", {
        sellPrice: roundMoney(sellPrice * 1.20),
        commission: clamp(commission - 1, 0, 40)
    });

    // "Bad market": sell down + inflation up
    add("Bad market: sell −10% & inflation +1%", {
        sellPrice: roundMoney(sellPrice * 0.90),
        inflation: clamp((Number.isFinite(inflation) ? inflation : 0) + 1, -10, 50)
    });

    // --- uniq + trim (stable: key order) ---
    const uniq = [];
    const seen = new Set();

    for (const s of out) {
        // сортируем ключи, чтобы JSON.stringify был стабильным даже если patch порядок разный
        const input = s.input_data;
        const sorted = Object.keys(input).sort().reduce((acc, k) => (acc[k] = input[k], acc), {});
        const h = JSON.stringify(sorted);

        if (seen.has(h)) continue;
        seen.add(h);
        uniq.push(s);
        const limit = Math.max(1, Math.min(200, Number(count || 3)));
        if (uniq.length >= limit) break;
    }

    return finalizeScenarios("property_sale", base, uniq, count);
}


function buildPropertyTaxesScenarios(baseInput, count) {
    const base = baseInput || {};

    const years = Number(base.years || 0);
    const price = Number(base.price || 0);

    const priceGrowth = Number(base.priceGrowth ?? 0);

    const propertyTax = Number(base.propertyTax ?? 0);
    const rentTax = Number(base.rentTax ?? 0);

    const annualFees = Number(base.annualFees || 0);
    const feeGrowth = Number(base.feeGrowth ?? 0);

    const saleTax = Number(base.saleTax ?? 0);
    const agentFee = Number(base.agentFee ?? 0);

    const inflationRate = Number(base.inflationRate ?? 0);

    if (!(price > 0 && years > 0)) return [];

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const roundMoney = (v) => Math.round(v);

    const out = [];
    const add = (label, patch) => out.push({ label, input_data: { ...base, ...patch } });

    // -------------------------
    // 1) Taxes (biggest policy drivers)
    // -------------------------
    add("Optimize property tax −1%", { propertyTax: clamp(propertyTax - 1, 0, 70) });
    add("Optimize property tax −2% (strong relief)", { propertyTax: clamp(propertyTax - 2, 0, 70) });

    add("Stress: property tax +1%", { propertyTax: clamp(propertyTax + 1, 0, 70) });
    add("Stress: property tax +3% (tax hike)", { propertyTax: clamp(propertyTax + 3, 0, 70) });

    if (rentTax > 0) {
        add("Optimize rent tax −1%", { rentTax: clamp(rentTax - 1, 0, 70) });
        add("Optimize rent tax −2% (strong relief)", { rentTax: clamp(rentTax - 2, 0, 70) });
    }
    add("Stress: rent tax +1%", { rentTax: clamp(rentTax + 1, 0, 70) });

    // -------------------------
    // 2) Fees (recurring drag)
    // -------------------------
    add("Fees grow slower (feeGrowth −2%)", { feeGrowth: clamp(feeGrowth - 2, 0, 50) });
    add("Fees grow slower (feeGrowth −4%)", { feeGrowth: clamp(feeGrowth - 4, 0, 50) });

    add("Stress: feeGrowth +2%", { feeGrowth: clamp(feeGrowth + 2, 0, 50) });
    add("Stress: feeGrowth +5% (bad HOA trajectory)", { feeGrowth: clamp(feeGrowth + 5, 0, 50) });

    if (annualFees > 0) {
        add("Fees −10% (audit recurring charges)", { annualFees: Math.max(0, roundMoney(annualFees * 0.90)) });
        add("Fees −20% (hard renegotiation)", { annualFees: Math.max(0, roundMoney(annualFees * 0.80)) });
        add("Stress: fees +10%", { annualFees: roundMoney(annualFees * 1.10) });
        add("Stress: fees +25% (major surprise)", { annualFees: roundMoney(annualFees * 1.25) });
    }

    // -------------------------
    // 3) Exit friction (one-time, but can be huge)
    // -------------------------
    add("Negotiate agent fee −1%", { agentFee: clamp(agentFee - 1, 0, 50) });
    add("Negotiate agent fee −2% (strong negotiation)", { agentFee: clamp(agentFee - 2, 0, 50) });
    add("Stress: agent fee +1% (worse exit)", { agentFee: clamp(agentFee + 1, 0, 50) });

    add("Optimize sale tax −1%", { saleTax: clamp(saleTax - 1, 0, 60) });
    add("Stress: sale tax +1%", { saleTax: clamp(saleTax + 1, 0, 60) });

    // -------------------------
    // 4) Macro / appreciation (changes base of taxes/fees outcome)
    // -------------------------
    add("Property growth +1% (strong market)", { priceGrowth: clamp(priceGrowth + 1, -20, 100) });
    add("Property growth +2% (very strong)", { priceGrowth: clamp(priceGrowth + 2, -20, 100) });
    add("Stress: property growth −1% (weak market)", { priceGrowth: clamp(priceGrowth - 1, -20, 100) });
    add("Stress: property growth −3% (bad market)", { priceGrowth: clamp(priceGrowth - 3, -20, 100) });

    add("Inflation −1% (easier macro)", { inflationRate: clamp(inflationRate - 1, -5, 30) });
    add("Stress: inflation +1% (harder macro)", { inflationRate: clamp(inflationRate + 1, -5, 30) });
    add("Stress: inflation +3% (high inflation)", { inflationRate: clamp(inflationRate + 3, -5, 30) });

    // -------------------------
    // 5) Combo scenarios (best value / ensure uniqueness)
    // -------------------------
    add("Rescue: propertyTax −1% & fees −10%", {
        propertyTax: clamp(propertyTax - 1, 0, 70),
        annualFees: annualFees > 0 ? Math.max(0, roundMoney(annualFees * 0.90)) : annualFees
    });

    add("Rescue: agentFee −1% & saleTax −1%", {
        agentFee: clamp(agentFee - 1, 0, 50),
        saleTax: clamp(saleTax - 1, 0, 60)
    });

    add("Bad policy shock: propertyTax +1% & rentTax +1%", {
        propertyTax: clamp(propertyTax + 1, 0, 70),
        rentTax: clamp(rentTax + 1, 0, 70)
    });

    add("HOA nightmare: fees +25% & feeGrowth +5%", {
        annualFees: annualFees > 0 ? roundMoney(annualFees * 1.25) : annualFees,
        feeGrowth: clamp(feeGrowth + 5, 0, 50)
    });

    add("Bad macro: inflation +3% & growth −3%", {
        inflationRate: clamp(inflationRate + 3, -5, 30),
        priceGrowth: clamp(priceGrowth - 3, -20, 100)
    });

    // -------------------------
    // uniq + trim (stable hash)
    // -------------------------
    const uniq = [];
    const seen = new Set();

    for (const s of out) {
        const input = s.input_data;
        const sorted = Object.keys(input).sort().reduce((acc, k) => (acc[k] = input[k], acc), {});
        const h = JSON.stringify(sorted);

        if (seen.has(h)) continue;
        seen.add(h);
        uniq.push(s);
        const limit = Math.max(1, Math.min(200, Number(count || 3)));
        if (uniq.length >= limit) break;
    }

    return finalizeScenarios("property_taxes", base, uniq, count);
}


function buildOwnershipCostScenarios(baseInput, count) {
    const base = baseInput || {};

    const price = Number(base.price || 0);
    const years = Number(base.years || 0);
    const taxPercent = Number(base.taxPercent ?? 0);
    const maintenance = Number(base.maintenance || 0);
    const inflation = Number(base.inflation ?? 0); // у тебя именно inflation в inputData

    if (!(price > 0 && years > 0)) return [];

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const roundMoney = (v) => Math.round(v);

    const out = [];
    const add = (label, patch) =>
        out.push({ label, input_data: { ...base, ...patch } });

    // 1) Tax percent
    add("Optimize tax −1% (check exemptions)", { taxPercent: clamp(taxPercent - 1, 0, 90) });
    add("Optimize tax −2% (appeal / reassess)", { taxPercent: clamp(taxPercent - 2, 0, 90) });
    add("Stress: tax +1%", { taxPercent: clamp(taxPercent + 1, 0, 90) });

    // 2) Maintenance (annual)
    if (maintenance > 0) {
        add("Maintenance −10% (vendor quotes)", { maintenance: Math.max(0, roundMoney(maintenance * 0.90)) });
        add("Maintenance −20% (optimize scope)", { maintenance: Math.max(0, roundMoney(maintenance * 0.80)) });
        add("Stress: maintenance +10%", { maintenance: roundMoney(maintenance * 1.10) });
        add("Stress: maintenance +25% (repairs)", { maintenance: roundMoney(maintenance * 1.25) });
    } else {
        // если maintenance = 0, всё равно надо дать meaningful сценарии
        add("Assume maintenance $500/yr", { maintenance: 500 });
        add("Assume maintenance $1,500/yr", { maintenance: 1500 });
    }

    // 3) Inflation sensitivity (влияет на PV и на рост номинальных расходов в твоей модели)
    add("Inflation −1% (easier macro)", { inflation: clamp(inflation - 1, -5, 40) });
    add("Stress: inflation +1% (harder macro)", { inflation: clamp(inflation + 1, -5, 40) });
    add("Stress: inflation +3% (high inflation)", { inflation: clamp(inflation + 3, -5, 40) });

    // 4) Horizon sensitivity
    add("Shorter hold: years −1", { years: clamp(years - 1, 1, 100) });
    add("Shorter hold: years −2", { years: clamp(years - 2, 1, 100) });
    add("Longer hold: years +5", { years: clamp(years + 5, 1, 100) });

    const uniq = [];
    const seen = new Set();

    for (const s of out) {
        const input = s.input_data;
        const sorted = Object.keys(input)
            .sort()
            .reduce((acc, k) => (acc[k] = input[k], acc), {});
        const h = JSON.stringify(sorted);
        if (seen.has(h)) continue;
        seen.add(h);
        uniq.push(s);
        const limit = Math.max(1, Math.min(200, Number(count || 3)));
        if (uniq.length >= limit) break;
    }

    return finalizeScenarios("ownership_cost", base, uniq, count);
}



function buildAlternativeInvestmentScenarios(baseInput, count) {
    const base = baseInput || {};
    const years = Number(base.years || 0);
    const propertyInitial = Number(base.propertyInitial || 0);
    const propertyCashflow = Number(base.propertyCashflow || 0);
    const propertyGrowth = Number(base.propertyGrowth ?? 0);
    const propertyInflation = Number(base.propertyInflation ?? 0);
    const propertyTaxRate = Number(base.propertyTaxRate ?? 0);

    const altReturn = Number(base.altReturn ?? 0);
    const altContribution = Number(base.altContribution ?? 0);
    const altInflation = Number(base.altInflation ?? 0);
    const altTaxRate = Number(base.altTaxRate ?? 0);

    if (!(propertyInitial > 0 && years > 0)) return [];

    const out = [];
    const clampPct = (v) => clampNum(v, -99, 2000);
    const clampTax = (v) => clampNum(v, 0, 100);
    const clampInfl = (v) => clampNum(v, 0, 100);
    const clampMoney = (v) => clampNum(Math.round(v), 0, 10_000_000);
    const clampYears = (v) => clampNum(Math.round(v), 1, 80);
    const add = (label, patch) => out.push({ label, input_data: { ...base, ...patch } });

    // 1) Alternative side levers (directly affects computeAlternativeInvestment)
    add("Alternative return +2% (better market)", { altReturn: clampPct(altReturn + 2) });
    add("Alternative return +5% (strong market)", { altReturn: clampPct(altReturn + 5) });
    add("Stress: alternative return -2%", { altReturn: clampPct(altReturn - 2) });
    add("Stress: alternative return -5%", { altReturn: clampPct(altReturn - 5) });

    if (altContribution > 0) {
        add("Alternative contribution +10%", { altContribution: clampMoney(altContribution * 1.10) });
        add("Alternative contribution +25%", { altContribution: clampMoney(altContribution * 1.25) });
        add("Stress: contribution -10%", { altContribution: clampMoney(altContribution * 0.90) });
    }

    if (Number.isFinite(altTaxRate)) {
        add("Alternative tax -1% (better tax drag)", { altTaxRate: clampTax(altTaxRate - 1) });
        add("Alternative tax -2% (strong optimization)", { altTaxRate: clampTax(altTaxRate - 2) });
        add("Stress: alternative tax +1%", { altTaxRate: clampTax(altTaxRate + 1) });
    }

    if (Number.isFinite(altInflation)) {
        add("Alternative inflation -1% (easier macro)", { altInflation: clampInfl(altInflation - 1) });
        add("Stress: alternative inflation +1%", { altInflation: clampInfl(altInflation + 1) });
    }

    // 2) Property side levers (relative winner can flip)
    if (Number.isFinite(propertyGrowth)) {
        add("Property growth +1% (property tailwind)", { propertyGrowth: clampPct(propertyGrowth + 1) });
        add("Stress: property growth -1%", { propertyGrowth: clampPct(propertyGrowth - 1) });
    }

    if (Number.isFinite(propertyTaxRate)) {
        add("Property tax -1% (tax relief)", { propertyTaxRate: clampTax(propertyTaxRate - 1) });
        add("Stress: property tax +1%", { propertyTaxRate: clampTax(propertyTaxRate + 1) });
    }

    if (propertyCashflow !== 0) {
        add("Property cashflow +10%", { propertyCashflow: Math.round(propertyCashflow * 1.10) });
        add("Stress: property cashflow -10%", { propertyCashflow: Math.round(propertyCashflow * 0.90) });
    }

    if (Number.isFinite(propertyInflation)) {
        add("Property inflation -1% (easier macro)", { propertyInflation: clampInfl(propertyInflation - 1) });
        add("Stress: property inflation +1%", { propertyInflation: clampInfl(propertyInflation + 1) });
    }

    // 3) Horizon sensitivity
    add("Shorter horizon: years -2", { years: clampYears(years - 2) });
    add("Longer horizon: years +2", { years: clampYears(years + 2) });

    // 4) Combo scenarios (high contrast)
    add("Rescue alt: return +2% & tax -1%", {
        altReturn: clampPct(altReturn + 2),
        altTaxRate: clampTax(altTaxRate - 1)
    });
    add("Bad macro alt: return -5% & inflation +1%", {
        altReturn: clampPct(altReturn - 5),
        altInflation: clampInfl(altInflation + 1)
    });
    add("Property edge: growth +1% & property tax -1%", {
        propertyGrowth: clampPct(propertyGrowth + 1),
        propertyTaxRate: clampTax(propertyTaxRate - 1)
    });

    // uniq + trim
    const uniq = [];
    const seen = new Set();
    for (const s of out) {
        const input = s.input_data || {};
        const sorted = Object.keys(input).sort().reduce((acc, k) => (acc[k] = input[k], acc), {});
        const h = JSON.stringify(sorted);
        if (seen.has(h)) continue;
        seen.add(h);
        uniq.push(s);
        const limit = Math.max(1, Math.min(200, Number(count || 3)));
        if (uniq.length >= limit) break;
    }
    return finalizeScenarios("alternative_investment", base, uniq, count);
}


function buildMortgageOverpaymentScenarios(baseInput, count) {
    const base = baseInput || {};
    const loan = Number(base.loan || 0);
    const rate = Number(base.rate ?? base.ratePercent ?? 0);
    const years = Number(base.years || 0);
    const inflation = Number(base.inflation ?? 0);

    if (!(loan > 0 && years > 0)) return [];

    const out = [];

    const r = (x) => roundTo(clampNum(x, 0.1, 70), 0.1);
    const y = (x) => clampNum(Math.round(x), 1, 70);
    const inf = (x) => roundTo(clampNum(x, 0, 50), 0.1);

    // A: refinance ideas (finer grid)
    out.push({ label: "Refinance: rate −0.25%", input_data: { ...base, rate: r(rate - 0.25) } });
    out.push({ label: "Refinance: rate −0.5%", input_data: { ...base, rate: r(rate - 0.5) } });
    out.push({ label: "Refinance: rate −0.75%", input_data: { ...base, rate: r(rate - 0.75) } });
    out.push({ label: "Refinance: rate −1.0%", input_data: { ...base, rate: r(rate - 1.0) } });
    out.push({ label: "Refinance: rate −1.5%", input_data: { ...base, rate: r(rate - 1.5) } });

    // B: shorten term (reduces total interest paid)
    out.push({ label: "Shorter term: −3 years", input_data: { ...base, years: y(years - 3) } });
    out.push({ label: "Shorter term: −5 years", input_data: { ...base, years: y(years - 5) } });
    out.push({ label: "Shorter term: −7 years", input_data: { ...base, years: y(years - 7) } });
    out.push({ label: "Shorter term: −10 years", input_data: { ...base, years: y(years - 10) } });

    // C: inflation sensitivity (real burden)
    out.push({ label: "Inflation +0.5% (real burden down)", input_data: { ...base, inflation: inf(inflation + 0.5) } });
    out.push({ label: "Inflation −0.5% (real burden up)", input_data: { ...base, inflation: inf(inflation - 0.5) } });
    out.push({ label: "Inflation +1% (real burden down)", input_data: { ...base, inflation: inf(inflation + 1.0) } });
    out.push({ label: "Inflation −1% (real burden up)", input_data: { ...base, inflation: inf(inflation - 1.0) } });
    out.push({ label: "Inflation +2% (real burden down)", input_data: { ...base, inflation: inf(inflation + 2.0) } });
    out.push({ label: "Inflation −2% (real burden up)", input_data: { ...base, inflation: inf(inflation - 2.0) } });

    // D: stress tests (rate up)
    out.push({ label: "Stress test: rate +0.5%", input_data: { ...base, rate: r(rate + 0.5) } });
    out.push({ label: "Stress test: rate +1.0%", input_data: { ...base, rate: r(rate + 1.0) } });
    out.push({ label: "Stress test: rate +2.0%", input_data: { ...base, rate: r(rate + 2.0) } });

    // E: combos (often useful + realistic)
    out.push({
        label: "Best case: rate −1% & term −5y",
        input_data: { ...base, rate: r(rate - 1.0), years: y(years - 5) }
    });
    out.push({
        label: "Tough case: rate +1% & inflation −1%",
        input_data: { ...base, rate: r(rate + 1.0), inflation: inf(inflation - 1.0) }
    });
    out.push({
        label: "Re-fi + modest cut: rate −0.5% & term −3y",
        input_data: { ...base, rate: r(rate - 0.5), years: y(years - 3) }
    });

    // uniq + trim
    const uniq = [];
    const seen = new Set();
    for (const s of out) {
        const h = JSON.stringify(s.input_data);
        if (seen.has(h)) continue;
        seen.add(h);
        uniq.push(s);
        const limit = Math.max(1, Math.min(200, Number(count || 3)));
        if (uniq.length >= limit) break;
    }

    return finalizeScenarios("mortgage_overpayment", base, uniq, count);
}



const MINI_TEXT = {
    mortgage: {
        good: " Mortgage looks cost-efficient for these terms (low interest burden).",
        warn: " Costly mortgage: total interest is high. Optimize rate / down payment / term.",
        bad: " Extremely expensive mortgage structure: interest dominates total cost.",
        info: "ℹ Mortgage computed. Add missing inputs to judge the total cost reliably."
    },
    rent_vs_buy: {
        good: " Buying is clearly cheaper than renting under these assumptions.",
        warn: " The result is sensitive: small changes could flip Rent vs Buy.",
        bad: " Buying is significantly more expensive than renting under these assumptions.",
        info: "ℹ Results are close. Review key assumptions (rate, growth, horizon)."
    },
    break_even: {
        good: " Market rent clears break-even with a safety buffer.",
        warn: " Rent is close to break-even — small changes can flip the result.",
        bad: " Market rent is below break-even. Expect negative cash flow under these terms.",
        info: "ℹ Break-even computed. Review inputs to judge viability."
    },
    cash_flow: {
        good: " Cash flow is healthy: positive and resilient under stress assumptions.",
        warn: " Cash flow is positive but fragile — small changes can flip it negative.",
        bad: " Cash flow is negative or fails stress test. High risk of monthly losses.",
        info: "ℹ Cash flow computed. Add missing inputs to judge stability reliably."
    },
    property_irr: {
        good: " IRR looks strong after inflation (real IRR is solid for the horizon).",
        warn: " IRR is positive but not compelling — returns are sensitive to assumptions.",
        bad: " Real IRR is weak or negative after inflation — value likely erodes.",
        info: " IRR computed. Review assumptions (rent, expenses, exit price) for reliability."
    },
    renovation_roi: {
        good: " Renovation ROI looks attractive: positive value creation and payback is reasonable.",
        warn: " Renovation may work, but returns are sensitive to assumptions (rent/value uplift, fees).",
        bad: " Renovation ROI is weak or negative — costs/fees outweigh the uplift.",
        info: " Renovation ROI computed. Verify value uplift and rent uplift assumptions."
    },
    property_sale: {
        good: " Sale looks strong: real annual return is solid after inflation and costs.",
        warn: "Sale is profitable, but real return is low or sensitive to fees/taxes.",
        bad: "Sale is not attractive after inflation and costs (real return or net profit is negative).",
        info: "Sale computed. Verify taxes/fees and holding period assumptions."
    },
    property_taxes: {
        good: "Taxes & fees are manageable: investment stays profitable after inflation.",
        warn: " Taxes/fees noticeably reduce returns. Optimize rates and fee growth assumptions.",
        bad: " Taxes/fees destroy real returns: investment loses value after inflation and costs.",
        info: " Property taxes computed. Verify tax rates, fee growth, and exit costs."
    },
    ownership_cost: {
        good: " Ownership cost is well-controlled: holding the property remains financially efficient.",
        warn: " Ownership costs are high. Review fees, repairs reserve, and tax assumptions.",
        bad:  " Ownership costs are too high vs purchase price — ownership is inefficient under these assumptions.",
        info: " Ownership cost calculated. Verify fees, maintenance, insurance, and tax rates."
    },
    alternative_investment: {
        good: " Alternative investment looks attractive: expected growth and compounding outperform the baseline.",
        warn: " Alternative investment is only moderately better (or close). Recheck return/risk assumptions and fees.",
        bad: " Alternative investment underperforms: assumptions or fee drag make it unattractive vs baseline.",
        info: " Alternative investment calculated. Verify return rate, contributions, fees, and time horizon."
    },
    mortgage_overpayment: {
        good: " Overpayment is acceptable in real terms: inflation meaningfully reduces the real burden.",
        warn: " Overpayment is noticeable. Consider refinancing or shortening the term to reduce total cost.",
        bad: " Overpayment is very high: interest dominates the total cost even after inflation.",
        info: "Overpayment computed. Verify rate, term, and inflation assumptions."
    },
};



module.exports = { buildScenarios, buildMortgageScenarios, buildRentVsBuyScenarios, buildBreakEvenScenarios, buildCashFlowScenarios, buildIRRScenarios, buildRenovationRoiScenarios ,
     buildPropertySaleScenarios , buildPropertyTaxesScenarios, buildOwnershipCostScenarios, buildAlternativeInvestmentScenarios , buildMortgageOverpaymentScenarios, MINI_TEXT };
