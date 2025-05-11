import { useState, useEffect, useCallback, ChangeEvent, FC } from 'react';

// --- Type Definitions ---

// Constants for Buy Metrics
const BUY_METRICS = {
  CPM: 'CPM', // Cost Per Mille (Thousand Impressions)
  CPC: 'CPC', // Cost Per Click
  CPA: 'CPA', // Cost Per Acquisition/Conversion
  CPCV: 'CPCV', // Cost Per Completed View
  FLAT_FEE: 'Flat Fee/Units', // For Job/Project or when rate is per unit
} as const; // Use 'as const' for stricter type checking

type BuyMetricKeys = keyof typeof BUY_METRICS;
type BuyMetricValues = typeof BUY_METRICS[BuyMetricKeys];

interface InputConfig {
  name: string;
  label: string;
  type: 'number' | 'select' | 'boolean';
  default: number | string | boolean;
  options?: BuyMetricValues[];
  min?: number;
  max?: number;
}

interface CalculationFunctionParams {
  totalBudget?: number;
  commissionRate?: number;
  fixedRate?: number;
  buyMetricId?: BuyMetricValues;
  actualDeliveredUnits?: number;
  actualMediaSpend?: number;
  pacingFromAdServer?: boolean;
  capBudget?: boolean;
  invoiceQuantity?: number;
  amountAlreadyCharged?: number;
  serviceFeeRate?: number;
  totalDaysInPlacement?: number;
  daysElapsedInDateRange?: number;
  clientSpend?: CalculationResult; // For dependent calculations
  invoiceSpend?: number;
  [key: string]: any; // Allow other properties
}

interface CalculationResult {
  value: number | string;
  formula: string;
}

interface PricingModelConfig {
  id: string;
  name: string;
  description: string;
  inputs: InputConfig[];
  calculations: {
    [key: string]: (params: CalculationFunctionParams) => CalculationResult;
  };
}

interface PricingModelsConfigMap {
  [key: string]: PricingModelConfig;
}

type InputsState = Record<string, number | string | boolean>;
type OutputsState = Record<string, CalculationResult>;


// Helper function to parse float or return 0
const parseFloatOrZero = (value: string | number): number => {
  const parsed = parseFloat(value as string);
  return isNaN(parsed) ? 0 : parsed;
};

// Base class logic (simplified for UI)
const BasePricingModelLogic = {
  isPacingOnImpressions: (buyMetricId?: BuyMetricValues): boolean => buyMetricId === BUY_METRICS.CPM,
  getDeliveredMetrics: (_pacingFromAdServer: boolean, _buyMetricId: BuyMetricValues, actualDeliveredUnits: number): number => {
    return actualDeliveredUnits;
  },
  calculateSpendFromMetrics: (_pacingFromAdServer: boolean, buyMetricId: BuyMetricValues, actualDeliveredUnits: number, rate: number, budget: number, capBudget: boolean = true): number => {
    let clientSpend = rate * actualDeliveredUnits;
    if (BasePricingModelLogic.isPacingOnImpressions(buyMetricId)) {
      clientSpend = (rate * actualDeliveredUnits) / 1000;
    }
    return capBudget ? Math.min(clientSpend, budget) : clientSpend;
  },
  getCommissionAmount: (budget: number, commissionRate: number): number => {
    if (isNaN(budget) || isNaN(commissionRate) || commissionRate >= 100 || commissionRate < 0) {
      return 0;
    }
    return (budget * commissionRate) / 100;
  }
};

// --- Individual Pricing Model Logic ---

const FixedMetricLogic: PricingModelConfig = {
  id: 'FixedMetric',
  name: 'Fixed Metric',
  description: 'Bills based on a fixed rate for a specific metric (e.g., CPM, CPC), capped by budget.',
  inputs: [
    { name: 'totalBudget', label: 'Total Budget ($)', type: 'number', default: 10000 },
    { name: 'commissionRate', label: 'Agency Commission (%)', type: 'number', default: 15, min: 0, max: 99.99 },
    { name: 'fixedRate', label: 'Fixed Rate ($ per unit/CPM)', type: 'number', default: 5 },
    { name: 'buyMetricId', label: 'Buy Metric', type: 'select', options: Object.values(BUY_METRICS), default: BUY_METRICS.CPM },
    { name: 'actualDeliveredUnits', label: 'Actual Delivered Units', type: 'number', default: 1800000 },
    { name: 'actualMediaSpend', label: 'Actual Media Spend ($)', type: 'number', default: 8000 },
    { name: 'pacingFromAdServer', label: 'Pace from Ad Server?', type: 'boolean', default: false },
    { name: 'capBudget', label: 'Cap Spend at Budget?', type: 'boolean', default: true },
    { name: 'invoiceQuantity', label: 'Quantity for Invoice', type: 'number', default: 1800000 },
    { name: 'amountAlreadyCharged', label: 'Amount Already Charged ($)', type: 'number', default: 0 },
  ],
  calculations: {
    targetDelivery: ({ totalBudget = 0, fixedRate = 0, buyMetricId = BUY_METRICS.CPM }) => {
      if (fixedRate <= 0 || totalBudget < 0) return { value: 'N/A', formula: "Rate must be > 0 and Budget >= 0." };
      const delivery = totalBudget / fixedRate;
      const value = BasePricingModelLogic.isPacingOnImpressions(buyMetricId) ? Math.ceil(delivery * 1000) : Math.ceil(delivery);
      return { value, formula: `If CPM: ceil((Total Budget / Fixed Rate) * 1000). Else: ceil(Total Budget / Fixed Rate). Result: ${value}` };
    },
    actualDelivery: ({ actualDeliveredUnits = 0 }) => {
      return { value: actualDeliveredUnits, formula: "User-provided 'Actual Delivered Units'." };
    },
    clientSpend: ({ pacingFromAdServer = false, fixedRate = 0, actualDeliveredUnits = 0, buyMetricId = BUY_METRICS.CPM, totalBudget = 0, capBudget = true }) => {
      const value = BasePricingModelLogic.calculateSpendFromMetrics(pacingFromAdServer, buyMetricId, actualDeliveredUnits, fixedRate, totalBudget, capBudget);
      return { value, formula: `(Fixed Rate * Actual Delivered Units) ${BasePricingModelLogic.isPacingOnImpressions(buyMetricId) ? '/ 1000 ' : ''}${capBudget ? ', capped by Total Budget.' : '.'} Result: ${value}` };
    },
    mediaSpend: ({ actualMediaSpend = 0 }) => {
      return { value: actualMediaSpend, formula: "User-provided 'Actual Media Spend'." };
    },
    netBudget: ({ clientSpend, commissionRate = 0, totalBudget = 0 }) => {
      const effectiveBudget = Math.min(clientSpend?.value as number || 0, totalBudget);
      const value = effectiveBudget * (1 - commissionRate / 100);
      return { value, formula: `min(Client Spend, Total Budget) * (1 - Commission Rate / 100). Result: ${value}` };
    },
    toDateBudget: () => ({ value: 'N/A', formula: "Complex, typically requires daily data. For Fixed Metric, it's usually the Client Spend up to a point." }),
    invoiceAmount: ({ totalBudget = 0, fixedRate = 0, commissionRate = 0, invoiceQuantity = 0, amountAlreadyCharged = 0, buyMetricId = BUY_METRICS.CPM }) => {
      const netBudget = totalBudget * (1 - commissionRate / 100);
      let amount = fixedRate * invoiceQuantity;
      if (BasePricingModelLogic.isPacingOnImpressions(buyMetricId)) {
        amount = (fixedRate * invoiceQuantity) / 1000;
      }
      amount = amount * (1 - commissionRate / 100);

      if (amount + amountAlreadyCharged > netBudget) {
        amount = netBudget - amountAlreadyCharged;
      }
      const value = Math.max(0, amount);
      return { value, formula: `Calculated based on quantity, rate, and commission, capped by (Net Budget - Amount Already Charged). Net Budget = Total Budget * (1 - Commission %). Amount = (Rate * Quantity ${BasePricingModelLogic.isPacingOnImpressions(buyMetricId) ? '/ 1000' : ''}) * (1 - Commission %). Result: ${value}` };
    }
  }
};

const HdGrossInvoiceGrossFeeLogic: PricingModelConfig = {
  id: 'HdGrossInvoiceGrossFee',
  name: 'HD Gross Invoice Gross Fee',
  description: 'Invoice based on gross amount, service fee calculated on gross budget. Commission applied first.',
  inputs: [
    { name: 'totalBudget', label: 'Total Budget ($)', type: 'number', default: 10000 },
    { name: 'commissionRate', label: 'Agency Commission (%)', type: 'number', default: 10, min:0, max:99.99 },
    { name: 'serviceFeeRate', label: 'Service Fee (%) on Gross', type: 'number', default: 15, min:0, max:100 },
    { name: 'actualMediaSpend', label: 'Actual Media Spend ($)', type: 'number', default: 7000 },
    { name: 'invoiceSpend', label: 'Spend for Invoice Calc. ($)', type: 'number', default: 7000 },
    { name: 'amountAlreadyCharged', label: 'Amount Already Charged ($)', type: 'number', default: 0 },
  ],
  calculations: {
    serviceFeeAmount: ({ totalBudget = 0, serviceFeeRate = 0 }) => {
        const value = (totalBudget * serviceFeeRate) / 100;
        return { value, formula: `Total Budget * Service Fee Rate / 100. Result: ${value}`};
    },
    targetDelivery: ({ totalBudget = 0, commissionRate = 0, serviceFeeRate = 0 }) => {
      const netBudgetAfterCommission = totalBudget * (1 - commissionRate / 100);
      const serviceFeeAmount = (totalBudget * serviceFeeRate) / 100; // Service fee on gross budget
      const value = netBudgetAfterCommission - serviceFeeAmount;
      return { value, formula: `(Total Budget * (1 - Commission Rate / 100)) - (Total Budget * Service Fee Rate / 100). Result: ${value}` };
    },
    actualDelivery: ({ actualMediaSpend = 0 }) => {
      return { value: actualMediaSpend, formula: "Typically the Actual Media Spend (simplified here)." };
    },
    clientSpend: ({ actualMediaSpend = 0, commissionRate = 0, serviceFeeRate = 0, totalBudget = 0 }) => {
      let clientSpend = 0;
      const denominator = 1 - commissionRate / 100 - serviceFeeRate / 100;
      if (denominator > 0) {
        clientSpend = actualMediaSpend / denominator;
      } else {
        clientSpend = Infinity;
      }
      const value = Math.min(totalBudget, clientSpend);
      return { value, formula: `Media Spend / (1 - Commission Rate% - Service Fee Rate%) , capped by Total Budget. Result: ${value}` };
    },
    mediaSpend: ({ actualMediaSpend = 0 }) => {
      return { value: actualMediaSpend, formula: "User-provided 'Actual Media Spend'." };
    },
    netBudget: ({ totalBudget = 0, commissionRate = 0, actualMediaSpend = 0, serviceFeeRate = 0 }) => {
      const netBudgetAfterCommission = totalBudget * (1 - commissionRate / 100);
      const serviceFeeOnGross = (totalBudget * serviceFeeRate) / 100;
      const bookedNetMediaSpend = netBudgetAfterCommission - serviceFeeOnGross;
      let value;
      if (actualMediaSpend <= bookedNetMediaSpend) {
         value = netBudgetAfterCommission; // Simplified: Net budget is budget after commission
      } else {
        value = netBudgetAfterCommission;
      }
      return { value, formula: `Total Budget * (1 - Commission Rate / 100). (Simplified interpretation). Result: ${value}` };
    },
    toDateBudget: () => ({ value: 'N/A', formula: "Complex, requires daily flight data and pacing logic." }),
    invoiceAmount: ({ totalBudget = 0, commissionRate = 0, serviceFeeRate = 0, amountAlreadyCharged = 0, invoiceSpend = 0 }) => {
        let amount = 0;
        const denominator = 100 - serviceFeeRate - commissionRate;
        if (denominator > 0) {
            amount = (invoiceSpend * 100) / denominator;
        } else {
            amount = Infinity;
        }
        amount = Math.min(amount, totalBudget - amountAlreadyCharged);
        const value = Math.max(0,amount);
        return { value, formula: `min( (Invoice Spend * 100) / (100 - Service Fee % - Commission %), Total Budget - Amount Already Charged ). Result: ${value}`};
    }
  }
};

const HdNetInvoiceGrossFeeLogic: PricingModelConfig = {
  ...HdGrossInvoiceGrossFeeLogic,
  id: 'HdNetInvoiceGrossFee',
  name: 'HD Net Invoice Gross Fee',
  description: 'Invoice based on net amount (after commission), service fee calculated on gross budget.',
  calculations: {
    ...HdGrossInvoiceGrossFeeLogic.calculations,
    netBudget: ({ totalBudget = 0, commissionRate = 0 }) => {
        const value = totalBudget * (1 - commissionRate / 100);
        return { value, formula: `Total Budget * (1 - Commission Rate / 100). Result: ${value}` };
    },
    invoiceAmount: ({ totalBudget = 0, commissionRate = 0, serviceFeeRate = 0, amountAlreadyCharged = 0, invoiceSpend = 0 }) => {
        const netBudget = totalBudget * (1 - commissionRate / 100);
        let amount = 0;
        const denominator = 100 - serviceFeeRate - commissionRate; // Denominator for grossing up
        if (denominator > 0) {
             // Gross up spend to find gross client cost, then take net portion
            amount = (invoiceSpend * 100 / denominator) * (1 - commissionRate / 100);
        } else {
            amount = Infinity;
        }
        amount = Math.min(amount, netBudget - amountAlreadyCharged);
        const value = Math.max(0,amount);
        return { value, formula: `Invoice is Net. Amount = min( (Spend / (100-Comm%-Serv%)) * (100-Comm%) , Net Budget - Already Charged). Result: ${value}` };
    }
  }
};

const HdNetInvoiceNetFeeLogic: PricingModelConfig = {
  ...HdGrossInvoiceGrossFeeLogic,
  id: 'HdNetInvoiceNetFee',
  name: 'HD Net Invoice Net Fee',
  description: 'Invoice based on net amount, service fee calculated on net budget (after commission).',
  calculations: {
    ...HdGrossInvoiceGrossFeeLogic.calculations,
    serviceFeeAmount: ({ totalBudget = 0, commissionRate = 0, serviceFeeRate = 0 }) => {
        const netBudgetAfterCommission = totalBudget * (1 - commissionRate / 100);
        const value = (netBudgetAfterCommission * serviceFeeRate) / 100;
        return { value, formula: `(Total Budget * (1 - Commission Rate / 100)) * Service Fee Rate / 100. Result: ${value}`};
    },
    targetDelivery: ({ totalBudget = 0, commissionRate = 0, serviceFeeRate = 0 }) => {
      const netBudgetAfterCommission = totalBudget * (1 - commissionRate / 100);
      const serviceFeeAmount = (netBudgetAfterCommission * serviceFeeRate) / 100; // Service fee on net
      const value = netBudgetAfterCommission - serviceFeeAmount;
      return { value, formula: `Net Budget After Commission - Service Fee (on Net Budget). Result: ${value}` };
    },
    clientSpend: ({ actualMediaSpend = 0, commissionRate = 0, serviceFeeRate = 0, totalBudget = 0 }) => {
      let clientSpend = 0;
      const netFactor = (1 - commissionRate/100) * (1 - serviceFeeRate/100);
      if (netFactor > 0) {
        clientSpend = actualMediaSpend / netFactor;
      } else {
        clientSpend = Infinity;
      }
      const value = Math.min(totalBudget, clientSpend);
      return { value, formula: `Media Spend / ((1 - Commission Rate%) * (1 - Service Fee Rate% on Net)) , capped by Total Budget. Result: ${value}` };
    },
    netBudget: ({ totalBudget = 0, commissionRate = 0, actualMediaSpend = 0, serviceFeeRate = 0 }) => {
        const netBudgetAfterCommission = totalBudget * (1 - commissionRate / 100);
        const serviceFeeOnNet = (netBudgetAfterCommission * serviceFeeRate) / 100;
        const bookedNetMediaSpend = netBudgetAfterCommission - serviceFeeOnNet;
        let value;
        if (actualMediaSpend <= bookedNetMediaSpend) {
             value = actualMediaSpend * 100 / (100 - serviceFeeRate); // Net spend before service fee (which was on net)
        } else {
            value = netBudgetAfterCommission;
        }
        return { value, formula: `If Media Spend <= Booked Net Media Spend: Media Spend / (1-Service Fee% on Net). Else: Total Budget * (1-Commission Rate%). Result: ${value}` };
    },
    invoiceAmount: ({ totalBudget = 0, commissionRate = 0, serviceFeeRate = 0, amountAlreadyCharged = 0, invoiceSpend = 0 }) => {
        const netBudget = totalBudget * (1 - commissionRate / 100);
        let amount = 0;
        if ((100 - serviceFeeRate) > 0) {
            amount = (invoiceSpend * 100) / (100 - serviceFeeRate); // Spend grossed up for service fee (on net)
        } else {
            amount = Infinity;
        }
        amount = Math.min(amount, netBudget - amountAlreadyCharged);
        const value = Math.max(0,amount);
        return { value, formula: `Invoice is Net. Amount = min( (Spend / (1-Serv% on Net)) , Net Budget - Already Charged). Result: ${value}` };
    }
  }
};

const JobServiceLogic: PricingModelConfig = {
  id: 'JobService',
  name: 'Job Service',
  description: 'Budget spread evenly over duration. Service fee on (Budget - Commission).',
  inputs: [
    { name: 'totalBudget', label: 'Total Budget ($)', type: 'number', default: 5000 },
    { name: 'commissionRate', label: 'Agency Commission (%)', type: 'number', default: 0, min:0, max:99.99 },
    { name: 'serviceFeeRate', label: 'Service Fee (%) on Net', type: 'number', default: 20, min:0, max:100 },
    { name: 'totalDaysInPlacement', label: 'Total Days in Placement', type: 'number', default: 30 },
    { name: 'daysElapsedInDateRange', label: 'Days Elapsed in Billing Period', type: 'number', default: 30 },
  ],
  calculations: {
    targetDelivery: ({ totalBudget = 0, commissionRate = 0, serviceFeeRate = 0 }) => {
      const value = (totalBudget * (1 - commissionRate / 100) * (1 - serviceFeeRate / 100));
      return { value, formula: `Total Budget * (1 - Commission Rate / 100) * (1 - Service Fee Rate / 100). Result: ${value}` };
    },
    actualDelivery: ({ clientSpend, serviceFeeRate = 0, commissionRate = 0 }) => {
        const netBudgetAfterCommission = (clientSpend?.value as number || 0) * (1 - commissionRate/100);
        const serviceFeeAmount = netBudgetAfterCommission * (serviceFeeRate/100);
        const value = netBudgetAfterCommission - serviceFeeAmount;
        return { value, formula: "Client Spend * (1-Comm%) * (1-ServFee% on Net). Result: " + value };
    },
    clientSpend: ({ totalBudget = 0, totalDaysInPlacement = 0, daysElapsedInDateRange = 0 }) => {
      if (totalDaysInPlacement <= 0) return { value: 0, formula: "Total Days must be > 0." };
      const dailyBill = totalBudget / totalDaysInPlacement;
      const value = Math.min(totalBudget, dailyBill * daysElapsedInDateRange);
      return { value, formula: `min(Total Budget, (Total Budget / Total Days) * Days Elapsed). Result: ${value}` };
    },
    mediaSpend: ({ clientSpend, serviceFeeRate = 0 }) => {
      const value = (clientSpend?.value as number || 0) * (1 - serviceFeeRate / 100);
      return { value, formula: `Client Spend * (1 - Service Fee Rate / 100). Result: ${value}` };
    },
    netBudget: ({ totalBudget = 0, serviceFeeRate = 0, commissionRate = 0 }) => {
      const value = (totalBudget * (1 - commissionRate/100)) * (1 - serviceFeeRate / 100);
      return { value, formula: `(Total Budget * (1 - Commission Rate %)) * (1 - Service Fee Rate / 100). Result: ${value}` };
    },
    toDateBudget: ({ clientSpend }) => {
        return { value: (clientSpend?.value as number || 0), formula: "Calculated Client Spend for the period." };
    },
    invoiceAmount: () => {
      return { value: 'N/A', formula: "Job model does not support invoice amount calculation via this method in the source." };
    }
  }
};

const ManagedServiceLogic: PricingModelConfig = {
  id: 'ManagedService',
  name: 'Managed Service',
  description: 'Service fee on (Budget - Commission). Client spend derived from media spend + fees.',
  inputs: [
    { name: 'totalBudget', label: 'Total Budget ($)', type: 'number', default: 10000 },
    { name: 'commissionRate', label: 'Agency Commission (%)', type: 'number', default: 10, min:0, max:99.99 },
    { name: 'serviceFeeRate', label: 'Service Fee (%) on Net', type: 'number', default: 20, min:0, max:100 },
    { name: 'actualMediaSpend', label: 'Actual Media Spend ($)', type: 'number', default: 6000 },
    { name: 'invoiceSpend', label: 'Spend for Invoice Calc. ($)', type: 'number', default: 6000 },
    { name: 'amountAlreadyCharged', label: 'Amount Already Charged ($)', type: 'number', default: 0 },
  ],
  calculations: {
    targetDelivery: ({ totalBudget = 0, commissionRate = 0, serviceFeeRate = 0 }) => {
      const value = (totalBudget * (1 - commissionRate / 100) * (1 - serviceFeeRate / 100));
      return { value, formula: `Total Budget * (1 - Commission Rate / 100) * (1 - Service Fee Rate / 100). Result: ${value}` };
    },
    actualDelivery: ({ actualMediaSpend = 0 }) => {
       return { value: actualMediaSpend, formula: "Actual Media Spend (if not pacing from ad server)." };
    },
    clientSpend: ({ actualMediaSpend = 0, commissionRate = 0, serviceFeeRate = 0, totalBudget = 0 }) => {
      let clientSpend = 0;
      const serviceFeeAmount = (actualMediaSpend * serviceFeeRate) / (100 - serviceFeeRate); // Service fee on (MediaSpend / (1-ServFee%))
      let commissionAmount = 0;
      if (commissionRate > 0) {
        commissionAmount = ((actualMediaSpend + serviceFeeAmount) * commissionRate) / (100 - commissionRate);
      }
      clientSpend = actualMediaSpend + serviceFeeAmount + commissionAmount;
      const value = Math.min(totalBudget, clientSpend);
      return { value, formula: `Media Spend + Service Fee (on Media Spend/(1-ServFee%)) + Commission (on (MediaSpend+ServFeeAmt)/(1-Comm%)), capped by Total Budget. Result: ${value}` };
    },
    mediaSpend: ({ actualMediaSpend = 0 }) => {
      return { value: actualMediaSpend, formula: "User-provided 'Actual Media Spend'." };
    },
    netBudget: ({ totalBudget = 0, commissionRate = 0, actualMediaSpend = 0, serviceFeeRate = 0 }) => {
      const bookedBudget = (totalBudget * (1 - commissionRate/100) * (1 - serviceFeeRate/100)); // Target Delivery
      let value;
      if (actualMediaSpend <= bookedBudget) {
        value = actualMediaSpend * 100 / (100 - serviceFeeRate); // Net spend before service fee
      } else {
        value = totalBudget * (1 - commissionRate / 100); // Net budget after commission
      }
      return { value, formula: `If Media Spend <= Booked Net Media Spend: Media Spend / (1 - Service Fee %). Else: Total Budget * (1 - Commission Rate %). Result: ${value}` };
    },
    toDateBudget: () => ({ value: 'N/A', formula: "Complex, requires daily flight data and pacing logic." }),
    invoiceAmount: ({ totalBudget = 0, commissionRate = 0, serviceFeeRate = 0, amountAlreadyCharged = 0, invoiceSpend = 0 }) => {
        const netBudget = totalBudget * (1 - commissionRate / 100);
        let amount = 0;
        if ((100 - serviceFeeRate) > 0) {
            amount = (invoiceSpend * 100) / (100 - serviceFeeRate);
        } else {
            amount = Infinity;
        }
        amount = Math.min(amount, netBudget - amountAlreadyCharged);
        const value = Math.max(0,amount);
        return { value, formula: `min( (Invoice Spend * 100) / (100 - Service Fee% on Net) , Net Budget - Already Charged). Result: ${value}` };
    }
  }
};

const MediaServiceLogic: PricingModelConfig = {
  id: 'MediaService',
  name: 'Media Service',
  description: 'Service fee and commission applied directly on top of media spend.',
   inputs: [
    { name: 'totalBudget', label: 'Total Budget ($)', type: 'number', default: 10000 },
    { name: 'commissionRate', label: 'Agency Commission (%) on Media Spend', type: 'number', default: 5, min:0, max:99.99 },
    { name: 'serviceFeeRate', label: 'Service Fee (%) on Media Spend', type: 'number', default: 10, min:0, max:100 },
    { name: 'actualMediaSpend', label: 'Actual Media Spend ($)', type: 'number', default: 8000 },
    { name: 'invoiceSpend', label: 'Spend for Invoice Calc. ($)', type: 'number', default: 8000 },
    { name: 'amountAlreadyCharged', label: 'Amount Already Charged ($)', type: 'number', default: 0 },
  ],
  calculations: {
    targetDelivery: ({ totalBudget = 0 }) => {
      return { value: totalBudget, formula: "Total Budget (as fees are additive to media spend)." };
    },
    actualDelivery: ({ actualMediaSpend = 0 }) => {
       return { value: actualMediaSpend, formula: "Actual Media Spend (if not pacing from ad server)." };
    },
    clientSpend: ({ actualMediaSpend = 0, commissionRate = 0, serviceFeeRate = 0, totalBudget = 0 }) => {
      const cappedMediaSpend = Math.min(actualMediaSpend, totalBudget);
      const serviceFeeAmount = (cappedMediaSpend * serviceFeeRate) / 100;
      const commissionAmount = (cappedMediaSpend * commissionRate) / 100;
      const value = cappedMediaSpend + serviceFeeAmount + commissionAmount;
      return { value, formula: `min(Actual Media Spend, Total Budget) + Service Fee (on capped Media Spend) + Commission (on capped Media Spend). Result: ${value}` };
    },
    mediaSpend: ({ actualMediaSpend = 0 }) => {
      return { value: actualMediaSpend, formula: "User-provided 'Actual Media Spend'." };
    },
    netBudget: ({ actualMediaSpend = 0, totalBudget = 0 }) => {
      const bookedBudget = totalBudget;
      const value = Math.min(actualMediaSpend, bookedBudget);
      return { value, formula: `min(Actual Media Spend, Total Budget). Result: ${value}` };
    },
    toDateBudget: () => ({ value: 'N/A', formula: "Complex, requires daily flight data and pacing logic." }),
    invoiceAmount: ({ totalBudget = 0, commissionRate = 0, serviceFeeRate = 0, amountAlreadyCharged = 0, invoiceSpend = 0 }) => {
        const netBudgetAfterCommission = totalBudget * (1 - commissionRate / 100);
        const grossBudgetIncludingNetServiceFee = netBudgetAfterCommission * (100 + serviceFeeRate) / 100;
        
        let amount = (invoiceSpend * (100 + serviceFeeRate)) / 100; // Spend grossed up by service fee
        //This is tricky. The original code has a complex adjustment for amountAlreadyCharged.
        //Simplified: cap by available gross budget (media + service fee portion, after commission on media is considered)
        const availableGrossBudget = grossBudgetIncludingNetServiceFee - amountAlreadyCharged; // Approximation
        amount = Math.min(amount, availableGrossBudget);
        const value = Math.max(0,amount);
        return { value, formula: `min( (Invoice Spend * (1 + Service Fee %)), Gross Budget (incl. ServFee on Net after Comm) - Already Charged (adjusted) ). Result: ${value}` };
    }
  }
};

const NoFeeServiceLogic: PricingModelConfig = {
  ...ManagedServiceLogic, // Inherits from ManagedService
  id: 'NoFeeService',
  name: 'No Fee Service',
  description: 'Variation of Managed Service, typically with service fee set to zero.',
  inputs: ManagedServiceLogic.inputs.map(input => input.name === 'serviceFeeRate' ? {...input, default: 0, label: 'Service Fee (%) on Net (usually 0)'} : input),
};

const ProjectServiceLogic: PricingModelConfig = {
  ...JobServiceLogic, // Similar to JobService
  id: 'ProjectService',
  name: 'Project Service',
  description: 'For project-based work, budget spread over duration. Service fee on (Budget - Commission). isProject() is true.',
};


const PRICING_MODELS_CONFIG: PricingModelsConfigMap = {
  FixedMetricLogic,
  HdGrossInvoiceGrossFeeLogic,
  HdNetInvoiceGrossFeeLogic,
  HdNetInvoiceNetFeeLogic,
  JobServiceLogic,
  ManagedServiceLogic,
  MediaServiceLogic,
  NoFeeServiceLogic,
  ProjectServiceLogic,
};

const App: FC = () => {
  const [selectedModelKey, setSelectedModelKey] = useState<string>(Object.keys(PRICING_MODELS_CONFIG)[0]);
  const [inputs, setInputs] = useState<InputsState>({});
  const [outputs, setOutputs] = useState<OutputsState>({});

  const currentModel = PRICING_MODELS_CONFIG[selectedModelKey];

  useEffect(() => {
    const initialInputs: InputsState = {};
    currentModel.inputs.forEach(input => {
      initialInputs[input.name] = input.default;
    });
    setInputs(initialInputs);
    setOutputs({});
  }, [currentModel]);

  const handleInputChange = (name: string, value: string | number | boolean) => {
    let processedValue: string | number | boolean = value;
    const inputConfig = currentModel.inputs.find(i => i.name === name);

    if (inputConfig?.type === 'number') {
      processedValue = parseFloatOrZero(value as string | number);
      if (inputConfig.min !== undefined && processedValue < inputConfig.min) processedValue = inputConfig.min;
      if (inputConfig.max !== undefined && processedValue > inputConfig.max) processedValue = inputConfig.max;
    }
    // Boolean is handled by checkbox's checked state directly setting the new boolean value
    setInputs(prev => ({ ...prev, [name]: processedValue }));
  };

  const calculateOutputs = useCallback(() => {
    if (!currentModel) return;

    const calculated: OutputsState = {};
    const tempCalculatedValues: Partial<CalculationFunctionParams> = {};

    if (currentModel.calculations.clientSpend) {
        const csResult = currentModel.calculations.clientSpend(inputs);
        calculated.clientSpend = csResult;
        tempCalculatedValues.clientSpend = csResult;
    }
    
    if (currentModel.calculations.serviceFeeAmount) {
        const sfaResult = currentModel.calculations.serviceFeeAmount({...inputs, ...tempCalculatedValues});
        calculated.serviceFeeAmount = sfaResult;
        tempCalculatedValues.serviceFeeAmount = sfaResult;
    }

    for (const key in currentModel.calculations) {
      if (key !== 'clientSpend' && key !== 'serviceFeeAmount') {
        calculated[key] = currentModel.calculations[key]({...inputs, ...tempCalculatedValues});
         if (typeof calculated[key].value === 'number') {
            // Ensure tempCalculatedValues stores the plain value for dependent calcs
            tempCalculatedValues[key] = {value: calculated[key].value, formula: ''};
        }
      }
    }
    setOutputs(calculated);
  }, [inputs, currentModel]);

  useEffect(() => {
    calculateOutputs();
  }, [inputs, calculateOutputs]);


  if (!currentModel) return <p className="text-center text-red-500">Loading model...</p>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-100 p-4 md:p-8 flex flex-col items-center justify-center">
      <div className="container max-w-4xl mx-auto bg-white/90 shadow-2xl rounded-3xl border border-gray-200 backdrop-blur-md">
        <header className="bg-gradient-to-r from-blue-700 via-blue-500 to-purple-500 text-white p-8 rounded-t-3xl shadow-md flex flex-col items-center">
          <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight drop-shadow-lg mb-2">Pricing Model Calculator</h1>
          <span className="text-lg font-medium opacity-80">Rubii Ltd.</span>
        </header>

        <div className="p-6 md:p-10">
          <div className="mb-10">
            <label htmlFor="model-select" className="block text-lg font-semibold text-gray-700 mb-3">Select Pricing Model:</label>
            <select
              id="model-select"
              value={selectedModelKey}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setSelectedModelKey(e.target.value)}
              className="w-full p-3 border-2 border-blue-200 rounded-xl shadow-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-lg transition-all bg-white hover:border-blue-400"
            >
              {Object.keys(PRICING_MODELS_CONFIG).map(key => (
                <option key={key} value={key}>{PRICING_MODELS_CONFIG[key].name}</option>
              ))}
            </select>
            <p className="mt-3 text-base text-gray-500 italic">{currentModel.description}</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
            <div className="bg-white/80 p-8 rounded-2xl border border-gray-200 shadow-md">
              <h2 className="text-2xl font-bold text-blue-700 mb-6 flex items-center gap-2"><span className="inline-block w-2 h-2 bg-blue-400 rounded-full animate-pulse"></span> Inputs</h2>
              {currentModel.inputs.map(input => (
                <div key={input.name} className="mb-6">
                  <label htmlFor={input.name} className="block text-base font-medium text-gray-700 mb-2">{input.label}:</label>
                  {input.type === 'number' && (
                    <input
                      type="number"
                      id={input.name}
                      name={input.name}
                      value={inputs[input.name] as number || ''}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => handleInputChange(input.name, e.target.value)}
                      min={input.min}
                      max={input.max}
                      step={input.name.toLowerCase().includes('rate') ? "0.01" : "1"}
                      className="w-full p-3 border-2 border-gray-200 rounded-lg shadow-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-lg transition-all bg-gray-50 hover:border-blue-400"
                    />
                  )}
                  {input.type === 'select' && (
                    <select
                      id={input.name}
                      name={input.name}
                      value={inputs[input.name] as string || ''}
                      onChange={(e: ChangeEvent<HTMLSelectElement>) => handleInputChange(input.name, e.target.value)}
                      className="w-full p-3 border-2 border-gray-200 rounded-lg shadow-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400 text-lg transition-all bg-gray-50 hover:border-blue-400"
                    >
                      {input.options?.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  )}
                  {input.type === 'boolean' && (
                    <label className="flex items-center space-x-3 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        id={input.name}
                        name={input.name}
                        checked={!!inputs[input.name]}
                        onChange={() => handleInputChange(input.name, !inputs[input.name])}
                        className="h-5 w-5 text-blue-600 border-gray-300 rounded focus:ring-blue-500 transition-all"
                      />
                       <span className="text-base text-gray-700">{inputs[input.name] ? 'Yes' : 'No'}</span>
                    </label>
                  )}
                </div>
              ))}
            </div>

            <div className="bg-gradient-to-br from-blue-50 via-white to-purple-100 p-8 rounded-2xl border border-gray-200 shadow-md">
              <h2 className="text-2xl font-bold text-purple-700 mb-6 flex items-center gap-2"><span className="inline-block w-2 h-2 bg-purple-400 rounded-full animate-pulse"></span> Calculated Outputs</h2>
              {Object.entries(outputs).map(([key, result]) => (
                <div key={key} className="mb-6 p-4 border border-gray-200 rounded-xl bg-white/90 shadow-sm hover:shadow-lg transition-all">
                  <h3 className="text-md font-semibold text-blue-700 capitalize mb-1 tracking-wide">{key.replace(/([A-Z])/g, ' $1')}:</h3>
                  <p className="text-2xl font-extrabold text-gray-900">
                    {typeof result.value === 'number' ? result.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : result.value}
                  </p>
                  <p className="text-xs text-gray-500 mt-2">
                    <span className="font-semibold">Calculation:</span> {result.formula}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
