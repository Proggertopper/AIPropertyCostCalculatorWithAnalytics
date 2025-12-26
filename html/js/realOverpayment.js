let csrfToken;
window.addEventListener("DOMContentLoaded", async () => {
  const res = await fetch("/api/csrf");
  const data = await res.json();
  csrfToken = data.csrfToken;
});

function calculateOverpayment() {
  const loan = +document.getElementById("loan").value;
  const rate = +document.getElementById("rate").value / 100;
  const years = +document.getElementById("years").value;
  const inflation = +document.getElementById("inflation").value / 100;

  const months = years * 12;
  const monthlyRate = rate / 12;
  const monthlyInflation = inflation / 12;

  // Аннуитетный платёж
  const payment =
    loan *
    (monthlyRate * Math.pow(1 + monthlyRate, months)) /
    (Math.pow(1 + monthlyRate, months) - 1);

  const totalPaid = payment * months;
  const nominalOverpayment = totalPaid - loan;

  // Реальная стоимость платежей (дисконтирование инфляцией)
  let realTotalPaid = 0;
  for (let m = 1; m <= months; m++) {
    realTotalPaid += payment / Math.pow(1 + monthlyInflation, m);
  }

  const realOverpayment = realTotalPaid - loan;

  document.getElementById("payment").textContent =
    payment.toFixed(0) + " $";

  document.getElementById("nominalOverpayment").textContent =
    nominalOverpayment.toFixed(0) + " $";

  document.getElementById("realOverpayment").textContent =
    realOverpayment.toFixed(0) + " $";

    fetch("/api/app/calculation", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify({
      expression: `${loan},${rate},${years},${inflation}`,
      result: realOverpayment
    })
  })
  .then(res => res.json())
  .then(data => {
    console.log("Сервер ответил:", data);
  })
  .catch(err => console.error("Ошибка при отправке:", err));
}

ocument.getElementById("calcBtn").addEventListener("click", calculateOverpayment);