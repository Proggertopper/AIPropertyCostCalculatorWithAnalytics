

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

function formatPayback(value) {
  if (value === null || !isFinite(value)) return "Not profitable";
  const yrs = Math.floor(value);
  const months = Math.round((value - yrs) * 12);
  if (yrs && months) return `${yrs} yrs ${months} months`;
  if (yrs) return `${yrs} yrs`;
  return `${months} months`;
}

function pctToRate(pct) {
  // pct = 5 => 0.05
  return Number(pct) / 100;
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

/* ===== calculation ===== */
function calculateRenovation() {
  clearErrors();

  const priceBefore = Number(priceBeforeEl.value);
  const rentBefore = Number(rentBeforeEl.value);           // считаем МЕСЯЧНУЮ аренду
  const renovationCost = Number(renovationCostEl.value);

  const priceIncreasePct = Number(priceIncreaseEl.value);  // проценты как вводишь (5 = 5%)
  const rentIncreasePct = Number(rentIncreaseEl.value);
  const agentFeePct = Number(agentFeeEl.value);
  const saleTaxPct = Number(saleTaxEl.value);

  const years = Math.trunc(Number(yearsEl.value));

  const discountRatePct = Number(discountRateEl.value) || 0;
  const inflationRatePct = Number(inflationRateEl.value) || 0;

  let valid = true;

  valid = valid && validateNumber({
    value: priceBefore, min: 1, max: 500_000_000,
    errorEl: priceBeforeError, name: "Price before renovation"
  });

  valid = valid && validateNumber({
    value: rentBefore, min: 0, max: 100_000_000,
    errorEl: rentBeforeError, name: "Rent before renovation"
  });

  valid = valid && validateNumber({
    value: renovationCost, min: 0, max: 100_000_000,
    errorEl: renovationCostError, name: "Renovation cost"
  });

  valid = valid && validateNumber({
    value: priceIncreasePct, min: -100, max: 2000,
    errorEl: priceIncreaseError, name: "Price increase"
  });

  valid = valid && validateNumber({
    value: rentIncreasePct, min: -100, max: 2000,
    errorEl: rentIncreaseError, name: "Rent increase"
  });

  valid = valid && validateNumber({
    value: agentFeePct, min: 0, max: 50,
    errorEl: agentFeeError, name: "Agent fee"
  });

  valid = valid && validateNumber({
    value: saleTaxPct, min: 0, max: 60,
    errorEl: saleTaxError, name: "Sale tax"
  });

  valid = valid && validateNumber({
    value: years, min: 1, max: 70,
    errorEl: yearsError, name: "Holding period"
  });

  valid = valid && validateNumber({
    value: inflationRatePct, min: 0, max: 100,
    errorEl: inflationRateError, name: "Inflation rate"
  });

  valid = valid && validateNumber({
    value: discountRatePct, min: 0, max: 100,
    errorEl: discountRateError, name: "Discount rate"
  });

  if (renovationCost > priceBefore) {
    renovationCostError.textContent = "⚠ Renovation cost exceeds property price!";
    valid = false;
  }

  if (!valid) return;

  /* ===== logic ===== */

  const priceIncrease = pctToRate(priceIncreasePct);
  const rentIncrease = pctToRate(rentIncreasePct);
  const agentFee = pctToRate(agentFeePct);
  const saleTax = pctToRate(saleTaxPct);

  const discountRate = pctToRate(discountRatePct);
  const inflationRate = pctToRate(inflationRatePct);

  const priceAfter = priceBefore * (1 + priceIncrease);
  const rentAfter = rentBefore * (1 + rentIncrease); // всё ещё МЕСЯЧНАЯ аренда

  // extra rent per YEAR (потому что горизонт years)
  const extraRentPerYear = (rentAfter - rentBefore) * 12;

  const totalExtraRent = extraRentPerYear * years;

  // Реальная дисконт-ставка (корректная)
  const realDiscount = (1 + discountRate) / (1 + inflationRate) - 1;

  let totalExtraRentPV = 0;
  if (Math.abs(realDiscount) < 1e-9) {
    // ставка ~0 => PV = сумма без дисконтирования
    totalExtraRentPV = extraRentPerYear * years;
  } else {
    for (let i = 1; i <= years; i++) {
      totalExtraRentPV += extraRentPerYear / Math.pow(1 + realDiscount, i);
    }
  }

  const agentCost = priceAfter * agentFee;
  const saleTaxCost = priceAfter * saleTax;

  const saleProfit = priceAfter - priceBefore - renovationCost - agentCost - saleTaxCost;

  const netProfit = saleProfit + totalExtraRent;
  const netProfitPV = saleProfit + totalExtraRentPV;

  const roi = renovationCost > 0 ? (netProfit / renovationCost) * 100 : null;
  const roiPV = renovationCost > 0 ? (netProfitPV / renovationCost) * 100 : null;

  let payback = null;
  if (extraRentPerYear > 0) {
    payback = renovationCost / extraRentPerYear; // в годах
  }

  /* ===== output ===== */

  priceAfterEl.textContent = moneyFormatter.format(priceAfter);

  // так как rentBefore/rentAfter у нас MONTHLY:
  rentAfterEl.textContent = moneyFormatter.format(rentAfter) + " / month";

  extraRentEl.textContent = moneyFormatter.format(totalExtraRent);
  netProfitEl.textContent = moneyFormatter.format(netProfit);

  roiEl.textContent = roi === null ? "N/A" : percentFormatter.format(roi / 100);
  roiPVEl.textContent = roiPV === null ? "N/A" : percentFormatter.format(roiPV / 100);

  paybackEl.textContent = formatPayback(payback);

  netProfitEl.style.color = netProfit >= 0 ? "green" : "red";
  roiEl.style.color = roi !== null && roi >= 0 ? "green" : "red";
  roiPVEl.style.color = roiPV !== null && roiPV >= 0 ? "green" : "red";
  paybackEl.style.color = payback !== null && payback > years ? "orange" : "blue";

  /* ===== save ===== */
  if (csrfToken) {
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
          priceIncrease: priceIncreasePct,
          rentIncrease: rentIncreasePct,
          agentFee: agentFeePct,
          saleTax: saleTaxPct,
          years,
          discountRate: discountRatePct,
          inflationRate: inflationRatePct
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
  } else {
    console.warn("CSRF token not loaded — skip saving.");
  }

  document.getElementById("results")
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.getElementById("calcBtn")?.addEventListener("click", calculateRenovation);


