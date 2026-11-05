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
    pause
    exit /b 1
  )
  echo.
  echo Bibliotecas instaladas.
  echo.
)

:inicio
%PY% monitorar_grupo.py %*
echo.
echo O monitor parou. Abrindo de novo em 30 segundos (feche esta janela para parar de vez).
timeout /t 30 /nobreak >nul
goto inicio
