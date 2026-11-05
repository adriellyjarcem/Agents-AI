@echo off
rem Deixa o monitor do grupo rodando. Se ele parar (sem internet, por exemplo), abre de novo em 30 s.
rem Na primeira vez: leia o QR code com o celular e escolha o grupo.
rem Para rodar sem janela, use o iniciar_oculto.vbs. Para parar: parar_monitor.bat
title Monitor - Informe Estoque Visual
cd /d "%~dp0"
if exist parar.flag del parar.flag

set PY=
py -3 --version >nul 2>nul && set PY=py -3
if not defined PY (
  python --version >nul 2>nul && set PY=python
)
if not defined PY (
  echo Python nao encontrado. Rode o instalar.bat primeiro.
  call :pausa
  exit /b 1
)

rem Confere as bibliotecas; se faltar alguma, instala antes de comecar
%PY% -c "import PIL, numpy, openpyxl, rapidocr, onnxruntime, neonize" >nul 2>nul
if errorlevel 1 (
  echo Faltam bibliotecas. Instalando agora, so desta vez (pode levar alguns minutos^)...
  echo.
  %PY% -m pip install -r requirements.txt
  %PY% -c "import PIL, numpy, openpyxl, rapidocr, onnxruntime, neonize"
  if errorlevel 1 (
    echo.
    echo A instalacao nao terminou. Copie as mensagens acima e envie para quem esta te ajudando.
    call :pausa
    exit /b 1
  )
  echo.
  echo Bibliotecas instaladas.
  echo.
)

:inicio
if exist parar.flag goto parado
%PY% monitorar_grupo.py %*
rem Codigo 3: ja existe um monitor rodando; nao abre outro
if errorlevel 3 if not errorlevel 4 (
  call :pausa
  exit /b 0
)
if exist parar.flag goto parado
echo.
echo O monitor parou. Abrindo de novo em 30 segundos (feche esta janela para parar de vez).
timeout /t 30 /nobreak >nul
goto inicio

:parado
del parar.flag >nul 2>nul
echo Monitor parado.
exit /b 0

:pausa
rem No modo oculto nao ha ninguem para apertar uma tecla
if not defined MONITOR_OCULTO pause
exit /b 0
