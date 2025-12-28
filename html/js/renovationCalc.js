let csrfToken;
window.addEventListener("DOMContentLoaded", async () => {
  const res = await fetch("/api/csrf" , {credentials:"include"});
  const data = await res.json();
  csrfToken = data.csrfToken;
});

function calculateRenovation() {
  const priceBefore = +priceBeforeEl.value;
  const rentBefore = +rentBeforeEl.value;
  const renovationCost = +renovationCostEl.value;

  const priceIncrease = +priceIncreaseEl.value / 100;
  const rentIncrease = +rentIncreaseEl.value / 100;

  const agentFee = +agentFeeEl.value / 100;
  const saleTax = +saleTaxEl.value / 100;
  const years = +yearsEl.value;

  // После ремонта
  const priceAfter = priceBefore * (1 + priceIncrease);
  const rentAfter = rentBefore * (1 + rentIncrease);

  const extraRentPerYear = rentAfter - rentBefore;
  const totalExtraRent = extraRentPerYear * years;

  // Продажа
  const agentCost = priceAfter * agentFee;
  const saleTaxCost = priceAfter * saleTax;

  const saleProfit =
    priceAfter -
    priceBefore -
    renovationCost -
    agentCost -
    saleTaxCost;

  const netProfit = totalExtraRent + saleProfit;

  const roi = (netProfit / renovationCost) * 100;
  const payback =
    extraRentPerYear > 0
      ? renovationCost / extraRentPerYear
      : Infinity;

  // OUTPUT
  priceAfterEl.textContent = priceAfter.toFixed(0) + " $";
  rentAfterEl.textContent = rentAfter.toFixed(0) + " $ / год";
  extraRentEl.textContent = totalExtraRent.toFixed(0) + " $";
  netProfitEl.textContent = netProfit.toFixed(0) + " $";
  roiEl.textContent = roi.toFixed(1) + " %";
  paybackEl.textContent =
    payback === Infinity ? "не окупается" : payback.toFixed(1) + " лет";

    fetch("/api/app/calculation", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify({
      expression: `${priceBefore},${rentBefore},${renovationCost},${priceIncrease},${rentIncrease},${agentFee},${saleTax},${years}`,
      result: netProfit
    })
  })
  .then(res => res.json())
  .then(data => {
    console.log("Сервер ответил:", data);
  })
  .catch(err => console.error("Ошибка при отправке:", err));

}

/* aliases */
const priceBeforeEl = document.getElementById("priceBefore");
const rentBeforeEl = document.getElementById("rentBefore");
const renovationCostEl = document.getElementById("renovationCost");
const priceIncreaseEl = document.getElementById("priceIncrease");
const rentIncreaseEl = document.getElementById("rentIncrease");

const agentFeeEl = document.getElementById("agentFee");
const saleTaxEl = document.getElementById("saleTax");
const yearsEl = document.getElementById("years");

const priceAfterEl = document.getElementById("priceAfter");
const rentAfterEl = document.getElementById("rentAfter");
const extraRentEl = document.getElementById("extraRent");
const netProfitEl = document.getElementById("netProfit");
const roiEl = document.getElementById("roi");
const paybackEl = document.getElementById("payback");

document.getElementById("calcBtn").addEventListener("click", calculateRenovation);