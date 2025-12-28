let csrfToken;
window.addEventListener("DOMContentLoaded", async () => {
    const res = await fetch("/api/csrf" , {credentials:"include"});
    const data = await res.json();
    csrfToken = data.csrfToken;
});



const form = document.getElementById('tco-form');// хз может есть 

form.addEventListener('submit', (e) => {
    e.preventDefault();

    const price = Number(document.getElementById('price').value);
    const years = Number(document.getElementById('years').value);
    const tax = Number(document.getElementById('tax').value) / 100;
    const maintenance = Number(document.getElementById('maintenance').value);

    if (price <= 0 || years <= 0 || tax < 0 || maintenance < 0) {
        alert("Пожалуйста, введите корректные значения.");
        return;
    }

    let totalCost = price;
    const labels = [];
    const data = [];

    for (let i = 1; i <= years; i++) {
        totalCost += price * tax + maintenance;
        labels.push(`Год ${i}`);
        data.push(Math.round(totalCost));
    }

    // Отображаем общий результат
    const results = document.getElementById('results');
    results.innerHTML = `
        <div class="alert alert-info mt-4">
            Общая стоимость владения за ${years} лет: <strong>${totalCost.toLocaleString()} ₴</strong>
        </div>
    `;

    // Строим график
    const ctx = document.getElementById('costChart').getContext('2d');

    // Если график уже есть, удаляем его, чтобы построить новый
    if (window.costChartInstance) {
        window.costChartInstance.destroy();
    }

    window.costChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Стоимость владения (₴)',
                data: data,
                borderColor: 'rgb(75, 192, 192)',
                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                tension: 0.3,
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: {
                    display: true
                },
            },
            scales: {
                y: {
                    beginAtZero: true
                }
            }
        }
    });

    fetch("/api/app/calculation", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
            expression: `${price},${years},${tax},${maintenance}`,
            result: totalCost
        })
    })
    .then(res => res.json())
    .then(data => {
        console.log("Сервер ответил:", data);
    })
    .catch(err => console.error("Ошибка при отправке:", err));
});