import React, { createContext, useState, useCallback, useEffect } from "react";
import {
  MarketTick,
  PriceData,
  FundingData,
  BasisData,
  LiquidityData,
  ConfidenceData,
} from "../types";

export interface MarketDataContextType {
  prices: PriceData;
  setPrices: (prices: PriceData) => void;
  funding: FundingData;
  setFunding: (funding: FundingData) => void;
  basis: BasisData;
  setBasis: (basis: BasisData) => void;
  liquidity: LiquidityData;
  setLiquidity: (liquidity: LiquidityData) => void;
  conf: ConfidenceData;
  setConf: (conf: ConfidenceData) => void;
  pythOn: boolean;
  setPythOn: (on: boolean) => void;
  pythTime: string | null;
  setPythTime: (time: string | null) => void;
}

export const MarketDataContext = createContext<MarketDataContextType | undefined>(
  undefined
);

export const MarketDataProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [prices, setPrices] = useState<PriceData>({
    BTC: 68450,
    ETH: 3515,
    SOL: 148,
    JTO: 3.2,
  });
  const [funding, setFunding] = useState<FundingData>({
    BTC: 0.000135,
    ETH: 0.000092,
    SOL: 0.00018,
    JTO: 0.000245,
  });
  const [basis, setBasis] = useState<BasisData>({
    BTC: 0.0074,
    ETH: 0.0058,
    SOL: 0.0045,
    JTO: 0.0062,
  });
  const [liquidity, setLiquidity] = useState<LiquidityData>({
    BTC: 12.4e6,
    ETH: 6.1e6,
    SOL: 4.2e6,
    JTO: 1.1e6,
  });
  const [conf, setConf] = useState<ConfidenceData>({
    BTC: 0,
    ETH: 0,
    SOL: 0,
    JTO: 0,
  });
  const [pythOn, setPythOn] = useState(false);
  const [pythTime, setPythTime] = useState<string | null>(null);

  const value: MarketDataContextType = {
    prices,
    setPrices,
    funding,
    setFunding,
    basis,
    setBasis,
    liquidity,
    setLiquidity,
    conf,
    setConf,
    pythOn,
    setPythOn,
    pythTime,
    setPythTime,
  };

  return (
    <MarketDataContext.Provider value={value}>
      {children}
    </MarketDataContext.Provider>
  );
};

export const useMarketDataContext = () => {
  const context = React.useContext(MarketDataContext);
  if (!context) {
    throw new Error(
      "useMarketDataContext must be used within MarketDataProvider"
    );
  }
  return context;
};
