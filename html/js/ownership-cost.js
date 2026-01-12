let csrfToken;
window.addEventListener("DOMContentLoaded", async () => {
    const res = await fetch("/api/csrf" , {credentials:"include"});
    const data = await res.json();
    csrfToken = data.csrfToken;
});




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
    currency: "USD",
    maximumFractionDigits: 0
});

/* ===== calculation ===== */
function calculateOwnershipCost() {
    clearErrors();

    const price = +priceInput.value;
    const years = +yearsInput.value;
    const taxPercent = +taxInput.value;
    const maintenance = +maintenanceInput.value;

    let valid = true;

    valid = valid && validateNumber({
        value: price,
        min: 1,
        max: 50_000_000,
        errorEl: priceError,
        name: "Property Price"
    });

    valid = valid && validateNumber({
        value: years,
        min: 1,
        max: 100,
        errorEl: yearsError,
        name: "Ownership Period"
    });

    valid = valid && validateNumber({
        value: taxPercent,
        min: 0,
        max: 90,
        errorEl: taxError,
        name: "Property Tax"
    });

    valid = valid && validateNumber({
        value: maintenance,
        min: 0,
        max: 10_000_000,
        errorEl: maintenanceError,
        name: "Maintenance"
    });

    if (!valid) return;

    /* ===== logic ===== */

    const taxRate = taxPercent / 100;
    let totalCost = price;

    for (let year = 1; year <= years; year++) {
        totalCost += price * taxRate + maintenance;
    }

    /* ===== output ===== */

    totalCostEl.textContent = moneyFormatter.format(totalCost);

    /* ===== save ===== */

    fetch("/api/app/calculation", {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
            calculatorType: "ownership_cost",
            inputData: {
                price,
                years,
                taxPercent,
                maintenance
            },
            resultData: {
                totalCost
            }
        })
    }).catch(console.error);

    document
        .getElementById("results")
        .scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ===== aliases ===== */

const priceInput = document.getElementById("price");
const yearsInput = document.getElementById("years");
const taxInput = document.getElementById("tax");
const maintenanceInput = document.getElementById("maintenance");

const totalCostEl = document.getElementById("totalCost");

/* errors */
const priceError = document.getElementById("priceError");
const yearsError = document.getElementById("yearsError");
const taxError = document.getElementById("taxError");
const maintenanceError = document.getElementById("maintenanceError");

/* button */
document
    .getElementById("calcBtn")
    .addEventListener("click", calculateOwnershipCost);