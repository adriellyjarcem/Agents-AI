@echo off
rem Importa as visitas antigas: arraste o .zip exportado do WhatsApp para cima deste arquivo.
rem (Conversa com a pessoa > Mais > Exportar conversa > Incluir midia)
title Importar visitas antigas
cd /d "%~dp0"

if "%~1"=="" (
  echo Arraste o .zip exportado da conversa do WhatsApp para cima deste arquivo.
  echo No celular: conversa com a pessoa ^> Mais ^> Exportar conversa ^> Incluir midia.
  pause
  exit /b 1
)

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

%PY% importar_visitas.py "%~1"
echo.
pause
