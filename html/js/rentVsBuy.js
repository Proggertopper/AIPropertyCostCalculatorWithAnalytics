
const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

function num(id) {
  const el = document.getElementById(id);
  if (!el) return NaN;
  // Number("") -> 0, поэтому лучше trim+NaN
  const v = el.value?.trim?.() ?? "";
  if (v === "") return NaN;
  return Number(v);
}

async function calculateRentVsBuy(e) {
  e.preventDefault();

  // ===== 1) читаем ИСХОДНЫЕ значения как вводит пользователь =====
  const rentInput = num("rent");                  // $/month
  const mortgageInput = num("mortgage");          // $/month
  const years = Math.trunc(num("years"));         // years
  const propertyValueInput = num("propertyValue");// $

  // проценты как проценты (3 = 3%)
  const rentGrowthPct = num("rentGrowth");
  const mortgageRatePct = num("mortgageRate");
  const propertyGrowthPct = num("propertyGrowth");
  const inflationPct = num("inflation");

  if (!validateInputs({
    rent: rentInput,
    mortgage: mortgageInput,
    years,
    propertyValue: propertyValueInput,
    rentGrowthPct,
    mortgageRatePct,
    propertyGrowthPct,
    inflationPct
  })) return;

  // ===== 2) для расчёта переводим проценты в доли =====
  const rentGrowth = rentGrowthPct / 100;
  const mortgageRate = mortgageRatePct / 100;
  const propertyGrowth = propertyGrowthPct / 100;
  const inflation = inflationPct / 100;

  // ===== 3) расчёт =====
  // Assumptions:
  // - mortgage is fixed monthly payment
  // - mortgageRate defines amortization for implied remaining balance
  // - implied mortgage term = 30 years
  const mortgageTermYears = 30;
  const termMonths = mortgageTermYears * 12;
  const horizonMonths = years * 12;
  const monthlyRate = mortgageRate / 12;

  const impliedLoanAmount = monthlyRate === 0
    ? mortgageInput * termMonths
    : mortgageInput * ((1 - Math.pow(1 + monthlyRate, -termMonths)) / monthlyRate);

  let remainingLoanBalance = 0;
  if (horizonMonths < termMonths) {
    if (monthlyRate === 0) {
      remainingLoanBalance = Math.max(0, impliedLoanAmount - mortgageInput * horizonMonths);
    } else {
      const pow = Math.pow(1 + monthlyRate, horizonMonths);
      remainingLoanBalance =
        impliedLoanAmount * pow -
        mortgageInput * ((pow - 1) / monthlyRate);
      if (!Number.isFinite(remainingLoanBalance)) remainingLoanBalance = 0;
      remainingLoanBalance = Math.max(0, remainingLoanBalance);
    }
  }

  // ===== rent path =====
  let rent = rentInput;

  let rentTotal = 0;
  const mortgagePaid = mortgageInput * 12 * years;
  let propertyValueFinal = propertyValueInput;

  for (let year = 1; year <= years; year++) {
    rentTotal += rent * 12;
    rent *= (1 + rentGrowth);

    propertyValueFinal *= (1 + propertyGrowth);
  }

  // Real equity approximation at horizon
  const discountedPropertyValue = propertyValueFinal / Math.pow(1 + inflation, years);
  const remainingBalanceReal = remainingLoanBalance / Math.pow(1 + inflation, years);
  const equityReal = discountedPropertyValue - remainingBalanceReal;
  const buyNetCost = mortgagePaid - equityReal;

  // ===== 4) output =====
  document.getElementById("rentResult").textContent =
    `${moneyFormatter.format(rentTotal)}`;

  document.getElementById("buyResult").textContent =
    `${moneyFormatter.format(buyNetCost)}`;

  document.getElementById("winner").textContent =
    rentTotal < buyNetCost
      ? "Renting is more cost-effective over this period"
      : "Buying is more cost-effective over this period";

  // ===== 5) save (сохраняем ИСХОДНЫЕ значения, а не 'rent' после цикла) =====
  if (typeof csrfToken === "undefined" || !csrfToken) {
    console.warn("CSRF token not loaded — skip saving.");
  } else {
    fetch("/api/app/calculation", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        calculatorType: "rent_vs_buy",
        inputData: {
          rent: rentInput,
          mortgage: mortgageInput,
          years,
          propertyValue: propertyValueInput,

          // сохраняем проценты как проценты (3, 6.5, ...)
          rentGrowth: rentGrowthPct,
          mortgageRate: mortgageRatePct,
          propertyGrowth: propertyGrowthPct,
          inflation: inflationPct
        },
        resultData: {
          rentTotal,
          mortgagePaid,
          impliedLoanAmount,
          remainingLoanBalance,
          equityReal,
          buyNetCost,
          winner: rentTotal < buyNetCost ? "rent" : "buy"
        }
      })
    }).catch(console.error);
  }

  document.getElementById("results")
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}


function validateInputs({
  rent,
  mortgage,
  years,
  propertyValue,
  rentGrowthPct,
  mortgageRatePct,
  propertyGrowthPct,
  inflationPct
}) {
  let isValid = true;

  document.querySelectorAll(".error").forEach(e => (e.textContent = ""));

  if (!Number.isFinite(rent) || rent <= 0) {
    document.getElementById("rentError").textContent = "Please enter a valid rent amount";
    isValid = false;
  }

  if (!Number.isFinite(mortgage) || mortgage <= 0) {
    document.getElementById("mortgageError").textContent = "Please enter a valid mortgage payment";
    isValid = false;
  }

  if (!Number.isFinite(propertyValue) || propertyValue <= 0) {
    document.getElementById("propertyValueError").textContent = "Please enter a valid property value";
    isValid = false;
  }

  if (!Number.isInteger(years) || years <= 0 || years > 50) {
    document.getElementById("yearsError").textContent = "Please enter a valid ownership period (1-50 years)";
    isValid = false;
  }

  // проценты в формате "6.5" (не 0.065)
  if (!Number.isFinite(rentGrowthPct) || rentGrowthPct < 0 || rentGrowthPct > 50) {
    document.getElementById("rentGrowthError").textContent = "Enter a valid rent growth (0–50%)";
    isValid = false;
  }

  if (!Number.isFinite(mortgageRatePct) || mortgageRatePct < 0 || mortgageRatePct > 100) {
    document.getElementById("mortgageRateError").textContent = "Enter a valid mortgage rate (0–100%)";
    isValid = false;
  }

  if (!Number.isFinite(propertyGrowthPct) || propertyGrowthPct < 0 || propertyGrowthPct > 50) {
    document.getElementById("propertyGrowthError").textContent = "Enter a valid property growth (0–50%)";
    isValid = false;
  }

  if (!Number.isFinite(inflationPct) || inflationPct < 0 || inflationPct > 20) {
    document.getElementById("inflationError").textContent = "Enter a valid inflation (0–20%)";
    isValid = false;
  }

  return isValid;
}

document.getElementById("calcBtn")?.addEventListener("click", calculateRentVsBuy);



