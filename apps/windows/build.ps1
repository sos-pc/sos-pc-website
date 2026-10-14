<#
.SYNOPSIS
  Builds Talos Diagnostic and packages it as an MSIX for the Microsoft Store.

.DESCRIPTION
  1. Compiles the WPF app (.NET Framework 4.8).
  2. Lays out the package (exe, config, assets, AppxManifest.xml).
  3. Indexes the scaled assets into resources.pri (makepri).
  4. Packs out\TalosDiagnostic_<version>_<arch>.msix (makeappx, which also
     validates the manifest).

  The package is unsigned: Partner Center signs Store submissions. The
  Store identity defaults to a local development identity; pass the values
  from Partner Center > Product identity (or set the STORE_* environment
  variables, as the GitHub workflow does) to build the Store upload.

.EXAMPLE
  ./apps/windows/build.ps1
  ./apps/windows/build.ps1 -IdentityName "12345TalosInt.TalosDiagnostic" -Publisher "CN=ABCD1234-..." -Version 1.0.1.0
#>
param(
  [string]$Configuration = "Release",
  [string]$IdentityName = $(if ($env:STORE_IDENTITY_NAME) { $env:STORE_IDENTITY_NAME } else { "TalosInt.TalosDiagnostic.Dev" }),
  [string]$Publisher = $(if ($env:STORE_PUBLISHER) { $env:STORE_PUBLISHER } else { "CN=TalosIntDev" }),
  [string]$PublisherDisplayName = $(if ($env:STORE_PUBLISHER_DISPLAY_NAME) { $env:STORE_PUBLISHER_DISPLAY_NAME } else { "Talos Int." }),
  [string]$Version = "1.0.0.0",
  [ValidateSet("x64", "arm64")] [string]$Arch = "x64"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$out = Join-Path $root "out"
$bin = Join-Path $out "bin"
$layout = Join-Path $out "layout"

function Find-SdkTool([string]$name) {
  $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  $tool = Get-ChildItem -Path $kits -Filter $name -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.Directory.Name -eq "x64" } |
    Sort-Object { $_.Directory.Parent.Name } -Descending |
    Select-Object -First 1
  if (-not $tool) { throw "$name introuvable : installez le Windows SDK (Windows Kits 10)." }
  return $tool.FullName
}

Write-Host "==> Compilation ($Configuration)"
dotnet build (Join-Path $root "TalosDiagnostic\TalosDiagnostic.csproj") -c $Configuration -o $bin --nologo
if ($LASTEXITCODE -ne 0) { throw "La compilation a échoué." }

Write-Host "==> Préparation du package"
if (Test-Path $layout) { Remove-Item -Recurse -Force $layout }
New-Item -ItemType Directory -Path (Join-Path $layout "Assets") | Out-Null
Copy-Item (Join-Path $bin "TalosDiagnostic.exe"), (Join-Path $bin "TalosDiagnostic.exe.config") $layout
Copy-Item (Join-Path $root "Package\Assets\*.png") (Join-Path $layout "Assets")

$manifest = Get-Content (Join-Path $root "Package\AppxManifest.xml") -Raw -Encoding UTF8
$tokens = @{
  '$IdentityName$' = $IdentityName
  '$Publisher$' = [System.Security.SecurityElement]::Escape($Publisher)
  '$PublisherDisplayName$' = [System.Security.SecurityElement]::Escape($PublisherDisplayName)
  '$Version$' = $Version
  '$Arch$' = $Arch
}
foreach ($key in $tokens.Keys) { $manifest = $manifest.Replace($key, $tokens[$key]) }
[System.IO.File]::WriteAllText((Join-Path $layout "AppxManifest.xml"), $manifest, (New-Object System.Text.UTF8Encoding $false))

Write-Host "==> Index des ressources (resources.pri)"
$makepri = Find-SdkTool "makepri.exe"
$priConfig = Join-Path $out "priconfig.xml"
& $makepri createconfig /cf $priConfig /dq fr-FR /pv 10.0.0 /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw "makepri createconfig a échoué." }
# Single package, not a bundle: keep every scale in resources.pri instead of
# splitting them into resource packs (resources.scale-200.pri).
[xml]$priXml = Get-Content $priConfig
$packaging = $priXml.SelectSingleNode("//packaging")
if ($packaging) { [void]$packaging.ParentNode.RemoveChild($packaging); $priXml.Save($priConfig) }
& $makepri new /pr $layout /cf $priConfig /mn (Join-Path $layout "AppxManifest.xml") /of (Join-Path $layout "resources.pri") /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw "makepri new a échoué." }

Write-Host "==> Création du MSIX"
$makeappx = Find-SdkTool "makeappx.exe"
$msix = Join-Path $out ("TalosDiagnostic_{0}_{1}.msix" -f $Version, $Arch)
& $makeappx pack /d $layout /p $msix /o
if ($LASTEXITCODE -ne 0) { throw "makeappx a échoué (manifeste invalide ?)." }

Write-Host ""
Write-Host "Package : $msix"
Write-Host "Identité : $IdentityName / $Publisher"
