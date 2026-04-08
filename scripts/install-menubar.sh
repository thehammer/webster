#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
MENUBAR_DIR="$PROJECT_DIR/menubar"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="webster-menu"
PLIST_NAME="com.hammer.webster-menu"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

echo "Building WebsterMenu..."
cd "$MENUBAR_DIR"
swift build -c release 2>&1

BUILT_BINARY="$MENUBAR_DIR/.build/release/WebsterMenu"
if [ ! -f "$BUILT_BINARY" ]; then
    echo "Build failed — binary not found"
    exit 1
fi

echo "Installing to $INSTALL_DIR/$BINARY_NAME..."
cp "$BUILT_BINARY" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"

# Copy resources (icon) next to binary
RESOURCES_DEST="$INSTALL_DIR/../share/webster-menu"
mkdir -p "$RESOURCES_DEST"
cp "$MENUBAR_DIR"/Resources/*.png "$RESOURCES_DEST/" 2>/dev/null || true

# Stop existing instance
launchctl stop "$PLIST_NAME" 2>/dev/null || true
launchctl unload "$PLIST_PATH" 2>/dev/null || true

echo "Creating launchd agent..."
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${INSTALL_DIR}/${BINARY_NAME}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>/tmp/webster-menu.log</string>
</dict>
</plist>
EOF

echo "Loading launchd agent..."
launchctl load "$PLIST_PATH"
launchctl start "$PLIST_NAME"

echo ""
echo "Done! Webster Menu is running in your menu bar."
echo "  Binary: $INSTALL_DIR/$BINARY_NAME"
echo "  Plist:  $PLIST_PATH"
echo "  Log:    /tmp/webster-menu.log"
