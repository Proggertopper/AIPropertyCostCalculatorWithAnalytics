// Смена темы
const moneyFormatter = new Intl.NumberFormat('en-US' , {
        style : 'currency' ,
        currency : 'USD'
    });



    document.getElementById('rentVsBuy').addEventListener('submit', e => {
        e.preventDefault();

    const rent = +document.getElementById('rent').value;// + превращает в число 
    const years = +document.getElementById('years').value;
    const mortgage = +document.getElementById('mortgage').value;

      if (!validateInputs({ rent, mortgage, years })) return;

  const rentTotal = rent * 12 * years;
  const buyTotal = mortgage * 12 * years;

    document.getElementById('rentResult').textContent =
    `Аренда: ${moneyFormatter.format(rentTotal)}`;

    document.getElementById('buyResult').textContent =
    `Покупка: ${moneyFormatter.format(buyTotal)}`;

    document.getElementById('winner').textContent =
    rentTotal < buyTotal ? 'Аренда выгоднее' : 'Покупка выгоднее';
});

function validateInputs({ rent, mortgage, years }) {
    let isValid = true;

    document.querySelectorAll(".error").forEach(e => e.textContent='');

    if (isNaN(rent) || rent <= 0) {
    document.getElementById('rentError').textContent = 'Введите корректную аренду';
    isValid = false;
  }

  if (isNaN(mortgage) || mortgage <= 0) {
    document.getElementById('mortgageError').textContent = 'Введите корректную ипотеку';
    isValid = false;
  }

  if (isNaN(years) || years <= 0) {
    document.getElementById('yearsError').textContent = 'Введите срок больше 0';
    isValid = false;
  }

  return isValid;
}
