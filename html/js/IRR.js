

/* ===== helpers ===== */

function clearErrors() {
    document.querySelectorAll(".error").forEach(e => (e.textContent = ""));
}

function validate({ value, min, max, errorEl, name }) {
    if (!Number.isFinite(value)) {
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

/* ===== robust IRR (find bracket + bisection) ===== */
function irrFromCashflows(cashFlows) {
    // IRR exists only if there is at least one sign change
    let hasPos = false, hasNeg = false;
    for (const cf of cashFlows) {
        if (cf > 0) hasPos = true;
        if (cf < 0) hasNeg = true;
    }
    if (!(hasPos && hasNeg)) return null;

    const npv = (rate) => {
        if (rate <= -0.999999) return Number.POSITIVE_INFINITY; // protect divide by ~0
        let sum = 0;
        for (let t = 0; t < cashFlows.length; t++) {
            sum += cashFlows[t] / Math.pow(1 + rate, t);
        }
        return sum;
    };

    // Search a bracket where NPV changes sign
    // Wide range, because real estate IRR can be high in toy inputs
    const candidates = [];
    for (let r = -0.9; r <= 1.0; r += 0.05) candidates.push(Number(r.toFixed(2)));
    candidates.push(1.5, 2, 3, 5, 10, 20);

    let a = null, b = null;
    let prevR = candidates[0];
    let prevV = npv(prevR);

    for (let i = 1; i < candidates.length; i++) {
        const r = candidates[i];
        const v = npv(r);

        if (Number.isFinite(prevV) && Number.isFinite(v) && prevV * v <= 0) {
            a = prevR; b = r;
            break;
        }
        prevR = r;
        prevV = v;
    }

    if (a === null) return null;

    // Bisection
    const tol = 1e-7;
    const maxIter = 250;

    let low = a, high = b;
    let fLow = npv(low);
    let fHigh = npv(high);

    if (Math.abs(fLow) < tol) return low;
    if (Math.abs(fHigh) < tol) return high;

    for (let i = 0; i < maxIter; i++) {
        const mid = (low + high) / 2;
        const fMid = npv(mid);

        if (!Number.isFinite(fMid)) return null;
        if (Math.abs(fMid) < tol) return mid;

        if (fLow * fMid <= 0) {
            high = mid;
            fHigh = fMid;
        } else {
            low = mid;
            fLow = fMid;
        }
    }

    return (low + high) / 2;
}

/* ===== main calculation ===== */
async function calculate() {
    clearErrors();

    // inputs
    const price = Number(priceInput.value);
    const downPayment = Number(downPaymentInput.value);
    const purchaseCosts = Number(purchaseCostsInput.value);
    const renovation = Number(renovationInput.value);

    const rentMonthly = Number(rentInput.value);         // monthly rent
    const vacancy = Number(vacancyInput.value);          // %
    const expensesAnnual = Number(expensesInput.value);  // annual expenses
    const mortgageAnnual = Number(mortgageInput.value);  // annual mortgage payment (simplified)

    const yearsRaw = Number(yearsInput.value);
    const years = Math.trunc(yearsRaw);

    const growth = Number(growthInput.value);            // %/year
    const saleTax = Number(saleTaxInput.value);          // % of sale price
    const inflation = Number(inflationInput.value);      // %/year

    let valid = true;

    valid = valid && validate({ value: price, min: 1, max: 500_000_000, errorEl: priceError, name: "Price" });
    valid = valid && validate({ value: downPayment, min: 0, max: price, errorEl: downPaymentError, name: "Down Payment" });
    valid = valid && validate({ value: purchaseCosts, min: 0, max: 10_000_000, errorEl: purchaseCostsError, name: "Purchase Costs" });
    valid = valid && validate({ value: renovation, min: 0, max: 100_000_000, errorEl: renovationError, name: "Renovation" });

    valid = valid && validate({ value: rentMonthly, min: 0, max: 10_000_000, errorEl: rentError, name: "Rent (monthly)" });
    valid = valid && validate({ value: vacancy, min: 0, max: 99, errorEl: vacancyError, name: "Vacancy %" });
    valid = valid && validate({ value: expensesAnnual, min: 0, max: 5_000_000, errorEl: expensesError, name: "Annual Expenses" });
    valid = valid && validate({ value: mortgageAnnual, min: 0, max: 10_000_000, errorEl: mortgageError, name: "Annual Mortgage" });

    valid = valid && validate({ value: yearsRaw, min: 1, max: 100, errorEl: yearsError, name: "Holding Period (years)" });
    if (valid && !Number.isInteger(yearsRaw)) {
        yearsError.textContent = "Holding Period must be a whole number";
        valid = false;
    }

    valid = valid && validate({ value: growth, min: -99, max: 2000, errorEl: growthError, name: "Price Growth %" });
    valid = valid && validate({ value: saleTax, min: 0, max: 80, errorEl: saleTaxError, name: "Sale Tax %" });
    valid = valid && validate({ value: inflation, min: -5, max: 40, errorEl: inflationError, name: "Inflation" });

    if (!valid) return;

    // ===== core assumptions (consistent):
    // Equity invested at t=0:
    const initialInvestment = downPayment + purchaseCosts + renovation;

    // Loan outstanding (simplified): we assume the principal is still there until sale.
    // This matches your inputs because you DO NOT have interest rate / amortization schedule.
    const loanAmount = Math.max(price - downPayment, 0);

    // ===== yearly model (optionally index by inflation for realism)
    const infl = inflation / 100;

    let rentM = rentMonthly;
    let expensesY = expensesAnnual;
    let mortgageY = mortgageAnnual;

    // property price path
    const g = growth / 100;
    const futurePrice = price * Math.pow(1 + g, years);
    const netSaleProceeds = (futurePrice * (1 - saleTax / 100)) - loanAmount;

    // Build cash flows
    // t=0: equity outflow
    const cashFlows = [-initialInvestment];

    let cashFlowAnnualShown = null;

    for (let t = 1; t <= years; t++) {
        // effective annual rent
        const effectiveRentAnnual = rentM * 12 * (1 - vacancy / 100);

        const cashFlowAnnual = effectiveRentAnnual - expensesY - mortgageY;
        if (t === 1) cashFlowAnnualShown = cashFlowAnnual;

        // last year: add sale proceeds
        const cf = (t === years) ? (cashFlowAnnual + netSaleProceeds) : cashFlowAnnual;
        cashFlows.push(cf);

        // ---- optional realism: grow rent/expenses/mortgage by inflation
        // (если тебе не нужно — можешь удалить эти 3 строки)
        rentM *= (1 + infl);
        expensesY *= (1 + infl);
        mortgageY *= (1 + infl);
    }

    if (cashFlows.slice(1, -1).every(x => x <= 0) && netSaleProceeds <= 0) {
        mortgageError.textContent = "⚠️ Cash flows are non-positive and sale proceeds are not positive — investment likely unprofitable.";
    } else if (cashFlows[1] <= 0) {
        mortgageError.textContent = "⚠️ Annual cash flow is ≤ 0. IRR may still exist due to sale value.";
    }

    // IRR (decimal)
    const irr = irrFromCashflows(cashFlows);

    // Real IRR (%) using Fisher equation with inflation input
    const realIRR = irr === null
        ? null
        : (((1 + irr) / (1 + infl)) - 1) * 100;

    // Net profit to equity and ROI %
    const netProfit = cashFlows.reduce((a, b) => a + b, 0);
    const roi = initialInvestment > 0 ? (netProfit / initialInvestment) * 100 : null;

    // Payback (simple, based on nominal CFs including sale in last year)
    let paybackYears = null;
    let cum = cashFlows[0];

    for (let t = 1; t < cashFlows.length; t++) {
        const prev = cum;
        cum += cashFlows[t];

        if (cum >= 0) {
            const inflow = cashFlows[t];
            if (inflow > 0) {
                const frac = (-prev) / inflow;
                paybackYears = (t - 1) + frac;
            } else {
                paybackYears = t;
            }
            break;
        }
    }

    // ===== output
    cashFlowEl.textContent = moneyFormatter.format(cashFlowAnnualShown ?? 0);
    roiEl.textContent = roi === null ? "—" : `${roi.toFixed(2)} %`;
    irrEl.textContent = irr === null ? "—" : `${(irr * 100).toFixed(2)} %`;
    realIRREl.textContent = realIRR === null ? "—" : `${realIRR.toFixed(2)} %`;
    paybackEl.textContent = paybackYears === null ? "—" : `${paybackYears.toFixed(1)} years`;

    // ===== save
    // Если CSRF нет — просто не сохраняем (чтобы расчёт не "ломался")
    if (csrfToken) {
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
                    price,
                    downPayment,
                    purchaseCosts,
                    renovation,
                    rent: rentMonthly,
                    vacancy,
                    expenses: expensesAnnual,
                    mortgage: mortgageAnnual,
                    years,
                    growth,
                    saleTax,
                    inflation
                },
                resultData: {
                    cashFlow: cashFlowAnnualShown,
                    roi,
                    irr: irr === null ? null : irr * 100, // percent
                    realIRR,
                    paybackYears
                }
            })
        }).catch(console.error);
    } else {
        console.warn("CSRF token not loaded — skip saving.");
    }

    document.getElementById("results")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
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
const realIRREl = document.getElementById("realIRR");
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
