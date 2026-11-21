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
      return 1
    fi
    local XCODE_OUT="$BUILD/safari-xcode"
    rm -rf "$XCODE_OUT"
    echo "  Converting to Xcode project..."
    xcrun safari-web-extension-converter "$OUT" \
      --project-location "$XCODE_OUT" \
      --app-name "Webster" \
      --bundle-identifier com.hammer.webster \
      --swift --no-open --macos-only 2>&1

    # Xcode 27's converter writes project.xcproj (a JSON-like description) instead
    # of project.pbxproj. xcodebuild can convert it back to the classic format,
    # which is what patch-pbxproj.py edits. Older Xcodes already emit pbxproj.
    local XCODEPROJ="$XCODE_OUT/Webster/Webster.xcodeproj"
    local PBXPROJ="$XCODEPROJ/project.pbxproj"
    if [ ! -f "$PBXPROJ" ] && [ -f "$XCODEPROJ/project.xcproj" ]; then
      echo "  Xcode 27 project format (project.xcproj) — converting to pbxproj..."
      if ! xcodebuild -project "$XCODEPROJ" -convert-project pbxproj >/dev/null 2>&1; then
        echo "  ✗ xcodebuild -convert-project pbxproj failed on $XCODEPROJ" >&2
        return 1
      fi
    fi
    if [ ! -f "$PBXPROJ" ]; then
      echo "  ✗ Converter produced neither project.pbxproj nor project.xcproj in $XCODEPROJ" >&2
      ls -la "$XCODEPROJ" >&2 || true
      return 1
    fi

    # Apply patches: full menu bar app + bun server management
    local PATCHES="$SCRIPT_DIR/safari-patches"
    cp "$PATCHES/AppDelegate.swift"         "$XCODE_OUT/Webster/Webster/AppDelegate.swift"
    cp "$PATCHES/StatusBarController.swift" "$XCODE_OUT/Webster/Webster/StatusBarController.swift"
    cp "$PATCHES/WebsterClient.swift"       "$XCODE_OUT/Webster/Webster/WebsterClient.swift"
    cp "$PATCHES/HotkeyManager.swift"       "$XCODE_OUT/Webster/Webster/HotkeyManager.swift"
    cp "$PATCHES/Info.plist"                "$XCODE_OUT/Webster/Webster/Info.plist"
    cp "$ROOT/menubar/Resources/icon-template.png" "$XCODE_OUT/Webster/Webster/icon-template.png"

    # Fix bundle id case, wire new files into the project, link Carbon, disable sandbox
    python3 "$PATCHES/patch-pbxproj.py" "$PBXPROJ" || return 1
    echo "  Patched: menu bar app + bun server management (StatusBarController, WebsterClient, HotkeyManager)"

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
  local APP_BIN="$INSTALL_PATH/Contents/MacOS/Webster"
  mkdir -p "$HOME/Applications"

  # Record launchd state BEFORE touching anything: only a job that is loaded now
  # is ever stopped and bootstrapped again by this run.
  local LAUNCHD_PLIST LAUNCHD_LABEL=""
  LAUNCHD_PLIST=$(find_launchd_plist "$APP_BIN")
  if [ -n "$LAUNCHD_PLIST" ]; then
    LAUNCHD_LABEL=$(plutil -extract Label raw -o - "$LAUNCHD_PLIST" 2>/dev/null || true)
    if [ -z "$LAUNCHD_LABEL" ]; then
      echo "  ✗ Cannot read Label from $LAUNCHD_PLIST — fix the plist or unload it: launchctl bootout gui/$(id -u) \"$LAUNCHD_PLIST\"" >&2
      return 1
    fi
  fi

  echo "  Stopping running Webster.app + its server..."
  stop_webster "$APP_BIN" "$LAUNCHD_LABEL" || return 1

  echo "  Installing to ~/Applications/Webster.app..."
  rm -rf "$INSTALL_PATH"
  cp -R "$APP_PATH" "$INSTALL_PATH"

  # Drop the DerivedData registration and register the installed extension
  # explicitly, so pluginkit has exactly one Webster extension.
  pluginkit -r "$APPEX" 2>/dev/null || true
  if ! pluginkit -a "$INSTALL_PATH/Contents/PlugIns/Webster Extension.appex" 2>/dev/null; then
    echo "  ⚠ pluginkit -a failed — Safari may not list the extension; try: pluginkit -a \"$INSTALL_PATH/Contents/PlugIns/Webster Extension.appex\"" >&2
  fi

  if [ -n "$LAUNCHD_PLIST" ]; then
    # launchd (KeepAlive) owns the app: restart through it, with the plist's
    # WEBSTER_PROJECT_DIR / WEBSTER_BUN_PATH, so it isn't launched twice.
    start_via_launchd "$LAUNCHD_PLIST" "$LAUNCHD_LABEL" || return 1
    echo "  Started via launchd ($LAUNCHD_LABEL)"
  else
    # Webster.app only starts its server when WEBSTER_PROJECT_DIR is set; `open`
    # does not inherit our environment, so pass it explicitly.
    open --env "WEBSTER_PROJECT_DIR=$ROOT" "$INSTALL_PATH"
  fi
  echo "✓ Webster running — $INSTALL_PATH"
  echo "  Safari: Settings > Extensions > enable Webster (Develop > Allow Unsigned Extensions if needed)"
}

# Print the LaunchAgent plist that runs the given app binary and is currently
# loaded in launchd. A plist that merely exists (or is a *.bak* copy) is
# ignored, so we never bootstrap a job the user had not loaded.
find_launchd_plist() {
  local app_bin="$1" plist first label
  for plist in "$HOME"/Library/LaunchAgents/*.plist; do
    [ -f "$plist" ] || continue
    case "$plist" in *.bak*) continue ;; esac
    first=$(plutil -extract ProgramArguments.0 raw -o - "$plist" 2>/dev/null || true)
    [ "$first" = "$app_bin" ] || continue
    label=$(plutil -extract Label raw -o - "$plist" 2>/dev/null || true)
    [ -n "$label" ] || continue
    if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
      echo "$plist"
      return 0
    fi
  done
  return 0
}

# Bootstrap the job; retry once, then kickstart it. Every failure path says what
# happened and what to run — nothing exits silently under `set -e`.
start_via_launchd() {
  local plist="$1" label="$2" domain
  domain="gui/$(id -u)"
  if launchctl bootstrap "$domain" "$plist"; then
    return 0
  fi
  if launchctl print-disabled "$domain" 2>/dev/null | grep -Eq "\"$label\"[[:space:]]*=>[[:space:]]*(disabled|true)"; then
    echo "  ✗ launchd job $label is disabled, so it cannot be started." >&2
    echo "    Run: launchctl enable $domain/$label && launchctl bootstrap $domain \"$plist\"" >&2
    return 1
  fi
  echo "  ⚠ launchctl bootstrap failed — retrying once..." >&2
  sleep 1
  if launchctl bootstrap "$domain" "$plist"; then
    return 0
  fi
  echo "  ⚠ bootstrap failed again — trying launchctl kickstart -k $domain/$label" >&2
  if launchctl kickstart -k "$domain/$label"; then
    return 0
  fi
  echo "  ✗ Could not start launchd job $label. The new build is installed but not running." >&2
  echo "    Run: launchctl bootstrap $domain \"$plist\"   (or: open \"$HOME/Applications/Webster.app\")" >&2
  return 1
}

# Print the pids whose executable is exactly the given app binary (exact string
# comparison on the process's path — no regex, so odd characters in the path
# are harmless).
app_pids_for() {
  local app_bin="$1" pid comm
  ps -axo pid=,comm= | while read -r pid comm; do
    [ "$comm" = "$app_bin" ] && echo "$pid"
  done
  return 0
}

# True if pid is a bun server started from THIS checkout: argv ends in
# src/index.ts and that path resolves to $ROOT/src/index.ts (absolute argv, or
# relative argv with the process cwd being $ROOT).
is_this_checkouts_server() {
  local pid="$1" cmd cwd root_real
  root_real=$(cd "$ROOT" && pwd -P)
  cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
  case "$cmd" in *bun*) ;; *) return 1 ;; esac
  case "$cmd" in
    *" /"*"src/index.ts")
      [[ "$cmd" == *" $ROOT/src/index.ts" || "$cmd" == *" $root_real/src/index.ts" ]]
      ;;
    *" src/index.ts")
      cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)
      [ "$cwd" = "$ROOT" ] || [ "$cwd" = "$root_real" ]
      ;;
    *) return 1 ;;
  esac
}

# Stop the installed Webster.app and the bun server it spawned. Only processes
# we can tie to the app (its pids, its children, or this checkout's Webster
# server holding the port) are signalled, always by exact pid.
#
# Stopping the server ends every MCP session on it, so other Claude sessions
# using webster must reconnect. The port is $WEBSTER_PORT (default 3456); it must
# be *exported* for this script to see it.
stop_webster() {
  local app_bin="$1" label="$2"
  local port="${WEBSTER_PORT:-3456}" domain
  domain="gui/$(id -u)"

  # Shared-server notice: this restarts the server other sessions may be using.
  local status sessions
  status=$(curl -s --max-time 2 "http://localhost:$port/api/status" 2>/dev/null || true)
  if [ -n "$status" ]; then
    sessions=$(printf '%s' "$status" | sed -n 's/.*"sessionCount":\([0-9][0-9]*\).*/\1/p')
    echo "  Note: restarting the Webster server on :$port ends all MCP sessions on it — other Claude sessions using webster must reconnect."
    if [ -n "$sessions" ] && [ "$sessions" -gt 0 ]; then
      echo "  ⚠ $sessions active MCP session(s) will be disconnected."
    fi
  fi

  # Remember the app's server child(ren) before the app goes away.
  local app_pids child_pids="" pid
  app_pids=$(app_pids_for "$app_bin")
  for pid in $app_pids; do
    child_pids="$child_pids $(pgrep -P "$pid" || true)"
  done

  if [ -n "$label" ]; then
    # bootout stops the job and everything in its process group (the server too).
    launchctl bootout "$domain/$label" 2>/dev/null || true
    # Installing while launchd still has the job registered makes bootstrap fail.
    local tries=100
    while launchctl print "$domain/$label" >/dev/null 2>&1; do
      tries=$(( tries - 1 ))
      if [ "$tries" -le 0 ]; then
        echo "  ✗ launchd job $label is still loaded 10s after bootout. Run: launchctl bootout $domain/$label" >&2
        return 1
      fi
      sleep 0.1
    done
  elif [ -n "$app_pids" ]; then
    osascript -e 'tell application id "com.hammer.webster" to quit' >/dev/null 2>&1 || true
  fi

  # Escalate for anything still alive: SIGTERM, then SIGKILL, by exact pid.
  if ! wait_gone "$app_pids $child_pids" 5; then
    local still=""
    for pid in $app_pids $child_pids; do
      kill -0 "$pid" 2>/dev/null && still="$still $pid"
    done
    # shellcheck disable=SC2086
    kill $still 2>/dev/null || true
    if ! wait_gone "$still" 5; then
      for pid in $still; do kill -9 "$pid" 2>/dev/null || true; done
      if ! wait_gone "$still" 5; then
        echo "  ✗ Could not stop Webster process(es):$still — kill them manually." >&2
        return 1
      fi
    fi
  fi

  # An orphaned Webster server from an older app still holds the port and
  # would make the new app's server fail to bind. Only the first listener is
  # considered: the server binds one port, and any other holder is not ours to
  # touch anyway.
  local holder cmd
  holder=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)
  if [ -n "$holder" ]; then
    cmd=$(ps -o command= -p "$holder" 2>/dev/null || true)
    if ! is_this_checkouts_server "$holder"; then
      echo "  ✗ Port $port is held by pid $holder, which is not this checkout's Webster server ($ROOT): $cmd — stop it yourself (kill $holder) or run this script from its checkout." >&2
      return 1
    fi
    echo "  Stopping orphaned Webster server (pid $holder) on :$port"
    kill "$holder" 2>/dev/null || true
    if ! wait_gone "$holder" 5; then
      # Re-verify before SIGKILL so a recycled pid is never hit.
      if is_this_checkouts_server "$holder"; then
        kill -9 "$holder" 2>/dev/null || true
        wait_gone "$holder" 5 || true
      fi
    fi
    if [ -n "$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)" ]; then
      echo "  ✗ Port $port is still held after stopping pid $holder. Check: lsof -i tcp:$port" >&2
      return 1
    fi
  fi
}

# wait_gone "<pids>" <seconds> — wait until none of the pids is alive.
# Returns non-zero if any is still alive when the time is up.
wait_gone() {
  local pids="$1" tries=$(( $2 * 10 )) pid alive
  while [ "$tries" -gt 0 ]; do
    alive=false
    for pid in $pids; do
      kill -0 "$pid" 2>/dev/null && alive=true
    done
    [ "$alive" = false ] && return 0
    sleep 0.1
    tries=$(( tries - 1 ))
  done
  return 1
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
