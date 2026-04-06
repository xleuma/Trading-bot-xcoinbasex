# Trading-bot-xcoinbasex
Automated crypto trading bot with ML and ai agents making market decisions
# 🛡️ NEXUSBOT v9.0 — Autonomous Coinbase Trader

NexusBot is a high-frequency, multi-agent AI trading system designed for **Coinbase Advanced Trade**. It utilizes a hierarchical architecture of five Claude-powered agents and a self-tuning Machine Learning (ML) model to execute live trades based on real-time market sentiment, on-chain metrics, and technical analysis.

---

### ⚠️ IMPORTANT FINANCIAL DISCLAIMER

**THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.** Trading cryptocurrencies involves substantial risk of loss and is not suitable for every investor. The valuation of cryptocurrencies may fluctuate, and as a result, clients may lose more than their original investment. 

**This bot executes REAL trades on REAL Coinbase accounts.** By using this software, you acknowledge that:
* You are solely responsible for any financial losses incurred.
* Past performance of the included algorithms is not indicative of future results.
* You should never trade with capital you cannot afford to lose.
* The authors and contributors are not liable for any damages or losses.

---

## 🤖 System Architecture

NexusBot operates using a **Commander-Subordinate Hierarchy**:

1.  **Specialized Agents:** Four independent agents (News, Social, Market, and On-Chain) scrape live data from CryptoPanic, Reddit, CoinGecko, and Etherscan.
2.  **Forecast Agent (The Commander):** Synthesizes all sub-agent intelligence into a unified sentiment score and per-algorithm recommendations.
3.  **Auditor Agent (The Meta-Learner):** Runs every hour to review trade history and ML accuracy, dynamically retuning the Learning Rate ($lr$) and feature weights.
4.  **ML Model:** A 10-feature neural-weighted system that executes trades based on the "cleaned" signals from the agent hierarchy.

## ⚙️ Setup & Installation

### 1. Supabase Edge Function
To keep your Coinbase API keys secure, this bot requires a server-side proxy.
* Deploy a Supabase Edge Function (e.g., `coinbase-proxy`).
* Store your `CB_API_KEY` and `CB_API_SECRET` in Supabase Secrets.
* Ensure the function handles HMAC SHA256 signing for Coinbase Advanced Trade.

### 2. Environment Variables
In your frontend hosting environment (e.g., Lovable, Vercel, or Local), set:
`VITE_SUPABASE_FUNCTION_URL=https://your-project.supabase.co/functions/v1/coinbase-proxy`

### 3. Local Development
```bash
npm install
npm run dev
