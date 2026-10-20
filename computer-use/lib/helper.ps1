param([string]$AbortFile, [string]$CancelFile)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$cs = @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.IO;
using System.Windows.Forms;

public class CuNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);

    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint MOUSEEVENTF_HWHEEL = 0x1000;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    public static string AbortFile, CancelFile;
    public static void Check() {

        if (File.Exists(AbortFile) || File.Exists(CancelFile)) throw new OperationCanceledException("电脑操作已取消；如按下 ESC，将持续暂停直到本地用户重启插件。");
    }
    public static void Sleep(int ms) { for (int i=0; i<ms; i+=10) { Check(); Thread.Sleep(Math.Min(10, ms-i)); } Check(); }
    public static void ValidatePoint(int x, int y) {
        foreach (Screen screen in Screen.AllScreens) if (screen.Bounds.Contains(x,y)) return;
        throw new ArgumentException("坐标不在任何显示器的物理像素边界内。");
    }

    static CuNative()
    {
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { SetProcessDPIAware(); }
    }

    static void SendMouse(uint flags, int dx, int dy, uint data)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = 0;
        inputs[0].u.mi.dx = dx;
        inputs[0].u.mi.dy = dy;
        inputs[0].u.mi.mouseData = data;
        inputs[0].u.mi.dwFlags = flags;
        inputs[0].u.mi.dwExtraInfo = IntPtr.Zero;
        uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != 1) throw new InvalidOperationException("SendInput(mouse) failed: sent=" + sent + " err=" + Marshal.GetLastWin32Error());
    }

    public static void MoveTo(int x, int y) { Check(); ValidatePoint(x,y); if (!SetCursorPos(x,y)) throw new InvalidOperationException("鼠标移动失败。"); }

    public static void ClickAt(int x, int y, string button, int count)
    {
        MoveTo(x, y);
        Sleep(40);
        int n = count < 1 ? 1 : count;
        for (int i = 0; i < n; i++)
        {
            Check();
            uint down = button == "right" ? MOUSEEVENTF_RIGHTDOWN : button == "middle" ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
            uint up = button == "right" ? MOUSEEVENTF_RIGHTUP : button == "middle" ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
            try { SendMouse(down,0,0,0); } finally { SendMouse(up,0,0,0); }
            if (i < n - 1) Sleep(70);
        }
    }

    public static void DragTo(int x1, int y1, int x2, int y2, int steps)
    {
        ValidatePoint(x2,y2);
        MoveTo(x1,y1);
        Sleep(90);
        try {
        SendMouse(MOUSEEVENTF_LEFTDOWN, 0, 0, 0);
        Sleep(70);
        int s = steps < 2 ? 12 : steps;
        for (int i = 1; i <= s; i++)
        {
            int x = x1 + (x2 - x1) * i / s;
            int y = y1 + (y2 - y1) * i / s;
            SetCursorPos(x, y);
            Sleep(9);
        }
        Sleep(70);
        } finally { SendMouse(MOUSEEVENTF_LEFTUP, 0, 0, 0); }
    }

    public static void Scroll(int x, int y, int vertical, int horizontal)
    {
        MoveTo(x, y);
        Sleep(25);
        if (vertical != 0) SendMouse(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)(vertical * 120)));
        if (horizontal != 0) SendMouse(MOUSEEVENTF_HWHEEL, 0, 0, unchecked((uint)(horizontal * 120)));
    }

    static void SendVk(ushort vk, bool up)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = 1;
        inputs[0].u.ki.wVk = vk;
        inputs[0].u.ki.wScan = 0;
        inputs[0].u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        inputs[0].u.ki.dwExtraInfo = IntPtr.Zero;
        uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != 1) throw new InvalidOperationException("SendInput(key " + vk + ") failed: sent=" + sent + " err=" + Marshal.GetLastWin32Error());
    }

    static void SendUnicode(ushort ch, bool up)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = 1;
        inputs[0].u.ki.wVk = 0;
        inputs[0].u.ki.wScan = ch;
        inputs[0].u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
        inputs[0].u.ki.dwExtraInfo = IntPtr.Zero;
        uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != 1) throw new InvalidOperationException("SendInput(unicode " + ((int)ch) + ") failed: sent=" + sent + " err=" + Marshal.GetLastWin32Error());
    }

    public static void TypeText(string text)
    {
        int n = 0;
        foreach (char ch in text)
        {
            Check();
            if (ch == '\r') continue;
            if (ch == '\n') { PressKey(0x0D); }
            else if (ch == '\t') { PressKey(0x09); }
            else { try { SendUnicode(ch, false); } finally { SendUnicode(ch, true); } }
            n++;
            if (n % 12 == 0) Sleep(3);
        }
    }

    public static void PressKey(ushort vk) { Check(); try { SendVk(vk, false); } finally { SendVk(vk, true); } }

    public static void Hotkey(ushort[] mods, ushort key)
    {
        Check();
        int held = 0;
        try {
            for (int i = 0; i < mods.Length; i++) { held++; SendVk(mods[i], false); Sleep(20); }
            PressKey(key);
            Sleep(25);
        } finally {
            for (int i = held - 1; i >= 0; i--) { try { SendVk(mods[i], true); } catch {} }
        }
    }

    public static int[] Cursor()
    {
        POINT p;
        GetCursorPos(out p);
        return new int[] { p.X, p.Y };
    }

    public static int[] VirtualScreen()
    {
        Rectangle vs = SystemInformation.VirtualScreen;
        return new int[] { vs.X, vs.Y, vs.Width, vs.Height };
    }

    public static double ScaleFactor()
    {
        using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) { return g.DpiX / 96.0; }
    }

    public static string ForegroundInfo()
    {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) return "0|";
        System.Text.StringBuilder sb = new System.Text.StringBuilder(512);
        GetWindowText(h, sb, 512);
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        return pid + "|" + sb.ToString();
    }

    public static void DrawGrid(Bitmap bmp, int step, int originX, int originY)
    {
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
            using (Pen line = new Pen(Color.FromArgb(64, 0, 229, 176), 1f))
            using (Font font = new Font("Consolas", 10f, FontStyle.Bold))
            using (Brush shadow = new SolidBrush(Color.FromArgb(150, 0, 0, 0)))
            using (Brush label = new SolidBrush(Color.FromArgb(235, 60, 255, 205)))
            {
                for (int x = step; x < bmp.Width; x += step)
                {
                    g.DrawLine(line, x, 0, x, bmp.Height);
                    string t = (x + originX).ToString();
                    g.DrawString(t, font, shadow, x + 3f, 3f);
                    g.DrawString(t, font, label, x + 2f, 2f);
                }
                for (int y = step; y < bmp.Height; y += step)
                {
                    g.DrawLine(line, 0, y, bmp.Width, y);
                    string t = (y + originY).ToString();
                    g.DrawString(t, font, shadow, 3f, y + 2f);
                    g.DrawString(t, font, label, 2f, y + 1f);
                }
            }
        }
    }
}
'@

Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Windows.Forms, System.Drawing
[CuNative]::AbortFile = $AbortFile
[CuNative]::CancelFile = $CancelFile

$vkMap = @{
    'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B
    'space' = 0x20; 'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E; 'insert' = 0x2D
    'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pagedown' = 0x22
    'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28
    'ctrl' = 0x11; 'control' = 0x11; 'shift' = 0x10; 'alt' = 0x12; 'win' = 0x5B; 'meta' = 0x5B
    'capslock' = 0x14; 'numlock' = 0x90; 'printscreen' = 0x2C; 'apps' = 0x5D
    'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74; 'f6' = 0x75
    'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
    'comma' = 0xBC; 'period' = 0xBE; 'dot' = 0xBE; 'slash' = 0xBF
    'semicolon' = 0xBA; 'quote' = 0xDE; 'apostrophe' = 0xDE
    'backquote' = 0xC0; 'grave' = 0xC0; 'minus' = 0xBD; 'hyphen' = 0xBD
    'equal' = 0xBB; 'equals' = 0xBB; 'plus' = 0xBB
    'lbracket' = 0xDB; 'rbracket' = 0xDD; 'backslash' = 0xDC
    '`' = 0xC0; '-' = 0xBD; '=' = 0xBB; '[' = 0xDB; ']' = 0xDD; '\' = 0xDC
    ';' = 0xBA; "'" = 0xDE; ',' = 0xBC; '.' = 0xBE; '/' = 0xBF
}

function Resolve-Vk([string]$name) {
    $k = $name.Trim().ToLower()
    if ($vkMap.ContainsKey($k)) { return [int]$vkMap[$k] }
    if ($k.Length -eq 1) {
        $ch = $k[0]
        if ($ch -ge 'a' -and $ch -le 'z') { return [int][char]::ToUpper($ch) }
        if ($ch -ge '0' -and $ch -le '9') { return [int]$ch }
    }
    if ($k -match '^0x[0-9a-f]+$') { return [Convert]::ToInt32($k.Substring(2), 16) }
    throw "不支持键名 '$name'。可用 a-z、0-9、f1-f12、enter、tab、esc、方向键、ctrl/shift/alt/win 或符号别名（如 comma、plus）；组合示例 ctrl+shift+s。"
}

function Write-Frame([hashtable]$Payload) {
    $json = $Payload | ConvertTo-Json -Compress -Depth 10
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    [Console]::Out.WriteLine($b64)
    [Console]::Out.Flush()
}

function Get-ScreenShot([string]$Path, $X, $Y, $W, $H, $DrawGrid) {
    $vs = [CuNative]::VirtualScreen()
    if ($null -eq $X) { $X = $vs[0]; $Y = $vs[1]; $W = $vs[2]; $H = $vs[3] }
    $X = [int]$X; $Y = [int]$Y; $W = [int]$W; $H = [int]$H
    if ($W -le 0 -or $H -le 0 -or $X -lt $vs[0] -or $Y -lt $vs[1] -or ([long]$X + $W) -gt ($vs[0] + $vs[2]) -or ([long]$Y + $H) -gt ($vs[1] + $vs[3])) { throw "截图区域超出虚拟桌面物理像素边界。" }
    $bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)), [System.Drawing.CopyPixelOperation]::SourceCopy)
    $g.Dispose()
    if ($DrawGrid) { [CuNative]::DrawGrid($bmp, 200, $X, $Y) }
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return @{ path = $Path; width = $W; height = $H; originX = $X; originY = $Y; grid = [bool]$DrawGrid }
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line.Length -eq 0) { continue }
    $req = $null
    try {
        $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
        $req = $json | ConvertFrom-Json
        [CuNative]::Check()
        $cmd = [string]$req.cmd
        $data = $null
        switch ($cmd) {
            'ping' { $data = @{ pong = $true } }
            'info' {
                $vs = [CuNative]::VirtualScreen()
                $data = @{
                    x = $vs[0]; y = $vs[1]; width = $vs[2]; height = $vs[3]
                    scale = [CuNative]::ScaleFactor()
                    screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
                        @{ device = $_.DeviceName; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height; primary = $_.Primary }
                    })
                    cursor = [CuNative]::Cursor()
                    foreground = [CuNative]::ForegroundInfo()
                    pid = $PID
                }
            }
            'screenshot' { $data = Get-ScreenShot $req.path $req.x $req.y $req.w $req.h $req.grid }
            'cursor' { $data = @{ x = ([CuNative]::Cursor())[0]; y = ([CuNative]::Cursor())[1] } }
            'foreground' {
                $fg = [CuNative]::ForegroundInfo()
                $parts = $fg.Split('|')
                $data = @{ pid = [int]$parts[0]; title = $parts[1] }
            }
            'move' { [CuNative]::MoveTo([int]$req.x, [int]$req.y); $data = @{ x = ([CuNative]::Cursor())[0]; y = ([CuNative]::Cursor())[1] } }
            'click' {
                if ($null -eq $req.x) { $c = [CuNative]::Cursor(); $x = $c[0]; $y = $c[1] } else { $x = [int]$req.x; $y = [int]$req.y }
                $btn = if ($req.button) { [string]$req.button } else { 'left' }
                $cnt = if ($req.count) { [int]$req.count } else { 1 }
                [CuNative]::ClickAt($x, $y, $btn, $cnt)
                $data = @{ x = $x; y = $y; button = $btn; count = $cnt }
            }
            'drag' {
                [CuNative]::DragTo([int]$req.x, [int]$req.y, [int]$req.to_x, [int]$req.to_y, 16)
                $data = @{ from = @{ x = [int]$req.x; y = [int]$req.y }; to = @{ x = [int]$req.to_x; y = [int]$req.to_y } }
            }
            'scroll' {
                $v = if ($req.amount) { [int]$req.amount } else { 0 }
                $h = if ($req.horizontal) { [int]$req.horizontal } else { 0 }
                $x = if ($null -eq $req.x) { ([CuNative]::Cursor())[0] } else { [int]$req.x }
                $y = if ($null -eq $req.y) { ([CuNative]::Cursor())[1] } else { [int]$req.y }
                [CuNative]::Scroll($x, $y, $v, $h)
                $data = @{ x = $x; y = $y; amount = $v }
            }
            'type' {
                $text = [string]$req.text
                [CuNative]::TypeText($text)
                $data = @{ chars = $text.Length }
            }
            'key' {
                $spec = [string]$req.keys
                $parts = @($spec.Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
                if ($parts.Count -eq 0) { throw "keys must name at least one key" }
                if ($parts.Count -eq 1) {
                    $vk = Resolve-Vk $parts[0]
                    [CuNative]::PressKey([uint16]$vk)
                } else {
                    $mods = New-Object 'System.UInt16[]' ($parts.Count - 1)
                    for ($i = 0; $i -lt $parts.Count - 1; $i++) { $mods[$i] = [uint16](Resolve-Vk $parts[$i]) }
                    $vk = [uint16](Resolve-Vk $parts[$parts.Count - 1])
                    [CuNative]::Hotkey($mods, $vk)
                }
                $data = @{ keys = $spec }
            }
            'launch' {
                $target = [string]$req.command
                if ($req.args) { Start-Process -FilePath $target -ArgumentList ([string]$req.args) } else { Start-Process -FilePath $target }
                $data = @{ launched = $target }
            }
            'wait' {
                $ms = if ($null -ne $req.ms) { [int]$req.ms } else { 500 }
                if ($ms -gt 10000) { $ms = 10000 }
                [CuNative]::Sleep($ms)
                $data = @{ waited = $ms }
            }
            default { throw "unknown command: $cmd" }
        }
        Write-Frame @{ ok = $true; id = $req.id; data = $data }
    } catch {
        $msg = $_.Exception.Message
        $id = $null
        if ($null -ne $req) { $id = $req.id }
        Write-Frame @{ ok = $false; id = $id; error = $msg }
    }
}
