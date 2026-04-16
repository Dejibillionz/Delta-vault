import React, { createContext, useState } from "react";

export const MarketDataContext = createContext(undefined);

export const MarketDataProvider = ({ children }) => {
  const [prices, setPrices] = useState({
    BTC: 68450,
    ETH: 3515,
    SOL: 148,
    JTO: 3.2,
  });
  const [funding, setFunding] = useState({
    BTC: 0.000135,
    ETH: 0.000092,
    SOL: 0.00018,
    JTO: 0.000245,
  });
  const [basis, setBasis] = useState({
    BTC: 0.0074,
    ETH: 0.0058,
    SOL: 0.0045,
    JTO: 0.0062,
  });
  const [liquidity, setLiquidity] = useState({
    BTC: 12.4e6,
    ETH: 6.1e6,
    SOL: 4.2e6,
    JTO: 1.1e6,
  });
  const [conf, setConf] = useState({
    BTC: 0,
    ETH: 0,
    SOL: 0,
    JTO: 0,
  });
  const [pythOn, setPythOn] = useState(false);
  const [pythTime, setPythTime] = useState(null);

  const value = {
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
