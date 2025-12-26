let csrfToken;
window.addEventListener("DOMContentLoaded", async () => {
    const res = await fetch("/api/csrf");
    const data = await res.json();
    csrfToken = data.csrfToken;
});

const moneyFormatter = new Intl.NumberFormat('en-US' , {
        style : 'currency' ,
        currency : 'USD'
    });


function validateInputs({ price, down, ratePercent, termYears }) {

    let isValid = true;
    
    document.querySelectorAll('.error').forEach(e => e.textContent = '');

    if (isNaN(price) || price <= 0) {
    document.getElementById('priceError').textContent =
        'Введите корректную цену недвижимости';
        isValid = false;
    }

    if (isNaN(down) || down <= 0) {
    document.getElementById('downError').textContent =
        'Введите корректный первоначальный взнос';
        isValid = false;
    }

    if (!isNaN(price) && down >= price) {
    document.getElementById('downError').textContent =
        'Взнос не может быть больше цены';
        isValid = false;
    }

    if (isNaN(ratePercent) || ratePercent<= 0 || ratePercent > 100) {
    document.getElementById('rateError').textContent =
        'Введите процент от 0 до 100';
        isValid = false;
    }

    if (isNaN(termYears) || termYears <= 0 || termYears > 50) {
    document.getElementById('termError').textContent =
        'Введите срок от 1 до 50 лет';
        isValid = false;
    } 

    return isValid;
}




document.getElementById('propertyCalculator').addEventListener("submit" , function(e){
    e.preventDefault();

    const price =parseFloat(document.getElementById('propertyPrice').value);
    const down = parseFloat(document.getElementById('downPayment').value);
    const ratePercent =parseFloat(document.getElementById('interestRate').value);//0.016 будет платить тип;
    const termYears =parseFloat(document.getElementById('loanTerm').value);//месяцы;

    if(!validateInputs({price , down , ratePercent , termYears})){
        return;
    }

    const rate=ratePercent/100/12;
    const term = termYears*12;

    const loanAmount = price-down;

    const monthlyPayment = loanAmount * rate/(1-Math.pow(1+rate , -term));// аннуитетный платеж 
    const totalPayment = monthlyPayment * term;
    const totalInterest = totalPayment-loanAmount;

    document.getElementById('monthlyPayment').textContent = `Ежемесячный платеж: ${moneyFormatter.format(monthlyPayment)}`;
    document.getElementById('totalPayment').textContent =`Общая сумма к выплате: ${moneyFormatter.format(totalPayment)}`;
    document.getElementById('totalInterest').textContent = `Общие проценты: ${moneyFormatter.format(totalInterest)}`;

    const expression = { price, down, ratePercent, termYears };
const result = {
    monthlyPayment,
    totalPayment,
    totalInterest
};

fetch("/api/app/calculation", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify({ expression, result })
})
.then(res => res.json())
.then(data => {
    console.log("Сервер ответил:", data);
})
.catch(err => console.error("Ошибка при отправке данных:", err));

    const tbody = document.querySelector('#schedule tbody');
    tbody.innerHTML = '';

    let balance = loanAmount;

    for (let month = 1; month <= term; month++) {
        const interest = balance * rate;
        const principal = monthlyPayment - interest;
        balance -= principal;

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${month}</td>
            <td>$${monthlyPayment.toFixed(2)}</td>
            <td>$${interest.toFixed(2)}</td>
            <td>$${principal.toFixed(2)}</td>
            <td>$${Math.max(balance, 0).toFixed(2)}</td>
    `;

    tbody.appendChild(row);
}

let balance2 = loanAmount;
const interestData = [];
const principalData = [];
const labels = [];

for (let i = 1; i <= term; i++) {
    const interest = balance2 * rate;
    const principal = monthlyPayment - interest;
    balance2 -= principal;

    labels.push(i);
    interestData.push(interest.toFixed(2));
    principalData.push(principal.toFixed(2));
}

// if (window.loanChart) {
//     window.loanChart.destroy();
// }

// const ctx = document.getElementById('paymentChart').getContext('2d');

// window.loanChart = new Chart(ctx, {
//     type: 'line',
//     data: {
//     labels,
//     datasets: [
//                 {
//             label: 'Проценты',
//             data: interestData,
//             borderWidth: 2
//             },
//             {
//             label: 'Тело кредита',
//             data: principalData,
//             borderWidth: 2
//             }
//         ]
//     }
// });

});