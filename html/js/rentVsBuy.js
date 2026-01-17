let csrfToken;
window.addEventListener("DOMContentLoaded", async () => {
  const res = await fetch("/api/csrf", { credentials: "include" });
  const data = await res.json();
  csrfToken = data.csrfToken;
});

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

document.getElementById("calcBtn").addEventListener("click", e => {
  e.preventDefault();

  let rent = +document.getElementById("rent").value;
  const years = +document.getElementById("years").value;
  let mortgage = +document.getElementById("mortgage").value;
  const propertyValue = +document.getElementById("propertyValue").value;
  const rentGrowth = +document.getElementById("rentGrowth").value / 100;
  const mortgageRate = +document.getElementById("mortgageRate").value / 100;
  const propertyGrowth = +document.getElementById("propertyGrowth").value / 100;
  const inflation = +document.getElementById("inflation").value / 100;

  if (!validateInputs({ rent, mortgage, years, propertyValue, rentGrowth , mortgageRate, propertyGrowth , inflation })) return;

  /* ===== calculations ===== */

  let rentTotal = 0;
  let mortgagePaid = 0;
  let propertyValueFinal = propertyValue;

  for (let year = 1; year <= years; year++) {
    // рост аренды
    rentTotal += rent * 12;
    rent *= 1 + rentGrowth;

    // ипотека с процентами
    mortgagePaid += mortgage * 12;
    mortgage *= 1 + mortgageRate;

    // рост стоимости недвижимости
    propertyValueFinal *= 1 + propertyGrowth;
  }

  // покупка с учётом инфляции
  const buyNetCost = Math.max(mortgagePaid - propertyValueFinal / (1 + inflation) ** years, 0);

  /* ===== output ===== */

  document.getElementById("rentResult").textContent =
    `Rent (total paid with growth): ${moneyFormatter.format(rentTotal)}`;

  document.getElementById("buyResult").textContent =
    `Buy (net cost adjusted for growth and inflation): ${moneyFormatter.format(buyNetCost)}`;

  document.getElementById("winner").textContent =
    rentTotal < buyNetCost
      ? "Renting is more cost-effective over this period"
      : "Buying is more cost-effective over this period";

  /* ===== save ===== */

  if (!csrfToken) {
    console.error("CSRF token not loaded");
    return;
  }

  fetch("/api/app/calculation", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify({
      calculatorType: "rent_vs_buy",

      inputData: {
        rent,
        mortgage,
        years,
        propertyValue,
        rentGrowth,
        mortgageRate,
        propertyGrowth,
        inflation
      },

      resultData: {
        rentTotal,
        mortgagePaid,
        buyNetCost,
        winner: rentTotal < buyNetCost ? "rent" : "buy"
      }
    })
  }).catch(console.error);

  document
    .getElementById("results")
    .scrollIntoView({ behavior: "smooth", block: "start" });
});

/* ===== validation ===== */

function validateInputs({ rent, mortgage, years, propertyValue, rentGrowth, mortgageRate, propertyGrowth, inflation }) {
  let isValid = true;

  document.querySelectorAll(".error").forEach(e => (e.textContent = ""));

  if (isNaN(rent) || rent <= 0) {
    document.getElementById("rentError").textContent =
      "Please enter a valid rent amount";
    isValid = false;
  }

  if (isNaN(mortgage) || mortgage <= 0) {
    document.getElementById("mortgageError").textContent =
      "Please enter a valid mortgage payment";
    isValid = false;
  }

  if (isNaN(propertyValue) || propertyValue <= 0) {
    document.getElementById("propertyValueError").textContent =
      "Please enter a valid property value";
    isValid = false;
  }

  if (!Number.isInteger(years) || years <= 0 || years > 50) {
    document.getElementById("yearsError").textContent =
      "Please enter a valid ownership period (1-50 years)";
    isValid = false;
  }

  if (isNaN(mortgageRate) || mortgageRate < 0 || mortgageRate > 100) {
    document.getElementById("mortgageRateError").textContent = "Enter a valid mortgage rate (0-100%)";
    isValid = false;
  }
  if (isNaN(propertyGrowth) || propertyGrowth < -50 || propertyGrowth > 50) {
    document.getElementById("propertyGrowthError").textContent = "Enter a valid property growth (-50% to 50%)";
    isValid = false;
  }
  if (isNaN(rentGrowth) || rentGrowth < -50 || rentGrowth > 50) {
    document.getElementById("rentGrowthError").textContent = "Enter a valid rent growth (-50% to 50%)";
    isValid = false;
  }
  if (isNaN(inflation) || inflation < 0 || inflation > 20) {
    document.getElementById("inflationError").textContent = "Enter a valid inflation (0-20%)";
    isValid = false;
  }

  return isValid;
}



