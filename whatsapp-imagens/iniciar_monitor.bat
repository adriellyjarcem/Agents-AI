@echo off
rem Deixa o monitor do grupo rodando. Se ele parar (sem internet, por exemplo), abre de novo em 30 s.
rem Na primeira vez: leia o QR code com o celular e escolha o grupo.
title Monitor - Informe Estoque Visual
cd /d "%~dp0"

set PY=
py -3 --version >nul 2>nul && set PY=py -3
if not defined PY (
  python --version >nul 2>nul && set PY=python
)
if not defined PY (
  echo Python nao encontrado. Rode o instalar.bat primeiro.
  pause
  exit /b 1
)

:inicio
%PY% monitorar_grupo.py %*
echo.
echo O monitor parou. Abrindo de novo em 30 segundos (feche esta janela para parar de vez).
timeout /t 30 /nobreak >nul
goto inicio
