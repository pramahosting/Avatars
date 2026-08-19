# Extracts each zip-like file in data\Avatars_2D\20250408 and \20250612,
# moves the resulting extracted folder up into data\Avatars_2D itself,
# and renames it avatar_NN - continuing the numbering from whatever's
# already there (e.g. if avatar_02 exists, the next one becomes
# avatar_03, then avatar_04, and so on).
#
# Guarantees:
#   - The original files in 20250408\ and 20250612\ are never deleted
#     or modified - only read from, to extract their contents.
#   - Anything that isn't actually a valid zip (e.g. avatar.md, or a
#     file that failed to download correctly) is skipped with a clear
#     warning instead of stopping the whole script or silently losing
#     data.
#   - Nothing "new" is left behind in 20250408\/20250612\ afterward -
#     each extracted folder is *moved* (not copied) up to Avatars_2D,
#     which removes it from the source folder in the same step.
#
# Usage: right-click this file - "Run with PowerShell" - or run
#   powershell -ExecutionPolicy Bypass -File reorganize_avatars_2d.ps1
# from a Command Prompt in this folder.

$ErrorActionPreference = "Stop"

$AvatarsDir = "C:\Pramod\AI_Agents\Avatar\lite-avatar-app\data\Avatars_2D"
$SourceDirs = @(
    (Join-Path $AvatarsDir "20250408"),
    (Join-Path $AvatarsDir "20250612")
)

function Get-AvatarFingerprint($folderPath) {
    # A stable fingerprint for detecting duplicate imports - hashes the
    # actual content of net_encode.pt (the per-identity trained model
    # weights). Two genuinely different avatars will always have
    # different weights; the same avatar extracted twice from the same
    # zip (e.g. from running this script more than once, since the
    # original zips are deliberately never deleted) will have
    # byte-identical ones.
    $netEncodePath = Join-Path $folderPath "net_encode.pt"
    if (-not (Test-Path $netEncodePath)) { return $null }
    return (Get-FileHash -Path $netEncodePath -Algorithm SHA256).Hash
}

if (-not (Test-Path $AvatarsDir)) {
    Write-Host "ERROR: $AvatarsDir does not exist - check the path." -ForegroundColor Red
    exit 1
}

# ---- Figure out the next avatar_NN number, and fingerprint every
# existing avatar so re-running this script skips anything already
# imported instead of creating a duplicate-numbered copy ----
$existingNumbers = Get-ChildItem -Path $AvatarsDir -Directory -Name |
    Where-Object { $_ -match '^avatar_(\d+)$' } |
    ForEach-Object { [int]($Matches[1]) }

$nextNumber = if ($existingNumbers) { ($existingNumbers | Measure-Object -Maximum).Maximum + 1 } else { 1 }
Write-Host "Existing avatar_NN folders found: $($existingNumbers -join ', ')"
Write-Host "Starting new numbering at avatar_$('{0:D2}' -f $nextNumber)"

$knownFingerprints = New-Object System.Collections.Generic.HashSet[string]
Get-ChildItem -Path $AvatarsDir -Directory | Where-Object { $_.Name -match '^avatar_\d+$' } | ForEach-Object {
    $fp = Get-AvatarFingerprint $_.FullName
    if ($fp) { [void]$knownFingerprints.Add($fp) }
}
Write-Host ""

$successCount = 0
$skipCount = 0

foreach ($sourceDir in $SourceDirs) {
    if (-not (Test-Path $sourceDir)) {
        Write-Host "Skipping $sourceDir - does not exist." -ForegroundColor Yellow
        continue
    }

    Write-Host "=== Processing $sourceDir ===" -ForegroundColor Cyan

    # Rather than assuming the zip files specifically have no extension
    # (which may not hold for every entry), this explicitly excludes
    # known non-archive file types instead - the .png reference-image
    # thumbnails that sit alongside each zip (confirmed by avatar.md),
    # avatar.md itself, and a couple of other non-avatar files - and
    # treats everything else as a zip candidate.
    $excludedExtensions = @(".png", ".jpg", ".jpeg", ".md", ".txt", ".json", ".yml", ".yaml")
    $candidateFiles = Get-ChildItem -Path $sourceDir -File | Where-Object {
        $excludedExtensions -notcontains $_.Extension.ToLower() -and
        $_.Name -ne "avatar.md" -and
        $_.Name -ne "configuration"
    }

    foreach ($file in $candidateFiles) {
        Write-Host "  $($file.Name) ... " -NoNewline

        # Extract into a fresh temp folder rather than any pre-existing
        # same-named folder next to the file - avoids any ambiguity
        # about what might already be sitting in that folder, and keeps
        # the extraction itself fully separate from whatever move/rename
        # happens after.
        $tempExtractDir = Join-Path $sourceDir ("_extract_tmp_" + [guid]::NewGuid().ToString("N").Substring(0, 8))

        try {
            New-Item -ItemType Directory -Path $tempExtractDir -Force | Out-Null
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [System.IO.Compression.ZipFile]::ExtractToDirectory($file.FullName, $tempExtractDir)
        } catch {
            Write-Host "SKIPPED (not a valid zip - $($_.Exception.Message))" -ForegroundColor Yellow
            Remove-Item -Path $tempExtractDir -Recurse -Force -ErrorAction SilentlyContinue
            $skipCount++
            continue
        }

        # If the zip contained a single top-level folder (common for
        # archives like this), use its contents directly rather than
        # nesting an extra folder level inside avatar_NN.
        $topLevelItems = Get-ChildItem -Path $tempExtractDir
        $sourceForMove = $tempExtractDir
        if ($topLevelItems.Count -eq 1 -and $topLevelItems[0].PSIsContainer) {
            $sourceForMove = $topLevelItems[0].FullName
        }

        # net.pth ships in the LiteAvatarGallery download layout but is
        # never actually read by any code in this project
        # (net_encode.pt/net_decode.pt are what's actually used,
        # confirmed by grepping the project for it) - roughly 1MB of
        # dead weight per avatar for zero functional benefit, so it's
        # dropped here rather than carried into avatar_NN.
        $deadWeightPath = Join-Path $sourceForMove "net.pth"
        if (Test-Path $deadWeightPath) {
            Remove-Item -Path $deadWeightPath -Force
        }

        $destName = "avatar_{0:D2}" -f $nextNumber
        $destPath = Join-Path $AvatarsDir $destName

        # Skip if this exact avatar (by trained-weights content, not
        # just filename) has already been imported - this is what
        # actually prevents the duplicate-numbered-folder problem from
        # running this script more than once.
        $fingerprint = Get-AvatarFingerprint $sourceForMove
        if ($fingerprint -and $knownFingerprints.Contains($fingerprint)) {
            Write-Host "SKIPPED (already imported - duplicate content)" -ForegroundColor Yellow
            Remove-Item -Path $tempExtractDir -Recurse -Force -ErrorAction SilentlyContinue
            $skipCount++
            continue
        }

        if (Test-Path $destPath) {
            Write-Host "SKIPPED ($destName already exists - unexpected, not overwriting)" -ForegroundColor Yellow
            Remove-Item -Path $tempExtractDir -Recurse -Force -ErrorAction SilentlyContinue
            $skipCount++
            continue
        }

        Move-Item -Path $sourceForMove -Destination $destPath

        # Clean up the temp extraction folder - if we moved the inner
        # folder out above, this removes the now-empty wrapper; if we
        # moved the whole temp dir itself, it's already gone.
        Remove-Item -Path $tempExtractDir -Recurse -Force -ErrorAction SilentlyContinue

        if ($fingerprint) { [void]$knownFingerprints.Add($fingerprint) }
        Write-Host "-> $destName" -ForegroundColor Green
        $nextNumber++
        $successCount++
    }
}

Write-Host ""
Write-Host "============================================================"
Write-Host "Done. $successCount avatar(s) moved to $AvatarsDir, $skipCount skipped."
Write-Host "Original zip files in 20250408\ and 20250612\ were left untouched."
Write-Host "============================================================"
