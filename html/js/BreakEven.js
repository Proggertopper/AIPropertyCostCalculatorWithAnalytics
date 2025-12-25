function calculateBreakEven() {
  const price = +document.getElementById("price").value;
  const downPayment = +document.getElementById("downPayment").value;

  const mortgage = +document.getElementById("mortgage").value;
  const expenses = +document.getElementById("expenses").value;
  const taxes = +document.getElementById("taxes").value;

  const vacancy = +document.getElementById("vacancy").value / 100;

  // 1️⃣ Минимальная аренда (cash flow = 0)
  const totalMonthlyCosts = mortgage + expenses + taxes;
  const breakEvenRent =
    totalMonthlyCosts / (1 - vacancy);

  // 2️⃣ Максимальная цена покупки
  // Допущение: ипотека = 0.6% от цены в месяц (≈7.2% годовых)
  const mortgageRateMonthly = 0.006;
  const maxMortgage =
    breakEvenRent * (1 - vacancy) - expenses - taxes;

  const maxPrice =
    maxMortgage / mortgageRateMonthly;

  document.getElementById("breakEvenRent").textContent =
    breakEvenRent.toFixed(0) + " $ / мес";

  document.getElementById("breakEvenPrice").textContent =
    maxPrice.toFixed(0) + " $";
}