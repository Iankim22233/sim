#!/bin/bash
# Builds TurboWarpRemote.app: a thin launcher around the installed TurboWarp Desktop
# that opens Chromium's remote-debugging port so twctl.mjs can drive the editor.
# It uses its own profile dir, so it never touches your normal TurboWarp session.
set -euo pipefail
cd "$(dirname "$0")"

TW_APP="${TW_APP:-/Applications/TurboWarp.app}"
[ -x "$TW_APP/Contents/MacOS/TurboWarp" ] || { echo "TurboWarp not found at $TW_APP (set TW_APP=...)"; exit 1; }

APP="./TurboWarpRemote.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$TW_APP/Contents/Resources/icon.icns" "$APP/Contents/Resources/icon.icns"

cat > "$APP/Contents/MacOS/TurboWarpRemote" <<LAUNCH
#!/bin/bash
PORT="\${TW_REMOTE_PORT:-9333}"
PROFILE="\${TW_REMOTE_PROFILE:-\$HOME/Library/Application Support/TurboWarpRemote}"
mkdir -p "\$PROFILE"
exec "$TW_APP/Contents/MacOS/TurboWarp" \\
  --remote-debugging-port="\$PORT" \\
  --remote-allow-origins=http://localhost:\$PORT \\
  --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows \\
  --user-data-dir="\$PROFILE" "\$@"
LAUNCH
chmod +x "$APP/Contents/MacOS/TurboWarpRemote"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>TurboWarpRemote</string>
    <key>CFBundleDisplayName</key><string>TurboWarp Remote</string>
    <key>CFBundleIdentifier</key><string>com.local.turbowarpremote</string>
    <key>CFBundleVersion</key><string>1.0</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundleExecutable</key><string>TurboWarpRemote</string>
    <key>CFBundleIconFile</key><string>icon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
PLIST

echo "Built $APP"
echo "Launch:  open -n $APP      (debug port defaults to 9333; override with TW_REMOTE_PORT)"
echo "Control: node twctl.mjs status"
