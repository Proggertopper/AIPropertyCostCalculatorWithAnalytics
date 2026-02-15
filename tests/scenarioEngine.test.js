const test = require("node:test");
const assert = require("node:assert/strict");

const { computeResultByType } = require("../jsForAuth/compute");
const { CALC_FORMATS } = require("../jsForAuth/calcFormats");
const {
    buildScenarios,
    buildMortgageScenarios,
    buildRentVsBuyScenarios,
    buildBreakEvenScenarios,
    buildCashFlowScenarios,
    buildIRRScenarios,
    buildRenovationRoiScenarios,
    buildPropertySaleScenarios,
    buildPropertyTaxesScenarios,
    buildOwnershipCostScenarios,
    buildAlternativeInvestmentScenarios,
    buildMortgageOverpaymentScenarios,
    MINI_TEXT
} = require("../jsForAuth/scenarioEngine");

function stable(input) {
    const obj = input && typeof input === "object" ? input : {};
    return JSON.stringify(
        Object.keys(obj)
            .sort()
            .reduce((acc, key) => {
                acc[key] = obj[key];
                return acc;
            }, {})
    );
}

function changedKeysCount(base, next) {
    const keys = new Set([...Object.keys(base || {}), ...Object.keys(next || {})]);
    let count = 0;
    for (const key of keys) {
        if ((base || {})[key] !== (next || {})[key]) count += 1;
    }
    return count;
}

function assertScenarioBasics({ type, baseInput, scenarios, maxCount }) {
    assert.ok(Array.isArray(scenarios), `${type}: scenarios must be an array`);
    assert.ok(scenarios.length > 0, `${type}: scenarios should not be empty`);
    assert.ok(scenarios.length <= maxCount, `${type}: must respect requested count`);

    const seen = new Set();
    for (const scenario of scenarios) {
        assert.ok(scenario && typeof scenario === "object", `${type}: scenario must be object`);
        assert.equal(typeof scenario.label, "string", `${type}: label should be string`);
        assert.ok(scenario.label.trim().length > 0, `${type}: label should be non-empty`);
        assert.ok(scenario.input_data && typeof scenario.input_data === "object", `${type}: input_data should exist`);

        const hash = stable(scenario.input_data);
        assert.ok(!seen.has(hash), `${type}: scenario input_data must be unique`);
        seen.add(hash);

        assert.ok(
            changedKeysCount(baseInput, scenario.input_data) > 0,
            `${type}: scenario must change at least one input field`
        );
    }
}

const BASE_INPUTS = {
    mortgage: {
        price: 400000,
        down: 80000,
        ratePercent: 6.5,
        termYears: 30
    },
    rent_vs_buy: {
        rent: 2200,
        mortgage: 2500,
        years: 20,
        propertyValue: 450000,
        rentGrowth: 4,
        mortgageRate: 5.5,
        propertyGrowth: 3,
        inflation: 2
    },
    break_even: {
        price: 350000,
        downPayment: 70000,
        marketRent: 2600,
        mortgage: 1800,
        expenses: 350,
        taxes: 250,
        vacancy: 6
    },
    cash_flow: {
        rent: 2600,
        vacancy: 6,
        mortgage: 1500,
        expenses: 300,
        taxes: 10,
        inflation: 3
    },
    property_irr: {
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
    },
    renovation_roi: {
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
    },
    property_sale: {
        buyPrice: 300000,
        sellPrice: 420000,
        years: 8,
        tax: 8,
        commission: 4,
        inflation: 3,
        renovation: 25000
    },
    property_taxes: {
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
    },
    ownership_cost: {
        price: 350000,
        years: 15,
        taxPercent: 1.2,
        maintenance: 3000,
        inflation: 2
    },
    alternative_investment: {
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
    },
    mortgage_overpayment: {
        loan: 300000,
        rate: 6.5,
        years: 30,
        inflation: 2.5
    }
};

const SPECIALIZED_BUILDERS = {
    mortgage: buildMortgageScenarios,
    rent_vs_buy: buildRentVsBuyScenarios,
    break_even: buildBreakEvenScenarios,
    cash_flow: buildCashFlowScenarios,
    property_irr: buildIRRScenarios,
    renovation_roi: buildRenovationRoiScenarios,
    property_sale: buildPropertySaleScenarios,
    property_taxes: buildPropertyTaxesScenarios,
    ownership_cost: buildOwnershipCostScenarios,
    alternative_investment: buildAlternativeInvestmentScenarios,
    mortgage_overpayment: buildMortgageOverpaymentScenarios
};

test("specialized scenario builders produce unique and computable scenarios", () => {
    const maxCount = 20;

    for (const [type, builder] of Object.entries(SPECIALIZED_BUILDERS)) {
        const baseInput = BASE_INPUTS[type];
        const scenarios = builder(baseInput, maxCount);

        assertScenarioBasics({ type, baseInput, scenarios, maxCount });

        for (const scenario of scenarios) {
            const result = computeResultByType(type, scenario.input_data);
            assert.notEqual(result, null, `${type}: generated scenario should be valid for compute engine`);
        }
    }
});

test("generic buildScenarios returns valid unique scenarios across key calculators", () => {
    const types = ["cash_flow", "property_sale", "alternative_investment"];
    const maxCount = 12;

    for (const type of types) {
        const baseInput = BASE_INPUTS[type];
        const scenarios = buildScenarios(
            { calculator_type: type, input_data: baseInput, CALC_FORMATS },
            maxCount
        );

        assertScenarioBasics({ type, baseInput, scenarios, maxCount });

        for (const scenario of scenarios) {
            assert.notEqual(
                computeResultByType(type, scenario.input_data),
                null,
                `${type}: generic scenario should remain computable`
            );
        }
    }
});

test("property_sale scenarios include stress and high-contrast options", () => {
    const scenarios = buildPropertySaleScenarios(BASE_INPUTS.property_sale, 40);
    const labels = scenarios.map((s) => s.label);

    assert.ok(labels.some((x) => x.includes("Stress:")), "property_sale should include stress scenario labels");
    assert.ok(
        labels.some((x) => x.includes("break-even hunt") || x.includes("Bad market")),
        "property_sale should include high-contrast scenario labels"
    );
});

test("MINI_TEXT covers every calculator and required levels", () => {
    const expectedTypes = Object.keys(SPECIALIZED_BUILDERS);
    const levels = ["good", "warn", "bad", "info"];

    for (const type of expectedTypes) {
        assert.ok(MINI_TEXT[type], `${type}: MINI_TEXT section is missing`);
        for (const level of levels) {
            assert.equal(typeof MINI_TEXT[type][level], "string", `${type}: ${level} should be a string`);
            assert.ok(MINI_TEXT[type][level].trim().length > 0, `${type}: ${level} should be non-empty`);
        }
    }
});
