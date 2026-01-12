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

  const rent = +document.getElementById("rent").value;
  const years = +document.getElementById("years").value;
  const mortgage = +document.getElementById("mortgage").value;
  const propertyValue = +document.getElementById("propertyValue").value;

  if (!validateInputs({ rent, mortgage, years, propertyValue })) return;

  /* ===== calculations ===== */

  const rentTotal = rent * 12 * years;
  const mortgagePaid = mortgage * 12 * years;

  // минимально корректная модель:
  const equity = Math.max(propertyValue - mortgagePaid, 0);
  const buyNetCost = mortgagePaid - equity;

  /* ===== output ===== */

  document.getElementById("rentResult").textContent =
    `Rent (total paid): ${moneyFormatter.format(rentTotal)}`;

  document.getElementById("buyResult").textContent =
    `Buy (net cost): ${moneyFormatter.format(buyNetCost)}`;

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
        propertyValue
      },

      resultData: {
        rentTotal,
        mortgagePaid,
        equity,
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

function validateInputs({ rent, mortgage, years, propertyValue }) {
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

  return isValid;
}

