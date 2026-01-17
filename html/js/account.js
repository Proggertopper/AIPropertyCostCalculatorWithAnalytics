fetch("/api/auth/me", { credentials: "include" })
    .then(r => {
        if (r.status === 401) {
            location.href = "./login.html";
            return;
        }
        return r.json(); 
    })
    .then(user => {
        if (!user) return;
        const el = document.getElementById("user");
        if (el) el.innerText = user.email;
    });

fetch("/api/app/calculations", { credentials: "include" })
    .then(r => {
        if (!r.ok) {
            if (r.status === 401) location.href = "./login.html";
            throw new Error("Failed to load calculations");
        }
        return r.json();
    })
    .then(list => {
        const box = document.getElementById("calculations");
        box.textContent = "";

        document.getElementById("totalCalcs").textContent = list.length;

        if (list.length === 0) {
            const emptyDiv = document.createElement("div");
            emptyDiv.className = "muted";
            emptyDiv.textContent = "No calculations yet.Create your first calculation to analyze your investment.";
            box.appendChild(emptyDiv);
            return;
        }

        list.sort(
            (a, b) => new Date(b.created_at) - new Date(a.created_at)
        );

        const last = new Date(list[0].created_at).toLocaleDateString();
        document.getElementById("lastCalc").textContent = last;

        

        // уже для калькуляторов идет 
        list.forEach(calc => {
            const row = document.createElement("div");
            row.className = "calc-item";

            // Левая часть
            const info = document.createElement("div");
            info.className = "calc-info";

            const title = document.createElement("div");
            title.className = "calc-title";
            title.textContent = humanName(calc.calculator_type);

            const date = document.createElement("div");
            date.className = "calc-date";
            date.textContent = new Date(calc.created_at).toLocaleString();

            info.appendChild(title);
            info.appendChild(date);

            // Кнопки
            const actions = document.createElement("div");
            actions.className = "calc-actions";

            const openBtn = document.createElement("button");
            openBtn.className = "btn btn-open";
            openBtn.textContent = "▶ Open";
            

            const delBtn = document.createElement("button");
            delBtn.className = "btn btn-delete";
            delBtn.textContent = "Delete";
            delBtn.addEventListener("click" , () => {
                showDeleteModal(calc.id , row);
            });
            

            actions.appendChild(openBtn);
            actions.appendChild(delBtn);


            const details = document.createElement("div");
            details.className = "calc-details hidden";

            row.appendChild(info);
            row.appendChild(actions);
            row.appendChild(details);

            openBtn.addEventListener("click" , () => {
                openCalculation(calc, details, openBtn);
            });
            
            box.appendChild(row);
        });
    });


function humanInputName(key) {
    const map = {
        priceBefore: "Price before renovation",
        rentBefore: "Rent before renovation",
        renovationCost: "Renovation cost",
        priceIncrease: "Expected price increase",
        rentIncrease: "Expected rent increase",
        years: "Investment period"
    };

    return map[key] || humanize(key);
}

// Форматируем деньги
const moneyFormatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
});

const numberFormatter = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2
});

function humanize(key) {
    return key
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, s => s.toUpperCase());
}

function humanName(type) {
    const map = {
        alternative_investment: "Alternative Investments",
        break_even: "Break-even",
        cash_flow: "Cash Flow",
        property_irr: "Property IRR",
        mortgage: "Mortgage",
        ownership_cost: "Ownership Cost",
        property_sale: "Property Sale",
        property_taxes: "Property Taxes",
        mortgage_overpayment: "Mortgage Overpayment",
        renovation_roi: "Renovation ROI",
        rent_vs_buy: "Rent vs Buy"
    };

    return map[type] || type;
}

function formatPercent(value) {
    if (typeof value !== "number") return value;
    return value.toFixed(2) + "%";
}
function formatMoney(value) {
    if (typeof value !== "number") return value;
    return moneyFormatter.format(value);
}

function formatNumber(value) {
    if (typeof value !== "number") return value;
    return numberFormatter.format(value);
}

function formatPayback(value) {
    if (typeof value !== "number" || value < 0) return value;

    const years = Math.floor(value);
    const months = Math.round((value - years) * 12);

    if (years > 0 && months > 0) {
        return `${years} yrs ${months} months`;
    }

    if (years > 0) {
        return `${years} yrs`;
    }

    return `${months} months`;
}



const FORMAT = {
    money: v => formatMoney(v),
    percent: v => formatPercent(v),
    years: v => typeof v === "number"
        ? `${v.toFixed(1)} yrs`
        : v,
    payback: v => formatPayback(v) ,
    number: v => formatNumber(v),
    text: v => v 
};

const CALC_FORMATS = {

    alternative_investment: {
        input: {
            propertyInitial: "money",
            propertyCashflow: "money",
            propertyGrowth: "percent",
            propertyInflation: "percent",
            propertyTaxRate:"percent",
            altReturn: "percent",
            altContribution: "percent",
            altInflation: "percent",
            altTaxRate: "percent",
            years: "years"
        },
        result: {
            propertyValue: "money",
            alternativeValue: "money",
            propertyRealReturnPercent: "percent",
            alternativeRealReturnPercent: "percent",
            difference: "money",
            winner: "text"
        }
    },

    break_even: {
        input: {
            price: "money",
            downPayment: "money",
            mortgage: "money",
            expenses: "money",
            taxes: "money",
            vacancy: "percent"
        },
        result: {
            breakEvenRent: "money",
            breakEvenPrice: "money",
            winner: "text"      
        }
    },

    cash_flow: {
        input: {
            rent: "money",
            vacancy: "percent",
            mortgage: "money",
            expenses: "money",
            taxes: "percent",
            inflation: "percent"
        },
        result: {
            netIncome: "money",
            totalExpenses: "money",
            cashFlowMonth: "money",
            cashFlowYear: "money",
            realCashFlowMonth: "money",
            realCashFlowYear: "money",
            stressCashFlow: "money",
            status: "text"
        }
    },

    property_irr: {
        input: {
            price: "money",
            downPayment: "money",
            purchaseCosts: "money",
            renovation: "money",
            rent: "money",
            vacancy: "percent",
            expenses: "money",
            mortgage: "money",
            years: "years",
            growth: "percent",
            saleTax: "percent",
            inflation: "percent"
        },
        result: {
            cashFlow: "money",
            roi: "percent",
            irr: "percent",
            realIRR: "percent",
            paybackYears: "payback"
        }
    },

    mortgage: {
        input: {
            price: "money",
            down: "money",
            ratePercent: "percent",
            termYears: "years"
        },
        result: {
            monthlyPayment: "money",
            totalPayment: "money",
            totalInterest: "money"
        }
    },

    ownership_cost: {
        input: {
            price: "money",
            years: "years",
            taxPercent: "percent",
            maintenance: "money",
            inflation: "percent"
        },
        result: {
            totalCost: "money",
            totalCostPV: "money"
        }
    },

    property_sale: {
        input: {
            buyPrice: "money",
            sellPrice: "money",
            years: "years",
            tax: "percent",
            commission: "percent",
            inflation: "percent",
            renovation: "money"
        },
        result: {
            taxAmount: "money",
            commissionAmount: "money",
            netProfit: "money",
            annualReturn: "percent",
            realReturn: "percent"
        }
    },

    property_taxes: {
        input: {
            price: "money",
            rent: "money",
            years: "years",
            priceGrowth: "percent",
            propertyTax: "percent",
            rentTax: "percent",
            annualFees: "money",
            feeGrowth: "percent",
            saleTax: "percent",
            agentFee: "percent",
            inflationRate: "percent"
        },
        result: {
            totalTaxes: "money",
            totalFees: "money",
            totalRentNet: "money",
            finalProfit: "money",
            finalProfitPV: "money",
            simpleROI: "percent",
            realROI: "percent",
            taxBurdenPercent: "percent"
        }
    },

    mortgage_overpayment: {
        input: {
            loan: "money",
            rate: "percent",
            years: "years",
            inflation: "percent"
        },
        result: {
            monthlyPayment: "money",
            nominalOverpayment: "money",
            realOverpayment: "money",
            realInterestRate: "percent"
        }
    },

    renovation_roi: {
        input: {
            priceBefore: "money",
            rentBefore: "money",
            renovationCost: "money",
            priceIncrease: "percent",
            rentIncrease: "percent",
            agentFee: "percent",
            saleTax: "percent",
            years: "years",
            discountRate: "percent",
            inflationRate: "percent"
        },
        result: {
            priceAfter: "money",
            rentAfter: "money",
            totalExtraRent: "money",
            totalExtraRentPV: "money",
            saleProfit: "money",
            netProfit: "money",
            netProfitPV: "money",
            roi: "percent",
            roiPV: "percent",
            payback: "payback"
        }

    },

    rent_vs_buy: {
        input: {
            rent: "money",
            mortgage: "money",
            years: "years",
            propertyValue: "money",
            rentGrowth: "percent",
            mortgageRate: "percent",
            propertyGrowth: "percent",
            inflation: "percent"
        },
        result: {
            rentTotal: "money",
            mortgagePaid: "money",
            buyNetCost: "money",
            winner: "text"
        }
    }
};


function renderWarnings(calc) {
    if (!calc || !calc.result_data) return null;
    
    const box = document.createElement("div");
    const r = calc.result_data;
    const i = calc.input_data;

    if (typeof r.payback === "number" && typeof i.years === "number") {
        const horizonMonths = i.years * 12;
        const paybackMonths = r.payback * 12;

        if (paybackMonths > horizonMonths) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent =
                "⚠️ Payback period exceeds selected investment horizon.";
            box.appendChild(w);
        }
    }

    if (calc.calculator_type === "break_even") {
        const r = calc.result_data;
        const i = calc.input_data;

        if (i.vacancy > 20) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent = "⚠️ High vacancy assumption (>20%).";
            box.appendChild(w);
        }

        if (r.breakEvenRent > i.price * 0.012) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent="⚠️ Required rent exceeds 1.2% of purchase price.";
            box.appendChild(w);
        }

        if (i.mortgage === 0) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent="ℹ️ Mortgage not included. Results assume cash purchase.";
            box.appendChild(w);
        }
    }

    if (calc.calculator_type === "property_taxes") {
        const r = calc.result_data;

        if (r.taxBurdenPercent > 60) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent =
                "⚠️ High effective tax rate. Consider legal tax optimization strategies.";
            box.appendChild(w);
        }
    }
    
    if (calc.calculator_type === "ownership_cost") {
        const price = Number(i.price || 0);
        const total = Number(r.totalCost || 0);
        const real = Number(r.totalCostPV || 0);
        const years = Number(i.years || 0);
        const tax = Number(i.taxPercent || 0);
        const maintenance = Number(i.maintenance || 0);

        if (!price) return null;

        // if (real > price * 2) {
        //     const w = document.createElement("div");
        //     w.className = "verdict warn";
        //     w.textContent =
        //         "⚠️ Total real ownership cost exceeds 2x property price.";
        //     return w;
        // }

        // ⚠️ Высокие налоги
        if (tax > 5) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent =
                "⚠️ High annual property tax (>5% of property price).";
            box.appendChild(w);
        }

        // ⚠️ Высокое обслуживание
        if (maintenance > price * 0.03) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent =
                "⚠️ High maintenance costs (>3% of property price per year).";
            box.appendChild(w);
        }

        // ⚠️ Очень длинный период владения
        if (years > 50) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent =
                "⚠️ Very long ownership period (>50 years). Forecast reliability is low.";
            box.appendChild(w);
        }
    }

    return box.childNodes.length ? box : null;
}

function renderInputData(calc) {
    const ul = document.createElement("ul");
    ul.className = "input-list";

    const schema = CALC_FORMATS[calc.calculator_type]?.input || {};

    for (const key in schema) {
        const raw = calc.input_data?.[key];
        if (raw === undefined || raw === null) continue;

        const li = document.createElement("li");

        const type = schema[key] || "number";
        const formatter = FORMAT[type] || FORMAT.number;

        li.textContent = `${humanInputName(key)}: ${formatter(raw)}`;
        ul.appendChild(li);
    }

    return ul;
}


function renderResultData(calc) {
    const table = document.createElement("table");
    table.className = "result-table";

    const r = calc.result_data;

    const schema = CALC_FORMATS[calc.calculator_type]?.result || {};

    for (const key in schema) {
        if (!(key in r)) continue;

        const raw = r[key];
        if (raw === undefined || raw === null) continue;

        const row = document.createElement("tr");

        const name = document.createElement("td");
        name.textContent = humanize(key);

        const value = document.createElement("td");
        const type = schema[key] ?? "number";
        const formatter = FORMAT[type] || FORMAT.number;

        value.textContent = formatter(raw);

        const negativeMetrics = [
            "totalInterest",
            "taxAmount",
            "commissionAmount",
            "totalPayment",
            "totalCost",
            "totalExpenses"
        ];

        if (key === "realIRR") {
            if (raw > 0) value.classList.add("value-positive");
            else value.classList.add("value-negative");
            value.classList.add("result-highlight");
        }

        if (typeof raw === "number") {
            if (negativeMetrics.includes(key)) {
                if (raw > 0) value.classList.add("value-negative");
            } else {
                if (raw > 0) value.classList.add("value-positive");
                if (raw < 0) value.classList.add("value-negative");
            }
        }

        if (["roi", "roiPV", "netProfit", "netProfitPV", "irr"].includes(key)) {
            value.classList.add("result-highlight");
        }

        row.appendChild(name);
        row.appendChild(value);
        table.appendChild(row);
    }

    return table;
}


const INVESTMENT_CALCS = [
    "renovation_roi",
    "property_irr",
    "cash_flow",
    "alternative_investment",
    "property_sale",
    "property_taxes"
];

const COMPARISON_CALCS = [
    "rent_vs_buy",
    "break_even"
];

const COST_CALCS = [
    "mortgage",
    "mortgage_overpayment",
    "ownership_cost"
];


function renderVerdict(calc) {
    if (!calc || !calc.result_data) {
        const v = document.createElement("div");
        v.className = "verdict info";
        v.textContent = "ℹ️ Result data not available.";
        return v;
    }

    const type = calc.calculator_type;

    switch (type) {
        // инвестиционные калькуляторы
        case "property_irr":
        case "renovation_roi":
        case "alternative_investment":
        case "property_sale":
        case "property_taxes":
            return investmentVerdict(calc);

        // cash flow отдельный обработчик
        case "cash_flow":
            return cashFlowVerdict(calc);

        // сравнительные калькуляторы
        case "rent_vs_buy":
        case "break_even":
            return comparisonVerdict(calc);

        // стоимость / кредиты
        case "mortgage":
        case "mortgage_overpayment":
        case "ownership_cost":
            return costVerdict(calc);

        default:
            const v = document.createElement("div");
            v.className = "verdict info";
            v.textContent = "ℹ️ Verdict not available for this calculator.";
            return v;
    }
}



function investmentVerdict(calc) {
    const v = document.createElement("div");
    v.className = "verdict";
    
    const r = calc.result_data;

    if(calc.calculator_type === "renovation_roi"){
        if ((typeof r.netProfitPV === "number" && r.netProfitPV <= 0) ||
            (typeof r.roiPV === "number" && r.roiPV <= 0)) {
            v.classList.add("bad");
            v.textContent = "❌ This investment is not profitable when discounted at the given rate.";
        } else if ((typeof r.netProfit === "number" && r.netProfit <= 0) ||
            (typeof r.roi === "number" && r.roi <= 0)) {
            v.classList.add("warn");
            v.textContent = "⚠️ Investment is profitable nominally but loses value after discounting.";
        } else {
            v.classList.add("good");
            v.textContent = "✅ This investment looks profitable even after discounting.";
        }
    }

    else if (calc.calculator_type === "alternative_investment") {
        
        const r = calc.result_data;
        const diff = Number(r.difference || 0);
        const propRR = Number(r.propertyRealReturnPercent || 0);
        const altRR = Number(r.alternativeRealReturnPercent || 0);

        if (altRR > propRR && diff > 0) {
            v.classList.add("good");
            v.textContent = "✅ Alternative investment outperforms property after inflation, taxes, and risk adjustments.";
        } else if (Math.abs(diff) < 0.05 * Math.max(r.propertyValue, r.alternativeValue)) {
            v.classList.add("info");
            v.textContent = "ℹ️ Results are close — property and alternative investments are nearly equal.";
        } else {
            v.classList.add("bad");
            v.textContent = "❌ Property investment performs better on a risk-adjusted basis.";
        }

        return v;
    }

    else if (calc.calculator_type === "property_taxes") {
        const r = calc.result_data;

        const finalPV = Number(r.finalProfitPV || 0);
        const finalNominal = Number(r.finalProfit || 0);
        const realROI = Number(r.realROI || 0);
        const simpleROI = Number(r.simpleROI || 0);

        // ❌ Реально убыточно
        if (finalPV <= 0 || realROI <= 0) {
            v.classList.add("bad");
            v.textContent =
                "❌ This investment loses value after inflation, taxes, and fees.";
        }
        // ⚠️ Номинально ок, реально плохо
        else if (finalNominal > 0 && finalPV <= finalNominal * 0.3) {
            v.classList.add("warn");
            v.textContent =
                "⚠️ Nominal profit exists, but inflation significantly reduces returns.";
        }
        // ✅ Всё хорошо
        else {
            v.classList.add("good");
            v.textContent =
                "✅ Investment remains profitable after taxes and inflation.";
        }

        return v;
    }

    else if (calc.calculator_type === "property_sale") {
        const r = calc.result_data;

        const net = Number(r.netProfit || 0);
        const annual = Number(r.annualReturn || 0);
        const real = Number(r.realReturn || 0);

        // ❌ убыточно в реальности
        if (net <= 0 || real <= 0) {
            v.classList.add("bad");
            v.textContent =
                "❌ Sale results in a loss after inflation and costs.";
        }
        // ⚠️ номинально ок, реально слабо
        else if (real < 2) {
            v.classList.add("warn");
            v.textContent =
                "⚠️ Sale is profitable nominally, but real return is very low.";
        }
        // 🟡 нормально, но не инвестиционно
        else if (real < 5) {
            v.classList.add("info");
            v.textContent =
                "ℹ️ Sale preserves capital with modest real growth.";
        }
        // ✅ сильная продажа
        else {
            v.classList.add("good");
            v.textContent =
                "✅ Sale delivers strong real annual return.";
        }

        return v;
    }

    else if (calc.calculator_type === "property_irr") {
        const realIRR = Number(r.realIRR || 0);
        const irr = Number(r.irr || 0);

        // ❌ реально убыточно
        if (realIRR <= 0) {
            v.classList.add("bad");
            v.textContent = "❌ Investment loses value after inflation (real IRR ≤ 0%).";
        }
        // ⚠️ номинально прибыльно, но реальная доходность низкая
        else if (realIRR > 0 && realIRR < 5) {
            v.classList.add("warn");
            v.textContent = `⚠️ Investment nominally profitable (IRR ${irr.toFixed(2)}%), but real IRR is low (${realIRR.toFixed(2)}%).`;
        }
        // ✅ нормально
        else {
            v.classList.add("good");
            v.textContent = `✅ Investment looks profitable after inflation (real IRR ${realIRR.toFixed(2)}%).`;
        }

        return v;
    }

    // Общая логика для других инвесткалькуляторов
    
    if ((typeof r.irr === "number" && r.irr < 7) ||
        (typeof r.netProfit === "number" && r.netProfit <= 0) ||
        (typeof r.roi === "number" && r.roi <= 0)) {
        v.classList.add("bad");
        v.textContent = "❌ This investment is not profitable based on provided inputs.";
    } else {
        v.classList.add("good");
        v.textContent = "✅ This investment looks profitable based on provided inputs.";
    }
    return v;

}

function cashFlowVerdict(calc) {
    if (!calc || !calc.result_data) return null;

    const r = calc.result_data;
    const i = calc.input_data;

    /* ❌ Реальный cash flow отрицательный */
    if (r.realCashFlowMonth < 0) {
        const v = document.createElement("div");
        v.className = "verdict negative";
        v.textContent =
            "❌ Real cash flow is negative after inflation. Investment loses purchasing power.";
        return v;
    }

    /* ⚠️ Stress test не выдержан */
    if (r.stressCashFlow < 0) {
        const v = document.createElement("div");
        v.className = "verdict warn";
        v.textContent =
            "⚠️ Investment fails stress test (vacancy +5%, expenses +10%).";
        return v;
    }

    /* ⚠️ Высокая вакансия */
    if (i.vacancy > 15) {
        const v = document.createElement("div");
        v.className = "verdict warn";
        v.textContent =
            "⚠️ High vacancy assumption. Income may be unstable.";
        return v;
    }

    /* ⚠️ Ипотека слишком большая */
    if (i.mortgage > i.rent * 0.6) {
        const v = document.createElement("div");
        v.className = "verdict warn";
        v.textContent =
            "⚠️ Mortgage exceeds 60% of rent. High leverage risk.";
        return v;
    }

    /* ✅ Хорошая инвестиция */
    if (r.cashFlowMonth > i.rent * 0.1) {
        const v = document.createElement("div");
        v.className = "verdict positive";
        v.textContent =
            "✅ Strong positive cash flow with inflation protection.";
        return v;
    }

    const v = document.createElement("div");
    v.className = "verdict info";
    v.textContent =
        "ℹ️ Cash flow is close to break-even. Small changes may affect profitability.";
    return v;
}

function comparisonVerdict(calc) {
    const v = document.createElement("div");
    v.className = "verdict";

    let winner = (calc.result_data.winner || "").toLowerCase();

    if (!winner && calc.calculator_type === "break_even") {
        const r = calc.result_data;
        const i = calc.input_data;

        const beRent = Number(r.breakEvenRent || 0);
        const totalCost = Number(i.mortgage || 0) + Number(i.expenses || 0) + Number(i.taxes || 0);

        if (beRent > i.price * 0.012) {
            v.classList.add("warn");
            v.textContent =
                "⚠️ Required break-even rent is high relative to purchase price.";
        } else {
            v.classList.add("good");
            v.textContent =
                "✅ Break-even rent looks achievable under current assumptions.";
        }
        return v;
    }

    if (["property", "buy"].includes(winner)) {
        v.classList.add("good");
        v.textContent = "🏡 Property looks profitable compared to break-even point.";
    } else if (["alternative", "rent"].includes(winner)) {
        v.classList.add("warn");
        v.textContent = "⚠️ Break-even rent is high — investment may not pay off.";
    } else {
        v.classList.add("info");
        v.textContent = "ℹ️ Results are close — analyze assumptions carefully.";
    }

    return v;
}


// -------------------------
// Стоимость / кредиты
// -------------------------
function costVerdict(calc) {
    const v = document.createElement("div");
    v.className = "verdict";

    const r = calc.result_data;

    // mortgage
    if (calc.calculator_type === "mortgage") {
        const loan = Number(calc.input_data.price || 0) - Number(calc.input_data.down || 0);
        const totalInterest = Number(r.totalInterest || 0);

        if (!loan || !totalInterest) {
            v.classList.add("info");
            v.textContent = "ℹ️ Not enough data to evaluate loan cost.";
        } else if (totalInterest / loan > 0.8) {
            v.classList.add("bad");
            v.textContent = "❌ This loan is not suitable for investment purposes.";
        } else if (totalInterest / loan > 0.4) {
            v.classList.add("warn");
            v.textContent = "⚠️ High-interest loan. Strong cash flow is required.";
        } else {
            v.classList.add("good");
            v.textContent = "✅ Loan cost is acceptable.";
        }

        return v;
    }

    // mortgage_overpayment
    if (calc.calculator_type === "mortgage_overpayment") {
        const loan = Number(calc.input_data.loan || 0);
        const nominal = Number(r.nominalOverpayment || 0);
        const real = Number(r.realOverpayment || 0);

        if (!loan || !nominal) {
            v.classList.add("info");
            v.textContent = "ℹ️ Not enough data to evaluate overpayment.";
        }
        // сначала смотрим реальную переплату
        else if (real / loan > 0.6) {
            v.classList.add("bad");
            v.textContent = "❌ High real overpayment even after inflation.";
        }
        else if (real / loan > 0.3) {
            v.classList.add("warn");
            v.textContent = "⚠️ Moderate real overpayment after inflation.";
        }
        // если реальная ок, но номинальная высокая
        else if (nominal / loan > 0.5) {
            v.classList.add("info");
            v.textContent = "ℹ️ Nominal overpayment is high, but inflation reduces real cost.";
        }
        else {
            v.classList.add("good");
            v.textContent = "✅ Loan overpayment is acceptable in real terms.";
        }
    }

    if (calc.calculator_type === "ownership_cost") {
        const price = Number(calc.input_data.price || 0);
        const total = Number(r.totalCost || 0);
        const real = Number(r.totalCostPV || 0);

        if (!price || !total) {
            v.classList.add("info");
            v.textContent = "ℹ️ Ownership cost data unavailable.";
        }
        else if (real > price * 2) {
            v.classList.add("bad");
            v.textContent =
                "❌ Total real ownership cost exceeds 2× property price. Ownership is inefficient.";
        }
        else if (real > price * 1.3) {
            v.classList.add("warn");
            v.textContent =
                "⚠️ Ownership costs are high relative to property price.";
        }
        else {
            v.classList.add("good");
            v.textContent =
                "✅ Ownership costs are reasonable relative to property value.";
        }

        return v;
    }

    return v;
}


function renderInputSection(calc) {
    const wrapper = document.createElement("div");

    const toggle = document.createElement("div");
    toggle.className = "details-toggle";
    toggle.textContent = "Show input data";

    const content = renderInputData(calc);
    content.classList.add("hidden");

    toggle.addEventListener("click", () => {
        const open = !content.classList.contains("hidden");
        content.classList.toggle("hidden");
        toggle.textContent = open ? "Show input data" : "Hide input data";
    });

    wrapper.appendChild(toggle);
    wrapper.appendChild(content);

    return wrapper;
}

// Рассчеты 

let openedDetails = null;
let openedButton = null;

function openCalculation(calc, container, button) {
    if (openedDetails && openedDetails !== container) {
        openedDetails.classList.add("hidden");
        openedDetails.textContent = "";
        if (openedButton) openedButton.textContent = "▶ Open";
    }

    const isOpen = !container.classList.contains("hidden");

    if (isOpen) {
        container.classList.add("hidden");
        container.textContent = "";
        button.textContent = "▶ Open";
        openedDetails = null;
        openedButton = null;
        return;
    }

    container.textContent = "";
    container.classList.remove("hidden");
    button.textContent = "▼ Close";

    openedDetails = container;
    openedButton = button;

    const verdictEl = renderVerdict(calc);
    container.appendChild(verdictEl);

    const isBad = verdictEl.classList.contains("bad") ||
        verdictEl.classList.contains("negative");

    const warning = renderWarnings(calc);
    if (warning && !isBad) {
        container.appendChild(warning);
    }
    //input
    const inputTitle = document.createElement("h4");
    inputTitle.textContent = "Input data";
    container.appendChild(inputTitle);
    try {
        container.appendChild(renderInputSection(calc));
    } catch (e) {
        container.textContent = "Failed to render section.";
    }
    //results
    const resultTitle = document.createElement("h4");
    resultTitle.textContent = "Result";
    container.appendChild(resultTitle);
    try {
        container.appendChild(renderResultData(calc));
    } catch (e) {
        container.textContent = "Failed to render results.";
    }
    
}



// ------------------------
// Удаление расчёта
// ------------------------
let deleteTargetId = null;
let deleteTargetRow = null;

const modal = document.getElementById("deleteModal");
const confirmBtn = document.getElementById("confirmDelete");
const cancelBtn = document.getElementById("cancelDelete");

function showDeleteModal(id, row) {
    if (!modal) return;
    deleteTargetId = id;
    deleteTargetRow = row;
    modal.classList.add("open");
}

// Подтверждение удаления
if (confirmBtn) {
    confirmBtn.addEventListener("click", () => {
        if (!deleteTargetId || !deleteTargetRow) return;

        fetch(`/api/app/calculation/${deleteTargetId}`, {
            method: "DELETE",
            credentials: "include"
        })
            .then(res => {
                if (res.ok) {
                    // Удаляем элемент только если он реально существует
                    if (deleteTargetRow.parentNode) {
                        deleteTargetRow.remove();
                    }

                    // Обновляем счётчик
                    const counter = document.getElementById("totalCalcs");
                    if (counter) {
                        let value = parseInt(counter.textContent, 10);
                        if (!isNaN(value) && value > 0) counter.textContent = value - 1;
                    }

                    // Если список пустой
                    const box = document.getElementById("calculations");
                    if (box && box.querySelectorAll(".calc-item").length === 0) {
                        const emptyDiv = document.createElement("div");
                        emptyDiv.className = "muted";
                        emptyDiv.textContent = "No calculations yet";
                        box.appendChild(emptyDiv);

                        const lastCalc = document.getElementById("lastCalc");
                        if (lastCalc) lastCalc.textContent = "—";
                    }
                }
            })
            .catch(console.error)
            .finally(() => {
                modal.classList.remove("open");
                deleteTargetId = null;
                deleteTargetRow = null;
            });
    });
}
    

// Отмена
if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
        if (!modal) return;
        modal.classList.remove("open");
        deleteTargetId = null;
        deleteTargetRow = null;
    });
}




