@echo off
rem Dois cliques aqui instalam o que o script precisa. So precisa rodar uma vez.
title Instalar - Informe Estoque Visual
cd /d "%~dp0"

rem Procura o Python: primeiro o lancador "py", depois "python"
set PY=
py -3 --version >nul 2>nul && set PY=py -3
if not defined PY (
  python --version >nul 2>nul && set PY=python
)
if not defined PY (
  echo.
  echo Python nao encontrado.
  echo Baixe em https://www.python.org/downloads/ e, na instalacao,
  echo marque a opcao "Add python.exe to PATH". Depois rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)

echo Usando:
%PY% --version
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"
if errorlevel 1 (
  echo.
  echo Este Python e antigo demais. Instale o Python 3.12 em https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

echo.
echo Atualizando o pip...
%PY% -m pip install --upgrade pip
echo.
echo Instalando as bibliotecas (pode levar alguns minutos)...
%PY% -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo A instalacao falhou. Copie as mensagens acima e envie para quem esta te ajudando.
  echo Se aparecer "No matching distribution found", instale o Python 3.12
  echo em https://www.python.org/downloads/ e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)

echo.
echo Testando o OCR...
%PY% -c "import neonize; from leitor_informe import LeitorInforme; LeitorInforme(); print('OCR e WhatsApp prontos.')"
if errorlevel 1 (
  echo.
  echo As bibliotecas instalaram, mas o OCR nao abriu.
  echo Se a mensagem fala em "DLL load failed", instale o Visual C++ Redistributable:
  echo https://aka.ms/vs/17/release/vc_redist.x64.exe  e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)

echo.
echo Tudo pronto. Agora de dois cliques em iniciar_monitor.bat, leia o QR code e escolha o grupo.
echo Para processar uma exportacao manual, use no cmd:
echo   %PY% coletar_imagens.py pasta_das_exportacoes --grupo "nome do grupo"
echo.
pause
