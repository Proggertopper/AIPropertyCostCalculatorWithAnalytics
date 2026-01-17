let csrfToken;
window.addEventListener("DOMContentLoaded", async () => {
  const res = await fetch("/api/csrf", { credentials: "include" });
  const data = await res.json();
  csrfToken = data.csrfToken;
});

function clearErrors() {
  document.querySelectorAll(".error").forEach(e => {
    e.textContent = "";
  });
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

function formatPayback(value) {
  if (value === null || !isFinite(value)) return "Not profitable";
  const years = Math.floor(value);
  const months = Math.round((value - years) * 12);
  if (years && months) return `${years} yrs ${months} months`;
  if (years) return `${years} yrs`;
  return `${months} months`;
}

/* ===== calculation ===== */

function calculateRenovation() {
  clearErrors();

  const priceBefore = +priceBeforeEl.value;
  const rentBefore = +rentBeforeEl.value;
  const renovationCost = +renovationCostEl.value;
  const priceIncrease = +priceIncreaseEl.value;
  const rentIncrease = +rentIncreaseEl.value;
  const agentFee = +agentFeeEl.value;
  const saleTax = +saleTaxEl.value;
  const years = +yearsEl.value;
  const discountRate = +discountRateEl.value  || 0;
  const inflationRate = +inflationRateEl.value  || 0;


  let valid = true;

  valid = valid && validateNumber({
    value: priceBefore,
    min: 1,
    max: 500_000_000,
    errorEl: priceBeforeError,
    name: "Price before renovation"
  });

  valid = valid && validateNumber({
    value: rentBefore,
    min: 0,
    max: 100_000_000,
    errorEl: rentBeforeError,
    name: "Rent before renovation"
  });

  valid = valid && validateNumber({
    value: renovationCost,
    min: 0,
    max: 100_000_000,
    errorEl: renovationCostError,
    name: "Renovation cost"
  });

  valid = valid && validateNumber({
    value: priceIncrease,
    min: -100,
    max: 2000,
    errorEl: priceIncreaseError,
    name: "Price increase"
  });

  valid = valid && validateNumber({
    value: rentIncrease,
    min: -100,
    max: 2000,
    errorEl: rentIncreaseError,
    name: "Rent increase"
  });

  valid = valid && validateNumber({
    value: agentFee,
    min: 0,
    max: 50,
    errorEl: agentFeeError,
    name: "Agent fee"
  });

  valid = valid && validateNumber({
    value: saleTax,
    min: 0,
    max: 60,
    errorEl: saleTaxError,
    name: "Sale tax"
  });

  valid = valid && validateNumber({
    value: years,
    min: 1,
    max: 70,
    errorEl: yearsError,
    name: "Holding period"
  });

  valid = valid && validateNumber({
     value: inflationRate,
      min: 0, 
      max: 100, 
      errorEl: inflationRateError, 
      name: "Inflation rate" });

  valid = valid && validateNumber({
     value: discountRate, 
     min: 0, 
     max: 100, 
     errorEl: discountRateError, 
     name: "Discount rate" });

  if (renovationCost > priceBefore) {
    renovationCostError.textContent = "⚠ Renovation cost exceeds property price!";
    valid = false;
  }

  if (!valid) return;

  /* ===== logic ===== */

  const priceAfter = priceBefore * (1 + priceIncrease / 100);
  const rentAfter = rentBefore * (1 + rentIncrease / 100);

  const extraRentPerYear = rentAfter - rentBefore;
  const totalExtraRent = extraRentPerYear * years;

  let totalExtraRentPV = 0;
  for (let i = 1; i <= years; i++) {
    totalExtraRentPV += extraRentPerYear / Math.pow(1 + discountRate - inflationRate, i);
  }

  const agentCost = priceAfter * (agentFee / 100);
  const saleTaxCost = priceAfter * (saleTax / 100);

  const saleProfit =priceAfter - priceBefore - renovationCost - agentCost - saleTaxCost;

  const netProfit = saleProfit + totalExtraRent;
  const netProfitPV = saleProfit + totalExtraRentPV; // дисконтированный

  const roi =
    renovationCost > 0
      ? (netProfit / renovationCost) * 100
      : null;
  
  const roiPV = renovationCost > 0 ? (netProfitPV / renovationCost) * 100 : null;

  let payback = null;
  if (extraRentPerYear > 0 && netProfit > 0) {
    payback = renovationCost / extraRentPerYear;
  }

  function formatPayback(value) {
    if (value === null || !isFinite(value)) return "Not profitable";
    const years = Math.floor(value);
    const months = Math.round((value - years) * 12);
    if (years && months) return `${years} yrs ${months} months`;
    if (years) return `${years} yrs`;
    return `${months} months`;
  }

  /* ===== output ===== */

  priceAfterEl.textContent = moneyFormatter.format(priceAfter);
  rentAfterEl.textContent = moneyFormatter.format(rentAfter) + " / year";
  extraRentEl.textContent = moneyFormatter.format(totalExtraRent);
  netProfitEl.textContent = moneyFormatter.format(netProfit);

  roiEl.textContent = roi === null ? "N/A" : percentFormatter.format(roi / 100);
  roiPVEl.textContent = roiPV === null ? "N/A" : percentFormatter.format(roiPV / 100);
  paybackEl.textContent = formatPayback(payback);

  netProfitEl.style.color = netProfit >= 0 ? "green" : "red";

  roiEl.style.color = roi >= 0 ? "green" : "red";
  roiPVEl.style.color = roiPV >= 0 ? "green" : "red";
  paybackEl.style.color = payback && payback > years ? "orange" : "black";

  /* ===== save ===== */

  fetch("/api/app/calculation", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify({
      calculatorType: "renovation_roi",
      inputData: {
        priceBefore,
        rentBefore,
        renovationCost,
        priceIncrease,
        rentIncrease,
        agentFee,
        saleTax,
        years,
        discountRate,
        inflationRate
      },
      resultData: {
        priceAfter,
        rentAfter,
        totalExtraRent,
        totalExtraRentPV,
        saleProfit,
        netProfit,
        netProfitPV,
        roi,
        roiPV,
        payback
      }
    })
  }).catch(console.error);

  document
    .getElementById("results")
    .scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ===== aliases ===== */

const priceBeforeEl = document.getElementById("priceBefore");
const rentBeforeEl = document.getElementById("rentBefore");
const renovationCostEl = document.getElementById("renovationCost");
const priceIncreaseEl = document.getElementById("priceIncrease");
const rentIncreaseEl = document.getElementById("rentIncrease");

const agentFeeEl = document.getElementById("agentFee");
const saleTaxEl = document.getElementById("saleTax");
const yearsEl = document.getElementById("years");
const discountRateEl = document.getElementById("discountRate");
const inflationRateEl = document.getElementById("inflationRate");

const priceAfterEl = document.getElementById("priceAfter");
const rentAfterEl = document.getElementById("rentAfter");
const extraRentEl = document.getElementById("extraRent");
const netProfitEl = document.getElementById("netProfit");
const roiEl = document.getElementById("roi");
const roiPVEl = document.getElementById("roiPV");
const paybackEl = document.getElementById("payback");

/* errors */
const priceBeforeError = document.getElementById("priceBeforeError");
const rentBeforeError = document.getElementById("rentBeforeError");
const renovationCostError = document.getElementById("renovationCostError");
const priceIncreaseError = document.getElementById("priceIncreaseError");
const rentIncreaseError = document.getElementById("rentIncreaseError");
const agentFeeError = document.getElementById("agentFeeError");
const saleTaxError = document.getElementById("saleTaxError");
const yearsError = document.getElementById("yearsError");
const discountRateError = document.getElementById("discountRateError");
const inflationRateError = document.getElementById("inflationRateError");

document
  .getElementById("calcBtn")
  .addEventListener("click", calculateRenovation);