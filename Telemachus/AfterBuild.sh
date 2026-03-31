#!/usr/bin/env bash

set -o errexit
set -o nounset

ProjectDir=$1
TargetDir=$2
Dev=false
if [[ "${3:-}" == "--dev" ]] || [[ "${3:-}" == "-dev" ]]; then
  Dev=true
fi

authHeader=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  authHeader=(-H "Authorization: token $GITHUB_TOKEN")
fi

mustPublish=true
if [ "$Dev" = true ] && [ -f "$ProjectDir/../publish/GameData/Telemachus/Plugins/Telemachus.dll" ]; then
  mustPublish=false
fi

if [ "$mustPublish" = true ]; then
  if [ "$Dev" = true ]; then echo "Publish folder missing or incomplete, forcing full build even in -Dev mode."; fi
  
  houstonUrl="$(curl --silent "${authHeader[@]}" "https://api.github.com/repos/TeleIO/houston/releases/latest" | grep '"browser_download_url":' | cut -d : -f2,3 | cut -d \" -f2)"
  mkonUrl="https://github.com/TeleIO/mkon/archive/master.zip"

echo "$ProjectDir"
echo "$TargetDir"

# Stage publish directory
rm -rf "$ProjectDir/../publish/GameData"

mkdir -p "$ProjectDir/../publish/GameData/Telemachus/Plugins"
mkdir -p "$ProjectDir/../publish/GameData/Telemachus/Parts"
mkdir -p "$ProjectDir/../publish/GameData/Telemachus/PluginData"
mkdir -p "$ProjectDir/../publish/GameData/Telemachus/Plugins/PluginData/Telemachus/"

cp "$TargetDir/Telemachus.dll"      "$ProjectDir/../publish/GameData/Telemachus/Plugins/"
cp "$TargetDir/websocket-sharp.dll" "$ProjectDir/../publish/GameData/Telemachus/Plugins/"

cp "$ProjectDir/../TelemachusReborn.version" "$ProjectDir/../publish/GameData/Telemachus/"

cp -ra "$ProjectDir/../Parts/."                         "$ProjectDir/../publish/GameData/Telemachus/Parts/"
cp -ra "$ProjectDir/../WebPages/WebPages/src/."         "$ProjectDir/../publish/GameData/Telemachus/Plugins/PluginData/Telemachus/"
cp -ra "$ProjectDir/../Licences/."                      "$ProjectDir/../publish/GameData/Telemachus/"
cp     "$ProjectDir/../README.md"                       "$ProjectDir/../publish/GameData/Telemachus/"

# Download Houston
curl -LO "$houstonUrl"
mkdir -p "$ProjectDir/../publish/GameData/Telemachus/Plugins/PluginData/Telemachus/houston"
unzip Houston.zip -d "$ProjectDir/../publish/GameData/Telemachus/Plugins/PluginData/Telemachus/houston"

# Download mkon
curl -Lo mkon.zip "$mkonUrl"
mkdir -p "$ProjectDir/../publish/GameData/Telemachus/Plugins/PluginData/Telemachus/mkon"
unzip mkon.zip
cp -ra mkon-master/. "$ProjectDir/../publish/GameData/Telemachus/Plugins/PluginData/Telemachus/mkon"

  # Cleanup
  rm -f Houston.zip mkon.zip
  rm -rf mkon-master

  # Extract API schema from source-generated file
  schemaFile=$(find "$ProjectDir/obj" -name "TelemetrySchema.g.cs" -type f 2>/dev/null | head -1)
  if [ -n "$schemaFile" ]; then
    # Extract the JSON from between the @" and "; markers, un-doubling quotes
    sed -n '/SCHEMA_JSON_BEGIN/,/SCHEMA_JSON_END/p' "$schemaFile" \
      | grep -v 'SCHEMA_JSON' \
      | sed 's/.*internal const string Json = @"//;s/";//' \
      | sed 's/""/"/g' \
      > "$ProjectDir/../publish/api-schema.json"
    echo "Extracted API schema to publish/api-schema.json"
  else
    echo "Warning: TelemetrySchema.g.cs not found in obj/"
  fi
else
  echo "Skipping Publish build (--dev mode active and publish folder found)."
fi

  kspDir="$ProjectDir/../ksp-telemachus-dev"
  if [ -d "$kspDir" ]; then
    rm -rf "$kspDir/GameData/Telemachus"
    mkdir -p "$kspDir/GameData/Telemachus/Plugins"

    # Copy everything from publish to GameData, excluding the core web assets folder
    # We use --update (-u) with rsync to prevent overwriting newer files
    if command -v rsync >/dev/null 2>&1; then
      rsync -au --exclude='Telemachus/Plugins/PluginData/Telemachus' "$ProjectDir/../publish/GameData/" "$kspDir/GameData/"
    else
      # Fallback to manual folder copying if rsync is not available
      mkdir -p "$kspDir/GameData/Telemachus"
      cp -ra "$ProjectDir/../publish/GameData/Telemachus/Plugins" "$kspDir/GameData/Telemachus/"
      cp -ra "$ProjectDir/../publish/GameData/Telemachus/Parts"   "$kspDir/GameData/Telemachus/"
      if [ -f "$ProjectDir/../publish/GameData/Telemachus/TelemachusReborn.version" ]; then
        cp "$ProjectDir/../publish/GameData/Telemachus/TelemachusReborn.version" "$kspDir/GameData/Telemachus/"
      fi
    fi

    if [ "$Dev" = true ]; then
      echo "Updating DLLs directly in KSP (Dev Mode)..."
      cp -f "$TargetDir/Telemachus.dll"      "$kspDir/GameData/Telemachus/Plugins/"
      cp -f "$TargetDir/websocket-sharp.dll" "$kspDir/GameData/Telemachus/Plugins/"
    fi

    devPluginData="$kspDir/GameData/Telemachus/Plugins/PluginData/Telemachus"
    mkdir -p "$devPluginData"

    # Create symbolic links for all items in src (standard Unix approach)
    srcPath="$ProjectDir/../WebPages/WebPages/src"
    if [ -d "$srcPath" ]; then
      echo "Mirroring symbolic links from $srcPath to $devPluginData..."
      
      # 1. CLEANUP ORPHANS: Remove any link in destination that doesn't exist in source
      # Exclude houston, mkon, and test which are managed elsewhere
      for target_item in "$devPluginData"/*; do
        [ -e "$target_item" ] || continue
        bname=$(basename "$target_item")
        if [[ ! "$bname" =~ ^(houston|mkon|test)$ ]]; then
          if [ ! -e "$srcPath/$bname" ]; then
            echo "Removing orphan link: $bname"
            rm -rf "$target_item"
          fi
        fi
      done

      # 2. SYNC: Create/Update symbolic links
      for item in "$srcPath"/*; do
        bname=$(basename "$item")
        target="$devPluginData/$bname"
        if [ -L "$target" ] || [ -e "$target" ]; then
          rm -rf "$target"
        fi
        ln -s "$item" "$target"
      done
    fi

    # Specifically copy houston and mkon from publish (since they were excluded from the main sync)
    publishPluginData="$ProjectDir/../publish/GameData/Telemachus/Plugins/PluginData/Telemachus"
    if [ -d "$publishPluginData/houston" ]; then
      cp -ra "$publishPluginData/houston" "$devPluginData/"
    fi
    if [ -d "$publishPluginData/mkon" ]; then
      cp -ra "$publishPluginData/mkon" "$devPluginData/"
    fi

    # Handle test pages if they exist
    testSrcPath="$ProjectDir/../WebPages/WebPagesTest/src"
    if [ -d "$testSrcPath" ]; then
      mkdir -p "$devPluginData/test"
      cp -ra "$testSrcPath/." "$devPluginData/test/"
    fi
  fi

ls "$ProjectDir/../publish/GameData/Telemachus/Plugins/PluginData/Telemachus/"
