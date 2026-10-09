' Silent launcher used by the Desktop shortcut.
' Runs start-app.mjs via node.exe with no visible console window.
' Progress and errors are appended to launcher\launcher.log (next to this file).
Option Explicit

Dim objShell, objFSO, scriptDir, projectRoot, nodeExe, scriptPath, logPath, q, cmd

Sub WriteLog(msg)
  On Error Resume Next
  Dim f
  Set f = objFSO.OpenTextFile(logPath, 8, True)
  f.WriteLine Now & "  [vbs] " & msg
  f.Close
End Sub

Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")
scriptDir = objFSO.GetParentFolderName(WScript.ScriptFullName)
projectRoot = objFSO.GetParentFolderName(scriptDir)
logPath = scriptDir & "\launcher.log"
scriptPath = scriptDir & "\start-app.mjs"
q = Chr(34)

On Error Resume Next
objShell.CurrentDirectory = projectRoot
On Error GoTo 0

' Find node.exe (default install location first, then PATH)
nodeExe = "C:\Program Files\nodejs\node.exe"
If Not objFSO.FileExists(nodeExe) Then nodeExe = "C:\Program Files (x86)\nodejs\node.exe"
If Not objFSO.FileExists(nodeExe) Then nodeExe = "node"

' cmd /c "<node> <script>" >> log 2>&1  -- anything node prints (even a crash) lands in the log
cmd = "cmd.exe /c " & q & q & nodeExe & q & " " & q & scriptPath & q & " >> " & q & logPath & q & " 2>&1" & q

WriteLog "launching: " & cmd
On Error Resume Next
objShell.Run cmd, 0, False
If Err.Number <> 0 Then
  WriteLog "Run failed: " & Err.Number & " " & Err.Description
  objShell.Popup "Could not start the launcher." & vbCrLf & "See launcher\launcher.log", 0, "Launcher error", 16
  WScript.Quit 1
End If
On Error GoTo 0

' Small notice so the click visibly "did something" (closes itself after 3 seconds)
objShell.Popup "Starting the app... The browser will open in a few seconds." & vbCrLf & "(If the source changed, a rebuild can take up to ~30 seconds.)", 3, "Live camera & Milky Way map", 64
