

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

function calculateNOI(e) {
    e?.preventDefault?.();
    clearErrors();

    // monthly inputs
    const rent = Number(rentInput.value);
    const vacancy = Number(vacancyInput.value);
    const expenses = Number(expensesInput.value);

    let valid = true;
    valid = valid && validateNumber({ value: rent, min: 0, max: 100_000_000, errorEl: rentError, name: "Gross Rent" });
    valid = valid && validateNumber({ value: vacancy, min: 0, max: 95, errorEl: vacancyError, name: "Vacancy %" });
    valid = valid && validateNumber({ value: expenses, min: 0, max: 50_000_000, errorEl: expensesError, name: "Operating Expenses" });
    if (!valid) return;

    const vacancyRate = vacancy / 100;
    const effectiveRent = rent * (1 - vacancyRate);
    const noi = effectiveRent - expenses;

    effectiveRentEl.textContent = `${moneyFormatter.format(effectiveRent)} / month`;
    noiEl.textContent = `${moneyFormatter.format(noi)} / month`;

    // save
    if (csrfToken) {
        fetch("/api/app/calculation", {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken
            },
            body: JSON.stringify({
                calculatorType: "noi",
                inputData: { rent, vacancy, expenses },
                resultData: { effectiveRent, noi }
            })
        }).catch(console.error);
    }

    resultsEl?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* aliases */
const rentInput = document.getElementById("rent");
const vacancyInput = document.getElementById("vacancy");
const expensesInput = document.getElementById("expenses");

const effectiveRentEl = document.getElementById("effectiveRent");
const noiEl = document.getElementById("noi");
const resultsEl = document.getElementById("results");

/* errors */
const rentError = document.getElementById("rentError");
const vacancyError = document.getElementById("vacancyError");
const expensesError = document.getElementById("expensesError");

document.getElementById("calcBtn")?.addEventListener("click", calculateNOI);
