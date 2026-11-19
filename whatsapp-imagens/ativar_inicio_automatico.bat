@echo off
rem Faz o monitor abrir sozinho, sem janela, toda vez que voce entrar no Windows.
rem Rodar de novo desativa.
cd /d "%~dp0"
rem Um atalho por pasta: da para ter um monitor em cada pasta (ex.: estoque e visitas)
for %%I in ("%~dp0.") do set "NOME_PASTA=%%~nxI"
set "ATALHO=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Monitor WhatsApp - %NOME_PASTA%.bat"

if exist "%ATALHO%" (
  del "%ATALHO%"
  echo Inicio automatico DESATIVADO para a pasta %NOME_PASTA%.
  pause
  exit /b 0
)

if not exist config.json (
  echo Antes, rode o iniciar_monitor.bat uma vez: leia o QR code e escolha o grupo.
  pause
  exit /b 1
)

> "%ATALHO%" echo @echo off
>> "%ATALHO%" echo start "" wscript.exe "%~dp0iniciar_oculto.vbs"
echo Inicio automatico ATIVADO para a pasta %NOME_PASTA%.
echo O monitor vai abrir escondido (sem janela) sempre que voce entrar no Windows.
echo Para parar: parar_monitor.bat. Para ver o que ele fez: abra o monitor.log.
echo Para desativar, rode este arquivo de novo.
pause
