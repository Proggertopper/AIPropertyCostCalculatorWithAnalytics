

/* ===== helpers ===== */

function clearErrors() {
    document.querySelectorAll(".error").forEach(e => (e.textContent = ""));
}

// Пустое поле -> NaN (а не 0)
function num(el) {
    const v = (el?.value ?? "").trim();
    if (v === "") return NaN;
    return Number(v);
}

function validateNumber({ value, min, max, errorEl, name, integer = false }) {
    if (Number.isNaN(value)) {
        errorEl.textContent = `${name}: invalid number`;
        return false;
    }
    if (integer && !Number.isInteger(value)) {
        errorEl.textContent = `${name}: must be a whole number`;
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

/* ===== calculation ===== */

function calculateMortgage(e) {
    window.calculateMortgage = calculateMortgage;
    e.preventDefault();
    clearErrors();

    const price = num(propertyPriceInput);
    const down = num(downPaymentInput);
    const ratePercent = num(interestRateInput);
    const termYears = num(loanTermInput);

    let valid = true;

    valid = valid && validateNumber({
        value: price,
        min: 1,
        max: 500_000_000,
        errorEl: priceError,
        name: "Property Price"
    });

    // down должен быть >=0 и строго меньше price
    if (!Number.isNaN(price)) {
        valid = valid && validateNumber({
            value: down,
            min: 0,
            max: Math.max(price - 1, 0),
            errorEl: downError,
            name: "Down Payment"
        });
    } else {
        // если price NaN — пусть down тоже провалится нормально
        valid = valid && validateNumber({
            value: down,
            min: 0,
            max: 500_000_000,
            errorEl: downError,
            name: "Down Payment"
        });
    }

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
        name: "Loan Term",
        integer: true
    });

    if (!valid) return;

    const loanAmount = price - down;
    if (loanAmount <= 0) {
        downError.textContent = "Down payment must be less than property price";
        return;
    }

    const months = termYears * 12;
    const monthlyRate = (ratePercent / 100) / 12;

    let monthlyPayment;
    if (monthlyRate === 0) {
        monthlyPayment = loanAmount / months;
    } else {
        monthlyPayment =
            loanAmount * (monthlyRate / (1 - Math.pow(1 + monthlyRate, -months)));
    }

    const totalPayment = monthlyPayment * months;
    const totalInterest = totalPayment - loanAmount;

    // output
    monthlyPaymentEl.textContent = moneyFormatter.format(monthlyPayment);
    totalPaymentEl.textContent = moneyFormatter.format(totalPayment);
    totalInterestEl.textContent = moneyFormatter.format(totalInterest);

    // save (не мешаем расчёту, если csrf нет)
    if (csrfToken) {
        fetch("/api/app/calculation", {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken
            },
            body: JSON.stringify({
                calculatorType: "mortgage",
                inputData: { price, down, ratePercent, termYears },
                resultData: {
                    monthlyPayment: Math.round(monthlyPayment),
                    totalPayment: Math.round(totalPayment),
                    totalInterest: Math.round(totalInterest)
                }
            })
        }).catch(console.error);
    } else {
        console.warn("CSRF token missing — calculation not saved.");
    }

    document.getElementById("results")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
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

/* лучше form submit */
const form = document.querySelector("form");
if (form) {
    form.addEventListener("submit", calculateMortgage);
} else {
    document.querySelector("button[type='submit']").addEventListener("click", calculateMortgage);
}
