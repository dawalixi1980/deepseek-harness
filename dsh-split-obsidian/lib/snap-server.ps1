# dsh-split-obsidian —— 常驻窗口服务。
#
# 为什么是"常驻"：一次性起 PowerShell 进程要 ~390ms（启动 + Add-Type 编译），
# 拖动分隔条时每次都要这个开销会明显卡顿。改成进程内 while 循环读 stdin 之后，
# 单次移动降到 ~3ms（实测 20 次连续移动共 64ms），拖动完全跟手。
#
# 协议：每行一条命令，回复一行。
#   "init"                  -> "READY <dshHandle> <obHandle> <waX> <waY> <waW> <waH>"
#   "left,<x>,<y>,<w>,<h>"  -> "OK"   （只动 DSH）
#   "right,<x>,<y>,<w>,<h>" -> "OK"   （只动 Obsidian）
#   "both,<lx>,<ly>,<lw>,<lh>,<rx>,<ry>,<rw>,<rh>" -> "OK"
#   "focus,<left|right>"    -> "OK"
#   "query"                 -> "L<x>,<y>,<w>,<h>|<z><i>;R<x>,<y>,<w>,<h>|<z><i>"
#   "quit"                  -> 退出
#
# 注意：脚本必须是纯 ASCII，且用 -File 启动；出了问题只会写 stderr，不会污染协议。

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DshSplitNative {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct RECT { public int L, T, R, B; }
}
"@

Add-Type -AssemblyName System.Windows.Forms

$SW_RESTORE = 9
$SW_SHOWNOACTIVATE = 4

function Get-Handle([string]$name) {
  $p = Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($null -eq $p) { return [IntPtr]::Zero }
  return $p.MainWindowHandle
}

function Set-Window([IntPtr]$h, [int]$x, [int]$y, [int]$w, [int]$t, [bool]$activate) {
  if ($h -eq [IntPtr]::Zero) { return $false }
  if ([DshSplitNative]::IsZoomed($h)) { [void][DshSplitNative]::ShowWindow($h, $SW_RESTORE); Start-Sleep -Milliseconds 160 }
  if ([DshSplitNative]::IsIconic($h)) { [void][DshSplitNative]::ShowWindow($h, $SW_SHOWNOACTIVATE); Start-Sleep -Milliseconds 160 }
  $ok = [DshSplitNative]::MoveWindow($h, $x, $y, $w, $t, $true)
  if ($activate) { [void][DshSplitNative]::SetForegroundWindow($h) }
  return $ok
}

function Describe([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return "none" }
  $r = New-Object DshSplitNative+RECT
  [void][DshSplitNative]::GetWindowRect($h, [ref]$r)
  $z = if ([DshSplitNative]::IsZoomed($h)) { "z" } else { "-" }
  $i = if ([DshSplitNative]::IsIconic($h)) { "i" } else { "-" }
  return ("" + $r.L + "," + $r.T + "," + ($r.R - $r.L) + "," + ($r.B - $r.T) + "|" + $z + $i)
}

$dshHandle = Get-Handle "DeepSeek Harness"
$obHandle = Get-Handle "Obsidian"
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

[Console]::Out.WriteLine("READY " + [int64]$dshHandle + " " + [int64]$obHandle + " " + $wa.X + " " + $wa.Y + " " + $wa.Width + " " + $wa.Height)
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq "") { continue }
  if ($line -eq "quit") { break }
  try {
    $p = $line.Split(",")
    switch ($p[0]) {
      "left"  { [void](Set-Window $dshHandle ([int]$p[1]) ([int]$p[2]) ([int]$p[3]) ([int]$p[4]) $false); [Console]::Out.WriteLine("OK") }
      "right" { [void](Set-Window $obHandle  ([int]$p[1]) ([int]$p[2]) ([int]$p[3]) ([int]$p[4]) $false); [Console]::Out.WriteLine("OK") }
      "both"  {
        [void](Set-Window $dshHandle ([int]$p[1]) ([int]$p[2]) ([int]$p[3]) ([int]$p[4]) $false)
        [void](Set-Window $obHandle  ([int]$p[5]) ([int]$p[6]) ([int]$p[7]) ([int]$p[8]) $false)
        [Console]::Out.WriteLine("OK")
      }
      "focus" {
        if ($p[1] -eq "left") { [void][DshSplitNative]::SetForegroundWindow($dshHandle) }
        else { [void][DshSplitNative]::SetForegroundWindow($obHandle) }
        [Console]::Out.WriteLine("OK")
      }
      "handles" {
        $dshHandle = Get-Handle "DeepSeek Harness"
        $obHandle = Get-Handle "Obsidian"
        [Console]::Out.WriteLine("OK " + [int64]$dshHandle + " " + [int64]$obHandle)
      }
      "query" {
        [Console]::Out.WriteLine("L" + (Describe $dshHandle) + ";R" + (Describe $obHandle))
      }
      default { [Console]::Out.WriteLine("ERR unknown-command") }
    }
  } catch {
    [Console]::Out.WriteLine("ERR " + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}