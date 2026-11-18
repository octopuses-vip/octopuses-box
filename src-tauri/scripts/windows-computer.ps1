$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OctopusesInput {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, int data, UIntPtr info);
}
'@
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($data.action.action -eq 'screenshot') {
  $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $screen.Size); $bitmap.Save($data.path, [System.Drawing.Imaging.ImageFormat]::Png) }
  finally { $graphics.Dispose(); $bitmap.Dispose() }
  exit 0
}
if ($data.app -eq '__foreground__') {
  $idAtPointer = [uint32]0
  [void][OctopusesInput]::GetWindowThreadProcessId([OctopusesInput]::GetForegroundWindow(), [ref]$idAtPointer)
  $target = Get-Process -Id $idAtPointer
} else { $target = Get-Process -Name $data.app | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }
if (!$target) { throw 'Target application has no visible window' }
[void][OctopusesInput]::SetForegroundWindow($target.MainWindowHandle)
Start-Sleep -Milliseconds 200
$foreground = [OctopusesInput]::GetForegroundWindow()
$focusedId = [uint32]0
[void][OctopusesInput]::GetWindowThreadProcessId($foreground, [ref]$focusedId)
if ($focusedId -ne $target.Id) { throw 'Target application did not receive focus' }
$action = $data.action
if ($action.action -in @('click','double_click','right_click','drag','scroll')) {
  $x = [int]($screen.Left + $action.x * ($screen.Width - 1)); $y = [int]($screen.Top + $action.y * ($screen.Height - 1))
  $rect = New-Object OctopusesInput+Rect
  [void][OctopusesInput]::GetWindowRect($foreground, [ref]$rect)
  if ($x -lt $rect.Left -or $x -ge $rect.Right -or $y -lt $rect.Top -or $y -ge $rect.Bottom) { throw 'Pointer is outside the allowed application window' }
  [void][OctopusesInput]::SetCursorPos($x,$y)
}
switch ($action.action) {
  'activate' { }
  'click' { [OctopusesInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [OctopusesInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
  'double_click' { 1..2 | ForEach-Object { [OctopusesInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [OctopusesInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 80 } }
  'right_click' { [OctopusesInput]::mouse_event(8,0,0,0,[UIntPtr]::Zero); [OctopusesInput]::mouse_event(16,0,0,0,[UIntPtr]::Zero) }
  'scroll' { [OctopusesInput]::mouse_event(2048,0,0,([int]$action.amount * 120),[UIntPtr]::Zero) }
  'drag' {
    $tx = [int]($screen.Left + $action.toX * ($screen.Width - 1)); $ty = [int]($screen.Top + $action.toY * ($screen.Height - 1))
    if ($tx -lt $rect.Left -or $tx -ge $rect.Right -or $ty -lt $rect.Top -or $ty -ge $rect.Bottom) { throw 'Drag destination is outside the allowed application window' }
    [OctopusesInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    try { [void][OctopusesInput]::SetCursorPos($tx,$ty) } finally { [OctopusesInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
  }
  'type' {
    $escaped = -join ($action.text.ToCharArray() | ForEach-Object { if ($_ -in @('+','^','%','~','(',')','{','}','[',']')) { '{' + $_ + '}' } elseif ($_ -eq "`n") { '{ENTER}' } elseif ($_ -eq "`r") { '' } else { [string]$_ } })
    [System.Windows.Forms.SendKeys]::SendWait($escaped)
  }
  'key' {
    $keys = @{Enter='{ENTER}';Tab='{TAB}';Escape='{ESC}';Backspace='{BACKSPACE}';Up='{UP}';Down='{DOWN}';Left='{LEFT}';Right='{RIGHT}';'Cmd+A'='^a';'Cmd+C'='^c';'Cmd+V'='^v';'Cmd+S'='^s';'Cmd+F'='^f'}
    if (!$keys.ContainsKey($action.key)) { throw 'Unsupported key' }; [System.Windows.Forms.SendKeys]::SendWait($keys[$action.key])
  }
  'wait' { Start-Sleep -Milliseconds 250 }
  default { throw 'Unsupported action' }
}
