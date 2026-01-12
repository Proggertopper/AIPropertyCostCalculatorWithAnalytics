// 1️⃣ Получаем CSRF-токен при загрузке страницы
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

const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1
});

/* ===== calculation ===== */
function calculateSale() {
  clearErrors();

  const buyPrice = +buyPriceInput.value;
  const sellPrice = +sellPriceInput.value;
  const years = +yearsInput.value;

  const tax = +taxInput.value;
  const commission = +commissionInput.value;
  const inflation = +inflationInput.value;
  const renovation = +renovationInput.value;

  let valid = true;

  valid = valid && validateNumber({ value: buyPrice, min: 1, max: 500_000_000, errorEl: buyPriceError, name: "Purchase Price" });
  valid = valid && validateNumber({ value: sellPrice, min: 1, max: 500_000_000, errorEl: sellPriceError, name: "Sale Price" });
  valid = valid && validateNumber({ value: years, min: 1, max: 70, errorEl: yearsError, name: "Ownership Period" });

  valid = valid && validateNumber({ value: tax, min: 0, max: 70, errorEl: taxError, name: "Sale Tax" });
  valid = valid && validateNumber({ value: commission, min: 0, max: 40, errorEl: commissionError, name: "Agent Commission" });
  valid = valid && validateNumber({ value: inflation, min: -10, max: 50, errorEl: inflationError, name: "Inflation" });
  valid = valid && validateNumber({ value: renovation, min: 0, max: 100_000_000, errorEl: renovationError, name: "Renovation / Improvements" });

  if (!valid) return;

  /* ===== logic ===== */
  const taxRate = tax / 100;
  const commissionRate = commission / 100;
  const inflationRate = inflation / 100;

  const taxAmount = sellPrice * taxRate;
  const commissionAmount = sellPrice * commissionRate;

  const netProfit =
    sellPrice -
    buyPrice -
    taxAmount -
    commissionAmount -
    renovation;

  const investedCapital = buyPrice + renovation;

  const roiTotal =
    investedCapital > 0
      ? (netProfit / investedCapital) * 100
      : null;

  let annualReturn = null;
  if (roiTotal !== null && roiTotal > -100) {
    annualReturn =
      (Math.pow(1 + roiTotal / 100, 1 / years) - 1) * 100;
  }

  let realReturn = null;
  if (annualReturn !== null) {
    realReturn =
      ((1 + annualReturn / 100) / (1 + inflationRate) - 1) * 100;
  }

  /* ===== output ===== */
  document.getElementById("taxAmount").textContent = moneyFormatter.format(taxAmount);
  document.getElementById("commissionAmount").textContent = moneyFormatter.format(commissionAmount);
  document.getElementById("netProfit").textContent = moneyFormatter.format(netProfit);
  document.getElementById("annualReturn").textContent = percentFormatter.format(annualReturn);
  document.getElementById("realReturn").textContent = percentFormatter.format(realReturn);

  if (realReturn >= 5) {
    decisionEl.textContent = "Selling is justified in real terms 📈";
    decisionEl.className = "decision good";
  } else {
    decisionEl.textContent = "Return is below inflation ⛔";
    decisionEl.className = "decision bad";
  }


  /* ===== save ===== */

  fetch("/api/app/calculation", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify({
      calculatorType: "property_sale",
      inputData: {
        buyPrice,
        sellPrice,
        years,
        tax,
        commission,
        inflation,
        renovation
      },
      resultData: {
        taxAmount,
        commissionAmount,
        netProfit,
        roiTotal,
        annualReturn,
        realReturn
      }
    })
  }).catch(console.error);

  document
    .getElementById("results")
    .scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ===== aliases ===== */

const buyPriceInput = document.getElementById("buyPrice");
const sellPriceInput = document.getElementById("sellPrice");
const yearsInput = document.getElementById("years");

const taxInput = document.getElementById("tax");
const commissionInput = document.getElementById("commission");
const inflationInput = document.getElementById("inflation");
const renovationInput = document.getElementById("renovation");

/* results */
const taxAmountEl = document.getElementById("taxAmount");
const commissionAmountEl = document.getElementById("commissionAmount");
const netProfitEl = document.getElementById("netProfit");
const annualReturnEl = document.getElementById("annualReturn");
const realReturnEl = document.getElementById("realReturn");
const decisionEl = document.getElementById("decision");

/* errors */
const buyPriceError = document.getElementById("buyPriceError");
const sellPriceError = document.getElementById("sellPriceError");
const yearsError = document.getElementById("yearsError");
const taxError = document.getElementById("taxError");
const commissionError = document.getElementById("commissionError");
const inflationError = document.getElementById("inflationError");
const renovationError = document.getElementById("renovationError");

document
  .getElementById("calcBtn")
  .addEventListener("click", calculateSale);