export type Candle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type CandleSeries = {
  symbol: string;
  source: "mongodb" | "demo";
  candles: Candle[];
};

