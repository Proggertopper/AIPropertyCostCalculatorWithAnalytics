

window.addEventListener("DOMContentLoaded", async () => {

    // 2) DOM refs (после загрузки DOM — это и чинит половину “0%” багов)
    const noiAnnualInput = document.getElementById("noiAnnual");
    const priceInput = document.getElementById("price");

    const rentMonthlyInput = document.getElementById("rentMonthly");
    const vacancyInput = document.getElementById("vacancy");
    const opExAnnualInput = document.getElementById("opExAnnual");

    const capRateEl = document.getElementById("capRate");
    const noiUsedEl = document.getElementById("noiUsed");
    const noiSourceEl = document.getElementById("noiSource");
    const quickVerdictEl = document.getElementById("quickVerdict");
    const resultsEl = document.getElementById("results");

    const noiAnnualError = document.getElementById("noiAnnualError");
    const priceError = document.getElementById("priceError");
    const rentMonthlyError = document.getElementById("rentMonthlyError");
    const vacancyError = document.getElementById("vacancyError");
    const opExAnnualError = document.getElementById("opExAnnualError");

    const moneyFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
    const pctFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

    function clearErrors() {
        document.querySelectorAll(".error").forEach(e => (e.textContent = ""));
    }

    function parseNum(el) {
        // input.value всегда string
        const raw = (el?.value ?? "").trim();
        if (raw === "") return null; // важно: null, а не 0
        const n = Number(raw);
        return Number.isFinite(n) ? n : NaN;
    }

    function validateNumber({ value, min, max, errorEl, name, allowNull = false }) {
        if (value === null && allowNull) return true;
        if (!Number.isFinite(value)) {
            if (errorEl) errorEl.textContent = `${name}: invalid number`;
            return false;
        }
        if (value < min) {
            if (errorEl) errorEl.textContent = `${name}: minimum ${min}`;
            return false;
        }
        if (value > max) {
            if (errorEl) errorEl.textContent = `${name}: maximum ${max}`;
            return false;
        }
        return true;
    }

    function setVerdict(capRate, noiUsed, source, vacancy) {
        // используем твои классы: good / warn / bad / info
        quickVerdictEl.className = "winner"; // базовый класс как в твоём шаблоне

        // базовая логика по cap rate (можешь поменять пороги)
        if (noiUsed <= 0) {
            quickVerdictEl.classList.add("bad");
            quickVerdictEl.textContent = "❌ NOI is ≤ 0 — cap rate is not meaningful. Check rent/expenses.";
            return;
        }

        if (capRate >= 7) {
            quickVerdictEl.classList.add("good");
            quickVerdictEl.textContent = "✅ Strong cap rate — looks attractive for many markets (verify local comps).";
            return;
        }

        if (capRate >= 5) {
            quickVerdictEl.classList.add("warn");
            quickVerdictEl.textContent = "⚠️ Medium cap rate — could be OK, but sensitive to vacancy/expenses.";
            return;
        }

        // capRate < 5
        quickVerdictEl.classList.add("bad");
        // чуть умнее текст если NOI построен и vacancy высокая
        if (source === "Built from rent/expenses" && Number.isFinite(vacancy) && vacancy >= 10) {
            quickVerdictEl.textContent = "❌ Low cap rate — and vacancy assumption is high. Yield may be weak.";
        } else {
            quickVerdictEl.textContent = "❌ Low cap rate — yield may be weak for investment.";
        }
    }

    async function saveCalculation(payload) {
        // сохраняем только если есть csrfToken (значит, ты логин/сессия в норме)
        if (!csrfToken) return;

        try {
            await fetch("/api/app/calculation", {
                method: "POST",
                credentials: "include",
                headers: {
                    "Content-Type": "application/json",
                    "X-CSRF-Token": csrfToken
                },
                body: JSON.stringify(payload)
            });
        } catch (e) {
            console.error("Save calculation failed:", e);
        }
    }

    async function calculateCapRate() {
        clearErrors();

        const price = parseNum(priceInput);
        const noiAnnualDirect = parseNum(noiAnnualInput);

        // optional builder
        const rentMonthly = parseNum(rentMonthlyInput);
        const vacancy = parseNum(vacancyInput);
        const opExAnnual = parseNum(opExAnnualInput);

        let valid = true;

        valid = valid && validateNumber({
            value: price,
            min: 1,
            max: 500_000_000,
            errorEl: priceError,
            name: "Purchase Price"
        });

        // NOI может быть пустым — тогда строим
        valid = valid && validateNumber({
            value: noiAnnualDirect,
            min: -100_000_000,
            max: 10_000_000_000,
            errorEl: noiAnnualError,
            name: "NOI (annual)",
            allowNull: true
        });

        if (!valid) return;

        let noiUsed = null;
        let noiSource = "";

        if (noiAnnualDirect !== null) {
            noiUsed = noiAnnualDirect;
            noiSource = "Provided NOI";
        } else {
            // строим NOI если NOI пустой
            valid = true;
            valid = valid && validateNumber({
                value: rentMonthly,
                min: 0,
                max: 10_000_000,
                errorEl: rentMonthlyError,
                name: "Gross Rent (monthly)"
            });
            valid = valid && validateNumber({
                value: vacancy,
                min: 0,
                max: 100,
                errorEl: vacancyError,
                name: "Vacancy (%)"
            });
            valid = valid && validateNumber({
                value: opExAnnual,
                min: 0,
                max: 100_000_000,
                errorEl: opExAnnualError,
                name: "Operating Expenses (annual)"
            });

            if (!valid) return;

            const effectiveRentAnnual = rentMonthly * 12 * (1 - vacancy / 100);
            noiUsed = effectiveRentAnnual - opExAnnual;
            noiSource = "Built from rent/expenses";
        }

        const capRate = (noiUsed / price) * 100;

        // UI
        capRateEl.textContent = `${pctFmt.format(capRate)}%`;
        noiUsedEl.textContent = moneyFmt.format(noiUsed);
        noiSourceEl.textContent = noiSource;

        setVerdict(capRate, noiUsed, noiSource, vacancy);

        // save payload (inputData/resultData)
        const inputData = {
            // сохраняем и direct NOI, и optional-поля — чтобы в аккаунте можно было понять “из чего”
            noiAnnual: noiAnnualDirect,
            price,
            rentMonthly,
            vacancy,
            opExAnnual
        };

        const resultData = {
            capRate,
            noiUsed,
            noiSource
        };

        await saveCalculation({
            calculatorType: "cap_rate",
            inputData,
            resultData
        });

        resultsEl?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    document.getElementById("calcBtn")?.addEventListener("click", calculateCapRate);
});


