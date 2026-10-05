' Start the Vector server silently — no window, no new app tab. Target of the
' header's Start button (vector-start://). Takes no arguments on purpose.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
myDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = myDir
shell.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & myDir & "\start-app.ps1"" -ServerOnly", 0, False
