$ErrorActionPreference = "SilentlyContinue"
$Host.UI.RawUI.WindowTitle = "Talos Int. - Diagnostic en cours..."
Write-Host ""
Write-Host "  +-----------------------------------------+" -ForegroundColor Cyan
Write-Host "  |       Talos Int. - Diagnostic PC        |" -ForegroundColor Cyan
Write-Host "  +-----------------------------------------+" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Collecte des informations systeme..." -ForegroundColor White
Write-Host ""

# ── [1/12] OS ──────────────────────────────────────────────────────────────
Write-Host "  [1/12] Systeme d exploitation..." -ForegroundColor Gray
$os = Get-CimInstance Win32_OperatingSystem
$osInfo = @{
    name          = $os.Caption
    version       = $os.Version
    build         = $os.BuildNumber
    arch          = $os.OSArchitecture
    uptime        = [math]::Round((New-TimeSpan -Start $os.LastBootUpTime).TotalHours, 1)
    ram_total_gb  = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    ram_free_gb   = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    pagefile_total_gb = [math]::Round($os.SizeStoredInPagingFiles / 1MB, 1)
    pagefile_used_gb  = [math]::Round(($os.SizeStoredInPagingFiles - $os.FreeSpaceInPagingFiles) / 1MB, 1)
    last_boot     = $os.LastBootUpTime.ToString("yyyy-MM-ddTHH:mm:ss")
}

# ── [2/12] CPU ─────────────────────────────────────────────────────────────
Write-Host "  [2/12] Processeur..." -ForegroundColor Gray
$cpu     = Get-CimInstance Win32_Processor | Select-Object -First 1
$cpuLoad = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$cpuInfo = @{
    name    = $cpu.Name.Trim()
    cores   = $cpu.NumberOfCores
    threads = $cpu.NumberOfLogicalProcessors
    load    = [int]$cpuLoad
    max_mhz = $cpu.MaxClockSpeed
    socket  = $cpu.SocketDesignation
}

# ── [3/12] GPU ─────────────────────────────────────────────────────────────
Write-Host "  [3/12] Carte graphique..." -ForegroundColor Gray
$gpus = Get-CimInstance Win32_VideoController | ForEach-Object {
    @{
        name          = $_.Name
        ram_mb        = [math]::Round($_.AdapterRAM / 1MB)
        driver        = $_.DriverVersion
        driver_date   = if ($_.DriverDate) { $_.DriverDate.ToString("yyyy-MM-dd") } else { "?" }
        resolution    = "$($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)"
        refresh_hz    = $_.CurrentRefreshRate
        status        = $_.Status
    }
}

# ── [4/12] Stockage ────────────────────────────────────────────────────────
Write-Host "  [4/12] Stockage..." -ForegroundColor Gray
$disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
    @{
        letter   = $_.DeviceID
        label    = $_.VolumeName
        total_gb = [math]::Round($_.Size / 1GB, 1)
        free_gb  = [math]::Round($_.FreeSpace / 1GB, 1)
        pct_used = if ($_.Size -gt 0) { [math]::Round((1 - $_.FreeSpace / $_.Size) * 100) } else { 0 }
    }
}

# SMART + type disque
$physicalDisks = Get-PhysicalDisk | ForEach-Object {
    $smart = Get-StorageReliabilityCounter -PhysicalDisk $_ -ErrorAction SilentlyContinue
    @{
        friendly_name    = $_.FriendlyName
        media_type       = $_.MediaType
        bus_type         = $_.BusType
        size_gb          = [math]::Round($_.Size / 1GB, 1)
        health_status    = $_.HealthStatus
        operational_status = $_.OperationalStatus
        hours_used       = if ($smart) { $smart.PowerOnHours } else { $null }
        reallocated_sectors = if ($smart) { $smart.Reallocated } else { $null }
        read_errors      = if ($smart) { $smart.ReadErrorsUncorrected } else { $null }
        temperature_c    = if ($smart) { $smart.Temperature } else { $null }
    }
}

# ── [5/12] Reseau ──────────────────────────────────────────────────────────
Write-Host "  [5/12] Reseau..." -ForegroundColor Gray
$netAdapters = Get-NetAdapter | Where-Object { $_.Status -eq "Up" } | ForEach-Object {
    $ip = Get-NetIPAddress -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1
    @{
        name        = $_.Name
        description = $_.InterfaceDescription
        type        = if ($_.Name -match "Wi-Fi|WiFi|Wireless") { "WiFi" } elseif ($_.Name -match "VPN|Tunnel") { "VPN" } else { "Ethernet" }
        speed_mbps  = [math]::Round($_.LinkSpeed / 1MB)
        ip          = if ($ip) { $ip.IPAddress } else { $null }
    }
}

# Test connectivite
$pingGoogle  = Test-Connection -ComputerName "8.8.8.8"      -Count 1 -Quiet -ErrorAction SilentlyContinue

$dnsLatency  = Measure-Command { Resolve-DnsName "google.com" -ErrorAction SilentlyContinue } | Select-Object -ExpandProperty TotalMilliseconds

$networkInfo = @{
    adapters        = @($netAdapters)
    internet_ok     = $pingGoogle
    dns_latency_ms  = [math]::Round($dnsLatency)
}

# ── [6/12] Securite ────────────────────────────────────────────────────────
Write-Host "  [6/12] Securite..." -ForegroundColor Gray
$defender = Get-MpComputerStatus -ErrorAction SilentlyContinue
$firewall = Get-NetFirewallProfile -ErrorAction SilentlyContinue

$securityInfo = @{
    defender_enabled         = if ($defender) { $defender.AntivirusEnabled }        else { $null }
    realtime_protection      = if ($defender) { $defender.RealTimeProtectionEnabled } else { $null }
    antivirus_signature_date = if ($defender) { $defender.AntivirusSignatureLastUpdated.ToString("yyyy-MM-dd") } else { $null }
    antispyware_enabled      = if ($defender) { $defender.AntispywareEnabled }       else { $null }
    firewall_domain          = if ($firewall) { ($firewall | Where-Object Name -eq "Domain").Enabled }  else { $null }
    firewall_private         = if ($firewall) { ($firewall | Where-Object Name -eq "Private").Enabled } else { $null }
    firewall_public          = if ($firewall) { ($firewall | Where-Object Name -eq "Public").Enabled }  else { $null }
    uac_enabled              = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" -ErrorAction SilentlyContinue).EnableLUA
}

# ── [7/12] Mises a jour ────────────────────────────────────────────────────
Write-Host "  [7/12] Mises a jour Windows..." -ForegroundColor Gray
$lastUpdates = Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 5 | ForEach-Object {
    @{
        id           = $_.HotFixID
        description  = $_.Description
        installed_on = if ($_.InstalledOn) { $_.InstalledOn.ToString("yyyy-MM-dd") } else { "?" }
    }
}
$updatesInfo = @{
    last_hotfixes = @($lastUpdates)
}

# ── [8/12] Temperatures ────────────────────────────────────────────────────
Write-Host "  [8/12] Temperatures..." -ForegroundColor Gray
$thermalZones = Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace "root/wmi" -ErrorAction SilentlyContinue | ForEach-Object {
    @{
        instance    = $_.InstanceName
        temp_celsius = [math]::Round($_.CurrentTemperature / 10 - 273.15, 1)
    }
}

# ── [9/12] Stabilite (BSOD) ───────────────────────────────────────────────
Write-Host "  [9/12] Stabilite systeme..." -ForegroundColor Gray
$since = (Get-Date).AddHours(-24)
$since7days = (Get-Date).AddDays(-7)

$bsods = Get-WinEvent -FilterHashtable @{ LogName='System'; Id=41,1001; StartTime=$since7days } -MaxEvents 10 -ErrorAction SilentlyContinue | ForEach-Object {
    @{
        time    = $_.TimeCreated.ToString("yyyy-MM-ddTHH:mm:ss")
        id      = $_.Id
        message = ($_.Message -split "`n")[0] -replace '[^\x20-\x7E]', ''
    }
}

$critCount    = (Get-WinEvent -FilterHashtable @{ LogName='System','Application'; Level=1,2; StartTime=$since } -MaxEvents 100 -ErrorAction SilentlyContinue | Measure-Object).Count
$recentErrors = Get-WinEvent -FilterHashtable @{ LogName='System'; Level=2; StartTime=$since } -MaxEvents 5 -ErrorAction SilentlyContinue | ForEach-Object {
    @{
        id      = $_.Id
        source  = $_.ProviderName
        time    = $_.TimeCreated.ToString("yyyy-MM-ddTHH:mm:ss")
        message = ($_.Message -split "`n")[0] -replace '[^\x20-\x7E]', ''
    }
}

$stabilityInfo = @{
    bsod_last_7days = @($bsods)
    bsod_count      = @($bsods).Count
    critical_24h    = $critCount
    samples         = @($recentErrors)
}

# ── [10/12] Performance I/O ────────────────────────────────────────────────
Write-Host "  [10/12] Performance disque..." -ForegroundColor Gray
$diskIO = Get-Counter '\PhysicalDisk(_Total)\% Disk Time' -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue
$diskQueue = Get-Counter '\PhysicalDisk(_Total)\Current Disk Queue Length' -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue

$performanceInfo = @{
    disk_pct_busy    = if ($diskIO)    { [math]::Round($diskIO.CounterSamples[0].CookedValue, 1) }    else { $null }
    disk_queue       = if ($diskQueue) { [math]::Round($diskQueue.CounterSamples[0].CookedValue, 1) } else { $null }
    ram_used_pct     = [math]::Round((1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100, 1)
    pagefile_used_pct = if ($os.SizeStoredInPagingFiles -gt 0) { [math]::Round(($os.SizeStoredInPagingFiles - $os.FreeSpaceInPagingFiles) / $os.SizeStoredInPagingFiles * 100, 1) } else { 0 }
}

# ── [11/12] Processus + Demarrage ─────────────────────────────────────────
Write-Host "  [11/12] Processus et demarrage..." -ForegroundColor Gray
$topProcs = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 8 | ForEach-Object {
    @{
        name   = $_.Name
        ram_mb = [math]::Round($_.WorkingSet64 / 1MB)
        cpu    = [math]::Round($_.CPU, 1)
        pid    = $_.Id
    }
}

$startupApps = @()
foreach ($path in @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run"
)) {
    if (Test-Path $path) {
        Get-ItemProperty $path | Get-Member -MemberType NoteProperty |
        Where-Object { $_.Name -notlike "PS*" } |
        ForEach-Object { $startupApps += $_.Name }
    }
}

# ── [12/12] Logiciels installes (liste complete) ───────────────────────────
Write-Host "  [12/12] Logiciels installes..." -ForegroundColor Gray
$softwarePaths = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
$installedSoftware = Get-ItemProperty $softwarePaths -ErrorAction SilentlyContinue |
    Where-Object {
        $_.DisplayName -and
        $_.DisplayName -ne "" -and
        $_.Publisher -notmatch "^Microsoft" -and
        $_.Publisher -notmatch "^Windows" -and
        $_.DisplayName -notmatch "^Microsoft" -and
        $_.DisplayName -notmatch "^Windows SDK" -and
        $_.DisplayName -notmatch "^Windows Desktop" -and
        $_.DisplayName -notmatch "^Universal CRT" -and
        $_.DisplayName -notmatch "^WinRT" -and
        $_.DisplayName -notmatch "^vs_" -and
        $_.DisplayName -notmatch "^vcpp_" -and
        $_.DisplayName -notmatch "^KB[0-9]" -and
        $_.DisplayName -notmatch "Add to Path|Core Interpreter|Development Libraries" -and
        $_.DisplayName -notmatch "pip Bootstrap|Standard Library|Tcl/Tk Support|Test Suite" -and
        $_.DisplayName -notmatch "Python Launcher|Python [0-9]+\.[0-9]+ (Add|Core|Dev|Doc|Exe|pip|Std|Tcl|Test)" -and
        $_.DisplayName -notmatch "AppHost Pack|Targeting Pack|Toolset|Templates [0-9]" -and
        $_.DisplayName -notmatch "Host FX Resolver|Host - [0-9]|Runtime - [0-9]" -and
        $_.DisplayName -notmatch "Workload\.(Emscripten|Mono|Maui|iOS|tvOS|Android|MacCatalyst|macOS)" -and
        $_.DisplayName -notmatch "Manifest-[0-9]|SDK\.[A-Z]" -and
        $_.DisplayName -notmatch "Redistributable.*- [0-9]{2}\.[0-9]" -and
        $_.DisplayName -notmatch "^Update for " 
    } |
    Sort-Object DisplayName |
    ForEach-Object {
        @{
            name         = $_.DisplayName
            version      = $_.DisplayVersion
            publisher    = $_.Publisher
            install_date = $_.InstallDate
            size_mb      = if ($_.EstimatedSize) { [math]::Round($_.EstimatedSize / 1KB, 1) } else { $null }
        }
    }

# ── Assemblage payload ──────────────────────────────────────────────────────
$payload = @{
    os           = $osInfo
    cpu          = $cpuInfo
    gpus         = @($gpus)
    disks        = @($disks)
    physical_disks = @($physicalDisks)
    network      = $networkInfo
    security     = $securityInfo
    updates      = $updatesInfo
    temperatures = @($thermalZones)
    stability    = $stabilityInfo
    performance  = $performanceInfo
    procs        = @($topProcs)
    startup      = @($startupApps | Select-Object -Unique | Select-Object -First 30)
    software     = @($installedSoftware)
    collected_at = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss")
}

# ── Envoi ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Envoi des donnees vers Talos Int..." -ForegroundColor White

$sessionId = if ($s) { $s } else { "nosession" }

try {
    $body = [System.Text.Encoding]::UTF8.GetBytes(
        (@{ session = $sessionId; data = $payload } | ConvertTo-Json -Depth 6 -Compress)
    )
    Invoke-RestMethod -Uri "https://www.talos-int.com/api/diag/collect" `
        -Method POST `
        -ContentType "application/json; charset=utf-8" `
        -Body $body | Out-Null
    Write-Host "  Donnees envoyees ! Retournez sur talos-int.com" -ForegroundColor Green
} catch {
    Write-Host "  Erreur d envoi : $_" -ForegroundColor Red
}

Write-Host ""
Start-Sleep 3
