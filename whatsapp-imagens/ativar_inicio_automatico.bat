@echo off
rem Faz o monitor abrir sozinho (minimizado) toda vez que voce entrar no Windows.
rem Rodar de novo desativa.
cd /d "%~dp0"
set "ATALHO=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Monitor Informe Estoque.bat"

if exist "%ATALHO%" (
  del "%ATALHO%"
  echo Inicio automatico DESATIVADO. O monitor nao abre mais sozinho com o Windows.
  pause
  exit /b 0
)

if not exist config.json (
  echo Antes, rode o iniciar_monitor.bat uma vez: leia o QR code e escolha o grupo.
  pause
  exit /b 1
)

> "%ATALHO%" echo @echo off
>> "%ATALHO%" echo start "Monitor Informe Estoque" /min "%~dp0iniciar_monitor.bat"
echo Inicio automatico ATIVADO.
echo O monitor vai abrir minimizado sempre que voce entrar no Windows.
echo Para desativar, rode este arquivo de novo.
pause
