# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Backtester for a "Long-Short Rounding Strategy" (Turtlewealth | Growth Mantra PMS): a stop-and-reverse system that anchors floor/ceiling levels by rounding price to a fixed interval (e.g. 500 points), enters long/short when price crosses anchor ± offset, trails the active level bar-by-bar, and flips direction on stop-out. Positions are mark-to-market closed on the end date.

Note: the backend directory is literally named `python + html` (with spaces) — always quote it in shell commands.

## Commands

There is no requirements.txt. Backend dependencies:

```bash
pip install flask flask-cors yfinance pandas openpyxl
```

**Run the Flask backend** (port 5000; serves yfinance data + runs backtests):

```bash
cd "python + html" && python server.py
```

**Run the React frontend** (Vite dev server on port 5173):

```bash
cd frontend && npm install && npm run dev
```

Other frontend commands: `npm run build`, `npm run lint` (ESLint), `npm run preview`. On Windows, `start.bat` launches both servers.

**Run the engine directly (CLI)**:

```bash
cd "python + html"
python backtest_engine.py --ticker ^NSEI --rounding 500 --offset 10
python backtest_engine.py --sweep            # parameter sweep
python backtest_engine.py --file data.csv    # local CSV/Excel instead of yfinance
```

**Tests**: no pytest suite. `python test_fixes.py` (from repo root) runs an old-vs-new engine comparison; it downloads Nifty data via yfinance, so it needs network access. `test_output.txt` is a saved run of it.

## Architecture

The strategy engine is implemented **four times**, and they must be kept in sync when strategy logic changes:

1. **`python + html/backtest_engine.py`** — the canonical Python engine. `run_backtest()` is the FLAT/LONG/SHORT state machine; `compute_metrics()` builds the stats dict (win rate, profit factor, max drawdown, drawdown durations, etc.); `parameter_sweep()` grids rounding × offset. Also a CLI.
2. **`frontend/src/App.jsx`** — the React dashboard contains a full JS port (`runEngine` + `calcM`) used when the Flask server is offline or when the user uploads their own CSV/Excel/JSON data. When the server is up and no file is uploaded, it POSTs to the server instead.
3. **`LongShortBacktest.jsx`** (repo root) — a standalone single-file copy of the React component that `frontend/src/App.jsx` mirrors. Edits to one usually belong in the other.
4. **`python + html/backtest_dashboard.html`** — a self-contained HTML dashboard (Chart.js + SheetJS via CDN) that calls the Flask server at `localhost:5000`.

**`python + html/server.py`** is a thin Flask REST layer over the engine: `GET /health`, `GET /api/tickers`, `GET /api/ohlcv`, `POST /api/backtest`, `POST /api/sweep`. Backtest/sweep requests may include an `ohlcv` array of uploaded rows, which bypasses yfinance; that path parses Excel serial dates and day-first date strings.

### Strategy-logic invariants ("flaws" fixed in the current engine)

The engine comments reference three deliberate fixes — preserve them in all four implementations:

- **Flaw 1 (gap-fill)**: entries/exits execute at `max(open, trigger)` for longs and `min(open, trigger)` for shorts, so overnight gaps fill at the open, not the trigger.
- **Flaw 2 (both triggers hit while FLAT)**: direction is chosen by which trigger the open is closer to.
- **Flaw 3 (flip cap)**: at most one flip per bar (`flipped_today`).

Other invariants: the first bar only sets the anchor (no trade); trade PnL is `pnl_points × units × lot_size`; open positions are force-closed at the last close with exit_date suffixed `" (End)"`; timezone-aware indexes are stripped (`tz_localize(None)`) before filtering — recent bug fixes were about tz handling of hourly uploads, so be careful there.

### Data files

`python + html/original files/` holds TradingView CSV exports (daily/weekly/monthly) and `python + html/upload files/` holds Excel files used to test the upload path. These are fixtures, not code.
