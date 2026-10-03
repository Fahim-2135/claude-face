// Brings the editor or terminal window of a session to the front (Windows only).
// The window is found by title: VS Code and most terminals show the project folder name there.
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = `
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class CF {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public static List<string[]> Windows() {
    var list = new List<string[]>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var title = new StringBuilder(512);
      GetWindowText(h, title, 512);
      if (title.Length == 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      list.Add(new string[] { h.ToInt64().ToString(), pid.ToString(), title.ToString() });
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
$apps = @('Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'WindowsTerminal', 'powershell', 'pwsh', 'cmd',
  'conhost', 'mintty', 'alacritty', 'wezterm-gui', 'Hyper', 'Tabby')
$names = $env:CLAUDE_FACE_NAMES -split '\\|' | Where-Object { $_ }
$windows = foreach ($w in [CF]::Windows()) {
  $p = Get-Process -Id ([int]$w[1]) -ErrorAction SilentlyContinue
  if ($p -and $apps -contains $p.ProcessName) { [pscustomobject]@{ Handle = [IntPtr][long]$w[0]; Title = $w[2].ToLower() } }
}
foreach ($name in $names) {
  $hit = $windows | Where-Object { $_.Title.Contains($name.ToLower()) } | Select-Object -First 1
  if ($hit) {
    if ([CF]::IsIconic($hit.Handle)) { [void][CF]::ShowWindow($hit.Handle, 9) }
    [void][CF]::SetForegroundWindow($hit.Handle)
    exit 0
  }
}
exit 1
`;

// Folder names to look for in window titles, deepest first: E:\\work\\shop\\api -> api, shop, work
function folderNames(cwd) {
  return cwd.split(/[\\/]+/).filter((part) => part.length >= 3 && !part.endsWith(':')).slice(-3).reverse();
}

function focusWindow(cwd) {
  if (process.platform !== 'win32' || !cwd) return;
  const names = folderNames(path.resolve(cwd));
  if (!names.length) return;
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      { env: { ...process.env, CLAUDE_FACE_NAMES: names.join('|') }, windowsHide: true, stdio: 'ignore' }
    );
    child.on('error', () => {});
  } catch {
    // no PowerShell: nothing to do
  }
}

module.exports = { focusWindow };
