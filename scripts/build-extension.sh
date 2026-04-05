#!/usr/bin/env bash
# Build Webster extension for target browsers.
# Usage: ./scripts/build-extension.sh [--chrome] [--firefox] [--safari] [--all]
#
# Output: build/extension/{chrome,firefox,safari-src}/
# Safari output is a source directory — run xcrun safari-web-extension-converter
# or use the --xcode flag to also produce an Xcode project (requires macOS + Xcode).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
SRC="$ROOT/extension"
BUILD="$ROOT/build/extension"
XCODE=false
RUN=false

build_chrome() {
  local OUT="$BUILD/chrome"
  rm -rf "$OUT"
  mkdir -p "$OUT"
  cp -r "$SRC"/. "$OUT"/
  echo "✓ Chrome/Edge — $OUT"
  echo "  Load unpacked from chrome://extensions or edge://extensions"
}

build_firefox() {
  local OUT="$BUILD/firefox"
  rm -rf "$OUT"
  mkdir -p "$OUT"
  cp -r "$SRC"/. "$OUT"/

  # Firefox does not support background.service_worker in MV3 (behind a flag).
  # Bundle background JS into a single classic script (strip import/export),
  # and switch to background.scripts instead.
  cat "$OUT/background/command-handlers.js" "$OUT/background/service-worker.js" \
  | python3 -c "
import sys, re
content = sys.stdin.read()
content = re.sub(r'^import\s+.*$', '', content, flags=re.MULTILINE)
content = re.sub(r'^export\s+((?:async\s+)?(?:function|const|let|var|class))', r'\1', content, flags=re.MULTILINE)
content = re.sub(r'^export\s*\{[^}]*\}.*$', '', content, flags=re.MULTILINE)
sys.stdout.write(content)
" > "$OUT/background/_bundled.js"
  rm "$OUT/background/command-handlers.js" "$OUT/background/service-worker.js"
  mv "$OUT/background/_bundled.js" "$OUT/background/service-worker.js"

  # Update manifest: swap service_worker → scripts, add gecko settings
  python3 -c "
import json
with open('$OUT/manifest.json') as f:
    m = json.load(f)
m['background'] = {'scripts': ['background/service-worker.js']}
m['browser_specific_settings'] = {
    'gecko': {
        'id': 'webster@claude.local',
        'strict_min_version': '109.0'
    }
}
# Firefox enforces host_permissions for WebSocket — add ws://localhost/*
if 'ws://localhost/*' not in m.get('host_permissions', []):
    m.setdefault('host_permissions', []).append('ws://localhost/*')
# Explicit CSP so Firefox HTTPS-Only mode doesn't upgrade ws:// → wss://
csp = \"script-src 'self'; object-src 'self'; connect-src ws://localhost:*\"
m['content_security_policy'] = {'extension_pages': csp}
with open('$OUT/manifest.json', 'w') as f:
    json.dump(m, f, indent=2)
"
  echo "✓ Firefox — $OUT"
  echo "  Load at about:debugging, or: cd $OUT && web-ext run"
}

build_safari() {
  local OUT="$BUILD/safari-src"
  rm -rf "$OUT"
  mkdir -p "$OUT"
  cp -r "$SRC"/. "$OUT"/

  # Safari MV3 does not support ES module service workers ("type": "module").
  # Use the Safari-specific SW which implements HTTP long-poll transport (Safari's
  # extension sandbox blocks WebSocket from service workers). Concatenate with
  # command-handlers.js into a single non-module file, stripping import/export.
  cat "$OUT/background/command-handlers.js" "$OUT/background/safari-service-worker.js" \
  | python3 -c "
import sys, re
content = sys.stdin.read()
# Remove import statements
content = re.sub(r'^import\s+.*$', '', content, flags=re.MULTILINE)
# Remove export keyword from function/const/class/async declarations
content = re.sub(r'^export\s+((?:async\s+)?(?:function|const|let|var|class))', r'\1', content, flags=re.MULTILINE)
# Remove bare export { ... } blocks
content = re.sub(r'^export\s*\{[^}]*\}.*$', '', content, flags=re.MULTILINE)
sys.stdout.write(content)
" > "$OUT/background/_bundled.js"
  rm "$OUT/background/command-handlers.js" "$OUT/background/service-worker.js" "$OUT/background/safari-service-worker.js"
  mv "$OUT/background/_bundled.js" "$OUT/background/service-worker.js"

  # Remove "type": "module" from manifest background section.
  # Also strip webRequest + alarms — Safari MV3 support is incomplete and
  # an unrecognized permission can cause Safari to silently refuse to load
  # the service worker. Both are guarded in the SW code anyway.
  python3 -c "
import json
with open('$OUT/manifest.json') as f:
    m = json.load(f)
m['background'].pop('type', None)
m['host_permissions'] = [h for h in m.get('host_permissions', []) if h != 'http://localhost/*']
m['host_permissions'].extend(['http://localhost/*', 'ws://localhost/*'])
m['permissions'] = [p for p in m.get('permissions', []) if p not in ('webRequest',)]
csp = \"script-src 'self'; object-src 'self'; connect-src ws://localhost:* http://localhost:*\"
m['content_security_policy'] = {'extension_pages': csp}
with open('$OUT/manifest.json', 'w') as f:
    json.dump(m, f, indent=2)
"

  echo "✓ Safari source — $OUT"

  if [ "$XCODE" = true ]; then
    if ! command -v xcrun &>/dev/null; then
      echo "  ✗ xcrun not found — install Xcode to build the Safari app"
      return
    fi
    local XCODE_OUT="$BUILD/safari-xcode"
    rm -rf "$XCODE_OUT"
    echo "  Converting to Xcode project..."
    xcrun safari-web-extension-converter "$OUT" \
      --project-location "$XCODE_OUT" \
      --app-name "Webster" \
      --bundle-identifier com.hammer.webster \
      --swift --no-open --macos-only 2>&1

    # Fix bundle ID capitalization mismatch (converter uses capital W for app)
    sed -i '' \
      's/PRODUCT_BUNDLE_IDENTIFIER = com\.hammer\.Webster;/PRODUCT_BUNDLE_IDENTIFIER = com.hammer.webster;/g' \
      "$XCODE_OUT/Webster/Webster.xcodeproj/project.pbxproj"

    # Apply patches: menu bar app (no Dock icon, no window)
    local PATCHES="$SCRIPT_DIR/safari-patches"
    cp "$PATCHES/AppDelegate.swift" "$XCODE_OUT/Webster/Webster/AppDelegate.swift"
    cp "$PATCHES/Info.plist"        "$XCODE_OUT/Webster/Webster/Info.plist"
    echo "  Patched: menu bar app (LSUIElement + AppDelegate)"

    if [ "$RUN" = false ]; then
      echo "  Opening Xcode project..."
      open "$XCODE_OUT/Webster/Webster.xcodeproj"
      echo ""
      echo "  Xcode is opening. To install:"
      echo "    1. Press Cmd+R to build and run"
      echo "    2. Open Safari > Settings > Extensions"
      echo "    3. Enable 'Webster'"
      echo "    4. Safari > Develop > Allow Unsigned Extensions (if prompted)"
    fi
  else
    echo "  Run with --xcode to also build the Safari app (requires macOS + Xcode)"
  fi
}

run_safari() {
  local XCODE_PROJ="$BUILD/safari-xcode/Webster/Webster.xcodeproj"

  if [ ! -d "$XCODE_PROJ" ]; then
    echo "  ✗ Xcode project not found — run with --xcode first to generate it"
    return 1
  fi

  echo "  Building Webster.app..."
  local BUILD_LOG
  BUILD_LOG=$(xcodebuild \
    -scheme Webster \
    -configuration Debug \
    -project "$XCODE_PROJ" \
    build 2>&1)
  if ! echo "$BUILD_LOG" | grep -q "BUILD SUCCEEDED"; then
    echo "  ✗ xcodebuild failed:"
    echo "$BUILD_LOG" | grep -E "error:|BUILD FAILED" | head -20
    return 1
  fi

  # Resolve the built .app path via build settings (avoids hardcoding DerivedData hash)
  local APP_PATH
  APP_PATH=$(xcodebuild \
    -scheme Webster \
    -configuration Debug \
    -project "$XCODE_PROJ" \
    -showBuildSettings 2>/dev/null \
    | awk '/BUILT_PRODUCTS_DIR/ { print $3; exit }')
  APP_PATH="$APP_PATH/Webster.app"

  if [ ! -d "$APP_PATH" ]; then
    echo "  ✗ Built app not found at: $APP_PATH"
    return 1
  fi

  # Re-sign the extension appex with network.client entitlement.
  # Xcode's auto-generated entitlements for the extension don't include it,
  # but the service worker needs it to open WebSocket connections directly.
  # Must re-sign inside-out: appex first, then outer app bundle.
  local APPEX="$APP_PATH/Contents/PlugIns/Webster Extension.appex"
  local ENTITLEMENTS="$SCRIPT_DIR/safari-patches/Extension.entitlements"
  codesign --force --sign - --entitlements "$ENTITLEMENTS" "$APPEX" 2>/dev/null \
    && codesign --force --sign - "$APP_PATH" 2>/dev/null \
    && echo "  Re-signed extension with network.client entitlement" \
    || echo "  ⚠ Re-signing failed (extension may not connect)"

  # Install to ~/Applications so Safari has a stable, unambiguous registration.
  # Running from DerivedData accumulates duplicate pluginkit entries (same bundle ID,
  # different paths) which causes Safari to silently refuse to load the extension.
  local INSTALL_PATH="$HOME/Applications/Webster.app"
  mkdir -p "$HOME/Applications"

  echo "  Installing to ~/Applications/Webster.app..."
  pkill -f "Webster.app/Contents/MacOS/Webster" 2>/dev/null || true
  sleep 0.3
  rm -rf "$INSTALL_PATH"
  cp -R "$APP_PATH" "$INSTALL_PATH"

  # Remove any stale DerivedData registration from pluginkit
  local STALE_APPEX="$APP_PATH/Contents/PlugIns/Webster Extension.appex"
  pluginkit -r "$STALE_APPEX" 2>/dev/null || true

  open "$INSTALL_PATH"
  echo "✓ Webster running — $INSTALL_PATH"
}

zip_builds() {
  for dir in "$BUILD"/chrome "$BUILD"/firefox; do
    [ -d "$dir" ] || continue
    local name
    name="$(basename "$dir")"
    (cd "$dir" && zip -qr "$BUILD/webster-${name}.zip" .)
    echo "  Zipped: build/extension/webster-${name}.zip"
  done
}

# Parse arguments
TARGETS=()
for arg in "$@"; do
  case "$arg" in
    --chrome)   TARGETS+=(chrome) ;;
    --firefox)  TARGETS+=(firefox) ;;
    --safari)   TARGETS+=(safari) ;;
    --edge)     TARGETS+=(chrome) ;;  # Edge uses the Chrome build
    --all)      TARGETS=(chrome firefox safari) ;;
    --xcode)    XCODE=true ;;
    --run)      RUN=true; XCODE=true ;;
    --zip)      ZIP=true ;;
    *) echo "Unknown flag: $arg"
       echo "Usage: $0 [--chrome] [--firefox] [--safari] [--edge] [--all] [--xcode] [--run] [--zip]"
       exit 1 ;;
  esac
done

# Default to all if no flags given
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=(chrome firefox safari)
fi

# Deduplicate (bash 3.2 compatible)
IFS=$'\n' read -r -d '' -a TARGETS < <(printf '%s\n' "${TARGETS[@]}" | sort -u && printf '\0') || true

mkdir -p "$BUILD"
for target in "${TARGETS[@]}"; do
  "build_${target}"
done

if [ "${ZIP:-false}" = true ]; then
  zip_builds
fi

if [ "$RUN" = true ]; then
  run_safari
fi

echo ""
echo "Done."
