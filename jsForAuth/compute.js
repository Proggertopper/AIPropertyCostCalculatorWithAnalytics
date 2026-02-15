

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
};
const nz = (v) => {
    const x = n(v);
    return x === null ? 0 : x;
};

function roundMoney(x) {
    if (!Number.isFinite(x)) return null;
    return Math.round(x);
}

function irrFromCashflows(cashFlows) {
    // IRR exists only if there is at least one sign change
    let hasPos = false, hasNeg = false;
    for (const cf of cashFlows) {
        if (cf > 0) hasPos = true;
        if (cf < 0) hasNeg = true;
    }
    if (!(hasPos && hasNeg)) return null;

    const npv = (rate) => {
        if (rate <= -0.999999) return Number.POSITIVE_INFINITY;
        let sum = 0;
        for (let t = 0; t < cashFlows.length; t++) {
            sum += cashFlows[t] / Math.pow(1 + rate, t);
        }
        return sum;
    };

    // find bracket
    const candidates = [];
    for (let r = -0.9; r <= 1.0; r += 0.05) candidates.push(Number(r.toFixed(2)));
    candidates.push(1.5, 2, 3, 5, 10, 20);

    let a = null, b = null;
    let prevR = candidates[0];
    let prevV = npv(prevR);

    for (let i = 1; i < candidates.length; i++) {
        const r = candidates[i];
        const v = npv(r);

        if (Number.isFinite(prevV) && Number.isFinite(v) && prevV * v <= 0) {
            a = prevR; b = r;
            break;
        }
        prevR = r;
        prevV = v;
    }

    if (a === null) return null;

    // bisection
    const tol = 1e-7;
    const maxIter = 250;

    let low = a, high = b;
    let fLow = npv(low);
    let fHigh = npv(high);

    if (Math.abs(fLow) < tol) return low;
    if (Math.abs(fHigh) < tol) return high;

    for (let i = 0; i < maxIter; i++) {
        const mid = (low + high) / 2;
        const fMid = npv(mid);

        if (!Number.isFinite(fMid)) return null;
        if (Math.abs(fMid) < tol) return mid;

        if (fLow * fMid <= 0) {
            high = mid;
            fHigh = fMid;
        } else {
            low = mid;
            fLow = fMid;
        }
    }

    return (low + high) / 2;
}


// -------------------------
// MORTGAGE
// -------------------------
function computeMortgage(input) {
    const price = n(input?.price);
    const down = n(input?.down);
    const ratePercent = n(input?.ratePercent);
    const termYears = n(input?.termYears);

    if (![price, down, ratePercent, termYears].every(Number.isFinite)) return null;

    const loanAmount = price - down;
    if (!(loanAmount > 0)) return null;

    const months = termYears * 12;
    if (!(months > 0)) return null;

    const monthlyRate = (ratePercent / 100) / 12;

    let monthlyPayment;
    if (monthlyRate === 0) {
        monthlyPayment = loanAmount / months;
    } else {
        monthlyPayment = loanAmount * (monthlyRate / (1 - Math.pow(1 + monthlyRate, -months)));
    }

    const totalPayment = monthlyPayment * months;
    const totalInterest = totalPayment - loanAmount;

    return {
        monthlyPayment: roundMoney(monthlyPayment),
        totalPayment: roundMoney(totalPayment),
        totalInterest: roundMoney(totalInterest),
    };
}

// -------------------------
// CASH_FLOW
// -------------------------
function computeCashFlow(input) {
    // Все суммы — В МЕСЯЦ
    const rent = n(input?.rent);           // monthly rent income
    const vacancy = n(input?.vacancy);     // % (0..99)
    const mortgage = n(input?.mortgage);   // monthly mortgage payment
    const expenses = n(input?.expenses);   // monthly maintenance/opex
    const taxes = n(input?.taxes);         // % of netIncome (в твоём коде это именно %)
    const inflation = n(input?.inflation); // % per year

    if (![rent, vacancy, mortgage, expenses, taxes, inflation].every(Number.isFinite)) return null;

    // базовая валидация как у тебя
    if (rent < 0 || rent > 100_000_000) return null;
    if (vacancy < 0 || vacancy > 99) return null;
    if (mortgage < 0 || mortgage > 10_000_000) return null;
    if (expenses < 0 || expenses > 10_000_000) return null;
    // у тебя taxes max 70 и min 0 (хотя подпись в UI странная)
    if (taxes < 0 || taxes > 70) return null;
    if (inflation < -5 || inflation > 40) return null;

    // ===== logic (1:1) =====

    const netIncome = rent * (1 - vacancy / 100);

    // taxes — это процент от netIncome
    const taxesAmount = netIncome * (taxes / 100);

    const totalExpenses = mortgage + expenses + taxesAmount;
    const cashFlowMonth = netIncome - totalExpenses;
    const cashFlowYear = cashFlowMonth * 12;

    // инфляция: годовую -> месячную
    const inflationAnnual = inflation / 100;
    const inflationMonthly = Math.pow(1 + inflationAnnual, 1 / 12) - 1;

    const realCashFlowMonth = cashFlowMonth / (1 + inflationMonthly);
    const realCashFlowYear = realCashFlowMonth * 12;

    // stress test: vacancy +5pp, expenses +10%
    const stressVacancy = Math.min(vacancy + 5, 99);
    const stressIncome = rent * (1 - stressVacancy / 100);
    const stressTaxesAmount = stressIncome * (taxes / 100);
    const stressExpenses = expenses * 1.1;

    const stressTotalExpenses = mortgage + stressExpenses + stressTaxesAmount;
    const stressCashFlow = stressIncome - stressTotalExpenses;

    // status (как у тебя)
    const strongThreshold = netIncome * 0.1;

    let status;
    if (cashFlowMonth <= 0) {
        status = "Negative cash flow ❌";
    } else if (stressCashFlow < 0) {
        status = "Positive now, but fails stress test ⚠️";
    } else if (cashFlowMonth >= strongThreshold) {
        status = "Strong positive cash flow 💰";
    } else {
        status = "Marginal cash flow ⚠️";
    }

    return {
        netIncome,
        taxesAmount,
        totalExpenses,
        cashFlowMonth,
        cashFlowYear,
        realCashFlowMonth,
        realCashFlowYear,
        stressCashFlow,
        status
    };
}

// -------------------------
// BREAK_EVEN
// -------------------------
function computeBreakEven(input) {
    // inputs (всё в МЕСЯЦ кроме vacancy %)
    const price = n(input?.price);
    const downPayment = n(input?.downPayment);
    const marketRent = n(input?.marketRent);

    const mortgage = n(input?.mortgage);
    const expenses = n(input?.expenses);
    const taxes = n(input?.taxes);     // ВАЖНО: тут это $/month (как у тебя)
    const vacancy = n(input?.vacancy); // %

    if (![price, downPayment, marketRent, mortgage, expenses, taxes, vacancy].every(Number.isFinite)) return null;

    // валидация как в клиенте
    if (price < 1 || price > 500_000_000) return null;
    if (downPayment < 0 || downPayment > price) return null;
    if (marketRent < 0 || marketRent > 100_000_000) return null;
    if (mortgage < 0 || mortgage > 20_000_000) return null;
    if (expenses < 0 || expenses > 10_000_000) return null;
    if (taxes < 0 || taxes > 100_000_000) return null;
    if (vacancy < 0 || vacancy > 95) return null;

    const vacancyRate = vacancy / 100;
    const totalMonthlyCosts = mortgage + expenses + taxes;

    // 1) Required rent to break even (CF = 0)
    const breakEvenRent =
        (1 - vacancyRate) > 0
            ? (totalMonthlyCosts / (1 - vacancyRate))
            : Infinity;

    // 2) Max mortgage you can afford given MARKET rent
    const netMarketIncome = marketRent * (1 - vacancyRate);
    const maxMortgage = netMarketIncome - expenses - taxes;

    // 3) Max price estimate via "payment factor"
    const loanAmount = Math.max(price - downPayment, 0);

    // If current loan payment is missing, use a conservative amortization factor
    // (30y @ 6.5%) instead of a hard magic number.
    const assumedRate = 0.065 / 12;
    const assumedMonths = 30 * 12;
    const assumedFactor = assumedRate / (1 - Math.pow(1 + assumedRate, -assumedMonths));

    const paymentFactorRaw =
        (loanAmount > 0 && mortgage > 0)
            ? (mortgage / loanAmount)
            : assumedFactor;
    const paymentFactor = Number.isFinite(paymentFactorRaw) && paymentFactorRaw > 0
        ? paymentFactorRaw
        : assumedFactor;

    const breakEvenPrice =
        maxMortgage > 0
            ? (downPayment + (maxMortgage / paymentFactor))
            : 0;

    const winner = marketRent >= breakEvenRent ? "property" : "rent";

    return {
        breakEvenRent,
        breakEvenPrice,
        winner
    };
}

function computeRentVsBuy(input) {
    // исходные значения (как сохраняешь в БД/шлёшь на сервер)
    const rentInput = n(input?.rent);                 // $/month
    const mortgageInput = n(input?.mortgage);         // $/month
    const yearsRaw = n(input?.years);                 // years
    const propertyValueInput = n(input?.propertyValue); // $

    const rentGrowthPct = n(input?.rentGrowth);       // 3 = 3%
    const mortgageRatePct = n(input?.mortgageRate);   // 6 = 6%
    const propertyGrowthPct = n(input?.propertyGrowth); // 4 = 4%
    const inflationPct = n(input?.inflation);         // 2 = 2%

    if (![rentInput, mortgageInput, yearsRaw, propertyValueInput, rentGrowthPct, mortgageRatePct, propertyGrowthPct, inflationPct]
        .every(Number.isFinite)) return null;

    const years = Math.trunc(yearsRaw);

    // валидация как в клиенте
    if (!(rentInput > 0)) return null;
    if (!(mortgageInput > 0)) return null;
    if (!(propertyValueInput > 0)) return null;
    if (!(Number.isInteger(years) && years >= 1 && years <= 50)) return null;

    if (rentGrowthPct < 0 || rentGrowthPct > 50) return null;
    if (mortgageRatePct < 0 || mortgageRatePct > 100) return null;
    if (propertyGrowthPct < 0 || propertyGrowthPct > 50) return null;
    if (inflationPct < 0 || inflationPct > 20) return null;

    // проценты -> доли
    const rentGrowth = rentGrowthPct / 100;
    const mortgageRate = mortgageRatePct / 100;
    const propertyGrowth = propertyGrowthPct / 100;
    const inflation = inflationPct / 100;

    // Assumptions:
    // - mortgage is fixed monthly payment (no yearly compounding of payment itself)
    // - mortgageRate defines amortization for implied balance/equity math
    // - mortgage term assumed to be 30y for implied-loan estimation
    const mortgageTermYears = 30;
    const termMonths = mortgageTermYears * 12;
    const horizonMonths = years * 12;
    const monthlyRate = mortgageRate / 12;

    const impliedLoanAmount = monthlyRate === 0
        ? mortgageInput * termMonths
        : mortgageInput * ((1 - Math.pow(1 + monthlyRate, -termMonths)) / monthlyRate);

    let remainingLoanBalance = 0;
    if (horizonMonths < termMonths) {
        if (monthlyRate === 0) {
            remainingLoanBalance = Math.max(0, impliedLoanAmount - mortgageInput * horizonMonths);
        } else {
            const pow = Math.pow(1 + monthlyRate, horizonMonths);
            remainingLoanBalance =
                impliedLoanAmount * pow -
                mortgageInput * ((pow - 1) / monthlyRate);
            if (!Number.isFinite(remainingLoanBalance)) remainingLoanBalance = 0;
            remainingLoanBalance = Math.max(0, remainingLoanBalance);
        }
    }

    // расчёт (как на клиенте)
    let rent = rentInput;

    let rentTotal = 0;
    const mortgagePaid = mortgageInput * 12 * years;
    let propertyValueFinal = propertyValueInput;

    for (let year = 1; year <= years; year++) {
        rentTotal += rent * 12;
        rent *= (1 + rentGrowth);

        propertyValueFinal *= (1 + propertyGrowth);
    }

    const discountedPropertyValue = propertyValueFinal / Math.pow(1 + inflation, years);
    const remainingBalanceReal = remainingLoanBalance / Math.pow(1 + inflation, years);
    const equityReal = discountedPropertyValue - remainingBalanceReal;
    const buyNetCost = mortgagePaid - equityReal;

    const winner = rentTotal < buyNetCost ? "rent" : "buy";

    return {
        rentTotal,
        mortgagePaid,
        impliedLoanAmount,
        remainingLoanBalance,
        equityReal,
        buyNetCost,
        winner
    };
}

// -------------------------
// OWNERSHIP_COST
// -------------------------
function computeOwnershipCost(input) {
    const price = n(input?.price);
    const yearsRaw = n(input?.years);
    const taxPercent = n(input?.taxPercent);
    const maintenance = n(input?.maintenance);
    const inflationPercent = n(input?.inflation);

    if (![price, yearsRaw, taxPercent, maintenance, inflationPercent].every(Number.isFinite)) return null;

    const years = Math.trunc(yearsRaw);

    // валидация 1:1 как в клиенте
    if (price < 1 || price > 50_000_000) return null;

    // years — строго целое
    if (!Number.isInteger(years) || years < 1 || years > 100) return null;
    if (yearsRaw !== years) return null;

    if (taxPercent < 0 || taxPercent > 90) return null;
    if (maintenance < 0 || maintenance > 10_000_000) return null;
    if (inflationPercent < -5 || inflationPercent > 40) return null;

    const taxRate = taxPercent / 100;
    const inflationRate = inflationPercent / 100;

    // ===== логика =====
    // We model carrying ownership costs (tax + maintenance),
    // not the asset purchase principal itself.
    let totalCost = 0;
    let totalCostPV = 0;

    for (let y = 1; y <= years; y++) {
        // индекс инфляции на год y (y=1 => множитель 1, y=2 => (1+infl)^1, ...)
        const inflFactor = Math.pow(1 + inflationRate, y - 1);

        const annualTax = price * taxRate * inflFactor;
        const annualMaint = maintenance * inflFactor;
        const annualCost = annualTax + annualMaint;

        totalCost += annualCost;

        // PV: дисконтируем годовой расход на y лет
        const discount = Math.pow(1 + inflationRate, y);
        totalCostPV += annualCost / discount;
    }

    return {
        totalOwnershipCost: roundMoney(totalCost),
        totalOwnershipCostPV: roundMoney(totalCostPV),
        // backward compat
        totalCost: roundMoney(totalCost),
        totalCostPV: roundMoney(totalCostPV)
    };
}

// -------------------------
// MORTGAGE_OVERPAYMENT
// -------------------------
function annuityPayment(principal, annualRate, months) {
    // annualRate в долях (0.06)
    if (annualRate === 0) return principal / months;

    const r = annualRate / 12;
    const pow = Math.pow(1 + r, months);
    return principal * (r * pow) / (pow - 1);
}

function computeMortgageOverpayment(input) {
    const loan = n(input?.loan);
    const ratePct = n(input?.rate);          // % (например 6)
    const yearsRaw = n(input?.years);
    const inflationPct = n(input?.inflation); // % (например 4)

    if (![loan, ratePct, yearsRaw, inflationPct].every(Number.isFinite)) return null;

    const years = Math.trunc(yearsRaw);

    // валидация 1:1 как в клиенте
    if (loan <= 0 || loan > 100_000_000) return null;
    if (ratePct < 0.1 || ratePct > 70) return null;

    // years должен быть целым 1..70
    if (!Number.isInteger(years) || years < 1 || years > 70) return null;
    if (yearsRaw !== years) return null;

    if (inflationPct < 0 || inflationPct > 50) return null;

    const rate = ratePct / 100;                 // доля
    const inflation = inflationPct / 100;       // доля
    const months = years * 12;

    const payment = annuityPayment(loan, rate, months);

    const totalPaid = payment * months;
    const nominalOverpayment = totalPaid - loan;

    // реальная ставка в % (как у тебя)
    const realInterestRatePct = (((1 + rate) / (1 + inflation)) - 1) * 100;

    // PV платежей в "реальных" долларах
    const monthlyInflation = inflation / 12;

    let realTotalPaid = 0;
    for (let m = 1; m <= months; m++) {
        realTotalPaid += payment / Math.pow(1 + monthlyInflation, m);
    }

    let realOverpayment = realTotalPaid - loan;

    // clamp как у тебя: если инфляция перекрыла проценты — показываем 0 (числом)
    if (!(realOverpayment > 0)) realOverpayment = 0;

    return {
        monthlyPayment: roundMoney(payment),
        nominalOverpayment: roundMoney(nominalOverpayment),
        realOverpayment: roundMoney(realOverpayment),
        realInterestRate: realInterestRatePct // НЕ округляю до int — как в клиенте (может быть 1.92)
    };
}

// -------------------------
// PROPERTY_SALE
// -------------------------
function computePropertySale(input) {
    const buyPrice = n(input?.buyPrice);
    const sellPrice = n(input?.sellPrice);
    const yearsRaw = n(input?.years);

    const taxPct = n(input?.tax);               // % (0..70)
    const commissionPct = n(input?.commission); // % (0..40)
    const inflationPct = n(input?.inflation);   // % (-10..50)
    const renovation = n(input?.renovation);    // $

    if (![buyPrice, sellPrice, yearsRaw, taxPct, commissionPct, inflationPct, renovation].every(Number.isFinite)) {
        return null;
    }

    const years = Math.trunc(yearsRaw);

    // валидация 1:1 как в клиенте
    if (buyPrice < 1 || buyPrice > 500_000_000) return null;
    if (sellPrice < 1 || sellPrice > 500_000_000) return null;

    // years в UI trunc, но валидатор требует целое => как делали в mortgage_overpayment
    if (!Number.isInteger(years) || years < 1 || years > 70) return null;
    if (yearsRaw !== years) return null;

    if (taxPct < 0 || taxPct > 70) return null;
    if (commissionPct < 0 || commissionPct > 40) return null;
    if (inflationPct < -10 || inflationPct > 50) return null;
    if (renovation < 0 || renovation > 100_000_000) return null;

    const taxRate = taxPct / 100;
    const commissionRate = commissionPct / 100;
    const inflationRate = inflationPct / 100;

    const taxAmount = sellPrice * taxRate;
    const commissionAmount = sellPrice * commissionRate;

    const netProfit =
        sellPrice -
        buyPrice -
        taxAmount -
        commissionAmount -
        renovation;

    const investedCapital = buyPrice + renovation;

    // ROI total (%) за весь период
    const roiTotal =
        investedCapital > 0
            ? (netProfit / investedCapital) * 100
            : null;

    // AnnualReturn (%) годовых (CAGR)
    let annualReturn = null;
    if (roiTotal !== null && Number.isFinite(roiTotal) && roiTotal > -100) {
        annualReturn = (Math.pow(1 + roiTotal / 100, 1 / years) - 1) * 100;
    }

    // RealReturn (%) годовых с учётом инфляции (Fisher)
    let realReturn = null;
    if (annualReturn !== null && Number.isFinite(annualReturn)) {
        realReturn = ((1 + annualReturn / 100) / (1 + inflationRate) - 1) * 100;
    }

    // деньги округляем как в остальных вычислителях (чтобы совпадало с UI/БД)
    return {
        taxAmount: roundMoney(taxAmount),
        commissionAmount: roundMoney(commissionAmount),
        netProfit: roundMoney(netProfit),

        // проценты оставляем как number (могут быть дробные)
        roiTotal,
        annualReturn,
        realReturn
    };
}

// -------------------------
// PROPERTY_TAXES
// -------------------------
function computePropertyTaxes(input) {
    // annual значения (как в клиенте)
    const price = n(input?.price);
    const rent = n(input?.rent); // annual rent
    const yearsRaw = n(input?.years);

    const priceGrowthPct = n(input?.priceGrowth);
    const inflationRatePct = n(input?.inflationRate);

    const propertyTaxPct = n(input?.propertyTax);
    const rentTaxPct = n(input?.rentTax);
    const annualFees = n(input?.annualFees);
    const feeGrowthPct = n(input?.feeGrowth);

    const saleTaxPct = n(input?.saleTax);
    const agentFeePct = n(input?.agentFee);

    if (![
        price, rent, yearsRaw,
        priceGrowthPct, inflationRatePct,
        propertyTaxPct, rentTaxPct,
        annualFees, feeGrowthPct,
        saleTaxPct, agentFeePct
    ].every(Number.isFinite)) return null;

    const years = Math.trunc(yearsRaw);

    // ===== validation 1:1 как в клиенте =====
    if (price < 1 || price > 500_000_000) return null;
    if (rent < 0 || rent > 30_000_000) return null;

    if (!Number.isInteger(years) || years < 1 || years > 70) return null;
    if (yearsRaw !== years) return null;

    if (priceGrowthPct < -20 || priceGrowthPct > 100) return null;
    if (inflationRatePct < -5 || inflationRatePct > 30) return null;

    if (propertyTaxPct < 0 || propertyTaxPct > 70) return null;
    if (rentTaxPct < 0 || rentTaxPct > 70) return null;

    if (annualFees < 0 || annualFees > 10_000_000) return null;
    if (feeGrowthPct < 0 || feeGrowthPct > 50) return null;

    if (saleTaxPct < 0 || saleTaxPct > 60) return null;
    if (agentFeePct < 0 || agentFeePct > 50) return null;

    // ===== logic 1:1 =====
    const discountRate = inflationRatePct / 100;

    let totalTaxes = 0;
    let totalFees = 0;
    let totalRentNet = 0;
    let totalRentNetPV = 0;

    let currentPrice = price;
    let currentFees = annualFees;

    for (let y = 1; y <= years; y++) {
        const yearlyPropertyTax = currentPrice * (propertyTaxPct / 100);
        const yearlyRentTax = rent * (rentTaxPct / 100);

        const netRent = rent - yearlyRentTax - currentFees;

        totalTaxes += (yearlyPropertyTax + yearlyRentTax);
        totalFees += currentFees;
        totalRentNet += netRent;

        const discountFactor = 1 / Math.pow(1 + discountRate, y);
        totalRentNetPV += netRent * discountFactor;

        currentPrice *= (1 + priceGrowthPct / 100);
        currentFees *= (1 + feeGrowthPct / 100);
    }

    const totalGrossRent = rent * years;
    const taxBurdenPercent = totalGrossRent > 0 ? (totalTaxes / totalGrossRent) * 100 : 0;

    const saleTaxAmount = currentPrice * (saleTaxPct / 100);
    const agentFeeAmount = currentPrice * (agentFeePct / 100);

    const saleProfit = (currentPrice - price) - saleTaxAmount - agentFeeAmount;
    const saleProfitPV = saleProfit / Math.pow(1 + discountRate, years);

    const finalProfit = totalRentNet + saleProfit;
    const finalProfitPV = totalRentNetPV + saleProfitPV;

    const investedCapital = price + totalFees + totalTaxes;
    const simpleROI = investedCapital > 0 ? (finalProfit / investedCapital) * 100 : 0;
    const realROI = investedCapital > 0 ? (finalProfitPV / investedCapital) * 100 : 0;

    // деньги — округляем, проценты — оставляем как number (дробные)
    return {
        totalTaxes: roundMoney(totalTaxes),
        totalFees: roundMoney(totalFees),
        totalRentNet: roundMoney(totalRentNet),
        finalProfit: roundMoney(finalProfit),

        finalProfitPV: roundMoney(finalProfitPV),
        simpleROI,
        realROI,
        taxBurdenPercent

        // при желании можно тоже вернуть:
        // saleProfit, saleProfitPV, totalRentNetPV, currentPrice, saleTaxAmount, agentFeeAmount
    };
}

// -------------------------
// RENOVATION_ROI
// -------------------------
function computeRenovationROI(input) {
    const priceBefore = n(input?.priceBefore);
    const rentBefore = n(input?.rentBefore); // MONTHLY
    const renovationCost = n(input?.renovationCost);

    const priceIncreasePct = n(input?.priceIncrease); // 5 = 5%
    const rentIncreasePct = n(input?.rentIncrease);
    const agentFeePct = n(input?.agentFee);
    const saleTaxPct = n(input?.saleTax);

    const yearsRaw = n(input?.years);

    // в клиенте: Number(discountRateEl.value) || 0
    const discountRatePct = nz(input?.discountRate);
    const inflationRatePct = nz(input?.inflationRate);

    if (![
        priceBefore, rentBefore, renovationCost,
        priceIncreasePct, rentIncreasePct, agentFeePct, saleTaxPct,
        yearsRaw
    ].every(Number.isFinite)) return null;

    const years = Math.trunc(yearsRaw);

    // ===== validation (1:1) =====
    if (priceBefore < 1 || priceBefore > 500_000_000) return null;
    if (rentBefore < 0 || rentBefore > 100_000_000) return null;
    if (renovationCost < 0 || renovationCost > 100_000_000) return null;

    if (priceIncreasePct < -100 || priceIncreasePct > 2000) return null;
    if (rentIncreasePct < -100 || rentIncreasePct > 2000) return null;

    if (agentFeePct < 0 || agentFeePct > 50) return null;
    if (saleTaxPct < 0 || saleTaxPct > 60) return null;

    if (years < 1 || years > 70) return null;
    if (yearsRaw !== years) return null;

    if (inflationRatePct < 0 || inflationRatePct > 100) return null;
    if (discountRatePct < 0 || discountRatePct > 100) return null;

    // отдельная проверка как в UI
    if (renovationCost > priceBefore) return null;

    // ===== logic (1:1) =====
    const priceIncrease = priceIncreasePct / 100;
    const rentIncrease = rentIncreasePct / 100;
    const agentFee = agentFeePct / 100;
    const saleTax = saleTaxPct / 100;

    const discountRate = discountRatePct / 100;
    const inflationRate = inflationRatePct / 100;

    const priceAfter = priceBefore * (1 + priceIncrease);
    const rentAfter = rentBefore * (1 + rentIncrease); // MONTHLY

    const extraRentPerYear = (rentAfter - rentBefore) * 12;
    const totalExtraRent = extraRentPerYear * years;

    // Реальная дисконт-ставка
    const realDiscount = (1 + discountRate) / (1 + inflationRate) - 1;

    let totalExtraRentPV = 0;
    if (Math.abs(realDiscount) < 1e-9) {
        totalExtraRentPV = extraRentPerYear * years;
    } else {
        for (let i = 1; i <= years; i++) {
            totalExtraRentPV += extraRentPerYear / Math.pow(1 + realDiscount, i);
        }
    }

    const agentCost = priceAfter * agentFee;
    const saleTaxCost = priceAfter * saleTax;

    const saleProfit = priceAfter - priceBefore - renovationCost - agentCost - saleTaxCost;

    const netProfit = saleProfit + totalExtraRent;
    const netProfitPV = saleProfit + totalExtraRentPV;

    const roi = renovationCost > 0 ? (netProfit / renovationCost) * 100 : null;
    const roiPV = renovationCost > 0 ? (netProfitPV / renovationCost) * 100 : null;

    let payback = null;
    if (extraRentPerYear > 0) {
        payback = renovationCost / extraRentPerYear; // years (float)
    }

    return {
        priceAfter: roundMoney(priceAfter),
        rentAfter: roundMoney(rentAfter),

        totalExtraRent: roundMoney(totalExtraRent),
        totalExtraRentPV: roundMoney(totalExtraRentPV),

        saleProfit: roundMoney(saleProfit),

        netProfit: roundMoney(netProfit),
        netProfitPV: roundMoney(netProfitPV),

        roi,    // percent number or null
        roiPV,  // percent number or null
        payback // years float or null
    };
}

// -------------------------
// PROPERTY_IRR
// -------------------------
function computePropertyIRR(input) {
    const price = n(input?.price);
    const downPayment = n(input?.downPayment);
    const purchaseCosts = n(input?.purchaseCosts);
    const renovation = n(input?.renovation);

    const rentMonthly0 = n(input?.rent);     // monthly rent (как в клиенте)
    const vacancy = n(input?.vacancy);       // %
    const expensesAnnual0 = n(input?.expenses); // annual
    const mortgageAnnual0 = n(input?.mortgage); // annual (simplified)

    const yearsRaw = n(input?.years);
    const growthPct = n(input?.growth);      // %/year
    const saleTaxPct = n(input?.saleTax);    // %
    const inflationPct = n(input?.inflation);// %/year

    if (![
        price, downPayment, purchaseCosts, renovation,
        rentMonthly0, vacancy, expensesAnnual0, mortgageAnnual0,
        yearsRaw, growthPct, saleTaxPct, inflationPct
    ].every(Number.isFinite)) return null;

    const years = Math.trunc(yearsRaw);

    // ===== validation (1:1) =====
    if (price < 1 || price > 500_000_000) return null;
    if (downPayment < 0 || downPayment > price) return null;
    if (purchaseCosts < 0 || purchaseCosts > 10_000_000) return null;
    if (renovation < 0 || renovation > 100_000_000) return null;

    if (rentMonthly0 < 0 || rentMonthly0 > 10_000_000) return null;
    if (vacancy < 0 || vacancy > 99) return null;
    if (expensesAnnual0 < 0 || expensesAnnual0 > 5_000_000) return null;
    if (mortgageAnnual0 < 0 || mortgageAnnual0 > 10_000_000) return null;

    if (yearsRaw < 1 || yearsRaw > 100) return null;
    if (yearsRaw !== years) return null;

    if (growthPct < -99 || growthPct > 2000) return null;
    if (saleTaxPct < 0 || saleTaxPct > 80) return null;
    if (inflationPct < -5 || inflationPct > 40) return null;

    // ===== core assumptions =====
    const initialInvestment = downPayment + purchaseCosts + renovation;

    // principal stays until sale (как в клиенте)
    const loanAmount = Math.max(price - downPayment, 0);

    const infl = inflationPct / 100;
    const g = growthPct / 100;

    let rentM = rentMonthly0;
    let expensesY = expensesAnnual0;
    let mortgageY = mortgageAnnual0;

    const futurePrice = price * Math.pow(1 + g, years);
    const netSaleProceeds = (futurePrice * (1 - saleTaxPct / 100)) - loanAmount;

    // cash flows: t=0 equity outflow
    const cashFlows = [-initialInvestment];

    let cashFlowAnnualShown = null;

    for (let t = 1; t <= years; t++) {
        const effectiveRentAnnual = rentM * 12 * (1 - vacancy / 100);
        const cashFlowAnnual = effectiveRentAnnual - expensesY - mortgageY;

        if (t === 1) cashFlowAnnualShown = cashFlowAnnual;

        const cf = (t === years) ? (cashFlowAnnual + netSaleProceeds) : cashFlowAnnual;
        cashFlows.push(cf);

        // grow by inflation (как в клиенте)
        rentM *= (1 + infl);
        expensesY *= (1 + infl);
        mortgageY *= (1 + infl);
    }

    const irr = irrFromCashflows(cashFlows); // decimal (0.12)

    const realIRR = irr === null
        ? null
        : (((1 + irr) / (1 + infl)) - 1) * 100; // percent

    const netProfit = cashFlows.reduce((a, b) => a + b, 0);
    const roi = initialInvestment > 0 ? (netProfit / initialInvestment) * 100 : null;

    // payback (simple)
    let paybackYears = null;
    let cum = cashFlows[0];

    for (let t = 1; t < cashFlows.length; t++) {
        const prev = cum;
        cum += cashFlows[t];

        if (cum >= 0) {
            const inflow = cashFlows[t];
            if (inflow > 0) {
                const frac = (-prev) / inflow;
                paybackYears = (t - 1) + frac;
            } else {
                paybackYears = t;
            }
            break;
        }
    }

    return {
        cashFlow: roundMoney(cashFlowAnnualShown ?? 0),
        roi, // % or null
        irr: irr === null ? null : (irr * 100), // % or null
        realIRR, // % or null
        paybackYears // number or null

        // при желании можно вернуть больше для сценариев:
        // cashFlows, netSaleProceeds, netProfit
    };
}

// -------------------------
// ALTERNATIVE_INVESTMENT
// -------------------------

function computeRealFutureValue({ initial, annualContribution, annualReturn, years, inflationRate, taxRate }) {
    let value = initial;

    const r = annualReturn / 100;
    const inf = inflationRate / 100;
    const tax = taxRate / 100;

    for (let y = 0; y < years; y++) {
        const gain = value * r;

        // tax only on positive gain
        const taxOnGain = gain > 0 ? gain * tax : 0;

        value += (gain - taxOnGain);

        // contribution at end of year
        value += annualContribution;

        // convert to real value (today dollars)
        value /= (1 + inf);
    }

    return value;
}

function computeRealCAGRPercent({ initial, finalValue, years }) {
    if (!Number.isFinite(initial) || initial <= 0) return null;
    if (!Number.isFinite(finalValue) || finalValue <= 0) return null;
    if (!Number.isFinite(years) || years <= 0) return null;

    return (Math.pow(finalValue / initial, 1 / years) - 1) * 100;
}

function computeAlternativeInvestment(input) {
    const propertyInitial = n(input?.propertyInitial);
    const propertyCashflow = n(input?.propertyCashflow);   // $/year (can be negative)
    const propertyGrowth = n(input?.propertyGrowth);       // %/year

    const altReturn = n(input?.altReturn);                 // %/year
    const altContribution = n(input?.altContribution);     // $/year

    const propertyInflation = n(input?.propertyInflation); // %/year
    const propertyTaxRate = n(input?.propertyTaxRate);     // % on gain

    const altInflation = n(input?.altInflation);           // %/year
    const altTaxRate = n(input?.altTaxRate);               // % on gain

    const yearsRaw = n(input?.years);

    if (![
        propertyInitial, propertyCashflow, propertyGrowth,
        altReturn, altContribution,
        propertyInflation, propertyTaxRate,
        altInflation, altTaxRate,
        yearsRaw
    ].every(Number.isFinite)) return null;

    const years = Math.trunc(yearsRaw);

    // ===== validation (1:1) =====
    if (propertyInitial < 1 || propertyInitial > 100_000_000) return null;
    if (propertyCashflow < -10_000_000 || propertyCashflow > 10_000_000) return null;
    if (propertyGrowth < -99 || propertyGrowth > 2000) return null;

    if (altReturn < -99 || altReturn > 2000) return null;
    if (altContribution < 0 || altContribution > 10_000_000) return null;

    if (yearsRaw < 1 || yearsRaw > 80) return null;
    // на клиенте years не тримался, но валидация "number"; здесь делаем строго int
    if (yearsRaw !== years) return null;

    if (propertyInflation < 0 || propertyInflation > 100) return null;
    if (propertyTaxRate < 0 || propertyTaxRate > 100) return null;

    if (altInflation < 0 || altInflation > 100) return null;
    if (altTaxRate < 0 || altTaxRate > 100) return null;

    // ===== logic =====
    const propertyValue = computeRealFutureValue({
        initial: propertyInitial,
        annualContribution: propertyCashflow,
        annualReturn: propertyGrowth,
        years,
        inflationRate: propertyInflation,
        taxRate: propertyTaxRate
    });

    const alternativeValue = computeRealFutureValue({
        initial: propertyInitial,
        annualContribution: altContribution,
        annualReturn: altReturn,
        years,
        inflationRate: altInflation,
        taxRate: altTaxRate
    });

    const propertyRealReturnPercent = computeRealCAGRPercent({
        initial: propertyInitial,
        finalValue: propertyValue,
        years
    });

    const alternativeRealReturnPercent = computeRealCAGRPercent({
        initial: propertyInitial,
        finalValue: alternativeValue,
        years
    });

    const difference = propertyValue - alternativeValue;

    // difference = property - alternative:
    // positive => property wins, negative => alternative wins.
    const winner = difference > 0 ? "property" : (difference < 0 ? "alternative" : "tie");

    return {
        propertyValue: roundMoney(propertyValue),
        alternativeValue: roundMoney(alternativeValue),

        // проценты оставляем как числа (не округляю жестко, как у тебя)
        propertyRealReturnPercent,
        alternativeRealReturnPercent,

        difference: roundMoney(difference),
        winner
    };
}


function computeResultByType(type, input) {
    switch (String(type || "")) {
        case "mortgage":
            return computeMortgage(input);

        case "cash_flow":
            return computeCashFlow(input);

        case "break_even":
            return computeBreakEven(input);

        case "rent_vs_buy":
            return computeRentVsBuy(input);

        case "ownership_cost":
            return computeOwnershipCost(input);

        case "mortgage_overpayment":
            return computeMortgageOverpayment(input);

        case "property_sale":
            return computePropertySale(input);

        case "property_taxes":
            return computePropertyTaxes(input);

        case "renovation_roi":
            return computeRenovationROI(input);

        case "property_irr":
            return computePropertyIRR(input);

        case "alternative_investment":
            return computeAlternativeInvestment(input);

        default:
            return null;
    }
}

module.exports = { computeResultByType };
