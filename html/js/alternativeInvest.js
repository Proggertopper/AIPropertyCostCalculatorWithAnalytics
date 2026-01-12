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

/* ===== calculation ===== */
function calculateComparison() {
  clearErrors();

  const propertyInitial = +propertyInitialInput.value;
  const propertyCashflow = +propertyCashflowInput.value;
  const propertyGrowth = +propertyGrowthInput.value;

  const altReturn = +altReturnInput.value;
  const altContribution = +altContributionInput.value;

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

  if (!valid) return;

  /* ===== logic ===== */
  let propertyValue = propertyInitial;
  for (let y = 1; y <= years; y++) {
    propertyValue *= 1 + propertyGrowth / 100;
    propertyValue += propertyCashflow;
  }

  let alternativeValue = propertyInitial;
  for (let y = 1; y <= years; y++) {
    alternativeValue = alternativeValue * (1 + altReturn / 100) + altContribution;
  }

  /* ===== output ===== */
  propertyResultEl.textContent = moneyFormatter.format(propertyValue);
  alternativeResultEl.textContent = moneyFormatter.format(alternativeValue);

  if (propertyValue > alternativeValue) {
    winnerEl.textContent = "Property Wins 📈";
    winnerEl.className = "winner property";
  } else {
    winnerEl.textContent = "Alternative Investments Win 📊";
    winnerEl.className = "winner alternative";
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
        altReturn,
        altContribution,
        years
      },
      resultData: {
        propertyValue,
        alternativeValue,
        winner: winnerEl.textContent
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

/* errors */
const propertyInitialError = document.getElementById("propertyInitialError");
const propertyCashflowError = document.getElementById("propertyCashflowError");
const propertyGrowthError = document.getElementById("propertyGrowthError");

const altReturnError = document.getElementById("altReturnError");
const altContributionError = document.getElementById("altContributionError");

const yearsError = document.getElementById("yearsError");

document
  .getElementById("calcBtn")
  .addEventListener("click", calculateComparison);