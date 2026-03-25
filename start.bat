@echo off
echo Starting Long-Short Backend...
start "Long-Short Backend" cmd /c "cd python + html && python server.py"
echo Starting Long-Short Frontend...
start "Long-Short Frontend" cmd /c "cd frontend && npm run dev"
echo Both servers have been started. 
echo 1. Keep the two terminal windows open.
echo 2. Open http://localhost:5173 in your browser to view the React dashboard.
pause
