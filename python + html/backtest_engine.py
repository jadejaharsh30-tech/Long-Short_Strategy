"""
Long-Short Rounding Strategy — Backtest Engine
Turtlewealth | Growth Mantra PMS
------------------------------------------------
Usage:
    python backtest_engine.py                                         # Nifty defaults
    python backtest_engine.py --ticker ^NSEBANK                      # BankNifty
    python backtest_engine.py --ticker ^NSEI --rounding 500 --offset 10
    python backtest_engine.py --sweep                                 # parameter sweep
    python backtest_engine.py --file data.csv                        # from local file
"""

import math, json, argparse, sys
import pandas as pd
from typing import Optional


# ─────────────────────────────────────────────
# Rounding helpers
# ─────────────────────────────────────────────

def round_floor(price: float, rounding: int) -> float:
    return math.floor(price / rounding) * rounding

def round_ceil(price: float, rounding: int) -> float:
    return math.ceil(price / rounding) * rounding


# ─────────────────────────────────────────────
# Data loaders
# ─────────────────────────────────────────────

TICKER_MAP = {
    "nifty":     "^NSEI",
    "banknifty": "^NSEBANK",
    "gold":      "GC=F",
    "silver":    "SI=F",
}

def load_yfinance(ticker: str, start: str, end: Optional[str] = None) -> pd.DataFrame:
    try:
        import yfinance as yf
    except ImportError:
        raise ImportError("Run: pip install yfinance")

    ticker = TICKER_MAP.get(ticker.lower(), ticker)
    print(f"  Fetching {ticker} from {start} via yfinance...")
    df = yf.download(ticker, start=start, end=end, auto_adjust=True, progress=False)
    if df.empty:
        raise ValueError(f"No data for {ticker}. Check ticker symbol.")

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0].lower() for c in df.columns]
    else:
        df.columns = [c.lower() for c in df.columns]

    df.index = pd.to_datetime(df.index)
    df = df[['open', 'high', 'low', 'close', 'volume']].dropna()
    print(f"  Loaded {len(df)} rows  ({df.index[0].date()} to {df.index[-1].date()})")
    return df


def load_file(filepath: str) -> pd.DataFrame:
    raw = pd.read_csv(filepath) if filepath.endswith('.csv') else pd.read_excel(filepath)
    raw.columns = [c.strip().lower() for c in raw.columns]
    raw['date'] = pd.to_datetime(raw['date'])
    raw = raw.set_index('date').sort_index()
    cols = ['open', 'high', 'low', 'close'] + (['volume'] if 'volume' in raw.columns else [])
    return raw[cols].dropna()


# ─────────────────────────────────────────────
# Core engine
# ─────────────────────────────────────────────

def run_backtest(df: pd.DataFrame, start_date: str, end_date: str, rounding: int,
                 offset: float, instrument_name: str = 'Instrument',
                 lot_size: int = 1) -> dict:

    if df.index.tz is not None:
        df.index = df.index.tz_localize(None)

    start_dt = pd.to_datetime(start_date)
    if end_date:
        end_dt = pd.to_datetime(end_date)
        df = df[(df.index >= start_dt) & (df.index <= end_dt)].copy()
    else:
        df = df[df.index >= start_dt].copy()
    if df.empty:
        raise ValueError(f"No data from {start_date} onwards.")

    trades, daily_log = [], []
    state = 'FLAT'
    position_units = 0
    entry_price = entry_date = active_level = None
    anchor_done = False
    anchor_floor = anchor_ceil = None
    trade_id = 0
    cumulative_pnl = 0.0

    for dt, row in df.iterrows():
        o, h, l, c = float(row['open']), float(row['high']), float(row['low']), float(row['close'])
        day_log = {
            'date': dt.strftime('%Y-%m-%d'),
            'open': round(o, 2), 'high': round(h, 2),
            'low':  round(l, 2), 'close': round(c, 2),
            'state': state, 'active_level': active_level,
            'action': None, 'trade_id': None,
            'units': position_units, 'cumulative_pnl': round(cumulative_pnl, 2),
        }

        if not anchor_done:
            anchor_floor = round_floor(c, rounding)
            anchor_ceil  = round_ceil(c, rounding)
            if anchor_ceil == anchor_floor:
                anchor_ceil += rounding
            anchor_done = True
            day_log['action'] = f'ANCHOR: Floor={anchor_floor} Ceil={anchor_ceil}'
            day_log['active_level'] = f'{anchor_floor}/{anchor_ceil}'
            daily_log.append(day_log)
            continue

        flipped_today = False  # Flaw 3: cap to 1 flip per day

        if state == 'FLAT':
            uT, dT = anchor_ceil + offset, anchor_floor - offset
            day_log['active_level'] = f'{anchor_floor}/{anchor_ceil}'
            hit_up   = h >= uT
            hit_down = l <= dT

            # Flaw 2: both triggers hit → use open proximity to decide order
            go_long_first = True
            if hit_up and hit_down:
                go_long_first = abs(o - uT) <= abs(o - dT)

            if hit_up and (go_long_first or not hit_down):
                state = 'LONG'; position_units = 1
                entry_price = max(o, uT)  # Flaw 1: gap-fill
                entry_date = dt; trade_id += 1
                active_level = round_floor(l, rounding)
                day_log.update({'state': state, 'active_level': active_level,
                                'action': f'ENTER LONG @ {entry_price}',
                                'trade_id': trade_id, 'units': 1})
            elif hit_down:
                state = 'SHORT'; position_units = 1
                entry_price = min(o, dT)  # Flaw 1: gap-fill
                entry_date = dt; trade_id += 1
                active_level = round_ceil(h, rounding)
                day_log.update({'state': state, 'active_level': active_level,
                                'action': f'ENTER SHORT @ {entry_price}',
                                'trade_id': trade_id, 'units': 1})
            else:
                day_log['action'] = f'FLAT | Up={uT} Dn={dT}'

        elif state == 'LONG':
            snapshot = active_level
            dT = snapshot - offset
            if l <= dT:
                exit_price = min(o, dT)  # Flaw 1: gap-fill
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
                flipped_today = True
                state = 'SHORT'; position_units = 1
                entry_price = exit_price; entry_date = dt; trade_id += 1
                active_level = round_ceil(h, rounding)
                day_log.update({'state': state, 'active_level': active_level,
                                'action': f'FLIP->SHORT @ {exit_price}',
                                'trade_id': trade_id, 'units': 1})
            else:
                nf = round_floor(l, rounding)
                if nf > active_level:
                    active_level = nf
                day_log.update({'active_level': active_level,
                                'action': f'LONG | Floor={active_level} Trig={active_level-offset}',
                                'trade_id': trade_id})

        elif state == 'SHORT':
            snapshot = active_level
            uT = snapshot + offset
            if h >= uT:
                exit_price = max(o, uT)  # Flaw 1: gap-fill
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
                flipped_today = True
                state = 'LONG'; position_units = 1
                entry_price = exit_price; entry_date = dt; trade_id += 1
                active_level = round_floor(l, rounding)
                day_log.update({'state': state, 'active_level': active_level,
                                'action': f'FLIP->LONG @ {exit_price}',
                                'trade_id': trade_id, 'units': 1})
            else:
                nc = round_ceil(h, rounding)
                if nc < active_level:
                    active_level = nc
                day_log.update({'active_level': active_level,
                                'action': f'SHORT | Ceil={active_level} Trig={active_level+offset}',
                                'trade_id': trade_id})

        day_log['cumulative_pnl'] = round(cumulative_pnl, 2)
        day_log['flipped_today'] = flipped_today
        daily_log.append(day_log)

    # Force close any open position at the end date's close price (Mark to Market)
    if state != 'FLAT' and len(df) > 0:
        dt = df.index[-1]
        c = round(float(df.iloc[-1]['close']), 2)
        if state == 'LONG':
            pnl_pts = c - entry_price
        else:
            pnl_pts = entry_price - c
        pnl = pnl_pts * position_units * lot_size
        trades.append({
            'trade_id': trade_id, 'direction': state,
            'entry_date': entry_date.strftime('%Y-%m-%d'),
            'entry_price': entry_price,
            'exit_date': dt.strftime('%Y-%m-%d') + ' (End)',
            'exit_price': c,
            'units': position_units,
            'pnl_points': round(pnl_pts, 2),
            'pnl': round(pnl, 2),
            'days_held': max((dt - entry_date).days, 0),
        })

    return {
        'instrument': instrument_name,
        'params': {
            'ticker': instrument_name, 'start_date': start_date, 'end_date': end_date,
            'rounding': rounding, 'offset': offset,
            'lot_size': lot_size, 'total_days': len(df),
        },
        'trades': trades,
        'daily_log': daily_log,
        'metrics': compute_metrics(trades),
    }


# ─────────────────────────────────────────────
# Metrics
# ─────────────────────────────────────────────

def compute_metrics(trades: list) -> dict:
    if not trades:
        return {'error': 'No trades generated'}

    tdf = pd.DataFrame(trades)
    win = tdf[tdf['pnl_points'] > 0]
    los = tdf[tdf['pnl_points'] <= 0]
    lng = tdf[tdf['direction'] == 'LONG']
    sht = tdf[tdf['direction'] == 'SHORT']

    gp = win['pnl'].sum() if len(win) else 0
    gl = abs(los['pnl'].sum()) if len(los) else 0

    cum      = tdf['pnl'].cumsum()
    roll_max = cum.cummax()
    max_dd   = (cum - roll_max).min()

    def max_consec(lst, tgt):
        m = c = 0
        for b in lst:
            c = c + 1 if b == tgt else 0
            m = max(m, c)
        return m

    # Calculate Drawdown Durations (in days)
    drawdown_durations = []
    current_peak_val = 0
    current_peak_date = None
    
    cum_pnl = 0
    for _, t in tdf.iterrows():
        cum_pnl += t['pnl']
        try:
            exit_dt = pd.to_datetime(t['exit_date'])
        except Exception:
            exit_dt = None
            
        if exit_dt:
            if current_peak_date is None:
                current_peak_date = exit_dt
                current_peak_val = cum_pnl
            elif cum_pnl >= current_peak_val:
                dur = (exit_dt - current_peak_date).days
                if dur > 0:
                    drawdown_durations.append(dur)
                current_peak_val = cum_pnl
                current_peak_date = exit_dt
                
    if current_peak_date is not None and cum_pnl < current_peak_val:
        try:
            last_dt = pd.to_datetime(tdf.iloc[-1]['exit_date'])
            dur = (last_dt - current_peak_date).days
            if dur > 0:
                drawdown_durations.append(dur)
        except Exception:
            pass

    max_dd_dur = max(drawdown_durations) if drawdown_durations else 0
    avg_dd_dur = round(sum(drawdown_durations) / len(drawdown_durations)) if drawdown_durations else 0

    wins = (tdf['pnl_points'] > 0).tolist()
    return {
        'total_trades':        len(tdf),
        'win_rate':            round(len(win) / len(tdf) * 100, 2),
        'total_pnl_points':    round(tdf['pnl'].sum(), 2),
        'gross_profit':        round(gp, 2),
        'gross_loss':          round(gl, 2),
        'profit_factor':       round(gp / gl, 2) if gl > 0 else float('inf'),
        'expectancy_points':   round(tdf['pnl_points'].mean(), 2),
        'avg_win_points':      round(win['pnl_points'].mean(), 2) if len(win) else 0,
        'avg_loss_points':     round(los['pnl_points'].mean(), 2) if len(los) else 0,
        'max_win_points':      round(tdf['pnl_points'].max(), 2),
        'max_loss_points':     round(tdf['pnl_points'].min(), 2),
        'max_drawdown_points': round(max_dd, 2),
        'max_drawdown_duration': max_dd_dur,
        'avg_drawdown_duration': avg_dd_dur,
        'avg_days_held':       round(tdf['days_held'].mean(), 1),
        'max_consec_wins':     max_consec(wins, True),
        'max_consec_losses':   max_consec(wins, False),
        'long_trades':         len(lng),
        'short_trades':        len(sht),
        'long_win_rate':       round(len(lng[lng['pnl_points'] > 0]) / len(lng) * 100, 2) if len(lng) else 0,
        'short_win_rate':      round(len(sht[sht['pnl_points'] > 0]) / len(sht) * 100, 2) if len(sht) else 0,
        'long_pnl':            round(lng['pnl'].sum(), 2) if len(lng) else 0,
        'short_pnl':           round(sht['pnl'].sum(), 2) if len(sht) else 0,
    }


# ─────────────────────────────────────────────
# Parameter sweep
# ─────────────────────────────────────────────

def parameter_sweep(df, start_date, end_date, rounding_range, offset_range,
                    instrument_name='Instrument') -> pd.DataFrame:
    results = []
    for r in rounding_range:
        for o in offset_range:
            try:
                bt = run_backtest(df, start_date, end_date, r, o, instrument_name)
                m  = bt['metrics']
                if 'error' not in m:
                    results.append({
                        'rounding': r, 'offset': o,
                        'total_trades':       m['total_trades'],
                        'win_rate':           m['win_rate'],
                        'profit_factor':      m['profit_factor'],
                        'total_pnl_points':   m['total_pnl_points'],
                        'expectancy_points':  m['expectancy_points'],
                        'max_drawdown_points':m['max_drawdown_points'],
                        'max_drawdown_duration':m.get('max_drawdown_duration', 0),
                        'avg_drawdown_duration':m.get('avg_drawdown_duration', 0),
                        'avg_days_held':      m['avg_days_held'],
                    })
            except Exception:
                pass
    return pd.DataFrame(results).sort_values('profit_factor', ascending=False)


# ─────────────────────────────────────────────
# JSON export
# ─────────────────────────────────────────────

def export_json(result: dict, filepath: str = 'backtest_result.json'):
    with open(filepath, 'w') as f:
        json.dump(result, f, indent=2, default=str)
    print(f"  Exported -> {filepath}")


# ─────────────────────────────────────────────
# CLI entry point
# ─────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Long-Short Rounding Strategy Backtest')
    parser.add_argument('--ticker',   default='^NSEI',             help='Yahoo ticker (default ^NSEI)')
    parser.add_argument('--start',    default='2020-01-01',        help='Start date YYYY-MM-DD')
    parser.add_argument('--rounding', default=500,   type=int,     help='Rounding interval')
    parser.add_argument('--offset',   default=10,    type=float,   help='Trigger offset')
    parser.add_argument('--lotsize',  default=1,     type=int,     help='Lot size multiplier')
    parser.add_argument('--out',      default='backtest_result.json', help='Output JSON filename')
    parser.add_argument('--file',     default=None,                help='Load from CSV/Excel file')
    parser.add_argument('--sweep',    action='store_true',         help='Run parameter sweep')
    args = parser.parse_args()

    print("=" * 60)
    print("  Long-Short Rounding Strategy — Backtest Engine")
    print("  Turtlewealth | Growth Mantra PMS")
    print("=" * 60)

    if args.file:
        print(f"\n  Loading from: {args.file}")
        df   = load_file(args.file)
        name = args.file.rsplit('/', 1)[-1].rsplit('.', 1)[0]
    else:
        df   = load_yfinance(args.ticker, args.start)
        name = args.ticker

    print(f"\n  Params: R={args.rounding} | Offset={args.offset} | Start={args.start} | End={args.end} | Lot={args.lotsize}\n")
    result = run_backtest(df, args.start, args.end, args.rounding, args.offset, name, args.lotsize)
    m = result['metrics']

    if 'error' in m:
        print(f"  {m['error']}")
        sys.exit(1)

    print(f"  Total Trades:      {m['total_trades']}")
    print(f"  Win Rate:          {m['win_rate']}%")
    print(f"  Profit Factor:     {m['profit_factor']}")
    print(f"  Total P&L Pts:     {m['total_pnl_points']}")
    print(f"  Expectancy Pts:    {m['expectancy_points']}")
    print(f"  Max Drawdown Pts:  {m['max_drawdown_points']}")
    print(f"  Avg Days Held:     {m['avg_days_held']}")
    print(f"  Long / Short:      {m['long_trades']} / {m['short_trades']}")

    export_json(result, args.out)

    if args.sweep:
        print("\n  Running parameter sweep (R=[250,500,750,1000] x Offset=[5,10,15,20])...")
        sweep = parameter_sweep(df, args.start, args.end,
                                rounding_range=[250, 500, 750, 1000],
                                offset_range=[5, 10, 15, 20],
                                instrument_name=name)
        print(sweep.to_string(index=False))
        sweep_path = args.out.replace('.json', '_sweep.csv')
        sweep.to_csv(sweep_path, index=False)
        print(f"\n  Sweep -> {sweep_path}")
