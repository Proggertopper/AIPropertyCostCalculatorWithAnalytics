const CALC_FORMATS = {
    alternative_investment: {
        input: {
            propertyInitial: { type: "money", min: 1, max: 100_000_000 },
            propertyCashflow: { type: "money", min: -10_000_000, max: 10_000_000 },
            propertyGrowth: { type: "percent", min: -99, max: 2000 },

            propertyInflation: { type: "percent", min: 0, max: 100 },
            propertyTaxRate: { type: "percent", min: 0, max: 100 },

            altReturn: { type: "percent", min: -99, max: 2000 },
            altContribution: { type: "money", min: 0, max: 10_000_000 },
            altInflation: { type: "percent", min: 0, max: 100 },
            altTaxRate: { type: "percent", min: 0, max: 100 },

            years: { type: "years", min: 1, max: 80 }
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
            price: { type: "money", min: 1, max: 500_000_000 },
            downPayment: { type: "money", min: 0, max: 500_000_000 }, // дополнительно проверяешь <= price в compute
            marketRent: { type: "money", min: 0, max: 100_000_000 },

            mortgage: { type: "money", min: 0, max: 20_000_000 },
            expenses: { type: "money", min: 0, max: 10_000_000 },
            taxes: { type: "money", min: 0, max: 100_000_000 }, // тут taxes = $/month
            vacancy: { type: "percent", min: 0, max: 95 }
        },
        result: {
            breakEvenRent: "money",
            breakEvenPrice: "money",
            winner: "text"
        }
    },

    cash_flow: {
        input: {
            rent: { type: "money", min: 0, max: 100_000_000 },
            vacancy: { type: "percent", min: 0, max: 99 },
            mortgage: { type: "money", min: 0, max: 10_000_000 },
            expenses: { type: "money", min: 0, max: 10_000_000 },

            taxes: { type: "percent", min: 0, max: 70 },      // у тебя taxes = % от netIncome
            inflation: { type: "percent", min: -5, max: 40 }
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
            price: { type: "money", min: 1, max: 500_000_000 },
            downPayment: { type: "money", min: 0, max: 500_000_000 }, // + <= price в compute
            purchaseCosts: { type: "money", min: 0, max: 10_000_000 },
            renovation: { type: "money", min: 0, max: 100_000_000 },

            rent: { type: "money", min: 0, max: 10_000_000 }, // monthly rent
            vacancy: { type: "percent", min: 0, max: 99 },

            expenses: { type: "money", min: 0, max: 5_000_000 },  // annual
            mortgage: { type: "money", min: 0, max: 10_000_000 }, // annual

            years: { type: "years", min: 1, max: 100 },

            growth: { type: "percent", min: -99, max: 2000 },
            saleTax: { type: "percent", min: 0, max: 80 },
            inflation: { type: "percent", min: -5, max: 40 }
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
            price: { type: "money", min: 1, max: 500_000_000 },
            down: { type: "money", min: 0, max: 500_000_000 }, // + <= price в computeMortgage
            ratePercent: { type: "percent", min: 0, max: 70 }, // у тебя computeMortgage принимает 0 тоже
            termYears: { type: "years", min: 1, max: 70 }
        },
        result: {
            monthlyPayment: "money",
            totalPayment: "money",
            totalInterest: "money"
        }
    },

    ownership_cost: {
        input: {
            price: { type: "money", min: 1, max: 50_000_000 },
            years: { type: "years", min: 1, max: 100 },

            
            taxPercent: { type: "percent", min: 0, max: 90 },

          
            maintenance: { type: "money", min: 0, max: 10_000_000 },

           
            inflation: { type: "percent", min: -5, max: 40 }
        },

        result: {
            
            years: "years",

            totalOwnershipCost: "money",      
            totalOwnershipCostPV: "money",    

            totalTaxes: "money",              // nominal sum of taxes (years 1..N)
            totalMaintenance: "money",         // nominal sum of maintenance (years 1..N)
            totalTaxesPV: "money",             // PV of taxes
            totalMaintenancePV: "money",       // PV of maintenance

            costAsPercentOfPrice: "percent",   // totalOwnershipCost / price * 100
            taxesSharePercent: "percent",      // totalTaxes / totalOwnershipCost * 100
            maintenanceSharePercent: "percent",// totalMaintenance / totalOwnershipCost * 100

            // ✅ backward compat (old UI / old storage)
            totalCost: "money",
            totalCostPV: "money"
        }
    },


    property_sale: {
        input: {
            buyPrice: { type: "money", min: 1, max: 500_000_000 },
            sellPrice: { type: "money", min: 1, max: 500_000_000 },
            years: { type: "years", min: 1, max: 70 },

            tax: { type: "percent", min: 0, max: 70 },
            commission: { type: "percent", min: 0, max: 40 },
            inflation: { type: "percent", min: -10, max: 50 },

            renovation: { type: "money", min: 0, max: 100_000_000 }
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
            price: { type: "money", min: 1, max: 500_000_000 },
            rent: { type: "money", min: 0, max: 30_000_000 }, // annual rent
            years: { type: "years", min: 1, max: 70 },

            priceGrowth: { type: "percent", min: -20, max: 100 },
            propertyTax: { type: "percent", min: 0, max: 70 },
            rentTax: { type: "percent", min: 0, max: 70 },

            annualFees: { type: "money", min: 0, max: 10_000_000 },
            feeGrowth: { type: "percent", min: 0, max: 50 },

            saleTax: { type: "percent", min: 0, max: 60 },
            agentFee: { type: "percent", min: 0, max: 50 },

            inflationRate: { type: "percent", min: -5, max: 30 }
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
            loan: { type: "money", min: 1, max: 100_000_000 },
            rate: { type: "percent", min: 0.1, max: 70 },
            years: { type: "years", min: 1, max: 70 },
            inflation: { type: "percent", min: 0, max: 50 }
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
            priceBefore: { type: "money", min: 1, max: 500_000_000 },
            rentBefore: { type: "money", min: 0, max: 100_000_000 }, // monthly
            renovationCost: { type: "money", min: 0, max: 100_000_000 },

            priceIncrease: { type: "percent", min: -100, max: 2000 },
            rentIncrease: { type: "percent", min: -100, max: 2000 },
            agentFee: { type: "percent", min: 0, max: 50 },
            saleTax: { type: "percent", min: 0, max: 60 },

            years: { type: "years", min: 1, max: 70 },

            discountRate: { type: "percent", min: 0, max: 100 },
            inflationRate: { type: "percent", min: 0, max: 100 }
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
            rent: { type: "money", min: 1, max: 100_000_000 },
            mortgage: { type: "money", min: 1, max: 100_000_000 },
            years: { type: "years", min: 1, max: 50 },
            propertyValue: { type: "money", min: 1, max: 500_000_000 },

            rentGrowth: { type: "percent", min: 0, max: 50 },
            mortgageRate: { type: "percent", min: 0, max: 100 },
            propertyGrowth: { type: "percent", min: 0, max: 50 },
            inflation: { type: "percent", min: 0, max: 20 }
        },
        result: {
            rentTotal: "money",
            mortgagePaid: "money",
            buyNetCost: "money",
            winner: "text"
        }
    }
};

module.exports = { CALC_FORMATS };
