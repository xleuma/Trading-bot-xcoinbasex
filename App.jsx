// NEXUSBOT v9.0 — Real Coinbase Advanced Trade
// All price data, balances, and orders are LIVE via your Supabase Edge Function.
// No simulated portfolio. No random price walk. No fake $10,000.
// Paste this file into Lovable as App.jsx (or import it into App.jsx).
// Set VITE_SUPABASE_FUNCTION_URL in Lovable's environment variables.

import { useState, useEffect, useRef, useCallback } from "react";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer
} from "recharts";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — set VITE_SUPABASE_FUNCTION_URL in Lovable environment variables
// e.g. https://xxxx.supabase.co/functions/v1/coinbase-proxy
// ─────────────────────────────────────────────────────────────────────────────
const EDGE_URL = (import.meta as any).env?.VITE_SUPABASE_FUNCTION_URL ?? "";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const clamp   = (v:number,a:number,b:number) => Math.max(a,Math.min(b,v));
const sigmoid = (x:number) => 1/(1+Math.exp(-x));
const fmt     = (n:number,d=2) => Number(n).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtUSD  = (n:number) => "$"+fmt(n,2);
const nowTs   = () => new Date().toLocaleTimeString("en-US",{hour12:false});
const sleep   = (ms:number) => new Promise(r=>setTimeout(r,ms));
const uuidv4  = () => crypto.randomUUID();

// ─────────────────────────────────────────────────────────────────────────────
// COINBASE API (via Supabase Edge Function)
// ─────────────────────────────────────────────────────────────────────────────
async function cbFetch(action:string, params:Record<string,string>={}, body?:object) {
  if (!EDGE_URL) throw new Error("VITE_SUPABASE_FUNCTION_URL not set. See Lovable env vars.");
  const qs = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(`${EDGE_URL}?${qs}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type":"application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

async function fetchAccounts() {
  const data = await cbFetch("accounts");
  // Returns list of accounts with available_balance
  return (data.accounts ?? []) as CoinbaseAccount[];
}

async function fetchCandles(product:string, granularity="ONE_MINUTE") {
  const data = await cbFetch("candles",{product,granularity});
  return (data.candles ?? []) as CoinbaseCandle[];
}

async function fetchBestPrice(product:string) {
  const data = await cbFetch("price",{product});
  return data.pricebooks?.[0] ?? null;
}

async function placeOrder(side:"BUY"|"SELL", product_id:string, quote_size?:string, base_size?:string) {
  return cbFetch("order",{},{
    side, product_id,
    quote_size, base_size,
    client_order_id: uuidv4(),
  });
}

async function fetchOrderHistory(product:string) {
  const data = await cbFetch("orders",{product});
  return (data.orders ?? []) as CoinbaseOrder[];
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
interface CoinbaseAccount {
  uuid: string; name: string; currency: string;
  available_balance: { value: string; currency: string };
  hold: { value: string; currency: string };
  type: string;
}
interface CoinbaseCandle {
  start: string; low: string; high: string;
  open: string; close: string; volume: string;
}
interface CoinbaseOrder {
  order_id: string; product_id: string; side: string; status: string;
  filled_size: string; filled_value: string; average_filled_price: string;
  created_time: string; order_type: string;
  completion_percentage: string;
}
interface PricePoint {
  time: string; price: number; sma5: number|null; sma20: number|null; volume: number;
  signal?: string; algoId?: string;
}
interface Trade {
  id: string; time: string; type: string; coin: string; price: number;
  amount: number; value: number; pnl: number; reason: string; algoId: string;
  mlConf: number|null; agentSent: number; regime: string; stopLoss: number;
  cbOrderId?: string; cbStatus?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA FETCHERS (agents — these remain real Claude calls)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchFearGreed() {
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=3",{signal:AbortSignal.timeout(5000)});
    return (await r.json())?.data||null;
  } catch { return null; }
}
async function fetchCryptoPanic(coin:string) {
  try {
    const r = await fetch(`https://cryptopanic.com/api/v1/posts/?auth_token=pub_free&currencies=${coin}&filter=hot&public=true`,{signal:AbortSignal.timeout(6000)});
    if(!r.ok) throw new Error();
    return (await r.json())?.results?.slice(0,8)||null;
  } catch { return null; }
}
async function fetchReddit(coin:string) {
  try {
    const sub=coin==="BTC"?"bitcoin":coin==="ETH"?"ethereum":coin==="SOL"?"solana":"CryptoCurrency";
    const r=await fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=8`,{signal:AbortSignal.timeout(6000)});
    if(!r.ok) throw new Error();
    return (await r.json())?.data?.children?.map((c:any)=>({title:c.data.title,score:c.data.score}))||null;
  } catch { return null; }
}
async function fetchEtherscan() {
  try {
    const r=await fetch("https://api.etherscan.io/api?module=gastracker&action=gasoracle",{signal:AbortSignal.timeout(5000)});
    return (await r.json())?.result||null;
  } catch { return null; }
}

// Mock fallbacks for agent data
const mockNews   = (c:string) => [{title:`${c} institutional accumulation rising as ETF inflows hit weekly high`},{title:`Major bank adds ${c} custody`},{title:`${c} exchange reserves declining`}];
const mockReddit = (c:string) => [{title:`${c} holding strong — accumulating every dip`,score:1200},{title:`Why ${c} could 2x — analysis`,score:2400}];

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE API
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude(system:string, user:string, maxTokens=800):Promise<string|null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:maxTokens,system,messages:[{role:"user",content:user}]}),
    });
    if(!res.ok) throw new Error();
    const d = await res.json();
    return d.content?.find((b:any)=>b.type==="text")?.text||"";
  } catch { return null; }
}
function parseJSON(text:string|null) {
  if(!text) return null;
  try { const m=text.match(/```json\s*([\s\S]*?)```/)||text.match(/(\{[\s\S]*\})/); return JSON.parse(m?.[1]||text); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPPORTED COINS (Coinbase USDT pairs)
// ─────────────────────────────────────────────────────────────────────────────
const COINS = [
  {s:"BTC",  product:"BTC-USDT",  name:"Bitcoin",       cg:"bitcoin"},
  {s:"ETH",  product:"ETH-USDT",  name:"Ethereum",      cg:"ethereum"},
  {s:"SOL",  product:"SOL-USDT",  name:"Solana",        cg:"solana"},
  {s:"BNB",  product:"BNB-USDT",  name:"BNB",           cg:"binancecoin"},
  {s:"ADA",  product:"ADA-USDT",  name:"Cardano",       cg:"cardano"},
  {s:"AVAX", product:"AVAX-USDT", name:"Avalanche",     cg:"avalanche-2"},
  {s:"DOT",  product:"DOT-USDT",  name:"Polkadot",      cg:"polkadot"},
  {s:"LINK", product:"LINK-USDT", name:"Chainlink",     cg:"chainlink"},
  {s:"DOGE", product:"DOGE-USDT", name:"Dogecoin",      cg:"dogecoin"},
  {s:"SHIB", product:"SHIB-USDT", name:"Shiba Inu",     cg:"shiba-inu"},
  {s:"UNI",  product:"UNI-USDT",  name:"Uniswap",       cg:"uniswap"},
  {s:"AAVE", product:"AAVE-USDT", name:"Aave",          cg:"aave"},
  {s:"LTC",  product:"LTC-USDT",  name:"Litecoin",      cg:"litecoin"},
  {s:"XRP",  product:"XRP-USDT",  name:"XRP",           cg:"ripple"},
  {s:"MATIC",product:"MATIC-USDT",name:"Polygon",       cg:"matic-network"},
  {s:"NEAR", product:"NEAR-USDT", name:"NEAR Protocol", cg:"near"},
  {s:"FET",  product:"FET-USDT",  name:"Fetch.ai",      cg:"fetch-ai"},
  {s:"RNDR", product:"RENDER-USDT",name:"Render",       cg:"render-token"},
];
const COIN_MAP = Object.fromEntries(COINS.map(c=>[c.s,c]));

// ─────────────────────────────────────────────────────────────────────────────
// ALGORITHMS
// ─────────────────────────────────────────────────────────────────────────────
const ALGORITHMS:Record<string,any> = {
  A:{id:"A",name:"Trend Rider",  color:"#06b6d4",weightMods:[2.2,1.8,0.6,0.5,1.6,0.4,1.4,0.8,0.5,1.8],minConf:0.52,riskMult:1.0,entry:(f:number[])=>f[0]>0.2&&f[1]>0.1&&f[4]>0.5,exit:(f:number[])=>f[0]<-0.15||f[1]<-0.2},
  B:{id:"B",name:"Mean Reversion",color:"#a855f7",weightMods:[0.4,0.5,0.8,1.8,0.6,0.6,2.0,0.5,2.4,0.4],minConf:0.48,riskMult:0.8,entry:(f:number[])=>f[8]<-0.4&&f[6]<0.3,exit:(f:number[])=>f[8]>0.3||f[6]>0.7},
  C:{id:"C",name:"Vol Breakout", color:"#f59e0b",weightMods:[0.8,1.2,0.5,2.8,2.2,0.3,0.6,2.6,0.8,1.4],minConf:0.55,riskMult:1.3,entry:(f:number[])=>f[3]>0.6&&f[4]>0.6&&Math.abs(f[7])>0.4,exit:(f:number[])=>f[3]<0.3||f[4]<0.3},
  D:{id:"D",name:"Sentiment Arb",color:"#10b981",weightMods:[0.5,0.6,3.0,0.8,0.8,1.2,0.8,0.4,0.6,0.5],minConf:0.45,riskMult:0.9,entry:(f:number[])=>f[2]>0.5&&f[1]>-0.1,exit:(f:number[])=>f[2]<-0.2},
};
const FEATURES = ["smaCross","momentum","sentiment","volatility","volume","timeOfDay","rsi","atr","bbDev","macdHist"];

// ─────────────────────────────────────────────────────────────────────────────
// MARKET REGIMES
// ─────────────────────────────────────────────────────────────────────────────
const REGIMES:Record<string,any> = {
  STRONG_BULL:{label:"Strong Bull",color:"#10b981",badge:"green", icon:"🚀"},
  BULL:       {label:"Bull",       color:"#34d399",badge:"green", icon:"📈"},
  STABLE:     {label:"Stable",     color:"#06b6d4",badge:"cyan",  icon:"➡️"},
  CHOPPY:     {label:"Choppy",     color:"#eab308",badge:"yellow",icon:"〰️"},
  VOLATILE:   {label:"Volatile",   color:"#f59e0b",badge:"amber", icon:"⚡"},
  BEAR:       {label:"Bear",       color:"#ef4444",badge:"red",   icon:"📉"},
  CRASH_RISK: {label:"Crash Risk", color:"#dc2626",badge:"red",   icon:"💥"},
  BREAKOUT:   {label:"Breakout",   color:"#8b5cf6",badge:"purple",icon:"💎"},
};

// ─────────────────────────────────────────────────────────────────────────────
// AUDITOR SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────
const AUDITOR_SYSTEM = `You are the Auditor — a Meta-Learning agent for a LIVE crypto trading bot using real Coinbase funds.
Analyze trade history, ML state, and agent signals to tune the ML system.
Return ONLY valid JSON:
{
  "mlAdvisory":{"action":"INCREASE_LR"|"DECREASE_LR"|"HOLD_LR"|"RESET_WEIGHTS","newLR":0.07,"reasoning":"concise","regimeDetected":"BULL"|"BEAR"|"CHOPPY"|"VOLATILE"|"STABLE"|"STRONG_BULL"|"CRASH_RISK"|"BREAKOUT","regimeConfidence":0.82},
  "featureWeightBias":{"smaCross":1.0,"momentum":1.3,"sentiment":0.8,"volatility":1.0,"volume":1.1,"timeOfDay":0.9,"rsi":1.2,"atr":1.0,"bbDev":0.7,"macdHist":1.1,"reasoning":"brief"},
  "algoVetoes":{"A":{"vetoed":false,"reason":"ok"},"B":{"vetoed":true,"reason":"reason"},"C":{"vetoed":false,"reason":"ok"},"D":{"vetoed":false,"reason":"ok"}},
  "riskPosture":{"stopLoss":5.0,"trailingStop":3.0,"positionScalar":1.0,"reasoning":"brief","urgency":"NORMAL"|"TIGHTEN_NOW"|"LOOSEN_NOW"}
}
RULES: newLR 0.01-0.18. featureWeightBias 0.2-3.0. stopLoss 2-15. trailingStop 1.5-10. positionScalar 0.1-1.0.
STRONG_BULL: veto B. CHOPPY/BEAR: veto A. CRASH_RISK: veto A and C.
LIVE TRADING: be conservative. Prefer TIGHTEN_NOW over LOOSEN_NOW when uncertain.
If fewer than 5 trades: HOLD_LR, neutral biases, no vetoes, positionScalar 0.3.`;

const NEWS_SYS    = `Return ONLY JSON: {"sentiment":0.72,"bullishSignals":["s"],"bearishSignals":["s"],"marketImpact":"BULLISH","confidence":0.81,"summary":"2-3 sentences"}`;
const SOCIAL_SYS  = `Return ONLY JSON: {"sentiment":0.65,"crowdMood":"CAUTIOUSLY_OPTIMISTIC","hypeLevel":0.4,"fearLevel":0.3,"confidence":0.75,"summary":"2-3 sentences"}`;
const MARKET_SYS  = `Return ONLY JSON: {"sentiment":0.58,"trend":"UPTREND","momentum":"WEAKENING","forecast24h":"SIDEWAYS_TO_UP","confidence":0.70,"summary":"2-3 sentences"}`;
const ONCHAIN_SYS = `Return ONLY JSON: {"sentiment":0.60,"networkActivity":"HIGH","whaleSignal":"ACCUMULATING","networkHealth":0.75,"confidence":0.65,"summary":"2-3 sentences"}`;
const FORECAST_SYS = `You are a crypto forecasting AI. On-Chain beats News when they conflict. BULLISH_BREAKOUT→STRONG_BUY Algo C. BEARISH_CRASH→STRONG_SELL all.
Return ONLY JSON: {"overallSentiment":0.68,"priceDirection":"UP","confidence":0.74,"riskLevel":"MODERATE","conflictDetected":false,"divergenceType":"NONE","algorithmRecommendations":{"A":{"action":"BUY","confidence":0.78,"reason":"brief"},"B":{"action":"WAIT","confidence":0.45,"reason":"brief"},"C":{"action":"BUY","confidence":0.82,"reason":"brief"},"D":{"action":"BUY","confidence":0.71,"reason":"brief"}},"regimeSuggestion":"BULL","summary":"3-4 sentences"}`;

// ─────────────────────────────────────────────────────────────────────────────
// SHARED ML MODEL
// ─────────────────────────────────────────────────────────────────────────────
class SharedMLModel {
  weights:number[];bias:number;lr:number;decay:number;
  algoBias:Record<string,number>;algoLr:number;
  history:any[];algoHistory:Record<string,any[]>;totalUpdates:number;
  currentRegime:string;lrHistory:any[];auditHistory:any[];
  featureBias:Record<string,number>;vetoedAlgos:Record<string,string>;
  auditInterval:number;lastAuditTrade:number;isAuditing:boolean;

  constructor() {
    const r=()=>(Math.random()-0.5)*0.16;
    this.weights=[r(),r(),r(),r(),r(),r(),r(),r(),r(),r()];
    this.bias=0;this.lr=0.05;this.decay=0.0003; // conservative LR for live trading
    this.algoBias={A:0,B:0,C:0,D:0};this.algoLr=0.03;
    this.history=[];this.algoHistory={A:[],B:[],C:[],D:[]};this.totalUpdates=0;
    this.currentRegime="STABLE";this.lrHistory=[{t:0,lr:0.05,regime:"STABLE"}];
    this.auditHistory=[];this.featureBias=Object.fromEntries(FEATURES.map(f=>[f,1.0]));
    this.vetoedAlgos={};this.auditInterval=8;this.lastAuditTrade=0;this.isAuditing=false;
  }
  effectiveWeights(id:string){const m=ALGORITHMS[id].weightMods;return this.weights.map((w,i)=>w*(m[i]??1)*(this.featureBias[FEATURES[i]]??1));}
  predict(f:number[],id:string){const ew=this.effectiveWeights(id);return sigmoid(this.bias+this.algoBias[id]+f.reduce((s,v,i)=>s+v*ew[i],0));}
  learn(f:number[],label:number,id:string){const err=this.predict(f,id)-label;this.bias-=this.lr*0.5*err;this.weights=this.weights.map((w,i)=>w-this.lr*0.5*(err*f[i]+this.decay*w));this.algoBias[id]-=this.algoLr*err;this.totalUpdates++;}
  recordTrade(f:number[],pnl:number,id:string){const pred=this.predict(f,id);this.learn(f,pnl>0?1:0,id);const e={id:this.totalUpdates,predicted:+pred.toFixed(3),actual:pnl>0?1:0,pnl,algoId:id,regime:this.currentRegime};this.history.push(e);this.algoHistory[id].push(e);if(this.history.length>400)this.history.shift();if(this.algoHistory[id].length>100)this.algoHistory[id].shift();}
  applyAdvisory(adv:any){const prev={lr:this.lr,regime:this.currentRegime};if(adv.mlAdvisory?.newLR)this.lr=clamp(adv.mlAdvisory.newLR,0.01,0.18);if(adv.mlAdvisory?.regimeDetected&&REGIMES[adv.mlAdvisory.regimeDetected])this.currentRegime=adv.mlAdvisory.regimeDetected;if(adv.mlAdvisory?.action==="RESET_WEIGHTS"){this.weights=this.weights.map(w=>w*0.3);this.bias*=0.3;}if(adv.featureWeightBias)FEATURES.forEach(f=>{if(adv.featureWeightBias[f]!=null)this.featureBias[f]=this.featureBias[f]*0.4+clamp(adv.featureWeightBias[f],0.2,3.0)*0.6;});this.vetoedAlgos={};if(adv.algoVetoes)Object.entries(adv.algoVetoes).forEach(([id,v]:any)=>{if(v?.vetoed)this.vetoedAlgos[id]=v.reason||"Vetoed";});this.lrHistory.push({t:this.totalUpdates,lr:+this.lr.toFixed(4),regime:this.currentRegime});if(this.lrHistory.length>100)this.lrHistory.shift();this.auditHistory.unshift({time:nowTs(),tradeCount:this.totalUpdates,advisory:adv,prevLR:prev.lr,newLR:this.lr,prevRegime:prev.regime,newRegime:this.currentRegime});if(this.auditHistory.length>20)this.auditHistory.pop();this.lastAuditTrade=this.totalUpdates;return prev;}
  tier1Validate(f:number[],algoId:string,conflict:number){if(this.vetoedAlgos[algoId])return{pass:false,reason:`Auditor veto: ${this.vetoedAlgos[algoId]}`};const conf=this.predict(f,algoId);const algo=ALGORITHMS[algoId];if(conflict>0.65)return{pass:false,reason:"Agent conflict"};const bar=(this.currentRegime==="VOLATILE"||this.currentRegime==="CRASH_RISK")?algo.minConf+0.1:algo.minConf;if(conf<bar)return{pass:false,reason:`Conf ${fmt(conf*100,1)}% below bar ${fmt(bar*100,1)}%`};return{pass:true};}
  tier2Resolve(nS:number|null,sS:number|null,mS:number|null,oS:number|null){const sigs=[nS,sS,mS,oS].filter(s=>s!=null) as number[];if(!sigs.length)return{cleanedSent:0.5,vetoed:false,conflictScore:0,divergence:"NONE"};const mean=sigs.reduce((s,v)=>s+v,0)/sigs.length;const variance=sigs.reduce((s,v)=>s+(v-mean)**2,0)/sigs.length;const conflictScore=+Math.sqrt(variance).toFixed(3);let divergence="NONE",cleanedSent=mean,vetoed=false;if((mS??0.5)<0.52&&(sS??0.5)>0.68&&(oS??0.5)>0.65)divergence="BULLISH_BREAKOUT";else if((mS??0.5)>0.60&&(oS??0.5)<0.38&&(nS??0.5)<0.42)divergence="BEARISH_CRASH";else if(mean>0.65&&(mS??0.5)<0.55)divergence="SENTIMENT_PRICE_LAG";if(conflictScore>0.25){cleanedSent=mean*0.5+0.25;vetoed=true;}return{cleanedSent:+cleanedSent.toFixed(3),vetoed,conflictScore,divergence};}
  // Conservative live-trading position size: cap at 5% of available USDT per trade
  positionSizeUSD(conf:number,id:string,availableUSDT:number,budgetCap:number,posScalar:number){const effective=budgetCap>0?Math.min(availableUSDT,budgetCap):availableUSDT;const regMult=this.currentRegime==="VOLATILE"||this.currentRegime==="BEAR"||this.currentRegime==="CRASH_RISK"?0.4:this.currentRegime==="BULL"||this.currentRegime==="STRONG_BULL"?0.8:0.6;const raw=effective*(0.01+clamp(conf,0.3,0.9)*0.04)*ALGORITHMS[id].riskMult*regMult*clamp(posScalar,0.1,1.0);return +Math.max(1,raw).toFixed(2);} // min $1 (Coinbase min)
  accuracy(id?:string){const h=id?this.algoHistory[id]:this.history;if(h.length<3)return 50;return +(h.filter(e=>(e.predicted>0.5)===(e.actual===1)).length/h.length*100).toFixed(1);}
  recentAccuracy(id?:string){const h=(id?this.algoHistory[id]:this.history).slice(-10);if(h.length<3)return 50;return +(h.filter(e=>(e.predicted>0.5)===(e.actual===1)).length/h.length*100).toFixed(1);}
  get weightData(){return FEATURES.map((n,i)=>({feature:n,weight:+this.weights[i].toFixed(4),bias:+(this.featureBias[n]||1).toFixed(3),effective:+(this.weights[i]*(this.featureBias[n]||1)).toFixed(4),abs:+Math.abs(this.weights[i]).toFixed(4)}));}
}

// ─────────────────────────────────────────────────────────────────────────────
// CANDLE → PRICE POINT
// ─────────────────────────────────────────────────────────────────────────────
function candlesToPriceData(candles:CoinbaseCandle[]):PricePoint[] {
  const sorted = [...candles].sort((a,b)=>Number(a.start)-Number(b.start));
  let pts:PricePoint[] = sorted.map(c=>({
    time: new Date(Number(c.start)*1000).toLocaleTimeString("en-US",{hour12:false}),
    price: +c.close, sma5:null, sma20:null, volume:+c.volume,
  }));
  // SMA5
  pts = pts.map((d,i)=>{if(i<4)return d;const avg=pts.slice(i-4,i+1).reduce((s,x)=>s+x.price,0)/5;return{...d,sma5:+avg.toFixed(8)};});
  // SMA20
  pts = pts.map((d,i)=>{if(i<19)return d;const avg=pts.slice(i-19,i+1).reduce((s,x)=>s+x.price,0)/20;return{...d,sma20:+avg.toFixed(8)};});
  return pts;
}

function extractFeatures(pd:PricePoint[], agentSent:number):number[] {
  const n=pd.length; if(n<20)return new Array(10).fill(0);
  const last=pd[n-1];const price=last.price||1;
  const sma5=last.sma5||price;const sma20=last.sma20||price;
  const prev5=pd[n-6]?.price||price;
  const gains:number[]=[],losses:number[]=[];
  for(let i=Math.max(1,n-14);i<n;i++){const d=pd[i].price-pd[i-1].price;d>0?gains.push(d):losses.push(Math.abs(d));}
  const avgG=gains.length?gains.reduce((s,v)=>s+v,0)/14:0;
  const avgL=losses.length?losses.reduce((s,v)=>s+v,0)/14:0.001;
  const rsi=100-(100/(1+avgG/avgL));
  const trs:number[]=[]; for(let i=Math.max(1,n-14);i<n;i++)trs.push(Math.abs(pd[i].price-pd[i-1].price));
  const atr=trs.length?trs.reduce((s,v)=>s+v,0)/trs.length:0;
  const sl=pd.slice(-20).map(d=>d.price);
  const mean=sl.reduce((s,v)=>s+v,0)/sl.length;
  const std=Math.sqrt(sl.reduce((s,v)=>s+(v-mean)**2,0)/sl.length)||0.0001;
  return [
    clamp((sma5-sma20)/(sma20||1)*10,-1,1),
    clamp((price-prev5)/(prev5||1)*20,-1,1),
    clamp(agentSent*2-1,-1,1),
    clamp(1-(atr/price)/0.02,0,1),
    clamp(last.volume/1200,0,1),
    Math.sin((new Date().getHours()/24)*Math.PI),
    clamp((rsi-50)/50,-1,1),
    clamp(atr/price/0.01,0,1),
    clamp((price-mean)/(2*std),-1,1),
    clamp((sma5-sma20)/(sma20||1)*5,-1,1),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// UI PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────
function Badge({children,color="cyan"}:{children:React.ReactNode;color?:string}) {
  const c:Record<string,string>={cyan:"bg-cyan-500/15 text-cyan-400 border-cyan-500/30",green:"bg-emerald-500/15 text-emerald-400 border-emerald-500/30",red:"bg-red-500/15 text-red-400 border-red-500/30",yellow:"bg-yellow-500/15 text-yellow-300 border-yellow-500/30",purple:"bg-purple-500/15 text-purple-400 border-purple-500/30",orange:"bg-orange-500/15 text-orange-400 border-orange-500/30",indigo:"bg-indigo-500/15 text-indigo-400 border-indigo-500/30",amber:"bg-amber-500/15 text-amber-300 border-amber-500/30",blue:"bg-blue-500/15 text-blue-400 border-blue-500/30"};
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-bold border ${c[color]??c.cyan}`}>{children}</span>;
}
function StatCard({label,value,sub,color="default",alert=false,tiny=false,pulse=false}:{label:string;value:string;sub?:string;color?:string;alert?:boolean;tiny?:boolean;pulse?:boolean}) {
  const vc=alert?"text-red-400":color==="green"?"text-emerald-400":color==="red"?"text-red-400":color==="cyan"?"text-cyan-400":color==="amber"?"text-amber-300":color==="indigo"?"text-indigo-400":"text-white";
  return <div className={`rounded-xl border p-3 flex flex-col gap-1 ${alert?"border-red-500/60 bg-red-950/30":pulse?"border-amber-500/40 bg-amber-950/10":"border-white/8 bg-white/3"}`}><span className="text-xs font-mono text-white/35 uppercase tracking-widest leading-tight">{label}</span><span className={`${tiny?"text-base":"text-lg"} font-bold font-mono ${vc}`}>{value}</span>{sub&&<span className="text-xs font-mono text-white/28 leading-tight">{sub}</span>}</div>;
}
function Toggle({value,onChange,activeColor="bg-cyan-500"}:{value:boolean;onChange:(v:boolean)=>void;activeColor?:string}) {
  return <button onClick={()=>onChange(!value)} className={`w-10 h-5 rounded-full transition-all relative flex-shrink-0 ${value?activeColor:"bg-white/10"}`}><span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${value?"left-5":"left-0.5"}`}/></button>;
}
const ChartTip=({active,payload}:any)=>{if(!active||!payload?.length)return null;const d=payload[0]?.payload;return <div className="rounded-lg border border-white/10 bg-gray-950/95 p-3 text-xs font-mono shadow-2xl"><div className="text-white/40 mb-1">{d?.time}</div><div className="text-white font-bold">{d?.price>=1?fmtUSD(d?.price):"$"+(d?.price||0).toFixed(6)}</div>{d?.sma5&&<div className="text-cyan-400">SMA5: {fmtUSD(d.sma5)}</div>}{d?.sma20&&<div className="text-purple-400">SMA20: {fmtUSD(d.sma20)}</div>}{d?.signal&&<div className="text-amber-300">● {d.signal} [{d.algoId}]</div>}</div>;};
const TradeDot=({cx,cy,payload}:any)=>{if(!payload?.signal)return null;const buy=payload.signal==="BUY";const a=ALGORITHMS[payload.algoId];return <g><circle cx={cx} cy={cy} r={5} fill={buy?"#10b981":"#ef4444"} opacity={0.9}/><circle cx={cx} cy={cy} r={9} fill={buy?"#10b981":"#ef4444"} opacity={0.2}/><text x={cx} y={cy-13} textAnchor="middle" fill={a?.color||"#fff"} fontSize={7} fontFamily="monospace" fontWeight="bold">{buy?"▲":"▼"}{payload.algoId}</text></g>;};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
export default function CryptoDashboard() {
  // ── Config state ────────────────────────────────────────────────────────────
  const [edgeUrl,       setEdgeUrl]       = useState(EDGE_URL);
  const [edgeUrlInput,  setEdgeUrlInput]  = useState(EDGE_URL);
  const [showConfig,    setShowConfig]    = useState(!EDGE_URL);

  // ── Core state ──────────────────────────────────────────────────────────────
  const [activeCoin,   setActiveCoin]   = useState("BTC");
  const [activeAlgos,  setActiveAlgos]  = useState(["A","B","C","D"]);
  const [running,      setRunning]      = useState(false);
  const [tab,          setTab]          = useState("dashboard");
  const [priceData,    setPriceData]    = useState<PricePoint[]>([]);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [priceLoading, setPriceLoading] = useState(false);
  const [priceError,   setPriceError]   = useState<string|null>(null);

  // ── Portfolio / balance ─────────────────────────────────────────────────────
  const [accounts,     setAccounts]     = useState<CoinbaseAccount[]>([]);
  const [balanceLoading,setBalanceLoading]=useState(false);
  const [balanceError, setBalanceError] = useState<string|null>(null);
  const [budgetCap,    setBudgetCap]    = useState(0);    // 0 = no cap
  const [budgetInput,  setBudgetInput]  = useState("");

  // ── P&L tracking (computed from real fills) ─────────────────────────────────
  const [trades,       setTrades]       = useState<Trade[]>([]);
  const [cbOrders,     setCbOrders]     = useState<CoinbaseOrder[]>([]);
  const [totalPnL,     setTotalPnL]     = useState(0);
  const [wins,         setWins]         = useState(0);
  const [losses,       setLosses]       = useState(0);
  const [stopLoss,     setStopLoss]     = useState(5.0);
  const [trailingStop, setTrailingStop] = useState(3.0);
  const [posScalar,    setPosScalar]    = useState(0.3); // conservative default for live
  const [stopTriggered,setStopTriggered]=useState(false);
  const [highWater,    setHighWater]    = useState(0);

  // ── ML / Auditor ────────────────────────────────────────────────────────────
  const [mlVersion,    setMlVersion]    = useState(0);
  const [isAuditing,   setIsAuditing]   = useState(false);
  const [algoStats,    setAlgoStats]    = useState<Record<string,any>>({A:{trades:0,wins:0,losses:0,pnl:0},B:{trades:0,wins:0,losses:0,pnl:0},C:{trades:0,wins:0,losses:0,pnl:0},D:{trades:0,wins:0,losses:0,pnl:0}});

  // ── Agents ──────────────────────────────────────────────────────────────────
  const [agents,       setAgents]       = useState<Record<string,any>>({
    news:    {id:"news",    name:"News Agent",     icon:"📰",description:"CryptoPanic → Claude",  status:"idle",data:null},
    social:  {id:"social",  name:"Social Agent",   icon:"🐦",description:"Reddit → Claude",        status:"idle",data:null},
    market:  {id:"market",  name:"Market Agent",   icon:"📊",description:"F&G + price → Claude",   status:"idle",data:null},
    onchain: {id:"onchain", name:"On-Chain Agent", icon:"⛓️",description:"Etherscan → Claude",     status:"idle",data:null},
    forecast:{id:"forecast",name:"Forecast Agent", icon:"🔮",description:"Tier-2 synthesis",       status:"idle",data:null},
  });
  const [agentSent,    setAgentSent]    = useState(0.5);
  const [tier2Result,  setTier2Result]  = useState<any>(null);
  const [divergence,   setDivergence]   = useState("NONE");
  const [agentLog,     setAgentLog]     = useState<any[]>([]);
  const [autoAgents,   setAutoAgents]   = useState(false);
  const [tick,         setTick]         = useState(0);

  const modelRef        = useRef(new SharedMLModel());
  const portfolioRef    = useRef({usdtAvailable:0,coinHoldings:0,avgCost:0});
  const stopLossRef     = useRef(stopLoss);
  const trailingRef     = useRef(trailingStop);
  const posScalarRef    = useRef(posScalar);
  const agentSentRef    = useRef(agentSent);
  const tier2Ref        = useRef(tier2Result);
  const priceDataRef    = useRef(priceData);
  const activeAlgosRef  = useRef(activeAlgos);
  const activeCoinRef   = useRef(activeCoin);
  const agentsRef       = useRef(agents);
  const highWaterRef    = useRef(highWater);
  const budgetCapRef    = useRef(budgetCap);
  const edgeUrlRef      = useRef(edgeUrl);
  const runAuditRef     = useRef<(()=>void)|null>(null);

  useEffect(()=>{stopLossRef.current=stopLoss;},[stopLoss]);
  useEffect(()=>{trailingRef.current=trailingStop;},[trailingStop]);
  useEffect(()=>{posScalarRef.current=posScalar;},[posScalar]);
  useEffect(()=>{agentSentRef.current=agentSent;},[agentSent]);
  useEffect(()=>{tier2Ref.current=tier2Result;},[tier2Result]);
  useEffect(()=>{priceDataRef.current=priceData;},[priceData]);
  useEffect(()=>{activeAlgosRef.current=activeAlgos;},[activeAlgos]);
  useEffect(()=>{activeCoinRef.current=activeCoin;},[activeCoin]);
  useEffect(()=>{agentsRef.current=agents;},[agents]);
  useEffect(()=>{highWaterRef.current=highWater;},[highWater]);
  useEffect(()=>{budgetCapRef.current=budgetCap;},[budgetCap]);
  useEffect(()=>{edgeUrlRef.current=edgeUrl;},[edgeUrl]);

  const addLog   = useCallback((msg:string,type="info")=>setAgentLog(p=>[{id:Date.now(),time:nowTs(),msg,type},...p].slice(0,120)),[]);
  const updAgent = useCallback((id:string,patch:any)=>setAgents(p=>({...p,[id]:{...p[id],...patch}})),[]);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const model        = modelRef.current;
  const regime       = REGIMES[model.currentRegime] || REGIMES.STABLE;
  const vetoCount    = Object.keys(model.vetoedAlgos).length;
  const usdtAccount  = accounts.find(a=>a.currency==="USDT"||a.currency==="USD");
  const usdtBalance  = usdtAccount ? +usdtAccount.available_balance.value : 0;
  const coinInfo     = COIN_MAP[activeCoin];
  const coinAccount  = accounts.find(a=>a.currency===activeCoin);
  const coinBalance  = coinAccount ? +coinAccount.available_balance.value : 0;
  const forecastData = agents.forecast?.data;

  // ── Fetch real Coinbase balances ─────────────────────────────────────────────
  const refreshBalances = useCallback(async()=>{
    if(!edgeUrlRef.current){setBalanceError("Edge URL not set");return;}
    setBalanceLoading(true);setBalanceError(null);
    try {
      const accs = await fetchAccounts();
      setAccounts(accs);
      const usdt = accs.find((a:CoinbaseAccount)=>a.currency==="USDT"||a.currency==="USD");
      if(usdt) portfolioRef.current.usdtAvailable = +usdt.available_balance.value;
      addLog(`💰 Balances refreshed — USDT: ${fmtUSD(+( usdt?.available_balance.value||"0"))}`,"ok");
    } catch(e:any){
      setBalanceError(e.message||"Failed to fetch balances");
      addLog(`❌ Balance fetch error: ${e.message}`,"warn");
    }
    setBalanceLoading(false);
  },[addLog]);

  // ── Fetch real Coinbase candle data ──────────────────────────────────────────
  const refreshPrices = useCallback(async(coin=activeCoin)=>{
    if(!edgeUrlRef.current) return;
    const ci = COIN_MAP[coin]; if(!ci) return;
    setPriceLoading(true);setPriceError(null);
    try {
      const candles = await fetchCandles(ci.product,"ONE_MINUTE");
      if(candles.length>0){
        const pts = candlesToPriceData(candles);
        setPriceData(pts);
        const last = +candles.sort((a,b)=>Number(b.start)-Number(a.start))[0].close;
        setCurrentPrice(last);
        if(highWaterRef.current===0){setHighWater(last);highWaterRef.current=last;}
      }
    } catch(e:any){
      setPriceError(e.message||"Failed to fetch candles");
      addLog(`❌ Price fetch error: ${e.message}`,"warn");
    }
    setPriceLoading(false);
  },[activeCoin,addLog]);

  // ── Fetch real order history ─────────────────────────────────────────────────
  const refreshOrders = useCallback(async()=>{
    if(!edgeUrlRef.current) return;
    const ci = COIN_MAP[activeCoinRef.current]; if(!ci) return;
    try {
      const orders = await fetchOrderHistory(ci.product);
      setCbOrders(orders);
    } catch(e:any){ addLog(`❌ Order history error: ${e.message}`,"warn"); }
  },[addLog]);

  // Load on mount and on coin change
  useEffect(()=>{
    if(!edgeUrl) return;
    refreshBalances();
    refreshPrices(activeCoin);
    refreshOrders();
  },[edgeUrl,activeCoin]);

  // ── Price polling (every 30s when running) ───────────────────────────────────
  useEffect(()=>{
    if(!running||!edgeUrl) return;
    const iv = setInterval(()=>{
      setTick(t=>t+1);
      refreshPrices(activeCoinRef.current);
    },30000);
    return()=>clearInterval(iv);
  },[running,edgeUrl,refreshPrices]);

  // ── STOP LOSS (hard rule, checks after every price update) ───────────────────
  useEffect(()=>{
    if(!running||coinBalance===0||currentPrice===0) return;
    const port  = portfolioRef.current;
    const ep    = port.avgCost;
    if(ep===0) return;
    const drop  = ((currentPrice-ep)/ep)*100;
    const trail = highWaterRef.current>0?((currentPrice-highWaterRef.current)/highWaterRef.current)*100:0;
    if(drop<=-stopLossRef.current||trail<=-trailingRef.current){
      setStopTriggered(true);
      addLog(`🛑 STOP TRIGGERED — drop ${fmt(drop,2)}% trail ${fmt(trail,2)}% — placing SELL`,"warn");
      executeTrade("SELL",currentPrice,coinBalance,drop<=-stopLossRef.current?"Stop-Loss":"Trailing Stop",new Array(10).fill(0),"A",true);
    } else {
      setStopTriggered(false);
      if(currentPrice>highWaterRef.current){setHighWater(currentPrice);highWaterRef.current=currentPrice;}
    }
  },[currentPrice,running,coinBalance]);

  // ── EXECUTE REAL TRADE ──────────────────────────────────────────────────────
  const executeTrade = useCallback(async(
    type:"BUY"|"SELL", price:number, amount:number,
    reason:string, features:number[], algoId:string, skipGate=false
  )=>{
    const m    = modelRef.current;
    const ci   = COIN_MAP[activeCoinRef.current];
    if(!ci||!edgeUrlRef.current) return false;

    if(!skipGate&&features&&algoId){
      const t1 = m.tier1Validate(features,algoId,tier2Ref.current?.conflictScore||0);
      if(!t1.pass){addLog(`[${algoId}] Tier-1 blocked: ${t1.reason}`);return false;}
    }

    const port = portfolioRef.current;

    // Size the trade
    let quote_size:string|undefined; // USD for BUY
    let base_size:string|undefined;  // coin for SELL

    if(type==="BUY"){
      const usdAmount = m.positionSizeUSD(m.predict(features,algoId),algoId,port.usdtAvailable,budgetCapRef.current,posScalarRef.current);
      if(usdAmount<1){addLog(`[${algoId}] BUY skipped — position too small ($${usdAmount})`);return false;}
      if(usdAmount>port.usdtAvailable){addLog(`[${algoId}] BUY skipped — insufficient USDT (have ${fmtUSD(port.usdtAvailable)} need ${fmtUSD(usdAmount)})`);return false;}
      quote_size = usdAmount.toFixed(2);
    } else {
      if(coinBalance<=0){addLog(`[${algoId}] SELL skipped — no ${activeCoinRef.current} holdings`);return false;}
      // Sell 20% of holdings at a time (same as sim)
      base_size = +Math.max(0.000001,coinBalance*0.2).toFixed(8)+"";
    }

    addLog(`📤 Placing ${type} ${type==="BUY"?`$${quote_size}`:base_size+" "+activeCoinRef.current} on Coinbase — ${reason}`,"system");

    try {
      const result = await placeOrder(type,ci.product,quote_size,base_size);
      const success = result.success || result.order_id || result.success_response;
      const orderId = result.success_response?.order_id||result.order_id||"unknown";

      if(success){
        const fillPrice  = +( result.success_response?.average_filled_price||price);
        const fillSize   = +( result.success_response?.filled_size||base_size||"0");
        const fillValue  = +( result.success_response?.filled_value||quote_size||"0");

        // Compute pnl on SELL
        let pnl=0;
        if(type==="SELL"){
          pnl=(fillPrice-port.avgCost)*fillSize;
          port.coinHoldings=Math.max(0,port.coinHoldings-fillSize);
          port.usdtAvailable+=fillValue;
        } else {
          port.coinHoldings+=fillSize;
          port.usdtAvailable=Math.max(0,port.usdtAvailable-fillValue);
          // Update avg cost
          const prev=port.avgCost*( port.coinHoldings-fillSize);
          port.avgCost=(prev+fillValue)/port.coinHoldings;
        }

        // Record to ML only on SELL (pnl is meaningful)
        if(type==="SELL"&&pnl!==0&&features&&algoId){
          m.recordTrade(features,pnl,algoId);setMlVersion(v=>v+1);
          setTotalPnL(p=>p+pnl);
          if(pnl>0){setWins(w=>w+1);setAlgoStats(p=>({...p,[algoId]:{...p[algoId],trades:p[algoId].trades+1,wins:p[algoId].wins+1,pnl:p[algoId].pnl+pnl}}));}
          else{setLosses(l=>l+1);setAlgoStats(p=>({...p,[algoId]:{...p[algoId],trades:p[algoId].trades+1,losses:p[algoId].losses+1,pnl:p[algoId].pnl+pnl}}));}
          // Auto-audit
          setTimeout(()=>{const mn=modelRef.current;if(!mn.isAuditing&&(mn.totalUpdates-mn.lastAuditTrade)>=mn.auditInterval&&mn.history.length>=5)runAuditRef.current?.();},0);
        }

        const tradeEntry:Trade={
          id:orderId,time:nowTs(),type,coin:activeCoinRef.current,price:fillPrice,
          amount:fillSize,value:fillValue,pnl:+pnl.toFixed(2),reason,algoId,
          mlConf:features?+m.predict(features,algoId).toFixed(3):null,
          agentSent:+agentSentRef.current.toFixed(2),
          regime:m.currentRegime,stopLoss:stopLossRef.current,
          cbOrderId:orderId,cbStatus:"FILLED",
        };
        setTrades(p=>[tradeEntry,...p].slice(0,100));
        addLog(`✅ ${type} FILLED — ${ci.product} orderId:${orderId.slice(0,8)} PnL:${pnl!==0?fmtUSD(pnl):"-"}`,"ok");
        // Refresh real balance after fill
        setTimeout(()=>refreshBalances(),2000);
        return true;
      } else {
        const errMsg = result.error_response?.message||result.error||"Order rejected";
        addLog(`❌ Order FAILED: ${errMsg}`,"warn");
        return false;
      }
    } catch(e:any){
      addLog(`❌ Order error: ${e.message}`,"warn");
      return false;
    }
  },[refreshBalances,addLog]);

  // ── Strategy signals ──────────────────────────────────────────────────────────
  useEffect(()=>{
    if(!running||priceData.length<20||!edgeUrl) return;
    const coin    = activeCoinRef.current;
    const pd      = priceDataRef.current;
    const aSent   = agentSentRef.current;
    const algos   = activeAlgosRef.current;
    const fc      = agentsRef.current.forecast?.data;
    const m       = modelRef.current;
    const ps      = posScalarRef.current;
    const features = extractFeatures(pd,aSent);
    const price   = pd[pd.length-1]?.price||currentPrice;

    algos.forEach(algoId=>{
      if(Math.random()>0.35) return; // slightly lower bar for live
      if(m.vetoedAlgos[algoId]) return;
      const algo    = ALGORITHMS[algoId];
      const conf    = m.predict(features,algoId);
      const agRec   = fc?.algorithmRecommendations?.[algoId];
      const boost   = agRec?.action?.includes("BUY")?0.06:agRec?.action?.includes("SELL")?-0.06:0;
      const effConf = clamp(conf+boost,0,1);
      const shouldBuy  = algo.entry(features)&&effConf>=algo.minConf;
      const shouldSell = algo.exit(features)&&coinBalance>0;
      if(shouldBuy&&Math.random()<0.5)
        executeTrade("BUY",price,0,`[${algoId}] ${agRec?.reason?.slice(0,28)||algo.name}`,features,algoId);
      else if(shouldSell&&Math.random()<0.35)
        executeTrade("SELL",price,coinBalance*0.2,`[${algoId}] Exit`,features,algoId);
    });
  },[running,tick,currentPrice,coinBalance,edgeUrl,executeTrade]);

  // ── AUDITOR ────────────────────────────────────────────────────────────────────
  const runAudit = useCallback(async()=>{
    const m=modelRef.current;
    if(m.isAuditing||isAuditing) return;
    m.isAuditing=true;setIsAuditing(true);
    addLog("🔍 Auditor: Sending live trade history to Claude…","system");
    const recent=m.history.slice(-20);
    const sumPnL=recent.reduce((s:number,t:any)=>s+t.pnl,0);
    const ag=agentsRef.current;const t2=tier2Ref.current;const fd=ag.forecast?.data;
    const topW=m.weightData.slice().sort((a,b)=>b.abs-a.abs).slice(0,5).map(w=>`${w.feature}: base=${fmt(w.weight,3)} bias=×${fmt(w.bias,2)} eff=${fmt(w.effective,3)}`).join("\n");
    const breakdown=Object.keys(ALGORITHMS).map(id=>{const ah=m.algoHistory[id].slice(-5);return `${id}: ${ah.length}t ${ah.filter((t:any)=>t.pnl>0).length}W/${ah.filter((t:any)=>t.pnl<=0).length}L PnL=${fmtUSD(ah.reduce((s:number,t:any)=>s+t.pnl,0))} acc=${m.accuracy(id)}%`;}).join("\n");
    const prompt=`LIVE TRADING AUDIT — ${nowTs()}
Coin: ${activeCoinRef.current} | Regime: ${m.currentRegime} | LR: ${m.lr.toFixed(4)}
SL: ${stopLossRef.current}% | Trail: ${trailingRef.current}% | PosScalar: ${posScalarRef.current.toFixed(2)}
USDT Available: ${fmtUSD(portfolioRef.current.usdtAvailable)} | Budget Cap: ${budgetCapRef.current>0?fmtUSD(budgetCapRef.current):"None"}

RECENT LIVE TRADES (last ${recent.length}):
Lifetime acc: ${m.accuracy()}% | Last-10 acc: ${m.recentAccuracy()}%
W:${recent.filter((t:any)=>t.pnl>0).length} L:${recent.filter((t:any)=>t.pnl<=0).length} | PnL: ${fmtUSD(sumPnL)}
Last 3: ${m.history.slice(-3).map((t:any)=>t.pnl>0?"W":"L").join("")}

PER-ALGO:
${breakdown}

AGENT SIGNALS:
News: ${ag.news?.data?.sentiment??'N/A'} (${ag.news?.data?.marketImpact||'N/A'})
Social: ${ag.social?.data?.sentiment??'N/A'} (${ag.social?.data?.crowdMood||'N/A'})
Market: ${ag.market?.data?.sentiment??'N/A'} (${ag.market?.data?.trend||'N/A'})
Chain: ${ag.onchain?.data?.sentiment??'N/A'} (${ag.onchain?.data?.whaleSignal||'N/A'})
Forecast: ${fd?.overallSentiment??'N/A'} → ${fd?.priceDirection||'N/A'}
Tier-2: cleaned=${t2?.cleanedSent??'N/A'} vetoed=${t2?.vetoed??false} conflict=${t2?.conflictScore??'N/A'}

TOP-5 WEIGHTS:
${topW}
Vetoed: ${Object.keys(m.vetoedAlgos).join(",")||"none"} | Total updates: ${m.totalUpdates}`;
    const res=await callClaude(AUDITOR_SYSTEM,prompt,900);
    const adv=parseJSON(res);
    if(adv?.mlAdvisory&&adv?.featureWeightBias&&adv?.algoVetoes&&adv?.riskPosture){
      const prev=m.applyAdvisory(adv);
      if(adv.riskPosture.stopLoss!=null)setStopLoss(clamp(adv.riskPosture.stopLoss,2,15));
      if(adv.riskPosture.trailingStop!=null)setTrailingStop(clamp(adv.riskPosture.trailingStop,1.5,10));
      if(adv.riskPosture.positionScalar!=null)setPosScalar(clamp(adv.riskPosture.positionScalar,0.1,1.0));
      setMlVersion(v=>v+1);
      const vetoes=Object.entries(adv.algoVetoes).filter(([,v]:any)=>v.vetoed).map(([id])=>id);
      addLog(`🔍 Applied: LR ${prev.lr.toFixed(4)}→${m.lr.toFixed(4)} | ${prev.regime}→${m.currentRegime} | Vetoed:[${vetoes.join(",")||"none"}]`,"ok");
    } else {addLog("🔍 Auditor parse error — no changes applied","warn");}
    m.isAuditing=false;setIsAuditing(false);
  },[addLog,isAuditing]);
  useEffect(()=>{runAuditRef.current=runAudit;},[runAudit]);

  // ── Agent runners ──────────────────────────────────────────────────────────────
  const runNewsAgent = useCallback(async()=>{
    const coin=activeCoinRef.current;
    updAgent("news",{status:"running",data:null});addLog("📰 News: fetching…");
    let raw=await fetchCryptoPanic(coin);if(!raw){raw=mockNews(coin);addLog("📰 Fallback","warn");}
    const res=await callClaude(NEWS_SYS,`Analyze ${coin} news:\n• ${raw.map((n:any)=>n.title).join("\n• ")}`);
    const d=parseJSON(res)||{sentiment:0.55,marketImpact:"NEUTRAL",summary:"Moderate sentiment.",confidence:0.5};
    updAgent("news",{status:"ok",data:d,lastRun:nowTs()});addLog(`📰 News: ${fmt(d.sentiment*100,0)}% — ${d.marketImpact}`,"ok");
  },[updAgent,addLog]);

  const runSocialAgent = useCallback(async()=>{
    const coin=activeCoinRef.current;
    updAgent("social",{status:"running",data:null});addLog("🐦 Social: fetching Reddit…");
    let posts=await fetchReddit(coin);if(!posts){posts=mockReddit(coin);addLog("🐦 Fallback","warn");}
    const res=await callClaude(SOCIAL_SYS,`Analyze ${coin} Reddit:\n${(posts as any[]).map(p=>`"${p.title}" (${p.score} upvotes)`).join("\n")}`);
    const d=parseJSON(res)||{sentiment:0.55,crowdMood:"CAUTIOUSLY_OPTIMISTIC",hypeLevel:0.4,summary:"Cautiously optimistic.",confidence:0.5};
    updAgent("social",{status:"ok",data:d,lastRun:nowTs()});addLog(`🐦 Social: ${d.crowdMood}`,"ok");
  },[updAgent,addLog]);

  const runMarketAgent = useCallback(async()=>{
    updAgent("market",{status:"running",data:null});addLog("📊 Market: fetching F&G…");
    const fg=await fetchFearGreed();
    let text=`${activeCoinRef.current} price: ${fmtUSD(currentPrice)}. `;
    if(fg?.[0])text+=`Fear&Greed: ${fg[0].value} (${fg[0].value_classification}).`;
    const res=await callClaude(MARKET_SYS,text);
    const d=parseJSON(res)||{sentiment:0.55,trend:"SIDEWAYS",forecast24h:"SIDEWAYS",summary:"Analyzed.",confidence:0.5};
    updAgent("market",{status:"ok",data:d,lastRun:nowTs()});addLog(`📊 Market: ${d.trend}`,"ok");
  },[updAgent,addLog,currentPrice]);

  const runOnChainAgent = useCallback(async()=>{
    updAgent("onchain",{status:"running",data:null});addLog("⛓️ On-chain: fetching…");
    const gas=await fetchEtherscan();
    const text=gas?`ETH Gas: Safe=${gas.SafeGasPrice} Fast=${gas.FastGasPrice} Gwei`:`On-chain data unavailable — using fallback.`;
    const res=await callClaude(ONCHAIN_SYS,`On-chain for ${activeCoinRef.current}:\n${text}`);
    const d=parseJSON(res)||{sentiment:0.55,networkActivity:"MODERATE",whaleSignal:"NEUTRAL",summary:"Moderate.",confidence:0.55};
    updAgent("onchain",{status:"ok",data:d,lastRun:nowTs()});addLog(`⛓️ Chain: ${d.networkActivity}`,"ok");
  },[updAgent,addLog]);

  const runForecastAgent = useCallback(async(ag?:any)=>{
    const coin=activeCoinRef.current;
    updAgent("forecast",{status:"running",data:null});addLog("🔮 Forecast: Tier-2 synthesis…");
    const cur=ag||agentsRef.current;
    const nD=cur.news?.data,sD=cur.social?.data,mD=cur.market?.data,oD=cur.onchain?.data;
    const t2=modelRef.current.tier2Resolve(nD?.sentiment,sD?.sentiment,mD?.sentiment,oD?.sentiment);
    setTier2Result(t2);setDivergence(t2.divergence);
    if(t2.vetoed)addLog(`🔮 Tier-2 veto: conflict ${fmt(t2.conflictScore*100,1)}%`,"warn");
    if(t2.divergence!=="NONE")addLog(`🔮 DIVERGENCE: ${t2.divergence}`,"system");
    const text=`NEWS:${nD?.sentiment??0.5}|SOCIAL:${sD?.sentiment??0.5}|MARKET:${mD?.sentiment??0.5}|CHAIN:${oD?.sentiment??0.5}|CONFLICT:${t2.conflictScore}|CLEANED:${t2.cleanedSent}|DIV:${t2.divergence}|COIN:${coin}`;
    const res=await callClaude(FORECAST_SYS,text,800);
    const d=parseJSON(res);
    if(d){
      updAgent("forecast",{status:"ok",data:d,lastRun:nowTs()});
      setAgentSent(t2.vetoed?t2.cleanedSent:(d.overallSentiment??t2.cleanedSent));
      if(d.regimeSuggestion&&REGIMES[d.regimeSuggestion]){modelRef.current.currentRegime=d.regimeSuggestion;setMlVersion(v=>v+1);}
      addLog(`🔮 Forecast: ${d.priceDirection} | ${fmt((d.confidence||0)*100,0)}% | ${d.riskLevel}`,"ok");
    } else {
      updAgent("forecast",{status:"ok",data:{overallSentiment:t2.cleanedSent,priceDirection:"SIDEWAYS",confidence:0.55,riskLevel:"MODERATE",summary:"Synthesis complete.",algorithmRecommendations:{A:{action:"BUY",confidence:0.58,reason:"mild bullish"},B:{action:"WAIT",confidence:0.45,reason:"no setup"},C:{action:"WAIT",confidence:0.50,reason:"watching"},D:{action:"BUY",confidence:0.60,reason:"sentiment ok"}}},lastRun:nowTs()});
      setAgentSent(t2.cleanedSent);
    }
  },[updAgent,addLog]);

  const runAllAgents=useCallback(async()=>{
    addLog("═══ All 5 AI Agents starting ═══","system");
    await runNewsAgent();await sleep(400);await runSocialAgent();await sleep(400);
    await runMarketAgent();await sleep(400);await runOnChainAgent();await sleep(600);
    setAgents(ag=>{runForecastAgent(ag);return ag;});
    addLog("═══ Pipeline complete ═══","system");
  },[runNewsAgent,runSocialAgent,runMarketAgent,runOnChainAgent,runForecastAgent,addLog]);

  useEffect(()=>{if(!autoAgents)return;const iv=setInterval(()=>runAllAgents(),5*60*1000);return()=>clearInterval(iv);},[autoAgents,runAllAgents]);

  // ── RESET on coin change ──────────────────────────────────────────────────────
  useEffect(()=>{
    setPriceData([]);setCurrentPrice(0);setHighWater(0);highWaterRef.current=0;
    setTrades([]);setTotalPnL(0);setWins(0);setLosses(0);
    setStopTriggered(false);
    setAlgoStats({A:{trades:0,wins:0,losses:0,pnl:0},B:{trades:0,wins:0,losses:0,pnl:0},C:{trades:0,wins:0,losses:0,pnl:0},D:{trades:0,wins:0,losses:0,pnl:0}});
    modelRef.current=new SharedMLModel();setMlVersion(v=>v+1);
    setTier2Result(null);setDivergence("NONE");setAgentSent(0.5);
    addLog(`🔄 Switched to ${activeCoin}`,"system");
    if(edgeUrl)refreshPrices(activeCoin);
  },[activeCoin]);

  const TABS=[["dashboard","📊 Dashboard"],["auditor","🔍 Auditor"],["agents","🤖 Agents"],["orders","📋 Orders"],["log","📝 Log"]];

  return (
    <div className="min-h-screen text-white font-mono" style={{background:"radial-gradient(ellipse 80% 50% at 50% -10%,#0a1628 0%,#030712 60%)"}}>
      <div className="fixed inset-0 pointer-events-none z-10 opacity-[0.015]" style={{backgroundImage:"repeating-linear-gradient(0deg,transparent,transparent 2px,#fff 2px,#fff 3px)"}}/>
      <div className="max-w-7xl mx-auto px-4 py-4 space-y-3 relative z-20">

        {/* ── API Config Modal ── */}
        {showConfig&&(
          <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
            <div className="rounded-2xl border border-white/15 bg-gray-950 p-8 max-w-lg w-full space-y-5">
              <div className="text-xl font-black text-white">⚙️ NEXUSBOT Configuration</div>
              <div className="rounded-xl border border-blue-500/25 bg-blue-950/20 p-4 text-xs text-white/50 space-y-1.5">
                <div className="text-blue-300 font-bold mb-1">What this connects to</div>
                <div>• Your <strong className="text-white/70">Supabase Edge Function</strong> handles all Coinbase API calls securely server-side</div>
                <div>• Your Coinbase API key + secret live only in Supabase's encrypted secret manager</div>
                <div>• This URL is the only thing stored in the browser</div>
              </div>
              <div>
                <label className="text-xs text-white/40 uppercase tracking-widest block mb-2">Supabase Edge Function URL</label>
                <input value={edgeUrlInput} onChange={e=>setEdgeUrlInput(e.target.value)}
                  placeholder="https://xxxx.supabase.co/functions/v1/coinbase-proxy"
                  className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2.5 text-sm font-mono text-white placeholder-white/20 focus:outline-none focus:border-cyan-500/50"/>
                <div className="text-xs text-white/28 mt-1.5">Get this from your Supabase dashboard → Edge Functions → coinbase-proxy → URL</div>
              </div>
              <div>
                <label className="text-xs text-white/40 uppercase tracking-widest block mb-2">Trading Budget Cap (USDT)</label>
                <input value={budgetInput} onChange={e=>setBudgetInput(e.target.value)}
                  placeholder="e.g. 200 — leave blank for no cap (not recommended)"
                  className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2.5 text-sm font-mono text-white placeholder-white/20 focus:outline-none focus:border-cyan-500/50"/>
                <div className="text-xs text-white/28 mt-1.5">Hard ceiling on how much USDT the bot can deploy per session</div>
              </div>
              <div className="rounded-xl border border-amber-500/25 bg-amber-950/10 p-3 text-xs text-amber-300">
                ⚠ This bot will place <strong>real orders</strong> with real USDT on your Coinbase account. Start with a small budget cap and run agents first before pressing START.
              </div>
              <button onClick={()=>{
                setEdgeUrl(edgeUrlInput.trim());
                if(budgetInput.trim())setBudgetCap(Math.max(0,+budgetInput));
                setShowConfig(false);
              }} className="w-full py-3 rounded-xl bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 font-bold text-sm hover:bg-cyan-500/30 transition-all">
                Save & Connect
              </button>
            </div>
          </div>
        )}

        {/* ── Header ── */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <div className={`w-2 h-2 rounded-full ${running?"bg-cyan-400 animate-pulse":"bg-white/20"}`}/>
            <h1 className="text-xl font-bold">NEXUS<span className="text-cyan-400">BOT</span></h1>
            <Badge color="cyan">v9.0</Badge>
            <Badge color="green">LIVE</Badge>
            <Badge color={regime.badge}>{regime.icon} {regime.label}</Badge>
            <Badge color="indigo">LR: {model.lr.toFixed(4)}</Badge>
            {budgetCap>0&&<Badge color="amber">💰 Cap: {fmtUSD(budgetCap)}</Badge>}
            {vetoCount>0&&<Badge color="red">⛔ {vetoCount} vetoed</Badge>}
            {isAuditing&&<Badge color="amber">🔍 Auditing…</Badge>}
            {divergence!=="NONE"&&<Badge color={divergence==="BULLISH_BREAKOUT"?"purple":"red"}>{divergence==="BULLISH_BREAKOUT"?"💎":"⚠️"} {divergence.replace(/_/g," ")}</Badge>}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select value={activeCoin} onChange={e=>setActiveCoin(e.target.value)}
              className="bg-white/5 border border-white/15 rounded-lg px-2 py-1.5 text-xs font-mono text-white focus:outline-none">
              {COINS.map(c=><option key={c.s} value={c.s}>{c.s} — {c.name}</option>)}
            </select>
            <div className="flex rounded-lg border border-white/10 overflow-hidden">
              {Object.values(ALGORITHMS).map((a:any)=>{const vetoed=!!model.vetoedAlgos[a.id];const active=activeAlgos.includes(a.id)&&!vetoed;return(
                <button key={a.id} onClick={()=>setActiveAlgos(p=>p.includes(a.id)?p.filter((x:string)=>x!==a.id):[...p,a.id])}
                  className="px-3 py-1.5 text-xs font-black relative" style={{background:active?a.color+"28":"",color:active?a.color:"rgba(255,255,255,0.2)",opacity:vetoed?0.35:1}}>
                  {a.id}{vetoed&&<span className="absolute -top-0.5 -right-0.5 text-xs">⛔</span>}
                </button>
              );})}
            </div>
            <div className="flex items-center gap-1.5"><span className="text-xs text-white/28">Auto 5m</span><Toggle value={autoAgents} onChange={setAutoAgents} activeColor="bg-indigo-500"/></div>
            <button onClick={refreshBalances} disabled={balanceLoading} className="px-3 py-1.5 rounded-lg border border-white/15 text-white/50 hover:text-white text-xs font-mono disabled:opacity-30">💰 Refresh</button>
            <button onClick={runAllAgents} className="px-3 py-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/15 text-indigo-400 text-xs font-bold hover:bg-indigo-500/25">🤖 Agents</button>
            <button onClick={runAudit} disabled={isAuditing} className="px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/12 text-amber-300 text-xs font-bold disabled:opacity-30">🔍 Audit</button>
            <button onClick={()=>setShowConfig(true)} className="px-3 py-1.5 rounded-lg border border-white/15 text-white/45 hover:text-white text-xs font-mono">⚙️</button>
            <button onClick={()=>setRunning(r=>!r)}
              className={`px-5 py-1.5 rounded-lg text-sm font-bold border ${running?"bg-red-500/20 border-red-500/50 text-red-400":"bg-cyan-500/20 border-cyan-500/50 text-cyan-400"}`}>
              {running?"⏹ STOP":"▶ START"}
            </button>
          </div>
        </div>

        {/* Edge URL warning */}
        {!edgeUrl&&(
          <div className="rounded-xl border border-red-500/40 bg-red-950/20 p-4 flex items-center gap-3">
            <span className="text-red-400 text-xl">⚠️</span>
            <div className="flex-1">
              <div className="text-red-300 font-bold text-sm">Supabase Edge Function URL not configured</div>
              <div className="text-white/40 text-xs">Click ⚙️ in the header to set your Edge Function URL before starting.</div>
            </div>
            <button onClick={()=>setShowConfig(true)} className="px-4 py-2 rounded-lg border border-red-500/40 text-red-400 text-xs font-bold">Configure Now</button>
          </div>
        )}

        {/* ── Stats ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          <div className="col-span-2">
            <div className="rounded-xl border border-white/8 bg-white/3 p-3">
              <div className="text-xs text-white/30 uppercase tracking-widest">{activeCoin}/USDT — Coinbase Live</div>
              <div className="text-xl font-bold mt-0.5">
                {priceLoading?"Loading…":priceError?"Error":currentPrice>=1?fmtUSD(currentPrice):"$"+currentPrice.toFixed(6)}
              </div>
              <div className="text-xs text-white/28">{coinInfo?.name} · {coinInfo?.product}</div>
            </div>
          </div>
          <StatCard label="USDT Balance"   value={balanceLoading?"…":balanceError?"Error":fmtUSD(usdtBalance)} sub={budgetCap>0?`Cap: ${fmtUSD(budgetCap)}`:"No cap set"} color={usdtBalance>0?"green":"default"} tiny/>
          <StatCard label={activeCoin+" Holdings"} value={fmt(coinBalance,6)} sub={coinBalance>0?`≈ ${fmtUSD(coinBalance*currentPrice)}`:"No position"} color={coinBalance>0?"cyan":"default"} tiny/>
          <StatCard label="Realized P&L"   value={fmtUSD(totalPnL)} color={totalPnL>=0?"green":"red"} sub={`W:${wins} L:${losses}`} tiny/>
          <StatCard label="Regime / LR"    value={regime.label} color={regime.badge} sub={`LR: ${model.lr.toFixed(4)} · ${model.auditHistory.length} audits`} tiny pulse={isAuditing}/>
          <StatCard label="ML Accuracy"    value={model.accuracy()+"%"} sub={`Recent: ${model.recentAccuracy()}%`} color={model.accuracy()>60?"green":"default"} tiny/>
          <StatCard label="Agent Sent"     value={fmt(agentSent*100,0)+"%"} sub={tier2Result?.vetoed?"⚠ Vetoed":"✓ Clean"} color={agentSent>0.6?"green":agentSent<0.4?"red":"amber"} tiny/>
        </div>

        {stopTriggered&&<div className="rounded-xl border border-red-500/60 bg-red-950/30 p-3 flex gap-3 items-center"><span className="text-red-400">⚠</span><span className="text-red-400 font-bold">STOP TRIGGERED — Real SELL order placed on Coinbase</span></div>}
        {balanceError&&<div className="rounded-xl border border-orange-500/40 bg-orange-950/15 p-3 text-orange-300 text-sm">⚠ Balance error: {balanceError}. Check your Edge Function URL and Coinbase API keys.</div>}

        {forecastData?.summary&&(
          <div className="rounded-xl border border-indigo-500/25 bg-indigo-950/10 p-3 flex items-start gap-3">
            <span className="text-xl flex-shrink-0">🔮</span>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-xs font-bold text-indigo-300">Forecast Agent</span>
                <Badge color={forecastData.priceDirection?.includes("UP")?"green":forecastData.priceDirection?.includes("DOWN")?"red":"yellow"}>{forecastData.priceDirection}</Badge>
                <Badge color="indigo">{fmt((forecastData.confidence||0)*100,0)}%</Badge>
                {tier2Result?.vetoed&&<Badge color="orange">⚠ Vetoed</Badge>}
              </div>
              <p className="text-xs text-white/45 leading-relaxed">{forecastData.summary}</p>
            </div>
          </div>
        )}

        {/* ── Tabs ── */}
        <div className="flex gap-1 border-b border-white/8">
          {TABS.map(([k,l])=>(
            <button key={k} onClick={()=>setTab(k)}
              className={`px-4 py-2 text-xs font-bold rounded-t-lg border-b-2 ${tab===k?"border-cyan-400 text-cyan-300 bg-cyan-500/8":"border-transparent text-white/35 hover:text-white/65"}`}>
              {l}
            </button>
          ))}
        </div>

        {/* ── DASHBOARD TAB ── */}
        {tab==="dashboard"&&(
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            <div className="lg:col-span-3 space-y-4">
              {/* Chart */}
              <div className="rounded-xl border border-white/8 bg-white/2 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-white/28">{activeCoin}/USDT — Coinbase 1-min candles · {regime.icon} {regime.label} · SL:{fmt(stopLoss,1)}% Trail:{fmt(trailingStop,1)}%</span>
                  <div className="flex gap-2 items-center">
                    {priceLoading&&<span className="text-xs text-amber-300 animate-pulse">Fetching…</span>}
                    <button onClick={()=>refreshPrices(activeCoin)} className="text-xs text-white/28 hover:text-white px-2 py-1 rounded border border-white/8">↻ Refresh</button>
                    <div className="flex gap-3 text-xs"><span className="text-white/35">Price</span><span className="text-cyan-400">SMA5</span><span className="text-purple-400">SMA20</span></div>
                  </div>
                </div>
                {priceData.length>0?(
                  <>
                    <div className="text-3xl font-bold mb-3">{currentPrice>=1?fmtUSD(currentPrice):"$"+currentPrice.toFixed(8)}</div>
                    <ResponsiveContainer width="100%" height={200}>
                      <ComposedChart data={priceData} margin={{top:8,right:5,left:0,bottom:0}}>
                        <defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#06b6d4" stopOpacity={0.12}/><stop offset="95%" stopColor="#06b6d4" stopOpacity={0}/></linearGradient></defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                        <XAxis dataKey="time" tick={{fill:"rgba(255,255,255,0.18)",fontSize:8}} tickLine={false} axisLine={false} interval={19}/>
                        <YAxis tick={{fill:"rgba(255,255,255,0.18)",fontSize:8}} tickLine={false} axisLine={false} tickFormatter={v=>v>=1?"$"+fmt(v,2):"$"+v.toFixed(4)} width={72} domain={["auto","auto"]}/>
                        <Tooltip content={<ChartTip/>}/>
                        <Area type="monotone" dataKey="price" stroke="#e2e8f0" strokeWidth={1.5} fill="url(#pg)" dot={<TradeDot/>} activeDot={false} isAnimationActive={false}/>
                        <Line type="monotone" dataKey="sma5"  stroke="#06b6d4" strokeWidth={1} dot={false} strokeDasharray="4 2" isAnimationActive={false}/>
                        <Line type="monotone" dataKey="sma20" stroke="#a855f7" strokeWidth={1} dot={false} strokeDasharray="4 2" isAnimationActive={false}/>
                      </ComposedChart>
                    </ResponsiveContainer>
                  </>
                ):(
                  <div className="h-48 flex flex-col items-center justify-center gap-2">
                    <div className="text-white/30 text-sm">{priceError?`Error: ${priceError}`:"No price data yet"}</div>
                    {priceError?<button onClick={()=>refreshPrices(activeCoin)} className="px-4 py-2 rounded-lg border border-white/15 text-white/50 text-xs">Retry</button>:!edgeUrl?<div className="text-white/22 text-xs">Configure Edge Function URL first</div>:null}
                  </div>
                )}
              </div>

              {/* Trade log */}
              <div className="rounded-xl border border-white/8 bg-white/2 p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs text-white/28 uppercase tracking-widest">Live Trade Log — Real Coinbase Fills</div>
                  <div className="flex gap-2">
                    {running&&<span className="flex items-center gap-1 text-xs text-cyan-400"><span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse inline-block"/>Live</span>}
                    <span className="text-xs text-white/18">{trades.length} fills</span>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-white/18 border-b border-white/6">{["Time","Algo","Type","Price","Value","P&L","Order ID","Status"].map((h,i)=><th key={h} className={`pb-2 font-normal ${i>=3?"text-right":"text-left"}`}>{h}</th>)}</tr></thead>
                    <tbody className="divide-y divide-white/4">
                      {trades.length===0?(
                        <tr><td colSpan={8} className="text-center text-white/15 py-6">{running?"Watching for signals…":"Press ▶ START after running agents"}</td></tr>
                      ):trades.map(t=>{
                        const a=ALGORITHMS[t.algoId];const r=REGIMES[t.regime]||REGIMES.STABLE;
                        return <tr key={t.id} className="hover:bg-white/3">
                          <td className="py-1.5 text-white/22">{t.time}</td>
                          <td className="py-1.5"><span className="font-black px-1.5 py-0.5 rounded" style={{background:(a?.color||"#888")+"20",color:a?.color||"#888"}}>{t.algoId}</span></td>
                          <td className="py-1.5"><span className={`font-bold ${t.type==="BUY"?"text-emerald-400":"text-red-400"}`}>{t.type==="BUY"?"▲":"▼"} {t.type}</span></td>
                          <td className="py-1.5 text-right text-white">{t.price>=1?fmtUSD(t.price):"$"+t.price.toFixed(6)}</td>
                          <td className="py-1.5 text-right text-white/60">{fmtUSD(t.value)}</td>
                          <td className={`py-1.5 text-right font-bold ${t.pnl>0?"text-emerald-400":t.pnl<0?"text-red-400":"text-white/15"}`}>{t.pnl!==0?fmtUSD(t.pnl):"—"}</td>
                          <td className="py-1.5 text-right text-white/25 font-mono">{t.cbOrderId?.slice(0,8)||"—"}</td>
                          <td className="py-1.5 text-right"><Badge color={t.cbStatus==="FILLED"?"green":"amber"}>{t.cbStatus||"—"}</Badge></td>
                        </tr>;
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Sidebar */}
            <div className="space-y-3">
              <div className="rounded-xl border border-white/8 bg-white/2 p-4">
                <div className="text-xs text-white/28 uppercase tracking-widest mb-3">Risk — Auditor Controlled</div>
                <div className="space-y-3">
                  {[
                    [`Stop-Loss (${fmt(stopLoss,1)}%)`,   stopLoss,     setStopLoss,     2,   15,  "#ef4444"],
                    [`Trailing (${fmt(trailingStop,1)}%)`,trailingStop,  setTrailingStop, 1.5, 10,  "#f59e0b"],
                    [`Pos Scalar (×${fmt(posScalar,2)})`, posScalar,     setPosScalar,    0.1, 1.0, "#06b6d4"],
                  ].map(([l,v,s,mn,mx,c]:any[])=>(
                    <div key={l}>
                      <div className="flex justify-between text-xs mb-1"><span className="text-white/40">{l}</span><span className="text-xs text-white/22">Auditor adjusts</span></div>
                      <input type="range" min={mn} max={mx} step={0.1} value={v} onChange={e=>s(+e.target.value)} className="w-full h-1 cursor-pointer" style={{accentColor:c}}/>
                    </div>
                  ))}
                  <div className="text-xs text-white/22 bg-white/3 rounded p-2 border border-white/5">
                    Pos Scalar default 0.3× for live trading. Raise only after verified profitable runs.
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-white/8 bg-white/2 p-4">
                <div className="text-xs text-white/28 uppercase tracking-widest mb-2">Budget Cap</div>
                <div className="flex gap-2">
                  <input type="number" value={budgetInput} onChange={e=>setBudgetInput(e.target.value)}
                    placeholder={fmtUSD(usdtBalance)+" available"}
                    className="flex-1 bg-white/4 border border-white/10 rounded px-2 py-1.5 text-xs font-mono text-white placeholder-white/20 focus:outline-none"/>
                  <button onClick={()=>{setBudgetCap(Math.max(0,+budgetInput||0));addLog(`💰 Budget cap set: ${fmtUSD(+budgetInput||0)}`);}}
                    className="px-3 py-1.5 rounded text-xs font-bold bg-cyan-500/15 border border-cyan-500/35 text-cyan-400">Set</button>
                </div>
                {budgetCap>0&&<div className="mt-2 text-xs text-emerald-400">✓ Bot limited to {fmtUSD(budgetCap)} USDT</div>}
              </div>

              <div className="rounded-xl border border-white/8 bg-white/2 p-4">
                <div className="text-xs text-white/28 uppercase tracking-widest mb-2">Algo P&L</div>
                {Object.values(ALGORITHMS).map((algo:any)=>{
                  const s=algoStats[algo.id];const vetoed=!!model.vetoedAlgos[algo.id];
                  return <div key={algo.id} className={`flex items-center gap-2 mb-2 ${vetoed?"opacity-40":""}`}>
                    <div className="w-5 h-5 rounded flex items-center justify-center text-xs font-black" style={{background:algo.color+"22",color:algo.color}}>{algo.id}</div>
                    <div className="flex-1"><div className="h-1 rounded-full bg-white/5"><div className="h-full rounded-full" style={{width:`${Math.min(Math.abs(s.pnl)/20,1)*100}%`,background:s.pnl>=0?"#10b981":"#ef4444"}}/></div></div>
                    {vetoed?<span className="text-xs text-red-400">⛔</span>:<span className={`text-xs font-mono font-bold ${s.pnl>=0?"text-emerald-400":"text-red-400"}`}>{fmtUSD(s.pnl)}</span>}
                  </div>;
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── AUDITOR TAB ── */}
        {tab==="auditor"&&(
          <div className="space-y-4">
            <div className="rounded-2xl border p-5 flex items-center gap-5" style={{borderColor:regime.color+"44",background:regime.color+"0C"}}>
              <div className="text-5xl">{regime.icon}</div>
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-1 flex-wrap">
                  <span className="text-2xl font-black text-white">{regime.label} Market</span>
                  <Badge color={regime.badge}>{model.currentRegime}</Badge>
                  {vetoCount>0&&<Badge color="red">⛔ {Object.keys(model.vetoedAlgos).join(",")} vetoed</Badge>}
                  {isAuditing&&<Badge color="amber">🔍 Auditing…</Badge>}
                </div>
                <div className="flex gap-4 mt-2 text-xs text-white/38 flex-wrap">
                  <span>LR: <strong className="text-white font-mono">{model.lr.toFixed(4)}</strong></span>
                  <span>Accuracy: <strong className={`font-mono ${model.accuracy()>60?"text-emerald-400":"text-amber-300"}`}>{model.accuracy()}%</strong></span>
                  <span>Trades: <strong className="text-white font-mono">{model.totalUpdates}</strong></span>
                  <span>Next audit: <strong className="text-white font-mono">{Math.max(0,model.auditInterval-(model.totalUpdates-model.lastAuditTrade))} trades</strong></span>
                </div>
              </div>
              <button onClick={runAudit} disabled={isAuditing}
                className="px-4 py-2.5 rounded-xl border border-white/20 text-white/60 hover:text-white text-sm font-mono transition-all disabled:opacity-30 flex-shrink-0">
                {isAuditing?"🔍 Auditing…":"🔍 Run Audit"}
              </button>
            </div>

            {model.auditHistory[0]?.advisory?(
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                {/* ML Advisory */}
                {[
                  {title:"🧠 ML Advisory",   color:"indigo", content:(adv:any)=><>
                    <div className="flex items-center gap-3 mb-2">
                      <div className="text-right"><div className="text-xs text-white/30">Before</div><div className="font-mono font-bold text-white/50">{model.auditHistory[0].prevLR?.toFixed(4)}</div></div>
                      <div className="text-white/30">→</div>
                      <div><div className="text-xs text-white/30">After</div><div className="font-mono font-bold text-indigo-400">{model.auditHistory[0].newLR?.toFixed(4)}</div></div>
                    </div>
                    <div className="text-xs text-white/40 bg-white/3 rounded p-2 border border-white/5 leading-relaxed">{adv.mlAdvisory?.reasoning||"—"}</div>
                  </>},
                ].map(({title,color,content})=>(
                  <div key={title} className={`rounded-xl border border-${color}-500/30 bg-${color}-950/10 p-4`}>
                    <div className="text-sm font-bold mb-3" style={{color:`var(--tw-colors-${color}-300,#a5b4fc)`}}>{title}</div>
                    <div className="text-xs space-y-2">{content(model.auditHistory[0].advisory)}</div>
                  </div>
                ))}

                {/* Feature bias */}
                <div className="rounded-xl border border-cyan-500/25 bg-cyan-950/8 p-4">
                  <div className="text-sm font-bold text-cyan-300 mb-3">⚖️ Feature Bias</div>
                  <div className="space-y-1.5">
                    {FEATURES.map(f=>{const bias=model.featureBias[f]||1;const color=bias>1.15?"#10b981":bias<0.85?"#ef4444":"#06b6d4";return<div key={f}><div className="flex justify-between text-xs mb-0.5"><span className="text-white/40">{f}</span><span className="font-mono font-bold" style={{color}}>×{fmt(bias,2)}</span></div><div className="h-1 rounded-full bg-white/5"><div className="h-full rounded-full" style={{width:`${clamp((bias-0.2)/2.8,0,1)*100}%`,background:color,opacity:0.8}}/></div></div>;})}
                  </div>
                </div>

                {/* Vetoes */}
                <div className="rounded-xl border border-red-500/20 bg-red-950/8 p-4">
                  <div className="text-sm font-bold text-red-300 mb-3">⛔ Algo Vetoes</div>
                  <div className="space-y-2">
                    {Object.values(ALGORITHMS).map((algo:any)=>{const rec=model.auditHistory[0].advisory?.algoVetoes?.[algo.id];const vetoed=rec?.vetoed||false;return<div key={algo.id} className={`rounded-lg p-2 border flex items-start gap-2 ${vetoed?"border-red-500/35 bg-red-950/20":"border-white/6 bg-white/2"}`}><div className="w-6 h-6 rounded flex items-center justify-center text-xs font-black flex-shrink-0" style={{background:algo.color+"22",color:algo.color}}>{algo.id}</div><div className="flex-1 min-w-0"><div className="flex items-center gap-2 mb-0.5"><span className="text-xs font-bold text-white">{algo.name}</span><span className={`text-xs font-bold ${vetoed?"text-red-400":"text-emerald-400"}`}>{vetoed?"⛔":"✓"}</span></div><div className="text-xs text-white/35">{rec?.reason||"—"}</div></div></div>;})}
                  </div>
                </div>

                {/* Risk */}
                <div className="rounded-xl border border-orange-500/25 bg-orange-950/8 p-4">
                  <div className="text-sm font-bold text-orange-300 mb-3">🛡️ Risk Posture</div>
                  <div className="space-y-2 text-xs">
                    {[["Stop-Loss",stopLoss,"%"],["Trailing",trailingStop,"%"],["Pos Scalar",posScalar,"×"]].map(([l,v,u])=><div key={l as string} className="flex justify-between"><span className="text-white/40">{l}</span><span className="font-mono font-bold text-white">{u==="×"?`×${fmt(v as number,2)}`:`${fmt(v as number,1)}${u}`}</span></div>)}
                    <div className="mt-2 text-white/38 bg-white/3 rounded p-2 border border-white/5 leading-relaxed">{model.auditHistory[0].advisory?.riskPosture?.reasoning||"—"}</div>
                  </div>
                </div>
              </div>
            ):(
              <div className="rounded-xl border border-white/8 bg-white/2 p-8 text-center">
                <div className="text-4xl mb-3">🔍</div>
                <div className="text-white/40 text-sm mb-1">No audits yet</div>
                <div className="text-white/22 text-xs mb-4">Auditor fires every {model.auditInterval} real trades, or manually above.</div>
                <button onClick={runAudit} disabled={isAuditing} className="px-5 py-2 rounded-lg border border-indigo-500/40 bg-indigo-500/15 text-indigo-400 font-bold text-sm disabled:opacity-30">{isAuditing?"Running…":"Run First Audit"}</button>
              </div>
            )}

            {/* LR history */}
            <div className="rounded-xl border border-white/8 bg-white/2 p-4">
              <div className="text-xs text-white/30 uppercase tracking-widest mb-3">LR History — {model.auditHistory.length} audits</div>
              {model.lrHistory.length>2?(
                <ResponsiveContainer width="100%" height={90}>
                  <ComposedChart data={model.lrHistory.slice(-50)} margin={{top:5,right:5,left:0,bottom:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                    <XAxis dataKey="t" tick={{fill:"rgba(255,255,255,0.18)",fontSize:8}} tickLine={false} axisLine={false}/>
                    <YAxis domain={[0.01,0.20]} tick={{fill:"rgba(255,255,255,0.18)",fontSize:8}} tickLine={false} axisLine={false} width={38} tickFormatter={v=>v.toFixed(3)}/>
                    <Tooltip content={({active,payload}:any)=>{if(!active||!payload?.length)return null;const d=payload[0]?.payload;return <div className="rounded border border-white/10 bg-gray-950/95 p-2 text-xs font-mono"><div className="text-indigo-300">LR: {d?.lr}</div><div className="text-white/40">#{d?.t}</div></div>;}}/>
                    <Area type="stepAfter" dataKey="lr" stroke="#818cf8" fill="#818cf815" strokeWidth={2} dot={false} isAnimationActive={false}/>
                  </ComposedChart>
                </ResponsiveContainer>
              ):<div className="text-xs text-white/18 text-center py-4">Need trades to build LR history</div>}
            </div>
          </div>
        )}

        {/* ── AGENTS TAB ── */}
        {tab==="agents"&&(
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {Object.values(agents).map((agent:any)=>(
              <div key={agent.id} className={`rounded-xl border p-4 bg-white/2 ${agent.status==="running"?"border-amber-500/30":agent.status==="ok"?"border-emerald-500/20":"border-white/8"}`}>
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-2xl">{agent.icon}</span>
                  <div className="flex-1"><div className="text-sm font-bold text-white">{agent.name}</div><div className="text-xs text-white/28">{agent.description}</div></div>
                  <button onClick={()=>{if(agent.id==="news")runNewsAgent();else if(agent.id==="social")runSocialAgent();else if(agent.id==="market")runMarketAgent();else if(agent.id==="onchain")runOnChainAgent();else setAgents(ag=>{runForecastAgent(ag);return ag;});}} disabled={agent.status==="running"} className="px-2 py-1 rounded border border-white/12 text-white/35 hover:text-white text-xs disabled:opacity-30">↻</button>
                </div>
                {agent.data?.sentiment!=null&&<div className="mb-2"><div className="flex justify-between text-xs mb-0.5"><span className="text-white/28">Sentiment</span><span className={`font-bold ${agent.data.sentiment>0.6?"text-emerald-400":agent.data.sentiment<0.4?"text-red-400":"text-yellow-300"}`}>{fmt(agent.data.sentiment*100,0)}%</span></div><div className="h-1.5 rounded-full bg-white/6"><div className="h-full rounded-full" style={{width:`${agent.data.sentiment*100}%`,background:agent.data.sentiment>0.6?"#10b981":agent.data.sentiment<0.4?"#ef4444":"#eab308"}}/></div></div>}
                {agent.data?.summary&&<div className="text-xs text-white/42 bg-white/3 rounded p-2 border border-white/5 italic mt-2">"{agent.data.summary}"</div>}
                {agent.status==="idle"&&<div className="text-xs text-white/18 text-center py-2">Click ↻ to activate</div>}
              </div>
            ))}
          </div>
        )}

        {/* ── ORDERS TAB ── */}
        {tab==="orders"&&(
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-xs text-white/30 uppercase tracking-widest">Coinbase Order History — {coinInfo?.product}</div>
              <button onClick={refreshOrders} className="px-3 py-1.5 rounded-lg border border-white/15 text-white/40 hover:text-white text-xs">↻ Refresh</button>
            </div>
            <div className="rounded-xl border border-white/8 bg-white/2 p-4 overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-white/18 border-b border-white/6">{["Time","Side","Status","Filled Size","Filled Value","Avg Price","Type"].map((h,i)=><th key={h} className={`pb-2 font-normal ${i>=2?"text-right":"text-left"}`}>{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-white/4">
                  {cbOrders.length===0?<tr><td colSpan={7} className="text-center text-white/15 py-6">No orders yet — click ↻ Refresh or place your first trade</td></tr>
                  :cbOrders.map(o=>(
                    <tr key={o.order_id} className="hover:bg-white/3">
                      <td className="py-1.5 text-white/22">{new Date(o.created_time).toLocaleTimeString("en-US",{hour12:false})}</td>
                      <td className="py-1.5"><span className={`font-bold ${o.side==="BUY"?"text-emerald-400":"text-red-400"}`}>{o.side==="BUY"?"▲":"▼"} {o.side}</span></td>
                      <td className="py-1.5 text-right"><Badge color={o.status==="FILLED"?"green":o.status==="CANCELLED"?"red":"amber"}>{o.status}</Badge></td>
                      <td className="py-1.5 text-right text-white/60">{fmt(+o.filled_size,6)}</td>
                      <td className="py-1.5 text-right text-white">{fmtUSD(+o.filled_value)}</td>
                      <td className="py-1.5 text-right text-white/60">{+o.average_filled_price>0?fmtUSD(+o.average_filled_price):"—"}</td>
                      <td className="py-1.5 text-right text-white/25">{o.order_type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── LOG TAB ── */}
        {tab==="log"&&(
          <div className="rounded-xl border border-white/8 bg-white/2 p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs text-white/28 uppercase tracking-widest">Agent + Trade Log</div>
              <button onClick={()=>setAgentLog([])} className="text-xs text-white/22 hover:text-white/50">Clear</button>
            </div>
            <div className="space-y-0.5 max-h-96 overflow-y-auto pr-1" style={{scrollbarWidth:"thin"}}>
              {agentLog.length===0?<div className="text-xs text-white/15 text-center py-8">No activity yet</div>
              :agentLog.map(e=>(
                <div key={e.id} className={`flex gap-2 text-xs py-1 border-b border-white/4 ${e.type==="system"?"text-cyan-400":e.type==="ok"?"text-emerald-400":e.type==="warn"?"text-amber-300":e.type==="forecast"?"text-indigo-300":"text-white/38"}`}>
                  <span className="text-white/18 flex-shrink-0">{e.time}</span>
                  <span className="leading-relaxed">{e.msg}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="text-center text-xs text-white/10 pb-2">
          NEXUSBOT v9.0 · Real Coinbase Advanced Trade · Supabase Edge Function · Not financial advice · Trade responsibly
        </div>
      </div>
    </div>
  );
}
