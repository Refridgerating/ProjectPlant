param(
    [switch]$SkipStateMigration,
    [switch]$SkipPythonInstall,
    [string]$LanHost
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$workspaceRoot = Split-Path -Parent $repoRoot
$runtimeSecretsRoot = Join-Path $workspaceRoot "projectplant-runtime-secrets"
$fleetRoot = Join-Path $repoRoot "apps\fleet"
$hubRoot = Join-Path $repoRoot "apps\hub_api"

function Quote-PS {
    param([string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function Read-EnvFile {
    param([string]$PathValue)

    $values = @{}
    if (-not (Test-Path -LiteralPath $PathValue)) {
        return $values
    }

    foreach ($line in Get-Content -LiteralPath $PathValue) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) {
            continue
        }
        $parts = $trimmed.Split("=", 2)
        $values[$parts[0].Trim()] = $parts[1].Trim().Trim('"')
    }

    return $values
}

function Get-BasePython {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        return @("py", "-3")
    }
    if (Get-Command python -ErrorAction SilentlyContinue) {
        return @("python")
    }
    throw "Python 3 is required to run the local stack."
}

function Ensure-Venv {
    param([string]$AppRoot)

    $venvPython = Join-Path $AppRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $venvPython)) {
        $pythonCommand = Get-BasePython
        Write-Host "Creating virtualenv in $AppRoot\.venv"
        if ($pythonCommand.Count -eq 1) {
            & $pythonCommand[0] -m venv (Join-Path $AppRoot ".venv")
        } else {
            & $pythonCommand[0] $pythonCommand[1] -m venv (Join-Path $AppRoot ".venv")
        }
    }
    return $venvPython
}

function Ensure-Requirements {
    param(
        [string]$PythonPath,
        [string]$AppRoot
    )

    if ($SkipPythonInstall) {
        return
    }

    Push-Location $AppRoot
    try {
        & $PythonPath -m pip install --upgrade pip
        & $PythonPath -m pip install -r requirements.txt
    } finally {
        Pop-Location
    }
}

function Convert-ToEnvAssignments {
    param([hashtable]$Values)

    $parts = foreach ($key in ($Values.Keys | Sort-Object)) {
        $value = [string]$Values[$key]
        "`$env:$key=" + (Quote-PS $value)
    }
    return ($parts -join "; ")
}

function Get-PortListenerInfo {
    param([int]$Port)

    $pattern = "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$"
    foreach ($line in (netstat -ano)) {
        if ($line -match $pattern) {
            $processId = [int]$Matches[1]
            $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
            return [ordered]@{
                Port = $Port
                ProcessId = $processId
                ProcessName = if ($process) { $process.ProcessName } else { "unknown" }
                ProcessPath = if ($process) { $process.Path } else { $null }
            }
        }
    }
    return $null
}

function Format-PortListener {
    param($Info)

    if (-not $Info) {
        return "unknown process"
    }
    if ($Info.ProcessPath) {
        return "$($Info.ProcessName) [PID $($Info.ProcessId)] ($($Info.ProcessPath))"
    }
    return "$($Info.ProcessName) [PID $($Info.ProcessId)]"
}

function Get-PortApiInfo {
    param([int]$Port)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/v1/info" -TimeoutSec 2
        if (-not $response.Content) {
            return $null
        }
        $payload = $response.Content | ConvertFrom-Json
        if (-not $payload) {
            return $null
        }
        $name = if ($payload.name) { [string]$payload.name } else { "Unknown API" }
        $version = if ($payload.version) { [string]$payload.version } else { "unknown" }
        return "$name v$version"
    } catch {
        return $null
    }
}

function Resolve-Port {
    param(
        [int]$StartPort,
        [string]$Label,
        [int]$MaxAttempts = 50,
        [switch]$Fixed
    )

    for ($offset = 0; $offset -lt $MaxAttempts; $offset++) {
        $candidate = $StartPort + $offset
        $listener = Get-PortListenerInfo -Port $candidate
        if (-not $listener) {
            if ($offset -gt 0) {
                Write-Warning "$Label preferred port $StartPort is unavailable; using $candidate instead."
            }
            return $candidate
        }

        if ($offset -eq 0) {
            $message = "$Label preferred port $StartPort is already in use by $(Format-PortListener $listener)."
            if ($Fixed) {
                $apiInfo = Get-PortApiInfo -Port $candidate
                if ($apiInfo) {
                    $message += " The existing listener is responding as $apiInfo on http://127.0.0.1:$candidate/api/v1/info."
                }
                throw $message
            }
            Write-Warning $message
        }
    }

    throw "No free port found for $Label after scanning $MaxAttempts ports starting at $StartPort."
}

function Test-IPv4Literal {
    param([string]$Address)

    $parsed = $null
    return [System.Net.IPAddress]::TryParse($Address, [ref]$parsed)
}

function Test-Rfc1918Address {
    param([string]$Address)

    if (-not (Test-IPv4Literal -Address $Address)) {
        return $false
    }
    $octets = $Address.Split(".") | ForEach-Object { [int]$_ }
    if ($octets[0] -eq 10) {
        return $true
    }
    if ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) {
        return $true
    }
    if ($octets[0] -eq 192 -and $octets[1] -eq 168) {
        return $true
    }
    return $false
}

function Test-CgnatAddress {
    param([string]$Address)

    if (-not (Test-IPv4Literal -Address $Address)) {
        return $false
    }
    $octets = $Address.Split(".") | ForEach-Object { [int]$_ }
    return $octets[0] -eq 100 -and $octets[1] -ge 64 -and $octets[1] -le 127
}

function Get-HostFromUrl {
    param([string]$Url)

    if ([string]::IsNullOrWhiteSpace($Url)) {
        return $null
    }
    try {
        return ([uri]$Url).Host
    } catch {
        return $null
    }
}

function Get-LocalLanAddresses {
    $lanMatches = New-Object System.Collections.Generic.List[string]
    foreach ($line in (ipconfig)) {
        if ($line -match "IPv4[^:]*:\s*([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)") {
            $lanMatches.Add($Matches[1])
        }
    }

    return @(
        $lanMatches |
            Where-Object {
                $_ -ne "127.0.0.1" -and
                (Test-Rfc1918Address -Address $_) -and
                -not (Test-CgnatAddress -Address $_)
            } |
            Select-Object -Unique
    )
}

function Resolve-LanHost {
    param(
        [string]$Override,
        [hashtable]$HubManagedEnv,
        [hashtable]$AgentEnv
    )

    $localAddresses = @(Get-LocalLanAddresses)
    if ($Override) {
        if (-not (Test-IPv4Literal -Address $Override)) {
            throw "-LanHost must be an IPv4 address."
        }
        if ($localAddresses -notcontains $Override) {
            Write-Warning "Lan host override $Override was not detected in ipconfig output; continuing with the explicit override."
        }
        return $Override
    }

    $preferredHosts = @()
    $hubHost = Get-HostFromUrl -Url $HubManagedEnv["CONTROL_PLANE_URL"]
    if ($hubHost) {
        $preferredHosts += $hubHost
    }
    $agentHost = Get-HostFromUrl -Url $AgentEnv["FLEET_CONTROL_URL"]
    if ($agentHost) {
        $preferredHosts += $agentHost
    }

    foreach ($candidate in ($preferredHosts | Select-Object -Unique)) {
        if ($localAddresses -contains $candidate) {
            return $candidate
        }
    }

    if ($localAddresses.Count -gt 0) {
        return $localAddresses[0]
    }

    throw "Unable to resolve a local RFC1918 LAN address. Use -LanHost <ip> to override."
}

function ConvertTo-JsonArrayString {
    param([string[]]$Values)

    $normalized = @($Values | Where-Object { $_ } | Select-Object -Unique)
    return [string](ConvertTo-Json -InputObject $normalized -Compress)
}

function Build-UiOrigins {
    param(
        [string]$LanAddress,
        [int]$Port,
        [switch]$IncludeTauri
    )

    $origins = @(
        "http://127.0.0.1:${Port}",
        "http://localhost:${Port}",
        "http://${LanAddress}:${Port}"
    )
    if ($IncludeTauri) {
        $origins += "tauri://localhost"
    }
    return ConvertTo-JsonArrayString -Values $origins
}

function Start-Window {
    param(
        [string]$Title,
        [string]$WorkingDirectory,
        [string]$Command
    )

    $windowCommand = @(
        "`$host.UI.RawUI.WindowTitle = $(Quote-PS $Title)"
        "Set-Location $(Quote-PS $WorkingDirectory)"
        $Command
    ) -join "; "

    Start-Process powershell -WorkingDirectory $WorkingDirectory -ArgumentList @(
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        $windowCommand
    )
}

function Wait-HttpJson {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 20
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            return Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 2
        } catch {
            Start-Sleep -Seconds 1
        }
    }

    return $null
}

if (-not $SkipStateMigration) {
    & (Join-Path $PSScriptRoot "repair-runtime-state.ps1") -ArchiveDuplicates
}

$fleetPython = Ensure-Venv -AppRoot $fleetRoot
$hubPython = Ensure-Venv -AppRoot $hubRoot
Ensure-Requirements -PythonPath $fleetPython -AppRoot $fleetRoot
Ensure-Requirements -PythonPath $hubPython -AppRoot $hubRoot

$fleetSecretsEnv = Read-EnvFile -PathValue (Join-Path $runtimeSecretsRoot "fleet.dev.env")
$hubManagedEnv = Read-EnvFile -PathValue (Join-Path $runtimeSecretsRoot "hub.managed.env")
$agentEnv = Read-EnvFile -PathValue (Join-Path $runtimeSecretsRoot "agent.fleet.env")

$resolvedLanHost = Resolve-LanHost -Override $LanHost -HubManagedEnv $hubManagedEnv -AgentEnv $agentEnv
$fleetPort = Resolve-Port -StartPort 8100 -Label "Fleet API" -Fixed
$hubPort = Resolve-Port -StartPort 8000 -Label "Hub API" -Fixed
$fleetUiPort = Resolve-Port -StartPort 5180 -Label "Fleet UI"
$hubUiPort = Resolve-Port -StartPort 5173 -Label "Hub UI"

$fleetLocalBase = "http://127.0.0.1:${fleetPort}"
$fleetLanBase = "http://${resolvedLanHost}:${fleetPort}"
$hubLocalBase = "http://127.0.0.1:${hubPort}"
$hubLanBase = "http://${resolvedLanHost}:${hubPort}"
$fleetUiLocalBase = "http://127.0.0.1:${fleetUiPort}"
$fleetUiLanBase = "http://${resolvedLanHost}:${fleetUiPort}"
$hubUiLocalBase = "http://127.0.0.1:${hubUiPort}"
$hubUiLanBase = "http://${resolvedLanHost}:${hubUiPort}"

$fleetCorsOrigins = Build-UiOrigins -LanAddress $resolvedLanHost -Port $fleetUiPort
$hubCorsOrigins = Build-UiOrigins -LanAddress $resolvedLanHost -Port $hubUiPort -IncludeTauri

$fleetEnv = @{}
foreach ($key in $fleetSecretsEnv.Keys) {
    $fleetEnv[$key] = $fleetSecretsEnv[$key]
}
$fleetEnv["PORT"] = "$fleetPort"
$fleetEnv["DEBUG"] = "true"
$fleetEnv["FLEET_DATABASE_PATH"] = "data/fleet.sqlite3"
$fleetEnv["FLEET_ARTIFACT_DIR"] = "data/artifacts"
$fleetEnv["CORS_ORIGINS"] = $fleetCorsOrigins
$fleetAssignments = Convert-ToEnvAssignments -Values $fleetEnv

$hubEnv = @{}
foreach ($key in $hubManagedEnv.Keys) {
    $hubEnv[$key] = $hubManagedEnv[$key]
}
if ($hubEnv.ContainsKey("MQTT_ENABLED")) {
    $hubEnv.Remove("MQTT_ENABLED") | Out-Null
}
$hubEnv["PORT"] = "$hubPort"
$hubEnv["DEBUG"] = "true"
$hubEnv["CONTROL_PLANE_AUTH_MODE"] = "managed"
$hubEnv["CONTROL_PLANE_URL"] = $fleetLanBase
$hubEnv["CORS_ORIGINS"] = $hubCorsOrigins
$hubAssignments = Convert-ToEnvAssignments -Values $hubEnv

$fleetCommand = "$fleetAssignments; & $(Quote-PS $fleetPython) -m uvicorn --app-dir src main:app --reload --host 0.0.0.0 --port $fleetPort"
$hubCommand = "$hubAssignments; & $(Quote-PS $hubPython) -m uvicorn --app-dir src main:app --reload --host 0.0.0.0 --port $hubPort"
$fleetUiCommand = @(
    "`$env:PROJECTPLANT_STRICT_PORTS='1'"
    "`$env:VITE_FLEET_URL=$(Quote-PS $fleetLanBase)"
    "pnpm -C apps/fleet-ui dev --host 0.0.0.0 --port $fleetUiPort"
) -join "; "
$hubUiCommand = @(
    "`$env:PROJECTPLANT_STRICT_PORTS='1'"
    "`$env:PROJECTPLANT_HUB_URL=$(Quote-PS $hubLocalBase)"
    "pnpm -C apps/web_ui dev --host 0.0.0.0 --port $hubUiPort"
) -join "; "

$fleetProcess = Start-Window -Title "ProjectPlant Fleet" -WorkingDirectory $fleetRoot -Command $fleetCommand
$hubProcess = Start-Window -Title "ProjectPlant Hub" -WorkingDirectory $hubRoot -Command $hubCommand
$fleetUiProcess = Start-Window -Title "ProjectPlant Fleet UI" -WorkingDirectory $repoRoot -Command $fleetUiCommand
$hubUiProcess = Start-Window -Title "ProjectPlant Hub UI" -WorkingDirectory $repoRoot -Command $hubUiCommand

$hubInfoUrl = "${hubLocalBase}/api/v1/info"
$hubInfo = Wait-HttpJson -Url $hubInfoUrl -TimeoutSeconds 20

Write-Host "Resolved LAN host: $resolvedLanHost"
Write-Host "Started local ProjectPlant stack:"
Write-Host "  Fleet API:     $fleetLocalBase    LAN $fleetLanBase"
Write-Host "  Hub API:       $hubLocalBase    LAN $hubLanBase"
Write-Host "  Fleet UI:      $fleetUiLocalBase    LAN $fleetUiLanBase"
Write-Host "  Hub UI:        $hubUiLocalBase    LAN $hubUiLanBase"
if ($hubInfo) {
    $authMode = if ($hubInfo.authMode) { $hubInfo.authMode } else { "unknown" }
    $hubId = if ($hubInfo.hubId) { $hubInfo.hubId } else { "unassigned" }
    Write-Host "Hub API smoke check passed: $($hubInfo.name) authMode=$authMode hubId=$hubId ($hubInfoUrl)"
} else {
    Write-Warning "Hub API smoke check failed: $hubInfoUrl did not respond within 20 seconds. Check the 'ProjectPlant Hub' window for startup errors."
}
