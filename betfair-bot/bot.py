#!/usr/bin/env python3
"""
Betfair Australia real-money bot skeleton.
Starts with ~$1000 bankroll, uses percentage staking to compound wins.
Skeleton only — replace edge logic with a real positive-EV strategy.
Focus: AU horse racing WIN markets (pre-race preferred).
"""

import os
import logging
from dotenv import load_dotenv
import betfairlightweight
from betfairlightweight import filters

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

USERNAME = os.getenv("BF_USERNAME")
PASSWORD = os.getenv("BF_PASSWORD")
APP_KEY = os.getenv("BF_APP_KEY")
CERTS = os.getenv("BF_CERTS_PATH")
STAKE_PERCENT = float(os.getenv("STAKE_PERCENT", "0.01"))
MAX_STAKE = float(os.getenv("MAX_STAKE", "10"))

def get_client():
    if CERTS:
        return betfairlightweight.APIClient(USERNAME, PASSWORD, app_key=APP_KEY, certs=CERTS)
    else:
        # Interactive login fallback (less secure for unattended bots)
        client = betfairlightweight.APIClient(USERNAME, PASSWORD, app_key=APP_KEY)
        client.login_interactive()
        return client

def get_balance(trading):
    """Get current available to bet balance (AUD)."""
    try:
        funds = trading.account.get_account_funds()
        return float(funds.available_to_bet_balance)
    except Exception as e:
        logger.error(f"Failed to get balance: {e}")
        return 1000.0  # fallback for demo

def calculate_stake(balance):
    """Percentage of bankroll, capped."""
    stake = balance * STAKE_PERCENT
    return min(stake, MAX_STAKE)

def list_au_racing_markets(trading):
    """List upcoming AU horse racing WIN markets."""
    racing_filter = filters.market_filter(
        event_type_ids=["7"],  # Horse Racing
        market_countries=["AU"],
        market_type_codes=["WIN"],
        # Add more filters as needed: market_start_time, etc.
    )
    catalogues = trading.betting.list_market_catalogue(
        filter=racing_filter,
        market_projection=["MARKET_START_TIME", "RUNNER_DESCRIPTION", "EVENT"],
        max_results=20,
        sort="FIRST_TO_START",
    )
    logger.info(f"Found {len(catalogues)} AU racing WIN markets")
    for cat in catalogues:
        logger.info(f"{cat.market_id}: {cat.market_name} @ {cat.market_start_time}")
    return catalogues

def check_edge(market_book, runner):
    """
    Placeholder edge check. Replace with real model.
    Example: only consider if best back price is in a reasonable range.
    Returns True if we want to bet this runner.
    """
    if not runner.ex or not runner.ex.available_to_back:
        return False
    best_back = runner.ex.available_to_back[0].price
    # Dummy: bet if price between 2.0 and 4.0 (example only — NOT a real edge)
    return 2.0 <= best_back <= 4.0

def place_back_order(trading, market_id, selection_id, stake, price):
    """Place a limit back order."""
    limit_order = filters.limit_order(size=round(stake, 2), price=price, persistence_type="LAPSE")
    instruction = filters.place_instruction(
        order_type="LIMIT",
        selection_id=selection_id,
        side="BACK",
        limit_order=limit_order,
    )
    try:
        result = trading.betting.place_orders(market_id=market_id, instructions=[instruction])
        logger.info(f"Order result: {result.status}")
        return result
    except Exception as e:
        logger.error(f"Place order failed: {e}")
        return None

def main():
    if not all([USERNAME, PASSWORD, APP_KEY]):
        logger.error("Missing credentials in .env. See .env.example")
        return

    trading = get_client()
    trading.login()
    logger.info("Logged in successfully")

    balance = get_balance(trading)
    logger.info(f"Current balance: ${balance:.2f}")
    stake = calculate_stake(balance)
    logger.info(f"Next stake size ({STAKE_PERCENT*100}%): ${stake:.2f}")

    markets = list_au_racing_markets(trading)
    if not markets:
        logger.info("No markets found")
        trading.logout()
        return

    # Demo: look at first market
    first = markets[0]
    books = trading.betting.list_market_book(
        market_ids=[first.market_id],
        price_projection=filters.price_projection(price_data=["EX_BEST_OFFERS"]),
    )
    if books:
        book = books[0]
        logger.info(f"Examining {first.market_name}")
        for runner in book.runners:
            if check_edge(book, runner):
                best_price = runner.ex.available_to_back[0].price if runner.ex.available_to_back else None
                logger.info(f"Edge placeholder matched on runner {runner.selection_id} @ {best_price}")
                # Uncomment to actually place (DANGEROUS — use tiny stake / paper first)
                # place_back_order(trading, first.market_id, runner.selection_id, stake, best_price)
                break

    trading.logout()
    logger.info("Done. Customize check_edge() with a real strategy before enabling live orders.")

if __name__ == "__main__":
    main()
