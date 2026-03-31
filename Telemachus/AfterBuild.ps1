param(
    [Parameter(Mandatory)][string]$ProjectDir,
    [Parameter(Mandatory)][string]$TargetDir,
    [switch]$Dev
)

$ErrorActionPreference = 'Stop'

$root = Resolve-Path "$ProjectDir/.."
$publish = "$root/publish/GameData/Telemachus"
$pluginData = "$publish/Plugins/PluginData/Telemachus"

Write-Host "ProjectDir: $ProjectDir"
Write-Host "TargetDir:  $TargetDir"

# Determine if we need to run a full publish build
$mustPublish = (-not $Dev) -or (-not (Test-Path "$publish/Plugins/Telemachus.dll"))

if ($mustPublish) {
    if ($Dev) { Write-Host "Publish folder missing or incomplete, forcing full build even in -Dev mode." }

    # Stage publish directory
    if (Test-Path "$root/publish/GameData") {
        Remove-Item "$root/publish/GameData" -Recurse -Force
    }

    New-Item -ItemType Directory -Force -Path "$publish/Plugins", "$publish/Parts", "$publish/PluginData", "$publish/Textures", $pluginData | Out-Null

    Copy-Item "$TargetDir/Telemachus.dll"      "$publish/Plugins/"
    Copy-Item "$TargetDir/websocket-sharp.dll" "$publish/Plugins/"

    Copy-Item "$root/TelemachusReborn.version" "$publish/"

    Copy-Item "$root/Parts/*"                "$publish/Parts/"    -Recurse -Force
    Copy-Item "$root/Telemachus/Textures/*" "$publish/Textures/" -Recurse -Force
    Copy-Item "$root/WebPages/WebPages/src/*" $pluginData          -Recurse -Force
    Copy-Item "$root/Licences/*"             "$publish/"          -Recurse -Force
    Copy-Item "$root/README.md"              "$publish/"

    # Download Houston & mkon
    Write-Host "Downloading external assets..."
    $headers = @{}
    if ($env:GITHUB_TOKEN) {
        $headers['Authorization'] = "token $env:GITHUB_TOKEN"
    }

    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/TeleIO/houston/releases/latest' -Headers $headers
    $houstonUrl = $release.assets[0].browser_download_url

    $houstonZip = Join-Path $TargetDir 'Houston.zip'
    Invoke-WebRequest -Uri $houstonUrl -OutFile $houstonZip
    New-Item -ItemType Directory -Force -Path "$pluginData/houston" | Out-Null
    Expand-Archive -Path $houstonZip -DestinationPath "$pluginData/houston" -Force

    # Download mkon
    $mkonZip = Join-Path $TargetDir 'mkon.zip'
    Invoke-WebRequest -Uri 'https://github.com/TeleIO/mkon/archive/master.zip' -OutFile $mkonZip
    $mkonTmp = Join-Path $TargetDir 'mkon-extract'
    Expand-Archive -Path $mkonZip -DestinationPath $mkonTmp -Force
    New-Item -ItemType Directory -Force -Path "$pluginData/mkon" | Out-Null
    Copy-Item "$mkonTmp/mkon-master/*" "$pluginData/mkon" -Recurse -Force

    # Cleanup
    Remove-Item $houstonZip, $mkonZip -Force -ErrorAction SilentlyContinue
    Remove-Item $mkonTmp -Recurse -Force -ErrorAction SilentlyContinue

    # Extract API schema from source-generated file
    $schemaFile = Get-ChildItem "$ProjectDir/obj" -Filter "TelemetrySchema.g.cs" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($schemaFile) {
        $content = Get-Content $schemaFile.FullName -Raw
        if ($content -match 'internal const string Json = @"([\s\S]*?)";') {
            $json = $Matches[1] -replace '""', '"'
            Set-Content "$root/publish/api-schema.json" $json -NoNewline
            Write-Host "Extracted API schema to publish/api-schema.json"
        }
    } else {
        Write-Host "Warning: TelemetrySchema.g.cs not found in obj/"
    }
} else {
    Write-Host "Skipping Publish build (-Dev mode active and publish folder found)."
}

# Copy to local KSP install (local dev only)
$kspDir = "$root/ksp-telemachus-dev"
if (Test-Path $kspDir) {
    if (Test-Path "$kspDir/GameData/Telemachus") {
        Remove-Item "$kspDir/GameData/Telemachus" -Recurse -Force
    }

    # Ensure base directory exists
    New-Item -ItemType Directory -Force -Path "$kspDir/GameData/Telemachus/Plugins" | Out-Null

    # If in dev mode, we copy the DLL from the target dir directly since publish was skipped
    if ($Dev) {
        Write-Host "Updating DLLs directly in KSP (Dev Mode)..."
        Copy-Item "$TargetDir/Telemachus.dll"      "$kspDir/GameData/Telemachus/Plugins/"
        Copy-Item "$TargetDir/websocket-sharp.dll" "$kspDir/GameData/Telemachus/Plugins/"
    }

    # Robocopy copies everything EXCEPT the web assets folder that we want to link
    # /E = Copy subdirectories, including empty ones.
    # /XD = Exclude Directories
    $publishGameData = "$root/publish/GameData"
    $devGameData = "$kspDir/GameData"
    # Robocopy /XD works best with absolute paths or exact folder names
    $excludePath = Join-Path $publish "Plugins/PluginData/Telemachus"
    Write-Host "Copying from $publishGameData to $devGameData (excluding $excludePath)..."
    
    # Robocopy exit codes 0-3 are success. We ignore them to avoid false positives in ErrorActionPreference
    $robocopyArgs = @($publishGameData, $devGameData, "/E", "/XD", $excludePath, "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np")
    & robocopy $robocopyArgs
    if ($LASTEXITCODE -ge 8) { throw "Robocopy failed with exit code $LASTEXITCODE" }
    
    # Create the excluded directory
    $devPluginData = "$kspDir/GameData/Telemachus/Plugins/PluginData/Telemachus"
    New-Item -ItemType Directory -Force -Path $devPluginData | Out-Null

    # Create Junctions for directories and Hard Links for files from src
    $srcPath = "$root/WebPages/WebPages/src"
    if (Test-Path $srcPath) {
        Write-Host "Mirroring assets from $srcPath to $devPluginData..."
        
        # 1. CLEANUP ORPHANS: Remove anything in destination that doesn't exist in source
        # We skip 'houston', 'mkon' and 'test' folders as they are managed separately
        Get-ChildItem -Path $devPluginData | ForEach-Object {
            $srcItem = Join-Path $srcPath $_.Name
            if (-not (Test-Path $srcItem) -and $_.Name -notmatch "houston|mkon|test") {
                Write-Host "Removing orphan: $($_.Name)"
                Remove-Item $_.FullName -Recurse -Force
            }
        }

        # 2. SYNC: Create/Update links
        Get-ChildItem -Path $srcPath | ForEach-Object {
            $target = Join-Path $devPluginData $_.Name
            # Ensure target doesn't exist before creating link if it points to wrong thing or is a dead file
            if (Test-Path $target) { 
                # Check if it's the SAME link, otherwise replace it
                Remove-Item $target -Recurse -Force 
            }
            
            if ($_.PSIsContainer) {
                # Directory -> Junction
                New-Item -ItemType Junction -Path $target -Value $_.FullName | Out-Null
            } else {
                # File -> HardLink
                New-Item -ItemType HardLink -Path $target -Value $_.FullName | Out-Null
            }
        }
    }

    # Specifically copy houston and mkon from publish (since they were excluded by robocopy)
    if (Test-Path "$pluginData/houston") {
        Copy-Item "$pluginData/houston" $devPluginData -Recurse -Force
    }
    if (Test-Path "$pluginData/mkon") {
        Copy-Item "$pluginData/mkon"    $devPluginData -Recurse -Force
    }

    # Handle test pages if they exist
    if (Test-Path "$root/WebPages/WebPagesTest/src") {
        New-Item -ItemType Directory -Force -Path "$devPluginData/test" | Out-Null
        Copy-Item "$root/WebPages/WebPagesTest/src/*" "$devPluginData/test" -Recurse -Force
    }
}

Get-ChildItem $pluginData
