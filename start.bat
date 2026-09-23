@echo off
title Combo Solver server - keep this window open while playing
cd /d "%~dp0"
start "" http://localhost:8420
echo Combo Solver server is running. Minimize this window, but do NOT close it while playing.
python -m http.server 8420
