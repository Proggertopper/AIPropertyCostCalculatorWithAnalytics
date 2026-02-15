// propertySale.js


function clearErrors() {
  document.querySelectorAll(".error").forEach(e => (e.textContent = ""));
}

// Чтение числа: пусто -> NaN (а не 0)
function num(id) {
  const el = document.getElementById(id);
  if (!el) return NaN;
  const v = (el.value ?? "").toString().trim();
  if (v === "") return NaN;
  return Number(v);
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

// ВАЖНО: percent formatter ждёт ДОЛЮ (0.05)
const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 2
});

function fmtPct(pctValue) {
  // pctValue = 5 значит 5%
  if (!Number.isFinite(pctValue)) return "—";
  return percentFormatter.format(pctValue / 100);
}

function calculateSale(e) {
  if (e) e.preventDefault();
  clearErrors();

  // ===== читаем input =====
  const buyPrice = num("buyPrice");
  const sellPrice = num("sellPrice");
  const years = Math.trunc(num("years"));

  const tax = num("tax");               // %
  const commission = num("commission"); // %
  const inflation = num("inflation");   // %
  const renovation = num("renovation"); // $

  let valid = true;

  valid = valid && validateNumber({ value: buyPrice, min: 1, max: 500_000_000, errorEl: buyPriceError, name: "Purchase Price" });
  valid = valid && validateNumber({ value: sellPrice, min: 1, max: 500_000_000, errorEl: sellPriceError, name: "Sale Price" });
  valid = valid && validateNumber({ value: years, min: 1, max: 70, errorEl: yearsError, name: "Ownership Period" });

  valid = valid && validateNumber({ value: tax, min: 0, max: 70, errorEl: taxError, name: "Sale Tax" });
  valid = valid && validateNumber({ value: commission, min: 0, max: 40, errorEl: commissionError, name: "Agent Commission" });
  valid = valid && validateNumber({ value: inflation, min: -10, max: 50, errorEl: inflationError, name: "Inflation" });
  valid = valid && validateNumber({ value: renovation, min: 0, max: 100_000_000, errorEl: renovationError, name: "Renovation / Improvements" });

  if (!valid) return;

  // ===== логика =====
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

  // ROI total (%) за весь период
  const roiTotal =
    investedCapital > 0
      ? (netProfit / investedCapital) * 100
      : null;

  // AnnualReturn (%) годовых (CAGR)
  let annualReturn = null;
  if (roiTotal !== null && Number.isFinite(roiTotal) && roiTotal > -100) {
    annualReturn = (Math.pow(1 + roiTotal / 100, 1 / years) - 1) * 100;
  }

  // RealReturn (%) годовых с учётом инфляции (Fisher)
  let realReturn = null;
  if (annualReturn !== null && Number.isFinite(annualReturn)) {
    realReturn = ((1 + annualReturn / 100) / (1 + inflationRate) - 1) * 100;
  }

  // ===== output =====
  taxAmountEl.textContent = moneyFormatter.format(taxAmount);
  commissionAmountEl.textContent = moneyFormatter.format(commissionAmount);
  netProfitEl.textContent = moneyFormatter.format(netProfit);

  annualReturnEl.textContent = annualReturn === null ? "—" : fmtPct(annualReturn);
  realReturnEl.textContent = realReturn === null ? "—" : fmtPct(realReturn);

  // decision (оставил твою идею: >=5% real)
  if (realReturn === null) {
    decisionEl.textContent = "Not enough data to evaluate";
    decisionEl.className = "decision info";
  } else if (realReturn >= 5) {
    decisionEl.textContent = "Selling is justified in real terms 📈";
    decisionEl.className = "decision good";
  } else {
    decisionEl.textContent = "Return is below inflation ⛔";
    decisionEl.className = "decision bad";
  }

  // ===== save =====
  if (!csrfToken) {
    console.warn("CSRF token not loaded — skip saving.");
  } else {
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
          tax,        // проценты, как вводил
          commission, // проценты, как вводил
          inflation,  // проценты, как вводил
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
  }

  document.getElementById("results")
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
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

document.getElementById("calcBtn")
  .addEventListener("click", calculateSale);
