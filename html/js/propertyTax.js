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

function calculateTaxes() {
  clearErrors();

  const price = +priceInput.value;
  const rent = +rentIncomeInput.value;
  const years = +yearsInput.value;
  const priceGrowth = +priceGrowthInput.value;
  const inflationRate = +inflationRateInput.value;



  const propertyTax = +propertyTaxInput.value;
  const rentTax = +rentTaxInput.value;
  const annualFees = +annualFeesInput.value;
  const feeGrowth = +feeGrowthInput.value;

  const saleTax = +saleTaxInput.value;
  const agentFee = +agentFeeInput.value;


  let valid = true;

  valid = valid && validateNumber({ value: price, min: 1, max: 500_000_000, errorEl: priceError, name: "Property Price" });
  valid = valid && validateNumber({ value: rent, min: 0, max: 30_000_000, errorEl: rentIncomeError, name: "Annual Rent" });
  valid = valid && validateNumber({ value: years, min: 1, max: 70, errorEl: yearsError, name: "Ownership Period" });
  valid = valid && validateNumber({ value: priceGrowth, min: -20, max: 100, errorEl: priceGrowthError, name: "Price Growth" });
  valid = valid && validateNumber({value: inflationRate, min: -5, max: 30, errorEl: inflationRateError,name: "Inflation Rate" });

  valid = valid && validateNumber({ value: propertyTax, min: 0, max: 70, errorEl: propertyTaxError, name: "Property Tax" });
  valid = valid && validateNumber({ value: rentTax, min: 0, max: 70, errorEl: rentTaxError, name: "Rental Tax" });
  valid = valid && validateNumber({ value: annualFees, min: 0, max: 10_000_000, errorEl: annualFeesError, name: "Annual Fees" });
  valid = valid && validateNumber({ value: feeGrowth, min: 0, max: 50, errorEl: feeGrowthError, name: "Fee Growth" });

  valid = valid && validateNumber({ value: saleTax, min: 0, max: 60, errorEl: saleTaxError, name: "Sale Tax" });
  valid = valid && validateNumber({ value: agentFee, min: 0, max: 50, errorEl: agentFeeError, name: "Agent Commission" });

  if (!valid) return;

  /* ===== logic ===== */

  let totalTaxes = 0;
  let totalFees = 0;
  let totalRentNet = 0;

  let currentPrice = price;
  let currentFees = annualFees;

  const discountRate = inflationRate / 100;

  let totalRentNetPV = 0;

  for (let y = 1; y <= years; y++) {
    const yearlyPropertyTax = currentPrice * (propertyTax / 100);
    const yearlyRentTax = rent * (rentTax / 100);

    const netRent = rent - yearlyRentTax - currentFees;

    totalTaxes += yearlyPropertyTax + yearlyRentTax;
    totalFees += currentFees;
    totalRentNet += netRent;

    // 💡 discount cash flow
    const discountFactor = 1 / Math.pow(1 + discountRate, y);
    totalRentNetPV += netRent * discountFactor;

    currentPrice *= 1 + priceGrowth / 100;
    currentFees *= 1 + feeGrowth / 100;
  }

  const totalGrossRent = rent * years;

  const taxBurdenPercent =
    totalGrossRent > 0
      ? (totalTaxes / totalGrossRent) * 100
      : 0;

  const saleTaxAmount = currentPrice * (saleTax / 100);
  const agentFeeAmount = currentPrice * (agentFee / 100);

  const saleProfit =
    (currentPrice - price) -
    saleTaxAmount -
    agentFeeAmount;

  const saleProfitPV =
    saleProfit / Math.pow(1 + discountRate, years);

  const finalProfit =
    totalRentNet + saleProfit;

  const finalProfitPV =
    totalRentNetPV + saleProfitPV;

  const investedCapital = price + totalFees + totalTaxes;
  const simpleROI = (finalProfit / investedCapital) * 100;
  const realROI = (finalProfitPV / investedCapital) * 100;


  /* ===== output ===== */

  totalTaxesEl.textContent = moneyFormatter.format(totalTaxes);
  totalFeesEl.textContent = moneyFormatter.format(totalFees);
  netProfitEl.textContent = moneyFormatter.format(totalRentNet);
  finalProfitEl.textContent = moneyFormatter.format(finalProfit);
  /* ===== save ===== */

  fetch("/api/app/calculation", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify({
      calculatorType: "property_taxes",
      inputData: {
        price,
        rent,
        years,
        priceGrowth,
        propertyTax,
        rentTax,
        annualFees,
        feeGrowth,
        saleTax,
        agentFee,
        inflationRate
      },
      resultData: {
        totalTaxes,
        totalFees,
        totalRentNet,
        finalProfit,
        finalProfitPV,
        simpleROI,
        realROI,
        taxBurdenPercent
      }
    })
  }).catch(console.error);

  document.getElementById("results")
    .scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ===== aliases ===== */

const priceInput = document.getElementById("price");
const rentIncomeInput = document.getElementById("rentIncome");
const yearsInput = document.getElementById("years");
const priceGrowthInput = document.getElementById("priceGrowth");
const inflationRateInput = document.getElementById("inflationRate");

const propertyTaxInput = document.getElementById("propertyTax");
const rentTaxInput = document.getElementById("rentTax");
const annualFeesInput = document.getElementById("annualFees");
const feeGrowthInput = document.getElementById("feeGrowth");

const saleTaxInput = document.getElementById("saleTax");
const agentFeeInput = document.getElementById("agentFee");

const totalTaxesEl = document.getElementById("totalTaxes");
const totalFeesEl = document.getElementById("totalFees");
const netProfitEl = document.getElementById("netProfit");
const finalProfitEl = document.getElementById("finalProfit");

/* errors */
const priceError = document.getElementById("priceError");
const rentIncomeError = document.getElementById("rentIncomeError");
const yearsError = document.getElementById("yearsError");
const priceGrowthError = document.getElementById("priceGrowthError");
const inflationRateError = document.getElementById("inflationRateError");

const propertyTaxError = document.getElementById("propertyTaxError");
const rentTaxError = document.getElementById("rentTaxError");
const annualFeesError = document.getElementById("annualFeesError");
const feeGrowthError = document.getElementById("feeGrowthError");

const saleTaxError = document.getElementById("saleTaxError");
const agentFeeError = document.getElementById("agentFeeError");

document.getElementById("calcBtn")
  .addEventListener("click", calculateTaxes);

