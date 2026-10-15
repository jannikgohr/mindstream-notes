# Minimise/restore the app's top-level window from a spec, so a probe can ask
# the page what it thinks its visibility is while the window is not on screen.
#
# Resolving the app by process name only works while exactly one app is up,
# and the single-client suite runs spec files in parallel, so a second app can
# appear between two calls. Hence two modes:
#
#   -Probe          check that exactly one app is up and print its pid
#   -ProcId <pid>   drive that pid's window, however many apps are up now
#
# The caller probes once, up front, and passes the pid back for every call
# after. Discovering the ambiguity later is too late to recover: once the
# window is off screen the page stops answering, so the restore never lands.
#
# ASCII only: Windows PowerShell reads a BOM-less .ps1 as ANSI, so a stray
# non-ASCII character here is a parse error, not a mojibake message.
param(
  [Parameter(Mandatory = $true)][int]$Cmd,
  [string]$ProcName = "mindstream-notes-e2e",
  [int]$ProcId = 0,
  [switch]$Probe
)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WShow {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  // The app's own top-level window, found by its class.
  public static IntPtr AppWindow(uint want) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      // GW_OWNER = 4: an owned window is a dialog of the app, not the app.
      if (pid != want || GetWindow(h, 4) != IntPtr.Zero) return true;
      StringBuilder cls = new StringBuilder(64);
      GetClassName(h, cls, 64);
      if (cls.ToString() != "Tauri Window") return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
"@
if ($ProcId -gt 0) {
  $target = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  if ($null -eq $target) { Write-Error "no process with pid $ProcId"; exit 1 }
} else {
  $p = @(Get-Process $ProcName -ErrorAction SilentlyContinue)
  if ($p.Count -eq 0) { Write-Error "no process $ProcName"; exit 1 }
  if ($p.Count -gt 1) {
    Write-Error "$($p.Count) processes named $ProcName, so no window is unambiguously this spec's. Run it alone: pnpm test:e2e:app --spec e2e-tests/perf/hidden-visibility.e2e.ts"
    exit 2
  }
  $target = $p[0]
}
if ($Probe) { Write-Output $target.Id; exit 0 }
# Not MainWindowHandle. The process has a second top-level window that
# counts as visible, the windowing library's event target, and .NET takes
# whichever comes first in the z-order. With the app's window on screen that
# is the app's. Once it is minimised it can be the other one, depending on
# what else is on the desktop, and a restore sent there restores nothing.
$window = [WShow]::AppWindow([uint32]$target.Id)
if ($window -eq [IntPtr]::Zero) {
  Write-Error "process $($target.Id) has no app window"
  exit 1
}
[WShow]::ShowWindow($window, $Cmd) | Out-Null
