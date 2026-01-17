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
function calculateCashFlow() {
  clearErrors();

  const rent = +rentInput.value;
  const vacancy = +vacancyInput.value;

  const mortgage = +mortgageInput.value;
  const expenses = +expensesInput.value;
  const taxes = +taxesInput.value;
  const inflation = +inflationInput.value;

 

  let valid = true;

  valid = valid && validateNumber({
    value: rent,
    min: 0,
    max: 100_000_000,
    errorEl: rentError,
    name: "Rent"
  });

  valid = valid && validateNumber({
    value: vacancy,
    min: 0,
    max: 99,
    errorEl: vacancyError,
    name: "Vacancy %"
  });

  valid = valid && validateNumber({
    value: mortgage,
    min: 0,
    max: 10_000_000,
    errorEl: mortgageError,
    name: "Mortgage"
  });

  valid = valid && validateNumber({
    value: expenses,
    min: 0,
    max: 10_000_000,
    errorEl: expensesError,
    name: "Maintenance"
  });

  valid = valid && validateNumber({
    value: taxes,
    min: 0,
    max: 100_000_000,
    errorEl: taxesError,
    name: "Taxes & Insurance"
  }); 
  
  valid = valid && validateNumber({
    value: inflation,
    min: -5,
    max: 40,
    errorEl: inflationError,
    name: "Inflation %"
  });

  if (!valid) return;

  /* ===== logic ===== */
  const netIncome = rent * (1 - vacancy / 100);
  const totalExpenses = mortgage + expenses + taxes;

  const cashFlowMonth = netIncome - totalExpenses; 
  const cashFlowYear = cashFlowMonth * 12;

  const inflationRate = inflation / 100;

  const realCashFlowMonth = cashFlowMonth / (1 + inflationRate);
  const realCashFlowYear = realCashFlowMonth * 12;


// stress test
  const stressVacancy = vacancy + 5;
  const stressExpenses = expenses * 1.1;

  const stressIncome =
    rent * (1 - stressVacancy / 100);

  const stressTotalExpenses =
    mortgage + stressExpenses + taxes;

  const stressCashFlow =
    stressIncome - stressTotalExpenses;

  /* ===== output ===== */
  incomeEl.textContent = moneyFormatter.format(netIncome);
  totalExpensesEl.textContent = moneyFormatter.format(totalExpenses);
  cashFlowMonthEl.textContent = moneyFormatter.format(cashFlowMonth);
  cashFlowYearEl.textContent = moneyFormatter.format(cashFlowYear);
  realCashFlowMonthEl.textContent = moneyFormatter.format(realCashFlowMonth);
  realCashFlowYearEl.textContent = moneyFormatter.format(realCashFlowYear);

  if (cashFlowMonth > rent * 0.1) {
    statusEl.textContent = "Strong positive cash flow 💰";
    statusEl.className = "status positive";
  } else if (cashFlowMonth > 0) {
    statusEl.textContent = "Marginal cash flow ⚠️";
    statusEl.className = "status warn";
  } else {
    statusEl.textContent = "Negative cash flow ❌";
    statusEl.className = "status negative";
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
      calculatorType: "cash_flow",
      inputData: {
        rent,
        vacancy,
        mortgage,
        expenses,
        taxes,
        inflation
      },
      resultData: {
        netIncome,
        totalExpenses,
        cashFlowMonth,
        cashFlowYear,
        realCashFlowMonth,
        realCashFlowYear,
        stressCashFlow,
        status: statusEl.textContent
      }
    })
  }).catch(console.error);

  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ===== aliases ===== */

const rentInput = document.getElementById("rent");
const vacancyInput = document.getElementById("vacancy");

const mortgageInput = document.getElementById("mortgage");
const expensesInput = document.getElementById("expenses");
const taxesInput = document.getElementById("taxes");
const inflationInput = document.getElementById("inflation");

const incomeEl = document.getElementById("income");
const totalExpensesEl = document.getElementById("totalExpenses");
const cashFlowMonthEl = document.getElementById("cashFlowMonth");
const cashFlowYearEl = document.getElementById("cashFlowYear");
const realCashFlowMonthEl =document.getElementById("realCashFlowMonth");
const realCashFlowYearEl =document.getElementById("realCashFlowYear");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

/* errors */
const rentError = document.getElementById("rentError");
const vacancyError = document.getElementById("vacancyError");
const mortgageError = document.getElementById("mortgageError");
const expensesError = document.getElementById("expensesError");
const taxesError = document.getElementById("taxesError");
const inflationError= document.getElementById("inflationError");

document
  .getElementById("calcBtn")
  .addEventListener("click", calculateCashFlow);