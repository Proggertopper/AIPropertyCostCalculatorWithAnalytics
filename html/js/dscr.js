// let csrfToken;
// window.addEventListener("DOMContentLoaded", async () => {
//     try {
//         const res = await fetch("/api/csrf", { credentials: "include" });
//         const data = await res.json();
//         csrfToken = data.csrfToken;
//     } catch (e) {
//         console.warn("CSRF token load failed:", e);
//     }
// });

function clearErrors() {
    document.querySelectorAll(".error").forEach(e => (e.textContent = ""));
}

function validateNumber({ value, min, max, errorEl, name }) {
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

const numberFormatter = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2
});

function calculateDSCR(e) {
    e?.preventDefault?.();
    clearErrors();

    const rent = Number(rentInput.value);
    const vacancy = Number(vacancyInput.value);
    const expenses = Number(expensesInput.value);
    const mortgage = Number(mortgageInput.value);

    let valid = true;
    valid = valid && validateNumber({ value: rent, min: 0, max: 100_000_000, errorEl: rentError, name: "Gross Rent" });
    valid = valid && validateNumber({ value: vacancy, min: 0, max: 95, errorEl: vacancyError, name: "Vacancy %" });
    valid = valid && validateNumber({ value: expenses, min: 0, max: 50_000_000, errorEl: expensesError, name: "Operating Expenses" });
    valid = valid && validateNumber({ value: mortgage, min: 0, max: 50_000_000, errorEl: mortgageError, name: "Debt Service" });
    if (!valid) return;

    const vacancyRate = vacancy / 100;
    const effectiveRent = rent * (1 - vacancyRate);
    const noi = effectiveRent - expenses;

    const debtService = mortgage;
    const dscr = debtService > 0 ? (noi / debtService) : null;

    let status = "—";
    if (dscr === null) status = "No debt";
    else if (dscr >= 1.25) status = "Strong";
    else if (dscr >= 1.0) status = "Borderline";
    else status = "Weak";

    noiEl.textContent = `${moneyFormatter.format(noi)} / month`;
    debtServiceEl.textContent = `${moneyFormatter.format(debtService)} / month`;
    dscrEl.textContent = dscr === null ? "—" : numberFormatter.format(dscr);
    statusEl.textContent = status;

    if (csrfToken) {
        fetch("/api/app/calculation", {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken
            },
            body: JSON.stringify({
                calculatorType: "dscr",
                inputData: { rent, vacancy, expenses, mortgage },
                resultData: { noi, debtService, dscr, status }
            })
        }).catch(console.error);
    }

    resultsEl?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* aliases */
const rentInput = document.getElementById("rent");
const vacancyInput = document.getElementById("vacancy");
const expensesInput = document.getElementById("expenses");
const mortgageInput = document.getElementById("mortgage");

const noiEl = document.getElementById("noi");
const debtServiceEl = document.getElementById("debtService");
const dscrEl = document.getElementById("dscr");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

/* errors */
const rentError = document.getElementById("rentError");
const vacancyError = document.getElementById("vacancyError");
const expensesError = document.getElementById("expensesError");
const mortgageError = document.getElementById("mortgageError");

document.getElementById("calcBtn")?.addEventListener("click", calculateDSCR);
