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
}