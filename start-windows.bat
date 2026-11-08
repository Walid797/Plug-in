@echo off
chcp 65001 >nul
title Hoshmand Photo Studio
cd /d "%~dp0"
echo Hoshmand Photo Studio - starting local server (this computer only)...
where node >nul 2>nul && ( node server\serve.mjs & goto :eof )
where py >nul 2>nul && ( py -3 server\serve.py & goto :eof )
where python >nul 2>nul && ( python server\serve.py & goto :eof )
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\serve.ps1"
