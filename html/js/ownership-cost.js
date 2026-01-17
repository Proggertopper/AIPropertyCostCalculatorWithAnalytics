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
    const inflation = +inflationInput.value; 

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

    valid = valid && validateNumber({ value: inflation, min: -5, max: 40, errorEl: inflationError, name: "Inflation %" });

    if (!valid) return;

    /* ===== logic ===== */

    const taxRate = taxPercent / 100;
    const discountRate = inflation/100;


    let totalCost = price;

    let totalCostPV=price;

    for (let year = 1; year <= years; year++) {
        const annualCost = price * taxRate + maintenance;
        totalCost += annualCost;
        totalCostPV += annualCost / Math.pow(1 + discountRate, year); // дисконтируем с учётом инфляции
    }


    /* ===== output ===== */

    totalCostEl.textContent = moneyFormatter.format(totalCost);
    totalCostPVEl.textContent = moneyFormatter.format(totalCostPV);

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
                maintenance,
                inflation
            },
            resultData: {
                totalCost, totalCostPV
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
const inflationInput = document.getElementById("inflation");

const totalCostEl = document.getElementById("totalCost");
const totalCostPVEl = document.getElementById("totalCostPV");

/* errors */
const priceError = document.getElementById("priceError");
const yearsError = document.getElementById("yearsError");
const taxError = document.getElementById("taxError");
const maintenanceError = document.getElementById("maintenanceError");
const inflationError = document.getElementById("inflationError");

/* button */
document
    .getElementById("calcBtn")
    .addEventListener("click", calculateOwnershipCost);


async function checkLogin() {
    try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();

        if (!data.loggedIn) {
            // показываем блок для гостей
            document.getElementById('guest-promo').style.display = 'block';
        }
        else {
            document.getElementById('user-promo').style.display = 'flex'
        }
    } catch (err) {
        console.error("Ошибка при проверке логина:", err);
    }
}

// Проверяем при загрузке страницы
checkLogin();