"""
Long-Short Strategy — Local Data Server
Turtlewealth | Growth Mantra PMS
-----------------------------------------
Serves yfinance OHLCV + runs backtests via local REST API.

Setup:
    pip install flask flask-cors yfinance pandas openpyxl
    python server.py

Endpoints:
    GET  /api/ohlcv?ticker=^NSEI&start=2020-01-01
    POST /api/backtest   body: {ticker, start, rounding, offset, lot_size}
    POST /api/sweep      body: {ticker, start, roundings, offsets, lot_size}
    GET  /api/tickers
    GET  /health
"""

import sys
import pandas as pd
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # allow file:// and Vite localhost:5173

try:
    from backtest_engine import load_yfinance, run_backtest, parameter_sweep
except ImportError as e:
    print(f"ERROR: Cannot import backtest_engine.py — {e}")
    print("Keep server.py in the same folder as backtest_engine.py")
    sys.exit(1)

SUPPORTED_TICKERS = {
    "^NSEI":    "Nifty 50",
    "^NSEBANK": "BankNifty",
    "GC=F":     "Gold (MCX proxy)",
    "SI=F":     "Silver (MCX proxy)",
    "^BSESN":   "Sensex",
}


@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'server': 'Turtlewealth Backtest Server'})


@app.route('/api/tickers')
def tickers():
    return jsonify(SUPPORTED_TICKERS)


@app.route('/api/ohlcv')
def ohlcv():
    ticker = request.args.get('ticker', '^NSEI')
    start  = request.args.get('start',  '2020-01-01')
    end    = request.args.get('end',    None)
    try:
        df = load_yfinance(ticker, start, end)
        data = []
        for dt, row in df.iterrows():
            data.append({
                'date':   dt.strftime('%Y-%m-%d'),
                'open':   round(float(row['open']),  2),
                'high':   round(float(row['high']),  2),
                'low':    round(float(row['low']),   2),
                'close':  round(float(row['close']), 2),
                'volume': int(row.get('volume', 0)),
            })
        return jsonify({'ticker': ticker, 'rows': len(data), 'data': data})
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/backtest', methods=['POST'])
def backtest():
    b        = request.get_json(force=True)
    ticker   = b.get('ticker',   '^NSEI')
    start    = b.get('start',    '2020-01-01')
    rounding = int(b.get('rounding', 500))
    offset   = float(b.get('offset',   10))
    lot_size = int(b.get('lot_size',    1))
    ohlcv    = b.get('ohlcv',    None)
    try:
        if ohlcv and len(ohlcv) > 0:
            # Custom data uploaded from frontend
            df = pd.DataFrame(ohlcv)
            # Handle excel serial numbers or string dates
            def parse_date(x):
                if isinstance(x, (int, float)) or (isinstance(x, str) and x.replace('.','',1).isdigit()):
                    # Excel serial date
                    return pd.to_datetime(float(x), unit='D', origin='1899-12-30')
                return pd.to_datetime(x, dayfirst=True)
            
            df['date'] = df['date'].apply(parse_date)
            df = df.set_index('date').sort_index()
            for col in ['open', 'high', 'low', 'close']:
                df[col] = pd.to_numeric(df[col], errors='coerce')
            df = df.dropna(subset=['open', 'high', 'low', 'close'])
        else:
            df = load_yfinance(ticker, start)
        result = run_backtest(df, start, rounding, offset, ticker, lot_size)
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/sweep', methods=['POST'])
def sweep():
    b         = request.get_json(force=True)
    ticker    = b.get('ticker',    '^NSEI')
    start     = b.get('start',     '2020-01-01')
    roundings = b.get('roundings', [250, 500, 750, 1000])
    offsets   = b.get('offsets',   [5, 10, 15, 20])
    lot_size  = int(b.get('lot_size', 1))
    ohlcv     = b.get('ohlcv',     None)
    try:
        if ohlcv and len(ohlcv) > 0:
            df = pd.DataFrame(ohlcv)
            def parse_date(x):
                if isinstance(x, (int, float)) or (isinstance(x, str) and x.replace('.','',1).isdigit()):
                    return pd.to_datetime(float(x), unit='D', origin='1899-12-30')
                return pd.to_datetime(x, dayfirst=True)
            df['date'] = df['date'].apply(parse_date)
            df = df.set_index('date').sort_index()
            for col in ['open', 'high', 'low', 'close']:
                df[col] = pd.to_numeric(df[col], errors='coerce')
            df = df.dropna(subset=['open', 'high', 'low', 'close'])
        else:
            df = load_yfinance(ticker, start)
            
        result = parameter_sweep(df, start, roundings, offsets, ticker)
        return jsonify(result.to_dict(orient='records'))
    except Exception as e:
        return jsonify({'error': str(e)}), 400


if __name__ == '__main__':
    print("=" * 55)
    print("  Turtlewealth Backtest Server — localhost:5000")
    print("=" * 55)
    print("  GET  /api/ohlcv?ticker=^NSEI&start=2020-01-01")
    print("  POST /api/backtest  {ticker,start,rounding,offset}")
    print("  POST /api/sweep     {ticker,start,roundings,offsets}")
    print("  GET  /api/tickers")
    print("=" * 55)
    app.run(host='0.0.0.0', port=5000, debug=False)
