let csrfToken;
window.addEventListener("DOMContentLoaded", async () => {
  const res = await fetch("/api/csrf" , {credentials:"include"});
  const data = await res.json();
  csrfToken = data.csrfToken;
});

function clearErrors() {
  document.querySelectorAll(".error").forEach(e => e.textContent = "");
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

function calculateFutureValue({ initial, annualContribution, annualReturn, years, inflationRate, taxRate }) {
  let value = initial;
  for (let i = 0; i < years; i++) {
    value += value * (annualReturn / 100);
    value += annualContribution;
    value -= value * (taxRate / 100);   // налог
    value /= 1 + inflationRate / 100;   // инфляция
  }
  return value;
}

function calculateRealReturnPercent({ initial, finalValue, years }) {
  return ((Math.pow(finalValue / initial, 1 / years) - 1) * 100);
}

/* ===== calculation ===== */
function calculateComparison() {
  clearErrors();

  const propertyInitial = +propertyInitialInput.value;
  const propertyCashflow = +propertyCashflowInput.value;
  const propertyGrowth = +propertyGrowthInput.value;

  const altReturn = +altReturnInput.value;
  const altContribution = +altContributionInput.value;

  const propertyInflation = +propertyInflationInput.value;
  const propertyTaxRate = +propertyTaxInput.value;

  const altInflation = +altInflationInput.value;
  const altTaxRate = +altTaxInput.value;

  const years = +yearsInput.value;

  let valid = true;

  valid = valid && validateNumber({
    value: propertyInitial,
    min: 1,
    max: 100_000_000,
    errorEl: propertyInitialError,
    name: "Initial Investment"
  });

  valid = valid && validateNumber({
    value: propertyCashflow,
    min: -10_000_000,
    max: 10_000_000,
    errorEl: propertyCashflowError,
    name: "Cash Flow"
  });

  valid = valid && validateNumber({
    value: propertyGrowth,
    min: -99,
    max: 2000,
    errorEl: propertyGrowthError,
    name: "Property Growth"
  });

  valid = valid && validateNumber({
    value: altReturn,
    min: -99,
    max: 2000,
    errorEl: altReturnError,
    name: "Alternative Return"
  });

  valid = valid && validateNumber({
    value: altContribution,
    min: 0,
    max: 10_000_000,
    errorEl: altContributionError,
    name: "Additional Contribution"
  });

  valid = valid && validateNumber({
    value: years,
    min: 1,
    max: 80,
    errorEl: yearsError,
    name: "Investment Term"
  });

  // валидация новых полей
  valid = valid && validateNumber({
    value: propertyInflation,
    min: 0,
    max: 100,
    errorEl: propertyInflationError,
    name: "Property Inflation Rate"
  });

  valid = valid && validateNumber({
    value: propertyTaxRate,
    min: 0,
    max: 100,
    errorEl: propertyTaxError,
    name: "Property Tax Rate"
  });

  valid = valid && validateNumber({
    value: altInflation,
    min: 0,
    max: 100,
    errorEl: altInflationError,
    name: "Alternative Inflation Rate"
  });

  valid = valid && validateNumber({
    value: altTaxRate,
    min: 0,
    max: 100,
    errorEl: altTaxError,
    name: "Alternative Tax Rate"
  });

  if (!valid) return;

  /* ===== logic ===== */

  const propertyValue = calculateFutureValue({
    initial: propertyInitial,
    annualContribution: propertyCashflow,
    annualReturn: propertyGrowth,
    years,
    inflationRate: propertyInflation,
    taxRate: propertyTaxRate
  });

  const alternativeValue = calculateFutureValue({
    initial: propertyInitial,
    annualContribution: altContribution,
    annualReturn: altReturn,
    years,
    inflationRate: altInflation,
    taxRate: altTaxRate
  });

  const propertyRealReturnPercent = calculateRealReturnPercent({ initial: propertyInitial, finalValue: propertyValue, years });
  const alternativeRealReturnPercent = calculateRealReturnPercent({ initial: propertyInitial, finalValue: alternativeValue, years });

  const difference = alternativeValue - propertyValue;
  const winner = difference > 0 ? "Alternative Investment" : "Property";

  /* ===== output ===== */
  propertyResultEl.textContent = moneyFormatter.format(propertyValue);
  alternativeResultEl.textContent = moneyFormatter.format(alternativeValue);

  if (propertyValue > alternativeValue) {
    winnerEl.textContent = "Property Wins 📈";
    winnerEl.className = "winner property";
  } else if (alternativeValue > propertyValue) {
    winnerEl.textContent = "Alternative Investments Win 📊";
    winnerEl.className = "winner alternative";
  } else {
    winnerEl.textContent = "Tie 🤝";
    winnerEl.className = "winner tie";
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
      calculatorType: "alternative_investment",
      inputData: {
        propertyInitial,
        propertyCashflow,
        propertyGrowth,
        propertyInflation,
        propertyTaxRate,
        altReturn,
        altContribution,
        altInflation,
        altTaxRate,
        years
      },
      resultData: {
        propertyValue,
        alternativeValue,
        propertyRealReturnPercent,
        alternativeRealReturnPercent,
        difference,
        winner
      }
    })
  }).catch(console.error);

  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ===== aliases ===== */

const propertyInitialInput = document.getElementById("propertyInitial");
const propertyCashflowInput = document.getElementById("propertyCashflow");
const propertyGrowthInput = document.getElementById("propertyGrowth");

const altReturnInput = document.getElementById("altReturn");
const altContributionInput = document.getElementById("altContribution");

const yearsInput = document.getElementById("years");

const propertyResultEl = document.getElementById("propertyResult");
const alternativeResultEl = document.getElementById("alternativeResult");
const winnerEl = document.getElementById("winner");
const resultsEl = document.getElementById("results");

const propertyInflationInput = document.getElementById("propertyInflation");
const propertyTaxInput = document.getElementById("propertyTax");

const altInflationInput = document.getElementById("altInflation");
const altTaxInput = document.getElementById("altTax");

/* errors */
const propertyInitialError = document.getElementById("propertyInitialError");
const propertyCashflowError = document.getElementById("propertyCashflowError");
const propertyGrowthError = document.getElementById("propertyGrowthError");

const altReturnError = document.getElementById("altReturnError");
const altContributionError = document.getElementById("altContributionError");

const yearsError = document.getElementById("yearsError");

const propertyInflationError = document.getElementById("propertyInflationError");
const propertyTaxError = document.getElementById("propertyTaxError");

const altInflationError = document.getElementById("altInflationError");
const altTaxError = document.getElementById("altTaxError");

document
  .getElementById("calcBtn")
  .addEventListener("click", calculateComparison);