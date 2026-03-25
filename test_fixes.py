"""
Comparison test: OLD engine vs NEW (fixed) engine.
Downloads Nifty 50 data and runs both side-by-side.
"""
import math, sys, os

# Add the engine folder to path
engine_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'python + html')
sys.path.insert(0, engine_dir)

import pandas as pd
from backtest_engine import load_yfinance, run_backtest as run_new, compute_metrics

# ── OLD ENGINE (pre-fix copy) ─────────────────────────────
def round_floor(price, rounding):
    return math.floor(price / rounding) * rounding

def round_ceil(price, rounding):
    return math.ceil(price / rounding) * rounding

def run_old(df, start_date, rounding, offset, lot_size=1):
    start_dt = pd.to_datetime(start_date)
    df = df[df.index >= start_dt].copy()
    if df.empty:
        return {'trades': [], 'metrics': None}

    trades = []
    state = 'FLAT'
    position_units = 0
    entry_price = entry_date = active_level = None
    anchor_done = False
    anchor_floor = anchor_ceil = None
    trade_id = 0
    cumulative_pnl = 0.0

    for dt, row in df.iterrows():
        h, l, c = float(row['high']), float(row['low']), float(row['close'])

        if not anchor_done:
            anchor_floor = round_floor(c, rounding)
            anchor_ceil  = round_ceil(c, rounding)
            if anchor_ceil == anchor_floor:
                anchor_ceil += rounding
            anchor_done = True
            continue

        if state == 'FLAT':
            uT, dT = anchor_ceil + offset, anchor_floor - offset
            if h >= uT:
                state = 'LONG'; position_units = 1
                entry_price = uT; entry_date = dt; trade_id += 1
                active_level = round_floor(l, rounding)
            elif l <= dT:
                state = 'SHORT'; position_units = 1
                entry_price = dT; entry_date = dt; trade_id += 1
                active_level = round_ceil(h, rounding)

        elif state == 'LONG':
            snapshot = active_level
            dT = snapshot - offset
            if l <= dT:
                exit_price = dT
                pnl = (exit_price - entry_price) * position_units * lot_size
                trades.append({
                    'trade_id': trade_id, 'direction': 'LONG',
                    'entry_date': entry_date.strftime('%Y-%m-%d'),
                    'entry_price': entry_price,
                    'exit_date': dt.strftime('%Y-%m-%d'),
                    'exit_price': exit_price,
                    'units': position_units,
                    'pnl_points': round(exit_price - entry_price, 2),
                    'pnl': round(pnl, 2),
                    'days_held': (dt - entry_date).days,
                })
                cumulative_pnl += pnl
                state = 'SHORT'; position_units = 2
                entry_price = exit_price; entry_date = dt; trade_id += 1
                active_level = round_ceil(h, rounding)
            else:
                nf = round_floor(l, rounding)
                if nf > active_level:
                    active_level = nf

        elif state == 'SHORT':
            snapshot = active_level
            uT = snapshot + offset
            if h >= uT:
                exit_price = uT
                pnl = (entry_price - exit_price) * position_units * lot_size
                trades.append({
                    'trade_id': trade_id, 'direction': 'SHORT',
                    'entry_date': entry_date.strftime('%Y-%m-%d'),
                    'entry_price': entry_price,
                    'exit_date': dt.strftime('%Y-%m-%d'),
                    'exit_price': exit_price,
                    'units': position_units,
                    'pnl_points': round(entry_price - exit_price, 2),
                    'pnl': round(pnl, 2),
                    'days_held': (dt - entry_date).days,
                })
                cumulative_pnl += pnl
                state = 'LONG'; position_units = 2
                entry_price = exit_price; entry_date = dt; trade_id += 1
                active_level = round_floor(l, rounding)
            else:
                nc = round_ceil(h, rounding)
                if nc < active_level:
                    active_level = nc

    return {'trades': trades, 'metrics': compute_metrics(trades) if trades else None}


# ── COMPARE ───────────────────────────────────────────────
if __name__ == '__main__':
    ticker = '^NSEI'
    start  = '2020-01-01'
    rounding = 500
    offset = 10
    lot_size = 1

    print("=" * 65)
    print("  OLD vs NEW Engine Comparison")
    print("=" * 65)
    print(f"  Ticker: {ticker} | Start: {start} | R={rounding} | Offset={offset}")
    print()

    df = load_yfinance(ticker, start)

    old = run_old(df, start, rounding, offset, lot_size)
    new = run_new(df, start, rounding, offset, ticker, lot_size)

    old_trades = old['trades']
    new_trades = new['trades']
    old_m = old['metrics']
    new_m = new['metrics']

    print(f"  {'Metric':<25} {'OLD':>12} {'NEW':>12} {'Delta':>12}")
    print("  " + "-" * 61)
    for key in ['total_trades', 'win_rate', 'profit_factor', 'total_pnl_points',
                'expectancy_points', 'max_drawdown_points', 'avg_days_held',
                'long_pnl', 'short_pnl']:
        ov = old_m.get(key, 'N/A') if old_m else 'N/A'
        nv = new_m.get(key, 'N/A') if new_m else 'N/A'
        if isinstance(ov, (int, float)) and isinstance(nv, (int, float)):
            delta = round(nv - ov, 2)
            delta_str = f"{'+' if delta >= 0 else ''}{delta}"
        else:
            delta_str = '—'
        print(f"  {key:<25} {str(ov):>12} {str(nv):>12} {delta_str:>12}")

    # Find divergent trades
    print()
    print("  DIVERGENT TRADES (entry/exit price changed):")
    print("  " + "-" * 61)
    max_show = min(len(old_trades), len(new_trades))
    divergent_count = 0
    for i in range(max_show):
        ot, nt = old_trades[i], new_trades[i]
        if (ot['entry_price'] != nt['entry_price'] or
            ot['exit_price'] != nt['exit_price'] or
            ot['direction'] != nt['direction']):
            divergent_count += 1
            print(f"  Trade #{ot['trade_id']}: {ot['direction']} "
                  f"Entry {ot['entry_price']}->{nt['entry_price']}  "
                  f"Exit {ot['exit_price']}->{nt['exit_price']}  "
                  f"PnL {ot['pnl_points']}->{nt['pnl_points']}")
            if divergent_count >= 15:
                print(f"  ... ({max_show - i - 1} more trades not shown)")
                break

    if divergent_count == 0:
        print("  No divergent trades found (no gaps in this dataset).")
    else:
        print(f"\n  Total divergent trades: {divergent_count} out of {max_show}")

    if len(old_trades) != len(new_trades):
        print(f"\n  ⚠ Trade count differs: OLD={len(old_trades)} NEW={len(new_trades)}")
        print(f"    (Flaw 2 fix may reorder FLAT state entries, causing different trade sequences)")

    print("\n" + "=" * 65)
