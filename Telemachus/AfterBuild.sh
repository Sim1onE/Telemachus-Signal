#!/usr/bin/env bash

set -o errexit
set -o nounset

ProjectDir=$1
TargetDir=$2

authHeader=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  authHeader=(-H "Authorization: token $GITHUB_TOKEN")
fi
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

rm Houston.zip mkon.zip
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

  # Copy to local KSP install (local dev only — skipped in CI)
  kspDir="$ProjectDir/../ksp-telemachus-dev"
  if [ -d "$kspDir" ]; then
    rm -rf "$kspDir/GameData/Telemachus"
    
    # Copy everything from publish to GameData, excluding the core web assets folder
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --exclude='Telemachus/Plugins/PluginData/Telemachus' "$ProjectDir/../publish/GameData/" "$kspDir/GameData/"
    else
      # Fallback to manual folder copying if rsync is not available
      mkdir -p "$kspDir/GameData/Telemachus"
      cp -ra "$ProjectDir/../publish/GameData/Telemachus/Plugins" "$kspDir/GameData/Telemachus/"
      cp -ra "$ProjectDir/../publish/GameData/Telemachus/Parts"   "$kspDir/GameData/Telemachus/"
      if [ -f "$ProjectDir/../publish/GameData/Telemachus/TelemachusReborn.version" ]; then
        cp "$ProjectDir/../publish/GameData/Telemachus/TelemachusReborn.version" "$kspDir/GameData/Telemachus/"
      fi
    fi

    devPluginData="$kspDir/GameData/Telemachus/Plugins/PluginData/Telemachus"
    mkdir -p "$devPluginData"

    # Create symbolic links for all items in src (standard Unix approach)
    srcPath="$ProjectDir/../WebPages/WebPages/src"
    if [ -d "$srcPath" ]; then
      echo "Creating symbolic links from $srcPath to $devPluginData..."
      for item in "$srcPath"/*; do
        bname=$(basename "$item")
        ln -s "$item" "$devPluginData/$bname"
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
