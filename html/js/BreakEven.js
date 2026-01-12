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
function calculateBreakEven() {
  clearErrors();

  const price = +priceInput.value;
  const downPayment = +downPaymentInput.value;
  const mortgage = +mortgageInput.value;
  const expenses = +expensesInput.value;
  const taxes = +taxesInput.value;
  const vacancy = +vacancyInput.value;

  let valid = true;

  valid = valid && validateNumber({ value: price, min: 1, max: 500_000_000, errorEl: priceError, name: "Purchase Price" });
  valid = valid && validateNumber({ value: downPayment, min: 0, max: price, errorEl: downPaymentError, name: "Down Payment" });
  valid = valid && validateNumber({ value: mortgage, min: 0, max: 20_000_000, errorEl: mortgageError, name: "Mortgage" });
  valid = valid && validateNumber({ value: expenses, min: 0, max: 10_000_000, errorEl: expensesError, name: "Expenses" });
  valid = valid && validateNumber({ value: taxes, min: 0, max: 100_000_000, errorEl: taxesError, name: "Taxes & Insurance" });
  valid = valid && validateNumber({ value: vacancy, min: 0, max: 99, errorEl: vacancyError, name: "Vacancy %" });

  if (!valid) return;

  /* ===== logic ===== */

  const vacancyRate = vacancy / 100;
  const totalMonthlyCosts = mortgage + expenses + taxes;

  // 1️⃣ Минимальная аренда (cash flow = 0)
  const breakEvenRent =
    totalMonthlyCosts / (1 - vacancyRate);

  // 2️⃣ Максимальная цена покупки
  // допущение: ипотека ≈ 0.6% от цены в месяц
  const mortgageRateMonthly = 0.006;
  const maxMortgage =
    breakEvenRent * (1 - vacancyRate) - expenses - taxes;

  const breakEvenPrice =
    maxMortgage / mortgageRateMonthly;

  /* ===== output ===== */

  breakEvenRentEl.textContent = moneyFormatter.format(breakEvenRent) + " / month";
  breakEvenPriceEl.textContent = moneyFormatter.format(breakEvenPrice);

  /* ===== save ===== */

  fetch("/api/app/calculation", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify({
      calculatorType: "break_even",
      inputData: {
        price,
        downPayment,
        mortgage,
        expenses,
        taxes,
        vacancy
      },
      resultData: {
        breakEvenRent,
        breakEvenPrice
      }
    })
  }).catch(console.error);

  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ===== aliases ===== */

const priceInput = document.getElementById("price");
const downPaymentInput = document.getElementById("downPayment");
const mortgageInput = document.getElementById("mortgage");
const expensesInput = document.getElementById("expenses");
const taxesInput = document.getElementById("taxes");
const vacancyInput = document.getElementById("vacancy");

const breakEvenRentEl = document.getElementById("breakEvenRent");
const breakEvenPriceEl = document.getElementById("breakEvenPrice");
const resultsEl = document.getElementById("results");

/* errors */
const priceError = document.getElementById("priceError");
const downPaymentError = document.getElementById("downPaymentError");
const mortgageError = document.getElementById("mortgageError");
const expensesError = document.getElementById("expensesError");
const taxesError = document.getElementById("taxesError");
const vacancyError = document.getElementById("vacancyError");

document
  .getElementById("calcBtn")
  .addEventListener("click", calculateBreakEven);