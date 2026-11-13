# Betfair Real-Money Bot Skeleton

This is a proper real-money trading/value-betting skeleton for the Betfair Exchange (Australia), designed to start with a $1000 bankroll and compound wins via percentage staking.

**CRITICAL WARNINGS:**
- This is not financial advice. Most automated systems lose money.
- You can lose your entire $1000 (or more).
- Only risk capital you can afford to lose.
- Australian regulations: No in-play sports betting via API (phone only). Racing is generally allowed.
- Betfair takes 2-5%+ commission on net winnings (higher on some AU racing). Premium/Expert Charge may apply at high profits.
- Start with the delayed (developer) app key and tiny stakes or paper mode. Test thoroughly.
- Markets are competitive. Genuine positive edge after costs is hard and rare.

## Setup (Betfair Australia)
1. Open a Betfair Australia account and deposit funds (start with $1000 or less).
2. Get an Application Key: Follow https://www.betfair.com.au/hub/automation/betting-api/ or the Automation Hub. Delayed key for testing (has betting but delayed prices); apply for live when ready.
3. Generate SSL certificates for non-interactive login (recommended for bots). Or use interactive login for initial tests.
4. Create a `.env` file (copy from `.env.example`) with your username, password, app_key, and certs path.
5. `pip install -r requirements.txt`

## Running
```bash
python bot.py
```

It will log in, list upcoming AU horse racing WIN markets, demonstrate percentage staking calculation, and have placeholders for edge detection and order placement.

**Customize the strategy** in `check_edge()` and related functions. The current version is a skeleton only — replace the dummy logic with your own model (form, ratings, market microstructure, etc.).

## Bankroll Compounding
Stakes are calculated as a percentage of the current available balance (default 1%). Wins increase future stakes; losses decrease them. Adjust `STAKE_PERCENT` carefully. Use fractional Kelly if you have a quantified edge.

## Next Steps
- Add real edge detection.
- Implement streaming for live prices.
- Add full risk management (daily loss limits, max exposure).
- Backtest on historical data where available.
- Paper trade extensively before scaling.

Use at your own risk. Track every bet. Review regularly.
