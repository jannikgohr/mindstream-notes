# Minimise/restore the app's top-level window from a spec, so a probe can ask
# the page what it thinks its visibility is while the window is not on screen.
param([Parameter(Mandatory = $true)][int]$Cmd, [string]$ProcName = "mindstream-notes-e2e-single")
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WShow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); }
"@
$p = @(Get-Process $ProcName -ErrorAction SilentlyContinue)
if ($p.Count -eq 0) { Write-Error "no process $ProcName"; exit 1 }
$p[0].Refresh()
[WShow]::ShowWindow($p[0].MainWindowHandle, $Cmd) | Out-Null
