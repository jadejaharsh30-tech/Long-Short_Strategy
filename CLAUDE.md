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

The strategy engine is implemented **three times**, and strategy-logic changes must be applied to all of them:

1. **`python + html/backtest_engine.py`** — the canonical Python engine. `run_backtest()` is the FLAT/LONG/SHORT state machine; `compute_metrics()` builds the stats dict (win rate, profit factor, max drawdown, drawdown durations, etc.); `parameter_sweep()` grids rounding × offset. Also a CLI.
2. **`frontend/src/App.jsx`** — the React dashboard contains a full JS port (`runEngine` + `calcM`) used when the Flask server is offline or when the user uploads their own CSV/Excel/JSON data. When the server is up and no file is uploaded, it POSTs to the server instead.
3. **`LongShortBacktest.jsx`** (repo root) — a standalone single-file variant of the React component. It is NOT an exact mirror of `App.jsx`: the two have diverged (see below). Determine which one the user cares about before porting a change.

**`python + html/backtest_dashboard.html`** is a fourth UI (Chart.js + SheetJS via CDN) but has **no local engine** — it always POSTs to the Flask server at `localhost:5000`, including for uploaded files (uploads go in the request body as `ohlcv` rows). The React app, by contrast, runs uploaded data through its local JS engine and never sends uploads to the server.

### Known divergences between the JS engines (as of the current HEAD)

- `frontend/src/App.jsx`'s `runEngine` is **missing the mark-to-market force-close** of open positions at the end date; both `backtest_engine.py` and `LongShortBacktest.jsx` have it. Expect one fewer trade and different totals from the local engine when a position is open at the end.
- Drawdown durations are computed differently: Python and `LongShortBacktest.jsx` use calendar days between trade exit dates; `App.jsx` counts bars in a per-bar `dailyPnL` series. The numbers are not comparable across implementations.

**`python + html/server.py`** is a thin Flask REST layer over the engine: `GET /health`, `GET /api/tickers`, `GET /api/ohlcv`, `POST /api/backtest`, `POST /api/sweep`. Backtest/sweep requests may include an `ohlcv` array of uploaded rows, which bypasses yfinance; that path parses Excel serial dates and day-first date strings.

### Strategy-logic invariants ("flaws" fixed in the current engine)

The engine comments reference three deliberate fixes — preserve them in all four implementations:

- **Flaw 1 (gap-fill)**: entries/exits execute at `max(open, trigger)` for longs and `min(open, trigger)` for shorts, so overnight gaps fill at the open, not the trigger.
- **Flaw 2 (both triggers hit while FLAT)**: direction is chosen by which trigger the open is closer to.
- **Flaw 3 (flip cap)**: at most one flip per bar (`flipped_today`).

Other invariants: the first bar only sets the anchor (no trade); trade PnL is `pnl_points × units × lot_size`; open positions are force-closed at the last close with exit_date suffixed `" (End)"`; timezone-aware indexes are stripped (`tz_localize(None)`) before filtering — recent bug fixes were about tz handling of hourly uploads, so be careful there.

### Data files

`python + html/original files/` holds TradingView CSV exports (daily/weekly/monthly) and `python + html/upload files/` holds Excel files used to test the upload path. These are fixtures, not code.

### Other gotchas

- `frontend/README.md` is the stock Vite template — ignore it; this file is the real documentation.
- Saved backtest comparisons (the "saved" tab) live only in React state — they are lost on page refresh.
- `python + html/__pycache__/*.pyc` and `test_output.txt` are git-tracked despite `.gitignore` covering them (committed before the ignore rule); don't let edits to them creep into diffs.
- Python's `compute_metrics` returns `profit_factor: float('inf')` when there are no losers, which serializes as bare `Infinity` in the JSON response; the JS engines use the string `"∞"`. Frontend code must handle both.
