let csrfToken;
window.addEventListener("DOMContentLoaded", async () => {
    const res = await fetch("/api/csrf" , {credentials:"include"});
    const data = await res.json();
    csrfToken = data.csrfToken;
});


function clearErrors() {
    document.querySelectorAll(".error").forEach(e => e.textContent = "");
}

function validate({ value, min, max, errorEl, name }) {
    if (Number.isNaN(value)) {
        errorEl.textContent = `${name}: invalid number`;
        return false;
    }
    if (value < min) {
        errorEl.textContent = `${name}: minimum ${min}`;
        return false;
    }
    if (value > max) {
        errorEl.textContent = `${name}: maximum ${max}`;
        return false;
    }
    return true;
}

const moneyFormatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
});

const percentFormatter = new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 2
});

/* ===== IRR ===== */
function calculateIRR(cashFlows, guess = 0.1) {
    const maxIter = 1000;
    const tol = 1e-6;

    let low = -0.9999;   // нижняя граница (-99.99% годовых)
    let high = 10;        // верхняя граница (1000% годовых)

    const npv = (rate) => {
        return cashFlows.reduce((sum, cf, t) => sum + cf / Math.pow(1 + rate, t), 0);
    };

    let irr = guess;
    for (let i = 0; i < maxIter; i++) {
        irr = (low + high) / 2;
        const val = npv(irr);

        if (Math.abs(val) < tol) return irr;
        if (val > 0) {
            low = irr;
        } else {
            high = irr;
        }
    }

    return irr; // если не сошлось, возвращаем последнее приближение
}

/* ===== main calculation ===== */
function calculate() {
    clearErrors();

    const price = +priceInput.value;
    const downPayment = +downPaymentInput.value;
    const purchaseCosts = +purchaseCostsInput.value;
    const renovation = +renovationInput.value;

    const rent = +rentInput.value;
    const vacancy = +vacancyInput.value;
    const expenses = +expensesInput.value;
    const mortgage = +mortgageInput.value;

    const years = +yearsInput.value;
    const growth = +growthInput.value;
    const saleTax = +saleTaxInput.value;
    const inflation = +inflationInput.value;

    let valid = true;

    valid = valid && validate({ value: price, min: 1, max: 500_000_000, errorEl: priceError, name: "Price" });
    valid = valid && validate({ value: downPayment, min: 0, max: price, errorEl: downPaymentError, name: "Down Payment" });
    valid = valid && validate({ value: purchaseCosts, min: 0, max: 10_000_000, errorEl: purchaseCostsError, name: "Purchase Costs" });
    valid = valid && validate({ value: renovation, min: 0, max: 100_000_000, errorEl: renovationError, name: "Renovation" });

    valid = valid && validate({ value: rent, min: 0, max: 10_000_000, errorEl: rentError, name: "Rent" });
    valid = valid && validate({ value: vacancy, min: 0, max: 99, errorEl: vacancyError, name: "Vacancy %" });
    valid = valid && validate({ value: expenses, min: 0, max: 5_000_000, errorEl: expensesError, name: "Annual Expenses" });
    valid = valid && validate({ value: mortgage, min: 0, max: 10_000_000, errorEl: mortgageError, name: "Annual Mortgage" });

    valid = valid && validate({ value: years, min: 1, max: 100, errorEl: yearsError, name: "Holding Period (years)" });
    valid = valid && validate({ value: growth, min: -99, max: 2000, errorEl: growthError, name: "Price Growth %" });
    valid = valid && validate({ value: saleTax, min: 0, max: 80, errorEl: saleTaxError, name: "Sale Tax %" });
    valid = valid && validate({ value: inflation, min: -5, max: 40, errorEl: inflationError, name: "Inflation " });

    if (!valid) return;

    const initialInvestment =
        downPayment + purchaseCosts + renovation;

    const effectiveRent =
        rent * 12 * (1 - vacancy / 100);

    const cashFlow =
        effectiveRent - expenses - mortgage;

    if (cashFlow <= 0) {
        mortgageError.textContent = "Cash Flow ≤ 0, IRR невозможен";
        return;
    }

    const futurePrice =
        price * Math.pow(1 + growth / 100, years);

    const profitFromSale =
        futurePrice * (1 - saleTax / 100) - price;

    // формируем cashflows для IRR
    const cashFlows = [-initialInvestment];
    for (let i = 1; i <= years; i++) {
        if (i === years) {
            cashFlows.push(cashFlow + profitFromSale);
        } else {
            cashFlows.push(cashFlow);
        }
    }

    const irr = calculateIRR(cashFlows);
    const realIRR = irr !== null ? ((1 + irr) / (1 + inflation / 100) - 1) * 100 : null;

    const totalProfit = cashFlow * years + (profitFromSale - initialInvestment);
    const roi = (totalProfit / initialInvestment) * 100;

    // точный payback с учётом продажи
    let cumulative = -initialInvestment;
    let paybackYears = 0;
    for (let i = 1; i <= years; i++) {
        cumulative += i === years ? cashFlow + profitFromSale : cashFlow;
        if (cumulative >= 0) {
            paybackYears = i - 1 + (initialInvestment - (i - 1) * cashFlow) / cashFlow;
            break;
        }
    }

    /* output */
    cashFlowEl.textContent = moneyFormatter.format(cashFlow);
    roiEl.textContent = roi.toFixed(2) + " %";
    irrEl.textContent = irr !== null ? (irr * 100).toFixed(2) + " %" : "—";
    paybackEl.textContent = paybackYears ? (paybackYears.toFixed(1) + " years") : "—";
    document.getElementById("realIRR").textContent = realIRR !== null ? realIRR.toFixed(2) + " %" : "—";

    /* save */
    fetch("/api/app/calculation", {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
            calculatorType: "property_irr",
            inputData: {
                price, downPayment, purchaseCosts, renovation,
                rent, vacancy, expenses, mortgage,
                years, growth, saleTax , inflation
            },
            resultData: {
                cashFlow, roi, irr: irr * 100, realIRR , paybackYears
            }
        })
    }).catch(console.error);

    document
        .getElementById("results")
        .scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ===== aliases ===== */

const priceInput = document.getElementById("price");
const downPaymentInput = document.getElementById("downPayment");
const purchaseCostsInput = document.getElementById("purchaseCosts");
const renovationInput = document.getElementById("renovation");

const rentInput = document.getElementById("rent");
const vacancyInput = document.getElementById("vacancy");
const expensesInput = document.getElementById("expenses");
const mortgageInput = document.getElementById("mortgage");

const yearsInput = document.getElementById("years");
const growthInput = document.getElementById("growth");
const saleTaxInput = document.getElementById("saleTax");
const inflationInput = document.getElementById("inflation");

/* result */
const cashFlowEl = document.getElementById("cashFlow");
const roiEl = document.getElementById("roi");
const irrEl = document.getElementById("irr");
const paybackEl = document.getElementById("payback");

/* errors */
const priceError = document.getElementById("priceError");
const downPaymentError = document.getElementById("downPaymentError");
const purchaseCostsError = document.getElementById("purchaseCostsError");
const renovationError = document.getElementById("renovationError");
const rentError = document.getElementById("rentError");
const vacancyError = document.getElementById("vacancyError");
const expensesError = document.getElementById("expensesError");
const mortgageError = document.getElementById("mortgageError");
const yearsError = document.getElementById("yearsError");
const growthError = document.getElementById("growthError");
const saleTaxError = document.getElementById("saleTaxError");
const inflationError = document.getElementById("inflationError");

document.getElementById("calcBtn").addEventListener("click", calculate);