const test = require("node:test");
const assert = require("node:assert/strict");
const { computeResultByType } = require("../jsForAuth/compute");

function assertClose(actual, expected, eps = 1e-9) {
    assert.equal(typeof actual, "number");
    assert.ok(Math.abs(actual - expected) <= eps, `Expected ${actual} to be within ${eps} of ${expected}`);
}

test("alternative_investment: picks alternative when alternative outcome is stronger", () => {
    const result = computeResultByType("alternative_investment", {
        propertyInitial: 200000,
        propertyCashflow: 3000,
        propertyGrowth: 4,
        altReturn: 8,
        altContribution: 3000,
        propertyInflation: 3,
        propertyTaxRate: 15,
        altInflation: 3,
        altTaxRate: 15,
        years: 10
    });

    assert.ok(result);
    assert.equal(result.winner, "alternative");
    assert.equal(result.propertyValue, 237545);
    assert.equal(result.alternativeValue, 321792);
    assert.equal(result.difference, -84248);
});

test("alternative_investment: picks property when property outcome is stronger", () => {
    const result = computeResultByType("alternative_investment", {
        propertyInitial: 200000,
        propertyCashflow: 12000,
        propertyGrowth: 8,
        altReturn: 4,
        altContribution: 3000,
        propertyInflation: 2,
        propertyTaxRate: 10,
        altInflation: 2,
        altTaxRate: 15,
        years: 10
    });

    assert.ok(result);
    assert.equal(result.winner, "property");
    assert.equal(result.propertyValue, 477488);
    assert.equal(result.alternativeValue, 260507);
    assert.equal(result.difference, 216981);
});

test("property_sale: returns expected negative case metrics", () => {
    const result = computeResultByType("property_sale", {
        buyPrice: 300000,
        sellPrice: 250000,
        years: 15,
        tax: 10,
        commission: 4,
        inflation: 5,
        renovation: 100000
    });

    assert.ok(result);
    assert.equal(result.taxAmount, 25000);
    assert.equal(result.commissionAmount, 10000);
    assert.equal(result.netProfit, -185000);
    assertClose(result.realReturn, -8.62320271374063);
});

test("rent_vs_buy: keeps mortgage payment fixed and computes equity-adjusted buy cost", () => {
    const result = computeResultByType("rent_vs_buy", {
        rent: 2500,
        mortgage: 2400,
        years: 30,
        propertyValue: 400000,
        rentGrowth: 3,
        mortgageRate: 6.5,
        propertyGrowth: 3,
        inflation: 2.5
    });

    assert.ok(result);
    assert.equal(result.winner, "buy");
    assert.equal(result.mortgagePaid, 864000);
    assertClose(result.buyNetCost, 401128.1487384162, 1e-6);
});

test("ownership_cost: returns carrying costs without adding purchase principal", () => {
    const result = computeResultByType("ownership_cost", {
        price: 300000,
        years: 6,
        taxPercent: 1.2,
        maintenance: 3000,
        inflation: 2
    });

    assert.ok(result);
    assert.equal(result.totalOwnershipCost, 41634);
    assert.equal(result.totalOwnershipCostPV, 38824);
});

test("computeResultByType: returns null for unknown type or invalid input", () => {
    assert.equal(computeResultByType("unknown_calc", { a: 1 }), null);
    assert.equal(
        computeResultByType("mortgage", {
            price: 300000,
            down: 350000,
            ratePercent: 6,
            termYears: 30
        }),
        null
    );
});
