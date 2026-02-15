

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

function clearErrors() {
  document.querySelectorAll(".error").forEach(e => (e.textContent = ""));
}

function num(id) {
  const el = document.getElementById(id);
  if (!el) return NaN;
  const v = (el.value ?? "").toString().trim();
  if (v === "") return NaN;
  return Number(v);
}

function validateInputs({ loan, ratePct, years, inflationPct }) {
  let valid = true;
  clearErrors();

  if (Number.isNaN(loan) || loan <= 0 || loan > 100_000_000) {
    document.getElementById("loanError").textContent =
      "Enter an amount between 1 and 100,000,000";
    valid = false;
  }

  if (Number.isNaN(ratePct) || ratePct < 0.1 || ratePct > 70) {
    document.getElementById("rateError").textContent =
      "Interest rate must be between 0.1 and 70";
    valid = false;
  }

  if (!Number.isInteger(years) || years < 1 || years > 70) {
    document.getElementById("yearsError").textContent =
      "Enter a whole number of years (1-70)";
    valid = false;
  }

  if (Number.isNaN(inflationPct) || inflationPct < 0 || inflationPct > 50) {
    document.getElementById("inflationError").textContent =
      "Inflation rate must be between 0 and 50%";
    valid = false;
  }

  // сохранять можно и без csrfToken (просто не шлём), но валидатор пусть не ломает расчёт
  return valid;
}

function annuityPayment(principal, annualRate, months) {
  // annualRate в долях (0.06), months int
  if (annualRate === 0) return principal / months;

  const r = annualRate / 12;
  const pow = Math.pow(1 + r, months);
  return principal * (r * pow) / (pow - 1);
}

async function calculateOverpayment() {
  const loan = num("loan");
  const ratePct = num("rate");
  const years = Math.trunc(num("years"));
  const inflationPct = num("inflation");

  if (!validateInputs({ loan, ratePct, years, inflationPct })) return;

  const rate = ratePct / 100;           // доля
  const inflation = inflationPct / 100; // доля

  const months = years * 12;

  const payment = annuityPayment(loan, rate, months);

  const totalPaid = payment * months;
  const nominalOverpayment = totalPaid - loan;

  // реальная ставка (в %)
  const realInterestRatePct = (((1 + rate) / (1 + inflation)) - 1) * 100;

  // PV платежей в "реальных" долларах
  const monthlyInflation = inflation / 12;

  let realTotalPaid = 0;
  for (let m = 1; m <= months; m++) {
    realTotalPaid += payment / Math.pow(1 + monthlyInflation, m);
  }

  let realOverpayment = realTotalPaid - loan;

  // чтобы не было "минус денег" в UI/аккаунте:
  // если инфляция полностью перекрывает проценты — считаем 0, а текст выводим отдельно
  const realOverpaymentOffset = realOverpayment <= 0;
  if (realOverpaymentOffset) realOverpayment = 0;

  // ===== output =====
  document.getElementById("payment").textContent = moneyFormatter.format(payment);
  document.getElementById("nominalOverpayment").textContent = moneyFormatter.format(nominalOverpayment);

  document.getElementById("realOverpayment").textContent =
    realOverpaymentOffset
      ? "Inflation fully offsets interest"
      : moneyFormatter.format(realOverpayment);

  // ===== save =====
  if (!csrfToken) {
    console.warn("CSRF token not loaded — skip saving.");
  } else {
    try {
      await fetch("/api/app/calculation", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
          calculatorType: "mortgage_overpayment",
          inputData: {
            loan,
            rate: ratePct,             // ✅ храним как % (например 6)
            years,
            inflation: inflationPct    // ✅ храним как % (например 4)
          },
          resultData: {
            monthlyPayment: Math.round(payment),
            nominalOverpayment: Math.round(nominalOverpayment),
            realOverpayment: Math.round(realOverpayment), // ✅ всегда число >= 0
            realInterestRate: realInterestRatePct         // ✅ % (например 1.92)
          }
        })
      });
    } catch (err) {
      console.error("Error sending data:", err);
    }
  }

  document.getElementById("results")
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.getElementById("calcBtn")
  ?.addEventListener("click", calculateOverpayment);

