@echo off
rem Para o monitor (com janela ou oculto) de forma segura.
cd /d "%~dp0"
echo parar> parar.flag

if not exist monitor.pid (
  echo O monitor nao estava conectado. Se ele estava reiniciando, para em ate 30 segundos.
  pause
  exit /b 0
)

echo Parando o monitor...
for /l %%i in (1,1,30) do (
  if not exist monitor.pid goto parado
  timeout /t 1 /nobreak >nul
)
echo O monitor nao respondeu. Feche pelo Gerenciador de Tarefas (processo python).
del monitor.pid >nul 2>nul
pause
exit /b 1

:parado
echo Monitor parado. Para iniciar de novo: iniciar_oculto.vbs (sem janela) ou iniciar_monitor.bat.
pause
