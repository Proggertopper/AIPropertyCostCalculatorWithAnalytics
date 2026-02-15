// cashFlow.js


const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

function num(id) {
  const el = document.getElementById(id);
  if (!el) return NaN;
  const v = (el.value ?? "").toString().trim();
  if (v === "") return NaN;
  return Number(v);
}

function clearErrors() {
  document.querySelectorAll(".error").forEach(e => (e.textContent = ""));
}

function validateNumber({ value, min, max, errorEl, name }) {
  if (!Number.isFinite(value)) {
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

/* ===== calculation ===== */
function calculateCashFlow(e) {
  e?.preventDefault?.();
  clearErrors();

  // Все суммы ниже — В МЕСЯЦ
  const rent = num("rent");           // monthly rent income
  const vacancy = num("vacancy");     // %
  const mortgage = num("mortgage");   // monthly mortgage payment
  const expenses = num("expenses");   // monthly maintenance/opex
  const taxes = num("taxes");         // monthly taxes + insurance
  const inflation = num("inflation"); // % per year

  let valid = true;

  valid = valid && validateNumber({ value: rent, min: 0, max: 100_000_000, errorEl: rentError, name: "Rent" });
  valid = valid && validateNumber({ value: vacancy, min: 0, max: 99, errorEl: vacancyError, name: "Vacancy %" });
  valid = valid && validateNumber({ value: mortgage, min: 0, max: 10_000_000, errorEl: mortgageError, name: "Mortgage" });
  valid = valid && validateNumber({ value: expenses, min: 0, max: 10_000_000, errorEl: expensesError, name: "Maintenance" });
  valid = valid && validateNumber({ value: taxes, min: 0, max: 70, errorEl: taxesError, name: "Taxes & Insurance (%)" });
  valid = valid && validateNumber({ value: inflation, min: -5, max: 40, errorEl: inflationError, name: "Inflation %" });

  if (!valid) return;

  /* ===== logic ===== */

  const vacancyRate = vacancy / 100;

  const netIncome = rent * (1 - vacancy / 100);

  // taxesInput — это процент
  const taxesAmount = netIncome * (taxes / 100);

  const totalExpenses = mortgage + expenses + taxesAmount;
  const cashFlowMonth = netIncome - totalExpenses;
   const cashFlowYear = cashFlowMonth * 12;

  // Инфляция: годовую переводим в месячную (корректнее, чем делить на 1+annual)
  const inflationAnnual = inflation / 100;
  const inflationMonthly = Math.pow(1 + inflationAnnual, 1 / 12) - 1;

  const realCashFlowMonth = cashFlowMonth / (1 + inflationMonthly);
  const realCashFlowYear = realCashFlowMonth * 12;

  // stress test: vacancy +5pp, expenses +10%
  const stressVacancy = Math.min(vacancy + 5, 99);
  const stressIncome = rent * (1 - stressVacancy / 100);
  const stressTaxesAmount = stressIncome * (taxes / 100);
  const stressExpenses = expenses * 1.1;
  const stressTotalExpenses = mortgage + stressExpenses + stressTaxesAmount;
  const stressCashFlow = stressIncome - stressTotalExpenses;

  /* ===== output ===== */

  incomeEl.textContent = moneyFormatter.format(netIncome);
  totalExpensesEl.textContent = moneyFormatter.format(totalExpenses);
  cashFlowMonthEl.textContent = moneyFormatter.format(cashFlowMonth);
  cashFlowYearEl.textContent = moneyFormatter.format(cashFlowYear);
  realCashFlowMonthEl.textContent = moneyFormatter.format(realCashFlowMonth);
  realCashFlowYearEl.textContent = moneyFormatter.format(realCashFlowYear);

  // Если хочешь вывод stressCashFlow — добавь в HTML:
  // <strong id="stressCashFlow"></strong>
  const stressEl = document.getElementById("stressCashFlow");
  if (stressEl) stressEl.textContent = moneyFormatter.format(stressCashFlow);

  // Status (лучше опираться на netIncome, а не на rent)
  const strongThreshold = netIncome * 0.1; // 10% маржа от реального дохода

  if (cashFlowMonth <= 0) {
    statusEl.textContent = "Negative cash flow ❌";
    statusEl.className = "status negative";
  } else if (stressCashFlow < 0) {
    statusEl.textContent = "Positive now, but fails stress test ⚠️";
    statusEl.className = "status warn";
  } else if (cashFlowMonth >= strongThreshold) {
    statusEl.textContent = "Strong positive cash flow 💰";
    statusEl.className = "status positive";
  } else {
    statusEl.textContent = "Marginal cash flow ⚠️";
    statusEl.className = "status warn";
  }

  /* ===== save ===== */
  if (!csrfToken) {
    console.warn("CSRF token not loaded — skip saving.");
  } else {
    fetch("/api/app/calculation", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        calculatorType: "cash_flow",
        inputData: { rent, vacancy, mortgage, expenses, taxes, inflation },
        resultData: {
          netIncome,
          taxesAmount,
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
  }

  resultsEl?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ===== aliases ===== */
const rentError = document.getElementById("rentError");
const vacancyError = document.getElementById("vacancyError");
const mortgageError = document.getElementById("mortgageError");
const expensesError = document.getElementById("expensesError");
const taxesError = document.getElementById("taxesError");
const inflationError = document.getElementById("inflationError");

const incomeEl = document.getElementById("income");
const totalExpensesEl = document.getElementById("totalExpenses");
const cashFlowMonthEl = document.getElementById("cashFlowMonth");
const cashFlowYearEl = document.getElementById("cashFlowYear");
const realCashFlowMonthEl = document.getElementById("realCashFlowMonth");
const realCashFlowYearEl = document.getElementById("realCashFlowYear");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

document.getElementById("calcBtn")?.addEventListener("click", calculateCashFlow);
