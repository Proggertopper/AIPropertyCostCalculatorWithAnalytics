let csrfToken;
window.addEventListener("DOMContentLoaded", async () => {
  const res = await fetch("/api/csrf");
  const data = await res.json();
  csrfToken = data.csrfToken;
});


function calculateCashFlow() {
  const rent = +document.getElementById("rent").value;
  const vacancy = +document.getElementById("vacancy").value / 100;

  const mortgage = +document.getElementById("mortgage").value;
  const expenses = +document.getElementById("expenses").value;
  const taxes = +document.getElementById("taxes").value;

  const netIncome = rent * (1 - vacancy);
  const totalExpenses = mortgage + expenses + taxes;

  const cashFlowMonth = netIncome - totalExpenses;
  const cashFlowYear = cashFlowMonth * 12;

  document.getElementById("income").textContent =
    netIncome.toFixed(0) + " $";

  document.getElementById("totalExpenses").textContent =
    totalExpenses.toFixed(0) + " $";

  document.getElementById("cashFlowMonth").textContent =
    cashFlowMonth.toFixed(0) + " $";

  document.getElementById("cashFlowYear").textContent =
    cashFlowYear.toFixed(0) + " $";

  const status = document.getElementById("status");

  if (cashFlowMonth > 0) {
    status.textContent = "Объект приносит деньги 💰";
    status.className = "status positive";
  } else {
    status.textContent = "Объект убыточен ⚠️";
    status.className = "status negative";
  }

  const expression = { rent, vacancy, mortgage, expenses, taxes };
  const result = { netIncome, totalExpenses, cashFlowMonth, cashFlowYear, status: status.textContent };

  fetch("/api/app/calculation", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify({ expression, result })
  })
  .then(res => res.json())
  .then(data => console.log("Сервер ответил:", data))
  .catch(err => console.error("Ошибка при отправке данных:", err));


}

document.getElementById("calcBtn").addEventListener("click", calculateCashFlow);