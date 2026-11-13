#!/usr/bin/env python3
"""
Improved Betfair Australia bot skeleton.
- Fractional Kelly staking (compounds)
- EV calculation after commission
- Stricter market/price filters
- Placeholder model — replace estimate_probability() with real model
Focus: AU horse racing WIN markets.
"""

import os
import logging
from datetime import datetime, timedelta
from dotenv import load_dotenv
import betfairlightweight
from betfairlightweight import filters

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler("betfair_bot.log"), logging.StreamHandler()]
)
logger = logging.getLogger(__name__)

USERNAME = os.getenv("BF_USERNAME")
PASSWORD = os.getenv("BF_PASSWORD")
APP_KEY = os.getenv("BF_APP_KEY")
CERTS = os.getenv("BF_CERTS_PATH") or None

# Strategy params
KELLY_FRACTION = float(os.getenv("KELLY_FRACTION", "0.25"))  # 1/4 Kelly
MIN_EDGE = float(os.getenv("MIN_EDGE", "0.03"))  # 3% min net edge after commission
COMMISSION = float(os.getenv("COMMISSION", "0.08"))  # AU racing typical
MAX_STAKE_PCT = float(os.getenv("MAX_STAKE_PCT", "0.03"))  # never more than 3%
MIN_STAKE = 2.0
PAPER_MODE = os.getenv("PAPER_MODE", "true").lower() == "true"

def get_client():
    client = betfairlightweight.APIClient(USERNAME, PASSWORD, app_key=APP_KEY, certs=CERTS)
    if CERTS:
        client.login()
    else:
        client.login_interactive()
    return client

def get_balance(trading):
    try:
        funds = trading.account.get_account_funds()
        return float(funds.available_to_bet_balance)
    except Exception as e:
        logger.error(f"Balance error: {e}")
        return 1000.0

def estimate_probability(runner, market_book):
    """
    PLACEHOLDER MODEL.
    Replace this with your real probability estimate (form, ratings, etc.).
    Currently returns implied probability (no edge).
    """
    if not runner.ex or not runner.ex.available_to_back:
        return 0.0
    best_back = runner.ex.available_to_back[0].price
    return 1.0 / best_back  # pure market implied — change this!

def calculate_ev(true_prob, odds, commission=COMMISSION):
    """Expected value per unit stake after commission on winnings."""
    if odds <= 1 or true_prob <= 0:
        return -1.0
    profit_on_win = (odds - 1) * (1 - commission)
    ev = true_prob * profit_on_win - (1 - true_prob)
    return ev

def kelly_stake_pct(true_prob, odds, commission=COMMISSION, fraction=KELLY_FRACTION):
    """Fractional Kelly percentage of bankroll."""
    b = (odds - 1) * (1 - commission)  # net odds
    q = 1 - true_prob
    full_kelly = (b * true_prob - q) / b if b > 0 else 0
    full_kelly = max(0.0, full_kelly)
    return min(full_kelly * fraction, MAX_STAKE_PCT)

def list_au_racing_markets(trading):
    now = datetime.utcnow()
    later = now + timedelta(hours=12)
    market_filter = filters.market_filter(
        event_type_ids=["7"],
        market_countries=["AU"],
        market_type_codes=["WIN"],
        market_start_time={
            "from": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "to": later.strftime("%Y-%m-%dT%H:%M:%SZ")
        }
    )
    catalogues = trading.betting.list_market_catalogue(
        filter=market_filter,
        market_projection=["MARKET_START_TIME", "RUNNER_DESCRIPTION", "EVENT"],
        sort="FIRST_TO_START",
        max_results=15
    )
    logger.info(f"Found {len(catalogues)} upcoming AU racing WIN markets")
    return catalogues

def evaluate_and_bet(trading, market_id, balance):
    books = trading.betting.list_market_book(
        market_ids=[market_id],
        price_projection=filters.price_projection(price_data=["EX_BEST_OFFERS"])
    )
    if not books:
        return
    book = books[0]

    for runner in book.runners:
        if not runner.ex or not runner.ex.available_to_back:
            continue
        best_back = runner.ex.available_to_back[0].price
        if not (2.5 <= best_back <= 12.0):  # mid-range focus
            continue

        true_p = estimate_probability(runner, book)
        ev = calculate_ev(true_p, best_back)
        if ev < MIN_EDGE:
            continue

        stake_pct = kelly_stake_pct(true_p, best_back)
        stake = max(MIN_STAKE, balance * stake_pct)
        stake = min(stake, balance * MAX_STAKE_PCT, balance - 1)

        logger.info(
            f"OPPORTUNITY: sel={runner.selection_id} odds={best_back:.2f} "
            f"true_p={true_p:.3f} EV={ev:.3f} stake=${stake:.2f} ({stake_pct*100:.2f}%)"
        )

        if PAPER_MODE:
            logger.info("[PAPER] Order not placed")
        else:
            # Real order
            limit_order = filters.limit_order(
                size=round(stake, 2), price=best_back, persistence_type="LAPSE"
            )
            instruction = filters.place_instruction(
                order_type="LIMIT", selection_id=runner.selection_id,
                side="BACK", limit_order=limit_order
            )
            result = trading.betting.place_orders(
                market_id=market_id, instructions=[instruction]
            )
            logger.info(f"Order status: {result.status}")
        return  # one bet per market for this demo

def main():
    if not all([USERNAME, PASSWORD, APP_KEY]):
        logger.error("Set BF_USERNAME, BF_PASSWORD, BF_APP_KEY in .env")
        return

    trading = get_client()
    logger.info("Logged in")

    balance = get_balance(trading)
    logger.info(f"Balance: ${balance:.2f} | Kelly fraction: {KELLY_FRACTION} | Min edge: {MIN_EDGE*100}%")

    markets = list_au_racing_markets(trading)
    for cat in markets[:8]:
        logger.info(f"Checking {cat.market_name} ({cat.market_id})")
        evaluate_and_bet(trading, cat.market_id, balance)

    trading.logout()
    logger.info("Session complete. Replace estimate_probability() with a real model for actual edge.")

if __name__ == "__main__":
    main()
