function calculateIRR(cashFlows, guess = 0.1) {
    let rate = guess;
    for (let i = 0; i < 500; i++) {
    let npv = 0;
    let dnpv = 0;

    for (let t = 0; t < cashFlows.length; t++) {
        npv += cashFlows[t] / Math.pow(1 + rate, t);
      dnpv -= t * cashFlows[t] / Math.pow(1 + rate, t + 1);
    }

    const newRate = rate - npv / dnpv;
    if (Math.abs(newRate - rate) < 1e-6) return rate;
    rate = newRate;
    }
    return rate;
}

function calculate() {
    const price = +document.getElementById("price").value;
    const downPayment = +document.getElementById("downPayment").value;
    const purchaseCosts = +document.getElementById("purchaseCosts").value;
    const renovation = +document.getElementById("renovation").value;

    const rent = +document.getElementById("rent").value;
    const vacancy = +document.getElementById("vacancy").value / 100;
    const expenses = +document.getElementById("expenses").value;
    const mortgage = +document.getElementById("mortgage").value;

    const years = +document.getElementById("years").value;
    const growth = +document.getElementById("growth").value / 100;
    const saleTax = +document.getElementById("saleTax").value / 100;

    const initialInvestment =
        downPayment + purchaseCosts + renovation;

    const effectiveRent =
      rent * 12 * (1 - vacancy);

    const cashFlow =
        effectiveRent - expenses - mortgage;

    const futurePrice =
      price * Math.pow(1 + growth, years);

    const profitFromSale =
      futurePrice * (1 - saleTax) - price;

    const cashFlows = [-initialInvestment];
    for (let i = 1; i <= years; i++) {
        cashFlows.push(i === years
            ? cashFlow + profitFromSale
            : cashFlow
    );
    }

    const irr = calculateIRR(cashFlows);
        const roi = ((cashFlow * years + profitFromSale) / initialInvestment) * 100;

    document.getElementById("cashFlow").textContent =
        cashFlow.toFixed(0) + " $";

    document.getElementById("roi").textContent =
        roi.toFixed(2) + " %";

    document.getElementById("irr").textContent =
        (irr * 100).toFixed(2) + " %";

    document.getElementById("payback").textContent =
        (initialInvestment / cashFlow).toFixed(1) + " лет";
}
