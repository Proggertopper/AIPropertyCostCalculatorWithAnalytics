function clearErrors() {
  document.querySelectorAll(".error").forEach(e => (e.textContent = ""));
}

function validateNumber({ value, min, max, errorEl, name }) {
  if (!Number.isFinite(value)) {
    if (errorEl) errorEl.textContent = `${name}: invalid number`;
    return false;
  }
  if (value < min) {
    if (errorEl) errorEl.textContent = `${name}: minimum ${min}`;
    return false;
  }
  if (value > max) {
    if (errorEl) errorEl.textContent = `${name}: maximum ${max}`;
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
  maximumFractionDigits: 2
});

/**
 * Real (inflation-adjusted) future value simulation.
 *
 * Assumptions (simple but consistent):
 * - annualReturn is nominal %/year on capital
 * - taxRate is % on *positive yearly gain* (not on the whole capital)
 * - annualContribution is $/year and is added at end of year (after taxes)
 * - inflationRate is %/year, applied to convert to "today's dollars" each year
 */
function calculateRealFutureValue({
  initial,
  annualContribution,
  annualReturn,
  years,
  inflationRate,
  taxRate
}) {
  let value = initial;

  const r = annualReturn / 100;
  const inf = inflationRate / 100;
  const tax = taxRate / 100;

  for (let y = 0; y < years; y++) {
    const gain = value * r;

    // tax only on positive gain (income / capital gain tax)
    const taxOnGain = gain > 0 ? gain * tax : 0;

    value += (gain - taxOnGain);

    // contribution assumed after-tax cash added at end of year
    value += annualContribution;

    // convert to real value (today's purchasing power)
    value /= (1 + inf);
  }

  return value;
}

function calculateRealCAGRPercent({ initial, finalValue, years }) {
  if (!Number.isFinite(initial) || initial <= 0) return null;
  if (!Number.isFinite(finalValue) || finalValue <= 0) return null;
  if (!Number.isFinite(years) || years <= 0) return null;

  return (Math.pow(finalValue / initial, 1 / years) - 1) * 100;
}

/* ===== calculation ===== */
function calculateComparison(e) {
  e?.preventDefault?.();
  clearErrors();

  // Inputs
  const propertyInitial = Number(propertyInitialInput.value);
  const propertyCashflow = Number(propertyCashflowInput.value); // $/year (can be negative)
  const propertyGrowth = Number(propertyGrowthInput.value);     // %/year

  const altReturn = Number(altReturnInput.value);              // %/year
  const altContribution = Number(altContributionInput.value);  // ✅ $/year (NOT %)

  const propertyInflation = Number(propertyInflationInput.value); // %/year
  const propertyTaxRate = Number(propertyTaxInput.value);         // % on gain

  const altInflation = Number(altInflationInput.value);           // %/year
  const altTaxRate = Number(altTaxInput.value);                   // % on gain

  const years = Number(yearsInput.value);

  let valid = true;

  valid = valid && validateNumber({
    value: propertyInitial, min: 1, max: 100_000_000,
    errorEl: propertyInitialError, name: "Initial Investment"
  });

  valid = valid && validateNumber({
    value: propertyCashflow, min: -10_000_000, max: 10_000_000,
    errorEl: propertyCashflowError, name: "Annual Cash Flow"
  });

  valid = valid && validateNumber({
    value: propertyGrowth, min: -99, max: 2000,
    errorEl: propertyGrowthError, name: "Annual Property Growth"
  });

  valid = valid && validateNumber({
    value: altReturn, min: -99, max: 2000,
    errorEl: altReturnError, name: "Expected Annual Return"
  });

  // ✅ Treat as dollars per year (fix mismatch with your HTML label)
  valid = valid && validateNumber({
    value: altContribution, min: 0, max: 10_000_000,
    errorEl: altContributionError, name: "Additional Contribution ($/year)"
  });

  valid = valid && validateNumber({
    value: years, min: 1, max: 80,
    errorEl: yearsError, name: "Investment Term"
  });

  valid = valid && validateNumber({
    value: propertyInflation, min: 0, max: 100,
    errorEl: propertyInflationError, name: "Property Inflation Rate"
  });

  valid = valid && validateNumber({
    value: propertyTaxRate, min: 0, max: 100,
    errorEl: propertyTaxError, name: "Property Tax Rate"
  });

  valid = valid && validateNumber({
    value: altInflation, min: 0, max: 100,
    errorEl: altInflationError, name: "Alternative Inflation Rate"
  });

  valid = valid && validateNumber({
    value: altTaxRate, min: 0, max: 100,
    errorEl: altTaxError, name: "Alternative Tax Rate"
  });

  if (!valid) return;

  /* ===== logic ===== */

  const propertyValue = calculateRealFutureValue({
    initial: propertyInitial,
    annualContribution: propertyCashflow,
    annualReturn: propertyGrowth,
    years,
    inflationRate: propertyInflation,
    taxRate: propertyTaxRate
  });

  const alternativeValue = calculateRealFutureValue({
    initial: propertyInitial,
    annualContribution: altContribution,
    annualReturn: altReturn,
    years,
    inflationRate: altInflation,
    taxRate: altTaxRate
  });

  const propertyRealReturnPercent = calculateRealCAGRPercent({
    initial: propertyInitial, finalValue: propertyValue, years
  });

  const alternativeRealReturnPercent = calculateRealCAGRPercent({
    initial: propertyInitial, finalValue: alternativeValue, years
  });

  const difference = propertyValue - alternativeValue;

  // difference = property - alternative: positive means property wins
  const winner = difference > 0 ? "property" : (difference < 0 ? "alternative" : "tie");

  /* ===== output ===== */
  propertyResultEl.textContent = moneyFormatter.format(propertyValue);
  alternativeResultEl.textContent = moneyFormatter.format(alternativeValue);

  if (winner === "property") {
    winnerEl.textContent = "Property Wins 📈";
    winnerEl.className = "winner property";
  } else if (winner === "alternative") {
    winnerEl.textContent = "Alternative Investments Win 📊";
    winnerEl.className = "winner alternative";
  } else {
    winnerEl.textContent = "Tie 🤝";
    winnerEl.className = "winner tie";
  }

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
        calculatorType: "alternative_investment",
        inputData: {
          propertyInitial,
          propertyCashflow,
          propertyGrowth,
          propertyInflation,
          propertyTaxRate,
          altReturn,
          altContribution,   // ✅ $/year
          altInflation,
          altTaxRate,
          years
        },
        resultData: {
          propertyValue,
          alternativeValue,
          propertyRealReturnPercent,     // may be null if finalValue <= 0
          alternativeRealReturnPercent,  // may be null if finalValue <= 0
          difference,
          winner
        }
      })
    }).catch(console.error);
  } else {
    console.warn("CSRF token not loaded — skip saving.");
  }

  resultsEl?.scrollIntoView({ behavior: "smooth", block: "start" });
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

document.getElementById("calcBtn").addEventListener("click", calculateComparison);
