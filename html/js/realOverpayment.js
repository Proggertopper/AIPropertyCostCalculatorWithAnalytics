let csrfToken;
window.addEventListener("DOMContentLoaded", async () => {
  const res = await fetch("/api/csrf", { credentials: "include" });
  const data = await res.json();
  csrfToken = data.csrfToken;
});

function clearErrors() {
  document.querySelectorAll(".error").forEach(e => e.textContent = "");
}

function validateInputs({ loan, rate, years, inflation }) {
  let valid = true;
  clearErrors();

  if (isNaN(loan) || loan <= 0 || loan > 100_000_000) {
    document.getElementById("loanError").textContent =
      "Enter an amount between 1 and 100,000,000";
    valid = false;
  }

  if (isNaN(rate) || rate <= 0 || rate > 99) {
    document.getElementById("rateError").textContent =
      "Interest rate must be between 0.1 and 50";
    valid = false;
  }

  if (
    isNaN(years) ||
    years <= 0 ||
    years > 70 ||
    !Number.isInteger(years)
  ) {
    document.getElementById("yearsError").textContent =
      "Enter a whole number of years (1–50)";
    valid = false;
  }

  if (isNaN(inflation) || inflation < 0 || inflation > 50) {
    document.getElementById("inflationError").textContent =
      "Inflation rate must be between 0 and 50%";
    valid = false;
  }

  if (!csrfToken) {
    console.error("CSRF token not loaded");
    valid = false;
  }

  return valid;
}

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

async function calculateOverpayment() {
  const loan = +document.getElementById("loan").value;
  const rate = +document.getElementById("rate").value;
  const years = +document.getElementById("years").value;
  const inflation = +document.getElementById("inflation").value;

  if (!validateInputs({ loan, rate, years, inflation })) return;

  const rateDecimal = rate / 100;
  const inflationDecimal = inflation / 100;

  const months = years * 12;
  const monthlyRate = rateDecimal / 12;
  const monthlyInflation = inflationDecimal / 12;

  const payment =
    loan *
    (monthlyRate * Math.pow(1 + monthlyRate, months)) /
    (Math.pow(1 + monthlyRate, months) - 1);

  const totalPaid = payment * months;
  const nominalOverpayment = totalPaid - loan;

  let realTotalPaid = 0;
  for (let m = 1; m <= months; m++) {
    realTotalPaid += payment / Math.pow(1 + monthlyInflation, m);
  }

  const realOverpayment = realTotalPaid - loan;

  document.getElementById("payment").textContent = moneyFormatter.format(payment);
  document.getElementById("nominalOverpayment").textContent = moneyFormatter.format(nominalOverpayment);
  document.getElementById("realOverpayment").textContent = moneyFormatter.format(realOverpayment);

  try {
    const res = await fetch("/api/app/calculation", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        calculatorType: "mortgage_overpayment",
        inputData: { loan, rate, years, inflation },
        resultData: {
          monthlyPayment: Math.round(payment),
          nominalOverpayment: Math.round(nominalOverpayment),
          realOverpayment: Math.round(realOverpayment)
        }
      })
    });

    const data = await res.json();
    // console.log("Server responded:", data);
  } catch (err) {
    console.error("Error sending data:", err);
  }

  document
    .getElementById("results")
    .scrollIntoView({ behavior: "smooth", block: "start" });
}

document.getElementById("calcBtn").addEventListener("click", calculateOverpayment);
