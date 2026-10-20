param(
    [Parameter(Mandatory = $true)][string]$StateFile,
    [string]$ColorA = '#4FD1FF',
    [string]$ColorB = '#B07BFF',
    [int]$Thickness = 44,
    [int]$ParentPid = 0,
    [string]$AbortFile = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$cs = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class EdgeGlowWindow
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)]
    public struct SIZE { public int CX, CY; public SIZE(int x, int y) { CX = x; CY = y; } }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] public static extern int DwmFlush();
    public const int WM_HOTKEY = 0x0312;
    public const int HOTKEY_ID = 0x4153;

    public class GlowForm : Form
    {
        public int Edge;
        private Bitmap _bitmap;
        private IntPtr _memDc = IntPtr.Zero;
        private IntPtr _hBitmap = IntPtr.Zero;
        private IntPtr _oldBitmap = IntPtr.Zero;
        private bool _built;

        public GlowForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
            BackColor = Color.Black;
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        public volatile bool EscPressed = false;
        private IntPtr _hook = IntPtr.Zero;
        private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
        private HookProc _callback;
        [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet=CharSet.Auto)] private static extern IntPtr GetModuleHandle(string name);
        public bool RegisterEsc() {
            if (_hook != IntPtr.Zero) return true;
            _callback = delegate(int code, IntPtr message, IntPtr data) {
                if (code >= 0 && (message.ToInt32() == 0x100 || message.ToInt32() == 0x104)
                    && Marshal.ReadInt32(data) == 0x1B && (Marshal.ReadInt32(data, 8) & 0x10) == 0) EscPressed = true;
                return CallNextHookEx(_hook, code, message, data);
            };
            _hook = SetWindowsHookEx(13, _callback, GetModuleHandle(null), 0);
            if (_hook == IntPtr.Zero) throw new InvalidOperationException("无法启用 ESC 急停监听：" + Marshal.GetLastWin32Error());
            return true;
        }
        public void UnregisterEsc() { if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x00080000;
                cp.ExStyle |= 0x00000020;
                cp.ExStyle |= 0x00000080;
                cp.ExStyle |= 0x08000000;
                return cp;
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e) { }

        public void Build(int argbA, int argbB)
        {
            Release();
            int w = Width, h = Height;
            if (w <= 0 || h <= 0) return;
            Color colorA = Color.FromArgb(argbA);
            Color colorB = Color.FromArgb(argbB);
            _bitmap = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            Rectangle rect = new Rectangle(0, 0, w, h);
            BitmapData data = _bitmap.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            int stride = data.Stride;
            byte[] buf = new byte[stride * h];
            for (int y = 0; y < h; y++)
            {
                for (int x = 0; x < w; x++)
                {
                    float along, fade;
                    if (Edge == 0) { along = (float)x / w; fade = 1f - (float)y / h; }
                    else if (Edge == 1) { along = (float)x / w; fade = (float)y / h; }
                    else if (Edge == 2) { along = (float)y / h; fade = 1f - (float)x / w; }
                    else { along = (float)y / h; fade = (float)x / w; }
                    float e = fade * fade;
                    byte r = (byte)(colorA.R + (colorB.R - colorA.R) * along);
                    byte g = (byte)(colorA.G + (colorB.G - colorA.G) * along);
                    byte b = (byte)(colorA.B + (colorB.B - colorA.B) * along);
                    int a = (int)(235 * e);
                    if (a > 255) a = 255; if (a < 0) a = 0;
                    int i = y * stride + x * 4;
                    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = (byte)a;
                }
            }
            Marshal.Copy(buf, 0, data.Scan0, buf.Length);
            _bitmap.UnlockBits(data);

            _memDc = CreateCompatibleDC(IntPtr.Zero);
            _hBitmap = _bitmap.GetHbitmap(Color.FromArgb(0));
            _oldBitmap = SelectObject(_memDc, _hBitmap);
            _built = true;
        }

        public void ApplyAlpha(double alpha)
        {
            if (!_built) return;
            if (alpha < 0.004) { if (Visible) Hide(); return; }
            if (!Visible) Show();
            IntPtr screenDc = GetDC(IntPtr.Zero);
            try
            {
                SIZE size = new SIZE(Width, Height);
                POINT src = new POINT(0, 0);
                POINT dst = new POINT(Left, Top);
                BLENDFUNCTION blend = new BLENDFUNCTION();
                blend.BlendOp = 0; blend.BlendFlags = 0;
                int ca = (int)(alpha * 255.0);
                if (ca > 255) ca = 255; if (ca < 0) ca = 0;
                blend.SourceConstantAlpha = (byte)ca;
                blend.AlphaFormat = 1;
                UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, _memDc, ref src, 0, ref blend, 2);
            }
            finally { ReleaseDC(IntPtr.Zero, screenDc); }
        }

        public void Release()
        {
            if (_memDc != IntPtr.Zero)
            {
                if (_oldBitmap != IntPtr.Zero) SelectObject(_memDc, _oldBitmap);
                if (_hBitmap != IntPtr.Zero) DeleteObject(_hBitmap);
                DeleteDC(_memDc);
                _memDc = IntPtr.Zero; _hBitmap = IntPtr.Zero; _oldBitmap = IntPtr.Zero;
            }
            if (_bitmap != null) { _bitmap.Dispose(); _bitmap = null; }
            _built = false;
        }
    }
}
'@

Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Windows.Forms, System.Drawing

function ConvertTo-Argb([string]$hex) {
    $h = $hex.Trim().TrimStart('#')
    if ($h.Length -eq 6) {
        $r = [Convert]::ToInt32($h.Substring(0, 2), 16)
        $g = [Convert]::ToInt32($h.Substring(2, 2), 16)
        $b = [Convert]::ToInt32($h.Substring(4, 2), 16)
        return [int](-16777216 -bor ($r -shl 16) -bor ($g -shl 8) -bor $b)
    }
    return [int](-16777216 -bor (79 -shl 16) -bor (209 -shl 8) -bor 255)
}

[void][EdgeGlowWindow]::SetProcessDpiAwarenessContext([IntPtr](-4))
$argbA = ConvertTo-Argb $ColorA
$argbB = ConvertTo-Argb $ColorB
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$forms = @()
for ($e = 0; $e -lt 4; $e++) {
    $f = New-Object EdgeGlowWindow+GlowForm
    $f.Edge = $e
    switch ($e) {
        0 { $f.Bounds = New-Object System.Drawing.Rectangle($vs.X, $vs.Y, $vs.Width, $Thickness) }
        1 { $f.Bounds = New-Object System.Drawing.Rectangle($vs.X, ($vs.Y + $vs.Height - $Thickness), $vs.Width, $Thickness) }
        2 { $f.Bounds = New-Object System.Drawing.Rectangle($vs.X, $vs.Y, $Thickness, $vs.Height) }
        3 { $f.Bounds = New-Object System.Drawing.Rectangle(($vs.X + $vs.Width - $Thickness), $vs.Y, $Thickness, $vs.Height) }
    }
    $f.Build($argbA, $argbB)
    $forms += $f
}

$current = 0.0
$lastRaw = ''
$state = $null
$ticks = 0
$hotkeyForm = $forms[0]
$hotkeyOn = $false

while ($true) {
    try {
        $raw = [System.IO.File]::ReadAllText($StateFile)
        if ($raw -and $raw -ne $lastRaw) {
            $lastRaw = $raw
            $state = $raw | ConvertFrom-Json
        }
    } catch { }

    if ($hotkeyForm.EscPressed) {
        $hotkeyForm.EscPressed = $false
        if ($AbortFile) {
            try {
                [System.IO.File]::WriteAllText($AbortFile, [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
            } catch { }
        }
        break
    }

    if ($null -ne $state) {
        if ($state.quit) { break }
        $isActive = $false
        if ($null -ne $state.until) {
            $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            $isActive = ([double]$state.until -gt $nowMs) -and (-not $state.suppressed)
        }
        $intensity = 0.92
        if ($null -ne $state.intensity) { $intensity = [double]$state.intensity }
        $target = if ($isActive) { $intensity } else { 0.0 }
        $step = if ($target -gt $current) { 0.30 } else { 0.20 }
        $current = if ($target -eq 0) { 0 } else { $current + ($target - $current) * $step }
        if ([Math]::Abs($target - $current) -lt 0.012) { $current = $target }

        if (([double]$state.until -gt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -and -not $hotkeyOn) { $hotkeyOn = $hotkeyForm.RegisterEsc() }
        elseif (([double]$state.until -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -and $hotkeyOn) { $hotkeyForm.UnregisterEsc(); $hotkeyOn = $false }
    }

    foreach ($f in $forms) { $f.ApplyAlpha($current) }
    [System.Windows.Forms.Application]::DoEvents()
    [System.IO.File]::WriteAllText("$StateFile.ready", "1")
    if ($state.suppressed) { [void][EdgeGlowWindow]::DwmFlush(); [System.IO.File]::WriteAllText("$StateFile.hidden", "1") } else { [System.IO.File]::WriteAllText("$StateFile.hidden", "0") }
    Start-Sleep -Milliseconds 20

    $ticks++
    if ($ParentPid -gt 0 -and $ticks % 60 -eq 0) {
        $alive = $true
        try { $null = [System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { $alive = $false }
        if (-not $alive) { break }
    }
}

if ($hotkeyOn) { $hotkeyForm.UnregisterEsc() }
foreach ($f in $forms) { $f.Release(); $f.Close(); $f.Dispose() }
