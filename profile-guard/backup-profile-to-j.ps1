# 把 DSH profile 的配置层备份到 J 盘，保留最近 30 份。
# 由 Windows 计划任务每天调用；J 盘不可用时跳过，不报错。
$ErrorActionPreference = 'Stop'

$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
if (-not (Test-Path -LiteralPath $profileDir)) { exit 0 }

$drive = 'J:\'
if (-not (Test-Path -LiteralPath $drive)) { exit 0 }

$root = Join-Path $drive '普通文件\备份\DSH配置备份'
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$dest = Join-Path $root $stamp
New-Item -ItemType Directory -Path $dest -Force | Out-Null

$files = @('cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-lock.yaml')
foreach ($name in $files) {
  $src = Join-Path $profileDir $name
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $dest $name) -Force }
}

$snapshots = Join-Path $profileDir '.profile-guard\snapshots'
if (Test-Path -LiteralPath $snapshots) {
  Copy-Item -LiteralPath $snapshots -Destination (Join-Path $dest 'snapshots') -Recurse -Force -ErrorAction SilentlyContinue
}

# 保留最近 30 份
$keep = 30
$all = Get-ChildItem -LiteralPath $root -Directory | Sort-Object Name -Descending
if ($all.Count -gt $keep) {
  $all | Select-Object -Skip $keep | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}
