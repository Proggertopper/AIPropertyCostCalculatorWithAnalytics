

function clearErrors() {
    document.querySelectorAll(".error").forEach(e => (e.textContent = ""));
}

function num(id) {
    const el = document.getElementById(id);
    if (!el) return NaN;
    const v = (el.value ?? "").toString().trim();
    if (v === "") return NaN;
    return Number(v);
}

function validateNumber({ value, min, max, errorEl, name }) {
    if (Number.isNaN(value)) {
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

function calculateOwnershipCost(e) {
    if (e) e.preventDefault?.();
    clearErrors();

    const price = num("price");
    const yearsRaw = num("years");
    const taxPercent = num("tax");
    const maintenance = num("maintenance");
    const inflationPercent = num("inflation");

    const years = Number.isNaN(yearsRaw) ? NaN : Math.trunc(yearsRaw);

    let valid = true;
    valid = valid && validateNumber({ value: price, min: 1, max: 50_000_000, errorEl: document.getElementById("priceError"), name: "Property Price" });
    valid = valid && validateNumber({ value: years, min: 1, max: 100, errorEl: document.getElementById("yearsError"), name: "Ownership Period (years)" });

    if (!Number.isNaN(yearsRaw) && yearsRaw !== years) {
        document.getElementById("yearsError").textContent = "Ownership Period: must be a whole number";
        valid = false;
    }

    valid = valid && validateNumber({ value: taxPercent, min: 0, max: 90, errorEl: document.getElementById("taxError"), name: "Property Tax (%)" });
    valid = valid && validateNumber({ value: maintenance, min: 0, max: 10_000_000, errorEl: document.getElementById("maintenanceError"), name: "Maintenance (annual)" });
    valid = valid && validateNumber({ value: inflationPercent, min: -5, max: 40, errorEl: document.getElementById("inflationError"), name: "Inflation (%)" });

    if (!valid) return;

    const taxRate = taxPercent / 100;
    const inflationRate = inflationPercent / 100;

    // ===== логика + totals =====
    // Carrying ownership costs only (tax + maintenance), without purchase principal.
    let totalOwnershipCost = 0;
    let totalOwnershipCostPV = 0;

    let totalTaxes = 0;
    let totalMaintenance = 0;

    let totalTaxesPV = 0;
    let totalMaintenancePV = 0;

    for (let y = 1; y <= years; y++) {
        const inflFactor = Math.pow(1 + inflationRate, y - 1);

        const annualTax = price * taxRate * inflFactor;
        const annualMaint = maintenance * inflFactor;

        totalTaxes += annualTax;
        totalMaintenance += annualMaint;

        const annualCost = annualTax + annualMaint;
        totalOwnershipCost += annualCost;

        const discount = Math.pow(1 + inflationRate, y);
        totalTaxesPV += annualTax / discount;
        totalMaintenancePV += annualMaint / discount;
        totalOwnershipCostPV += annualCost / discount;
    }

    // округления
    totalOwnershipCost = Math.round(totalOwnershipCost);
    totalOwnershipCostPV = Math.round(totalOwnershipCostPV);

    totalTaxes = Math.round(totalTaxes);
    totalMaintenance = Math.round(totalMaintenance);

    totalTaxesPV = Math.round(totalTaxesPV);
    totalMaintenancePV = Math.round(totalMaintenancePV);

    // derived-friendly fields прямо в resultData (чтобы UI не зависел от derived_metrics)
    const costAsPercentOfPrice = price > 0 ? Math.round((totalOwnershipCost / price) * 10000) / 100 : null;
    const taxesSharePercent = totalOwnershipCost > 0 ? Math.round((totalTaxes / totalOwnershipCost) * 10000) / 100 : null;
    const maintenanceSharePercent = totalOwnershipCost > 0 ? Math.round((totalMaintenance / totalOwnershipCost) * 10000) / 100 : null;

    // ===== output =====
    document.getElementById("totalCost").textContent = moneyFormatter.format(totalOwnershipCost);
    document.getElementById("totalCostPV").textContent = moneyFormatter.format(totalOwnershipCostPV);

    // ===== save =====
    if (!csrfToken) {
        console.warn("CSRF token not loaded — skip saving.");
        document.getElementById("results")?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
    }

    fetch("/api/app/calculation", {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
            calculatorType: "ownership_cost",
            inputData: {
                price,
                years,
                taxPercent,
                maintenance,
                inflation: inflationPercent
            },
            resultData: {
                // ✅ унифицированные ключи (используем везде)
                years,
                totalOwnershipCost,
                totalOwnershipCostPV,

                totalTaxes,
                totalMaintenance,
                totalTaxesPV,
                totalMaintenancePV,

                costAsPercentOfPrice,
                taxesSharePercent,
                maintenanceSharePercent,

                // ✅ backward compat (если где-то старый фронт ждёт)
                totalCost: totalOwnershipCost,
                totalCostPV: totalOwnershipCostPV
            }
        })
    }).catch(console.error);

    document.getElementById("results")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.getElementById("calcBtn").addEventListener("click", calculateOwnershipCost);




