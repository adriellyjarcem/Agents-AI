@echo off
rem Dois cliques aqui sobem o escritório virtual e abrem o navegador.
rem Deixe esta janela aberta enquanto estiver usando; fechar desliga o escritório.
title Escritorio Virtual
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo O Node.js nao esta instalado. Baixe a versao LTS em https://nodejs.org e tente de novo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instalando dependencias, so na primeira vez...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

node server\index.mjs --abrir
pause
