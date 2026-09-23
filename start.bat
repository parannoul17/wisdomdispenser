@echo off
title Wisdom Dispenser server - keep this window open while playing
cd /d "%~dp0"
start "" http://localhost:8420
echo Wisdom Dispenser server is running. Minimize this window, but do NOT close it while playing.
python -m http.server 8420
