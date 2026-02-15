

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

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

function calculateBreakEven(e) {
  e?.preventDefault?.();
  clearErrors();

  // inputs (всё в МЕСЯЦ кроме %)
  const price = Number(priceInput.value);
  const downPayment = Number(downPaymentInput.value);

  const marketRent = Number(marketRentInput.value); // ✅ НОВОЕ: реальная аренда рынка

  const mortgage = Number(mortgageInput.value);
  const expenses = Number(expensesInput.value);
  const taxes = Number(taxesInput.value); // здесь это $/month
  const vacancy = Number(vacancyInput.value);

  let valid = true;

  valid = valid && validateNumber({ value: price, min: 1, max: 500_000_000, errorEl: priceError, name: "Purchase Price" });
  valid = valid && validateNumber({ value: downPayment, min: 0, max: price, errorEl: downPaymentError, name: "Down Payment" });

  valid = valid && validateNumber({ value: marketRent, min: 0, max: 100_000_000, errorEl: marketRentError, name: "Market Rent" });

  valid = valid && validateNumber({ value: mortgage, min: 0, max: 20_000_000, errorEl: mortgageError, name: "Mortgage" });
  valid = valid && validateNumber({ value: expenses, min: 0, max: 10_000_000, errorEl: expensesError, name: "Expenses" });
  valid = valid && validateNumber({ value: taxes, min: 0, max: 100_000_000, errorEl: taxesError, name: "Taxes & Insurance" });
  valid = valid && validateNumber({ value: vacancy, min: 0, max: 95, errorEl: vacancyError, name: "Vacancy %" });

  if (!valid) return;

  const vacancyRate = vacancy / 100;
  const totalMonthlyCosts = mortgage + expenses + taxes;

  // 1) Required rent to break even (CF = 0)
  const breakEvenRent =
    (1 - vacancyRate) > 0
      ? totalMonthlyCosts / (1 - vacancyRate)
      : Infinity;

  // 2) Max mortgage you can afford given MARKET rent (важно!)
  const netMarketIncome = marketRent * (1 - vacancyRate);
  const maxMortgage = netMarketIncome - expenses - taxes;

  // 3) Max price (грубая оценка) через "payment factor"
  // ⚠️ Т.к. у нас нет rate/term, берём "коэффициент платежа" из твоего текущего кейса:
  // paymentFactor = mortgage / loanAmount (если loanAmount > 0).
  const loanAmount = Math.max(price - downPayment, 0);
  // If loan payment is missing, use a conservative amortization factor (30y @ 6.5%)
  // instead of a hardcoded magic number.
  const assumedRate = 0.065 / 12;
  const assumedMonths = 30 * 12;
  const assumedFactor = assumedRate / (1 - Math.pow(1 + assumedRate, -assumedMonths));
  const paymentFactorRaw = (loanAmount > 0 && mortgage > 0)
    ? (mortgage / loanAmount)
    : assumedFactor;
  const paymentFactor = (Number.isFinite(paymentFactorRaw) && paymentFactorRaw > 0)
    ? paymentFactorRaw
    : assumedFactor;

  const breakEvenPrice = maxMortgage > 0
    ? downPayment + (maxMortgage / paymentFactor)
    : 0;

  // verdict (для сохранения и UI)
  const winner = marketRent >= breakEvenRent ? "property" : "rent";

  // output
  breakEvenRentEl.textContent = Number.isFinite(breakEvenRent)
    ? `${moneyFormatter.format(breakEvenRent)} / month`
    : "—";

  breakEvenPriceEl.textContent = moneyFormatter.format(Math.max(breakEvenPrice, 0));

  // save
  if (csrfToken) {
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
          marketRent,
          mortgage,
          expenses,
          taxes,
          vacancy
        },
        resultData: {
          breakEvenRent,
          breakEvenPrice,
          winner
        }
      })
    }).catch(console.error);
  }

  resultsEl?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* aliases */
const priceInput = document.getElementById("price");
const downPaymentInput = document.getElementById("downPayment");
const marketRentInput = document.getElementById("marketRent"); 
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
const marketRentError = document.getElementById("marketRentError"); 
const mortgageError = document.getElementById("mortgageError");
const expensesError = document.getElementById("expensesError");
const taxesError = document.getElementById("taxesError");
const vacancyError = document.getElementById("vacancyError");

document.getElementById("calcBtn")?.addEventListener("click", calculateBreakEven);
