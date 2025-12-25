function calculateSale() {
  const buyPrice = +document.getElementById("buyPrice").value;
  const sellPrice = +document.getElementById("sellPrice").value;
  const years = +document.getElementById("years").value;

  const taxRate = +document.getElementById("tax").value / 100;
  const commissionRate = +document.getElementById("commission").value / 100;
  const renovation = +document.getElementById("renovation").value;
  const inflation = +document.getElementById("inflation").value / 100;

  const taxAmount = sellPrice * taxRate;
  const commissionAmount = sellPrice * commissionRate;

  const netProfit =
    sellPrice -
    buyPrice -
    taxAmount -
    commissionAmount -
    renovation;

  const investedCapital = buyPrice + renovation;

  const annualReturn =
    (netProfit / investedCapital) / years * 100;

  // 🔥 РЕАЛЬНАЯ доходность с учётом инфляции
  const realReturn =
    ((1 + annualReturn / 100) / (1 + inflation) - 1) * 100;

  document.getElementById("taxAmount").textContent =
    taxAmount.toFixed(0) + " $";

  document.getElementById("commissionAmount").textContent =
    commissionAmount.toFixed(0) + " $";

  document.getElementById("netProfit").textContent =
    netProfit.toFixed(0) + " $";

  document.getElementById("annualReturn").textContent =
    annualReturn.toFixed(1) + " %";

  document.getElementById("realReturn").textContent =
    realReturn.toFixed(1) + " %";

  const decision = document.getElementById("decision");

  if (realReturn >= 5) {
    decision.textContent = "Продажа оправдана в реальных деньгах 📈";
    decision.className = "decision good";
  } else {
    decision.textContent = "Доходность ниже инфляции ⛔";
    decision.className = "decision bad";
  }
}