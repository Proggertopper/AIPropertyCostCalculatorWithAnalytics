let csrfToken;
window.addEventListener("DOMContentLoaded", async () => {
  const res = await fetch("/api/csrf");
  const data = await res.json();
  csrfToken = data.csrfToken;
});


function calculateTaxes() {
  const price = +priceInput.value;
  const rent = +rentIncome.value;
  const years = +yearsInput.value;
  const priceGrowth = +priceGrowthInput.value / 100;

  const propertyTax = +propertyTaxInput.value / 100;
  const rentTax = +rentTaxInput.value / 100;
  const annualFees = +annualFeesInput.value;
  const feeGrowth = +feeGrowthInput.value / 100;

  const saleTax = +saleTaxInput.value / 100;
  const agentFee = +agentFeeInput.value / 100;

  let totalTaxes = 0;
  let totalFees = 0;
  let totalRentNet = 0;

  let currentPrice = price;
  let currentFees = annualFees;

  for (let y = 1; y <= years; y++) {
    const yearlyPropertyTax = currentPrice * propertyTax;
    const yearlyRentTax = rent * rentTax;

    totalTaxes += yearlyPropertyTax + yearlyRentTax;
    totalFees += currentFees;

    totalRentNet += rent - yearlyRentTax - currentFees;

    currentPrice *= (1 + priceGrowth);
    currentFees *= (1 + feeGrowth);
  }

  const saleTaxAmount = currentPrice * saleTax;
  const agentFeeAmount = currentPrice * agentFee;

  const finalProfit =
    totalRentNet +
    (currentPrice - price) -
    saleTaxAmount -
    agentFeeAmount;

  totalTaxesEl.textContent = totalTaxes.toFixed(0) + " $";
  totalFeesEl.textContent = totalFees.toFixed(0) + " $";
  netProfitEl.textContent = totalRentNet.toFixed(0) + " $";
  finalProfitEl.textContent = finalProfit.toFixed(0) + " $";

  fetch("/api/app/calculation", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify({
      expression: `${price},${rent},${years}`,
      result: finalProfit
    })
  })
  .then(res => res.json())
  .then(data => {
    console.log("Сервер ответил:", data);
  })
  .catch(err => console.error("Ошибка при отправке:", err));
}

/* aliases */
const priceInput = document.getElementById("price");
const rentIncome = document.getElementById("rentIncome");
const yearsInput = document.getElementById("years");
const priceGrowthInput = document.getElementById("priceGrowth");

const propertyTaxInput = document.getElementById("propertyTax");
const rentTaxInput = document.getElementById("rentTax");
const annualFeesInput = document.getElementById("annualFees");
const feeGrowthInput = document.getElementById("feeGrowth");

const saleTaxInput = document.getElementById("saleTax");
const agentFeeInput = document.getElementById("agentFee");

const totalTaxesEl = document.getElementById("totalTaxes");
const totalFeesEl = document.getElementById("totalFees");
const netProfitEl = document.getElementById("netProfit");
const finalProfitEl = document.getElementById("finalProfit");

document.getElementById("calcBtn").addEventListener("click", calculateTaxes);