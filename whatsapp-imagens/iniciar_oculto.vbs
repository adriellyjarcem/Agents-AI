' Inicia o monitor SEM janela, em segundo plano.
' Para parar: parar_monitor.bat. O que acontece fica registrado em monitor.log.
Option Explicit
Dim fso, sh, pasta, cfg, arq, ok
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
cfg = pasta & "\config.json"

ok = False
If fso.FileExists(cfg) Then
  Set arq = fso.OpenTextFile(cfg, 1)
  If Not arq.AtEndOfStream Then ok = (InStr(arq.ReadAll, "grupo_jid") > 0)
  arq.Close
End If
If Not ok Then
  MsgBox "Antes de usar o modo oculto, rode o iniciar_monitor.bat uma vez:" & vbCrLf & _
         "leia o QR code com o celular e escolha o grupo.", vbExclamation, "Monitor Informe Estoque"
  WScript.Quit 1
End If

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = pasta
sh.Run "cmd /c set MONITOR_OCULTO=1&& """ & pasta & "\iniciar_monitor.bat""", 0, False
