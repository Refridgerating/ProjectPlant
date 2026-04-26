param(
    [switch]$ArchiveDuplicates = $true
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$archiveStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$archiveRoot = Join-Path $repoRoot ("state-archive\" + $archiveStamp)
$script:reportActions = New-Object System.Collections.Generic.List[object]

function Add-Report {
    param(
        [string]$Action,
        [string]$Source,
        [string]$Target,
        [string]$Detail
    )

    $script:reportActions.Add([pscustomobject]@{
            action = $Action
            source = $Source
            target = $Target
            detail = $Detail
        })
}

function Ensure-Directory {
    param([string]$PathValue)

    if (-not (Test-Path -LiteralPath $PathValue)) {
        New-Item -ItemType Directory -Path $PathValue -Force | Out-Null
    }
}

function Get-RepoRelativePath {
    param([string]$PathValue)

    $resolved = (Resolve-Path -LiteralPath $PathValue).Path
    if ($resolved.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $resolved.Substring($repoRoot.Length).TrimStart("\")
    }
    return Split-Path -Path $resolved -Leaf
}

function Archive-Path {
    param(
        [string]$SourcePath,
        [string]$Reason
    )

    if (-not $ArchiveDuplicates -or -not (Test-Path -LiteralPath $SourcePath)) {
        return
    }

    $relative = Get-RepoRelativePath -PathValue $SourcePath
    $destination = Join-Path $archiveRoot $relative
    Ensure-Directory (Split-Path -Parent $destination)
    Move-Item -LiteralPath $SourcePath -Destination $destination -Force
    Add-Report -Action "archive" -Source $SourcePath -Target $destination -Detail $Reason
}

function Copy-CanonicalFile {
    param(
        [string]$SourcePath,
        [string]$TargetPath,
        [string]$Reason
    )

    if (-not (Test-Path -LiteralPath $SourcePath)) {
        return
    }

    Ensure-Directory (Split-Path -Parent $TargetPath)
    Copy-Item -LiteralPath $SourcePath -Destination $TargetPath -Force
    Add-Report -Action "copy" -Source $SourcePath -Target $TargetPath -Detail $Reason
}

function Merge-Directory {
    param(
        [string]$SourceDir,
        [string]$TargetDir,
        [string]$Reason
    )

    if (-not (Test-Path -LiteralPath $SourceDir)) {
        return
    }

    Ensure-Directory $TargetDir
    $sourceRoot = (Resolve-Path -LiteralPath $SourceDir).Path
    Get-ChildItem -LiteralPath $SourceDir -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($sourceRoot.Length).TrimStart("\")
        $targetPath = Join-Path $TargetDir $relative
        Ensure-Directory (Split-Path -Parent $targetPath)

        $copyFile = $true
        if (Test-Path -LiteralPath $targetPath) {
            $targetInfo = Get-Item -LiteralPath $targetPath
            $copyFile = $_.LastWriteTimeUtc -gt $targetInfo.LastWriteTimeUtc -or $_.Length -ne $targetInfo.Length
        }

        if ($copyFile) {
            Copy-Item -LiteralPath $_.FullName -Destination $targetPath -Force
            Add-Report -Action "merge-file" -Source $_.FullName -Target $targetPath -Detail $Reason
        }
    }
}

function Get-CurrentIso {
    return (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}

function Read-JsonFile {
    param([string]$PathValue)

    if (-not (Test-Path -LiteralPath $PathValue)) {
        return $null
    }

    try {
        return Get-Content -LiteralPath $PathValue -Raw | ConvertFrom-Json -AsHashtable
    } catch {
        return $null
    }
}

function Get-DeviceRegistryEntries {
    param([string]$PathValue)

    $entries = @{}
    $raw = Read-JsonFile -PathValue $PathValue
    if ($null -eq $raw) {
        return $entries
    }

    $devices = $raw
    if ($raw -is [System.Collections.IDictionary] -and $raw.Contains("devices")) {
        $devices = $raw["devices"]
    }

    if ($devices -is [System.Collections.IDictionary]) {
        foreach ($item in $devices.GetEnumerator()) {
            $potId = "$($item.Key)".Trim().ToLowerInvariant()
            if (-not $potId) {
                continue
            }
            $payload = $item.Value
            $addedAt = $null
            if ($payload -is [System.Collections.IDictionary]) {
                $addedAt = $payload["addedAt"]
                if (-not $addedAt) {
                    $addedAt = $payload["added_at"]
                }
            }
            if (-not $addedAt) {
                $addedAt = Get-CurrentIso
            }
            $entries[$potId] = [ordered]@{
                potId = $potId
                addedAt = "$addedAt"
            }
        }
        return $entries
    }

    if ($devices -is [System.Collections.IEnumerable]) {
        foreach ($item in $devices) {
            $potId = $null
            $addedAt = $null
            if ($item -is [string]) {
                $potId = $item
            } elseif ($item -is [System.Collections.IDictionary]) {
                $potId = $item["potId"]
                if (-not $potId) {
                    $potId = $item["pot_id"]
                }
                $addedAt = $item["addedAt"]
                if (-not $addedAt) {
                    $addedAt = $item["added_at"]
                }
            }

            $normalized = "$potId".Trim().ToLowerInvariant()
            if (-not $normalized) {
                continue
            }
            if (-not $addedAt) {
                $addedAt = Get-CurrentIso
            }
            $entries[$normalized] = [ordered]@{
                potId = $normalized
                addedAt = "$addedAt"
            }
        }
    }

    return $entries
}

function Write-DeviceRegistry {
    param(
        [string]$PathValue,
        [hashtable]$Entries
    )

    Ensure-Directory (Split-Path -Parent $PathValue)
    $devices = [ordered]@{}
    foreach ($potId in ($Entries.Keys | Sort-Object)) {
        $entry = $Entries[$potId]
        $devices[$potId] = [ordered]@{
            potId = $entry.potId
            addedAt = $entry.addedAt
        }
    }

    $payload = [ordered]@{
        version = 1
        devices = $devices
    }
    $json = $payload | ConvertTo-Json -Depth 8
    Set-Content -LiteralPath $PathValue -Value $json -Encoding utf8
}

function Merge-DeviceRegistry {
    param(
        [string]$SourcePath,
        [string]$TargetPath
    )

    if (-not (Test-Path -LiteralPath $SourcePath)) {
        return
    }

    $targetEntries = Get-DeviceRegistryEntries -PathValue $TargetPath
    $sourceEntries = Get-DeviceRegistryEntries -PathValue $SourcePath
    foreach ($potId in $sourceEntries.Keys) {
        if (-not $targetEntries.ContainsKey($potId)) {
            $targetEntries[$potId] = $sourceEntries[$potId]
        }
    }

    if ($targetEntries.Count -gt 0) {
        Write-DeviceRegistry -PathValue $TargetPath -Entries $targetEntries
        Add-Report -Action "merge-registry" -Source $SourcePath -Target $TargetPath -Detail "Merged device registry entries into canonical hub data."
    }
}

$fleetDataDir = Join-Path $repoRoot "apps\fleet\data"
$fleetCanonicalDb = Join-Path $fleetDataDir "fleet.sqlite3"
$fleetArtifactsDir = Join-Path $fleetDataDir "artifacts"
$fleetAuthoritativeDb = Join-Path $repoRoot "apps\fleet\src\data\fleet.sqlite3"
$fleetStaleDb = Join-Path $repoRoot "data\fleet.sqlite3"

$hubDataDir = Join-Path $repoRoot "apps\hub_api\data"
$hubCanonicalDb = Join-Path $hubDataDir "pot_telemetry.sqlite"
$hubCanonicalRegistry = Join-Path $hubDataDir "device_registry.json"
$hubCanonicalSchedules = Join-Path $hubDataDir "plant_schedules.json"
$hubCanonicalProvisioning = Join-Path $hubDataDir "provisioning"
$hubCanonicalHrrr = Join-Path $hubDataDir "hrrr"

$repoRootDataDir = Join-Path $repoRoot "data"
$repoRootHubDb = Join-Path $repoRootDataDir "pot_telemetry.sqlite"
$repoRootRegistry = Join-Path $repoRootDataDir "device_registry.json"
$repoRootSchedules = Join-Path $repoRootDataDir "plant_schedules.json"
$repoRootProvisioning = Join-Path $repoRootDataDir "provisioning"
$repoRootHrrr = Join-Path $repoRootDataDir "hrrr"

$packagedHubDataDir = Join-Path $repoRoot "apps\hub\apps\hub\data"
$packagedHubRegistry = Join-Path $packagedHubDataDir "device_registry.json"
$packagedHubSchedules = Join-Path $packagedHubDataDir "plant_schedules.json"
$packagedHubProvisioning = Join-Path $packagedHubDataDir "provisioning"
$packagedHubHrrr = Join-Path $packagedHubDataDir "hrrr"

Ensure-Directory $fleetDataDir
Ensure-Directory $fleetArtifactsDir
Ensure-Directory $hubDataDir
Ensure-Directory $hubCanonicalProvisioning
Ensure-Directory $hubCanonicalHrrr

Copy-CanonicalFile -SourcePath $fleetAuthoritativeDb -TargetPath $fleetCanonicalDb -Reason "Promoted authoritative fleet database into apps/fleet/data."
Archive-Path -SourcePath $fleetAuthoritativeDb -Reason "Archived former authoritative fleet database after promotion."
Archive-Path -SourcePath $fleetStaleDb -Reason "Archived stale repo-root fleet database backup."

Merge-DeviceRegistry -SourcePath $repoRootRegistry -TargetPath $hubCanonicalRegistry
Merge-DeviceRegistry -SourcePath $packagedHubRegistry -TargetPath $hubCanonicalRegistry
Archive-Path -SourcePath $repoRootRegistry -Reason "Archived repo-root device registry after merge."
Archive-Path -SourcePath $packagedHubRegistry -Reason "Archived packaged device registry after merge."

if (-not (Test-Path -LiteralPath $hubCanonicalSchedules)) {
    Copy-CanonicalFile -SourcePath $repoRootSchedules -TargetPath $hubCanonicalSchedules -Reason "Promoted repo-root plant schedules into apps/hub_api/data."
    Copy-CanonicalFile -SourcePath $packagedHubSchedules -TargetPath $hubCanonicalSchedules -Reason "Promoted packaged plant schedules into apps/hub_api/data."
}
Archive-Path -SourcePath $repoRootSchedules -Reason "Archived repo-root plant schedules after merge."
Archive-Path -SourcePath $packagedHubSchedules -Reason "Archived packaged plant schedules after merge."

if (Test-Path -LiteralPath $repoRootHubDb) {
    $sourceInfo = Get-Item -LiteralPath $repoRootHubDb
    $targetLength = 0
    if (Test-Path -LiteralPath $hubCanonicalDb) {
        $targetLength = (Get-Item -LiteralPath $hubCanonicalDb).Length
    }
    if (-not (Test-Path -LiteralPath $hubCanonicalDb) -or ($targetLength -eq 0 -and $sourceInfo.Length -gt 0)) {
        Copy-CanonicalFile -SourcePath $repoRootHubDb -TargetPath $hubCanonicalDb -Reason "Promoted repo-root telemetry database into apps/hub_api/data."
    }
}
Archive-Path -SourcePath $repoRootHubDb -Reason "Archived repo-root telemetry database after merge."

Merge-Directory -SourceDir $repoRootProvisioning -TargetDir $hubCanonicalProvisioning -Reason "Merged repo-root provisioning logs into canonical hub data."
Merge-Directory -SourceDir $packagedHubProvisioning -TargetDir $hubCanonicalProvisioning -Reason "Merged packaged provisioning logs into canonical hub data."
Archive-Path -SourcePath $repoRootProvisioning -Reason "Archived repo-root provisioning logs after merge."
Archive-Path -SourcePath $packagedHubProvisioning -Reason "Archived packaged provisioning logs after merge."

Merge-Directory -SourceDir $repoRootHrrr -TargetDir $hubCanonicalHrrr -Reason "Merged repo-root HRRR cache into canonical hub data."
Merge-Directory -SourceDir $packagedHubHrrr -TargetDir $hubCanonicalHrrr -Reason "Merged packaged HRRR cache into canonical hub data."
Archive-Path -SourcePath $repoRootHrrr -Reason "Archived repo-root HRRR cache after merge."
Archive-Path -SourcePath $packagedHubHrrr -Reason "Archived packaged HRRR cache after merge."

Ensure-Directory $archiveRoot
$reportPath = Join-Path $archiveRoot "repair-report.json"
$report = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    repoRoot = $repoRoot
    archiveDuplicates = [bool]$ArchiveDuplicates
    actions = $script:reportActions
}
($report | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $reportPath -Encoding utf8

Write-Host "Runtime state repair complete."
Write-Host "Canonical fleet DB: $fleetCanonicalDb"
Write-Host "Canonical hub data: $hubDataDir"
Write-Host "Report: $reportPath"
