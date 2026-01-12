let csrfToken;
window.addEventListener("DOMContentLoaded", async () => {
    const res = await fetch("/api/csrf" , {credentials:"include"});
    const data = await res.json();
    csrfToken = data.csrfToken;
});

/* ===== helpers ===== */


function clearErrors() {
    document.querySelectorAll(".error").forEach(e => (e.textContent = ""));
}

function validateNumber({ value, min, max, errorEl, name }) {
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
    currency: "USD"
});

/* ===== calculation ===== */
function calculateMortgage(e) {
    e.preventDefault();
    clearErrors();

    const price = +propertyPriceInput.value;
    const down = +downPaymentInput.value;
    const ratePercent = +interestRateInput.value;
    const termYears = +loanTermInput.value;

    let valid = true;

    valid = valid && validateNumber({
        value: price,
        min: 1,
        max: 500_000_000,
        errorEl: priceError,
        name: "Property Price"
    });

    valid = valid && validateNumber({
        value: down,
        min: 0,
        max: price,
        errorEl: downError,
        name: "Down Payment"
    });

    valid = valid && validateNumber({
        value: ratePercent,
        min: 0,
        max: 99,
        errorEl: rateError,
        name: "Interest Rate"
    });

    valid = valid && validateNumber({
        value: termYears,
        min: 1,
        max: 70,
        errorEl: termError,
        name: "Loan Term"
    });

    if (!valid) return;

    /* ===== logic ===== */

    const monthlyRate = ratePercent / 100 / 12;
    const months = termYears * 12;
    const loanAmount = price - down;

    const monthlyPayment =
        loanAmount *
        (monthlyRate / (1 - Math.pow(1 + monthlyRate, -months)));

    const totalPayment = monthlyPayment * months;
    const totalInterest = totalPayment - loanAmount;

    /* ===== output ===== */

    monthlyPaymentEl.textContent = moneyFormatter.format(monthlyPayment);
    totalPaymentEl.textContent = moneyFormatter.format(totalPayment);
    totalInterestEl.textContent = moneyFormatter.format(totalInterest);

    /* ===== save ===== */

    fetch("/api/app/calculation", {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
            calculatorType: "mortgage",
            inputData: {
                price,
                down,
                ratePercent,
                termYears
            },
            resultData: {
                monthlyPayment,
                totalPayment,
                totalInterest
            }
        })
    }).catch(console.error);

    document
        .getElementById("results")
        .scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ===== aliases ===== */

const propertyPriceInput = document.getElementById("propertyPrice");
const downPaymentInput = document.getElementById("downPayment");
const interestRateInput = document.getElementById("interestRate");
const loanTermInput = document.getElementById("loanTerm");

const monthlyPaymentEl = document.getElementById("monthlyPayment");
const totalPaymentEl = document.getElementById("totalPayment");
const totalInterestEl = document.getElementById("totalInterest");

/* errors */
const priceError = document.getElementById("priceError");
const downError = document.getElementById("downError");
const rateError = document.getElementById("rateError");
const termError = document.getElementById("termError");

/* button */
document
    .querySelector("button[type='submit']")
    .addEventListener("click", calculateMortgage);