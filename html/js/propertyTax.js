


function clearErrors() {
  document.querySelectorAll(".error").forEach(e => (e.textContent = ""));
}

// IMPORTANT: не превращаем "" в 0
function num(id) {
  const el = document.getElementById(id);
  if (!el) return NaN;
  const v = (el.value ?? "").toString().trim();
  if (v === "") return NaN;
  return Number(v);
}

function validateNumber({ value, min, max, errorEl, name }) {
  if (!Number.isFinite(value)) {
    errorEl.textContent = `${name}: invalid number`;
    return false;
  }
  if (value < min) {
    errorEl.textContent = `${name}: minimum ${min}`;
    return false;
  }
  if (value > max) {
    errorEl.textContent = `${name}: maximum ${max}`;
    return false;
  }
  return true;
}

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function calculateTaxes(e) {
  e?.preventDefault?.();
  clearErrors();

  // ===== read inputs (original user values) =====
  const price = num("price");
  const rent = num("rentIncome"); // annual rent
  const years = Math.trunc(num("years"));
  const priceGrowth = num("priceGrowth");
  const inflationRate = num("inflationRate");

  const propertyTax = num("propertyTax");
  const rentTax = num("rentTax");
  const annualFees = num("annualFees");
  const feeGrowth = num("feeGrowth");

  const saleTax = num("saleTax");
  const agentFee = num("agentFee");

  // ===== validate =====
  let valid = true;

  valid = valid && validateNumber({
    value: price, min: 1, max: 500_000_000,
    errorEl: document.getElementById("priceError"),
    name: "Property Price"
  });

  valid = valid && validateNumber({
    value: rent, min: 0, max: 30_000_000,
    errorEl: document.getElementById("rentIncomeError"),
    name: "Annual Rent"
  });

  // years must be integer
  if (!Number.isInteger(years) || years < 1 || years > 70) {
    document.getElementById("yearsError").textContent =
      "Ownership Period: enter a whole number (1–70)";
    valid = false;
  }

  valid = valid && validateNumber({
    value: priceGrowth, min: -20, max: 100,
    errorEl: document.getElementById("priceGrowthError"),
    name: "Price Growth"
  });

  // Я бы держал инфляцию >= 0, но оставил твою границу (-5..30)
  valid = valid && validateNumber({
    value: inflationRate, min: -5, max: 30,
    errorEl: document.getElementById("inflationRateError"),
    name: "Inflation Rate"
  });

  valid = valid && validateNumber({
    value: propertyTax, min: 0, max: 70,
    errorEl: document.getElementById("propertyTaxError"),
    name: "Property Tax"
  });

  valid = valid && validateNumber({
    value: rentTax, min: 0, max: 70,
    errorEl: document.getElementById("rentTaxError"),
    name: "Rental Tax"
  });

  valid = valid && validateNumber({
    value: annualFees, min: 0, max: 10_000_000,
    errorEl: document.getElementById("annualFeesError"),
    name: "Annual Fees"
  });

  valid = valid && validateNumber({
    value: feeGrowth, min: 0, max: 50,
    errorEl: document.getElementById("feeGrowthError"),
    name: "Fee Growth"
  });

  valid = valid && validateNumber({
    value: saleTax, min: 0, max: 60,
    errorEl: document.getElementById("saleTaxError"),
    name: "Sale Tax"
  });

  valid = valid && validateNumber({
    value: agentFee, min: 0, max: 50,
    errorEl: document.getElementById("agentFeeError"),
    name: "Agent Commission"
  });

  if (!valid) return;

  // ===== logic =====
  const discountRate = inflationRate / 100;

  let totalTaxes = 0;
  let totalFees = 0;
  let totalRentNet = 0;
  let totalRentNetPV = 0;

  let currentPrice = price;
  let currentFees = annualFees;

  for (let y = 1; y <= years; y++) {
    const yearlyPropertyTax = currentPrice * (propertyTax / 100);
    const yearlyRentTax = rent * (rentTax / 100);

    // net cash flow (annual)
    const netRent = rent - yearlyRentTax - currentFees;

    totalTaxes += (yearlyPropertyTax + yearlyRentTax);
    totalFees += currentFees;
    totalRentNet += netRent;

    // PV (today's dollars) by inflation discount
    const discountFactor = 1 / Math.pow(1 + discountRate, y);
    totalRentNetPV += netRent * discountFactor;

    // next year updates
    currentPrice *= (1 + priceGrowth / 100);
    currentFees *= (1 + feeGrowth / 100);
  }

  const totalGrossRent = rent * years;
  const taxBurdenPercent = totalGrossRent > 0 ? (totalTaxes / totalGrossRent) * 100 : 0;

  const saleTaxAmount = currentPrice * (saleTax / 100);
  const agentFeeAmount = currentPrice * (agentFee / 100);

  const saleProfit = (currentPrice - price) - saleTaxAmount - agentFeeAmount;
  const saleProfitPV = saleProfit / Math.pow(1 + discountRate, years);

  const finalProfit = totalRentNet + saleProfit;
  const finalProfitPV = totalRentNetPV + saleProfitPV;

  // ВАЖНО: это не “инвестированный капитал” в финансовом смысле,
  // но оставляем твою логику: цена + все налоги + все fees
  const investedCapital = price + totalFees + totalTaxes;
  const simpleROI = investedCapital > 0 ? (finalProfit / investedCapital) * 100 : 0;
  const realROI = investedCapital > 0 ? (finalProfitPV / investedCapital) * 100 : 0;

  // ===== output (если id есть — покажем) =====
  setText("totalTaxes", moneyFormatter.format(totalTaxes));
  setText("totalFees", moneyFormatter.format(totalFees));
  setText("netProfit", moneyFormatter.format(totalRentNet));
  setText("finalProfit", moneyFormatter.format(finalProfit));

  // Если у тебя есть дополнительные поля в html — полезно вывести:
  setText("finalProfitPV", moneyFormatter.format(finalProfitPV));
  setText("simpleROI", `${simpleROI.toFixed(2)}%`);
  setText("realROI", `${realROI.toFixed(2)}%`);
  setText("taxBurdenPercent", `${taxBurdenPercent.toFixed(2)}%`);

  // ===== save (если есть csrfToken) =====
  if (!csrfToken) {
    console.warn("CSRF token not loaded — skip saving.");
  } else {
    fetch("/api/app/calculation", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        calculatorType: "property_taxes",
        inputData: {
          price,
          rent,
          years,
          priceGrowth,      // percent (e.g. 5)
          propertyTax,      // percent
          rentTax,          // percent
          annualFees,
          feeGrowth,        // percent
          saleTax,          // percent
          agentFee,         // percent
          inflationRate     // percent
        },
        resultData: {
          totalTaxes,
          totalFees,
          totalRentNet,
          finalProfit,
          finalProfitPV,
          simpleROI,
          realROI,
          taxBurdenPercent

          // можно доп. сохранить, если захочешь (в таблице аккаунта не покажется без схемы)
          // saleProfit,
          // saleProfitPV,
          // totalRentNetPV
        }
      })
    }).catch(console.error);
  }

  document.getElementById("results")
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// bind
document.getElementById("calcBtn")?.addEventListener("click", calculateTaxes);
