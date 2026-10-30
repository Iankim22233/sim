#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

echo "Building release binary..."
swift build -c release

APP_NAME="FreezeFocused"
APP_DIR="./${APP_NAME}.app"
BIN_SRC=".build/release/${APP_NAME}"

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"

cp "$BIN_SRC" "$APP_DIR/Contents/MacOS/${APP_NAME}"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>Freeze Focused</string>
    <key>CFBundleIdentifier</key>
    <string>com.local.freezefocused</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
</dict>
</plist>
PLIST

echo "Built ${APP_DIR}"
echo "Run it with:  open ${APP_DIR}"
echo "Or move it to /Applications and double-click it."
