# Decodes every .exr under a folder with exrv_info and summarizes the
# storage/compression mix and any failures.
#
#   pwsh native/tools/batch_test.ps1 <folder> [-Exe path\to\exrv_info.exe]
param(
    [Parameter(Mandatory)] [string] $Folder,
    [string] $Exe = "$PSScriptRoot\..\build\native\Release\exrv_info.exe"
)

$files    = Get-ChildItem -Recurse -File $Folder -Filter *.exr
$kinds    = @{}
$failures = @()
$sw       = [Diagnostics.Stopwatch]::StartNew()

foreach ($f in $files) {
    $out = & $Exe $f.FullName 2>&1
    if ($LASTEXITCODE) {
        $msg = ($out | Where-Object { $_ -match 'failed' } | Select-Object -First 1)
        $failures += "{0}: {1}" -f $f.FullName, "$msg".Trim()
    }
    try { $hdr = $out[0] | ConvertFrom-Json } catch { continue }
    foreach ($p in $hdr.parts) {
        $key = "{0}/{1}" -f $p.storage, $p.compression
        $kinds[$key] = 1 + [int]$kinds[$key]
    }
    if ($hdr.parts.Count -gt 1) { $kinds['(multi-part files)'] = 1 + [int]$kinds['(multi-part files)'] }
    $maxch = ($hdr.parts | ForEach-Object { $_.channels.Count } | Measure-Object -Maximum).Maximum
    if ($maxch -gt 4) { $kinds['(files with >4 channels)'] = 1 + [int]$kinds['(files with >4 channels)'] }
}

"{0} files in {1:N1} s, {2} failed" -f $files.Count, $sw.Elapsed.TotalSeconds, $failures.Count
$kinds.GetEnumerator() | Sort-Object Name | ForEach-Object { "  {0,-28} {1}" -f $_.Name, $_.Value }
$failures | Select-Object -First 20 | ForEach-Object { "  FAIL $_" }
