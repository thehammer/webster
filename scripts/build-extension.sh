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

  # Inject gecko browser_specific_settings required by Firefox
  python3 -c "
import json, sys
with open('$OUT/manifest.json') as f:
    m = json.load(f)
m['browser_specific_settings'] = {
    'gecko': {
        'id': 'webster@claude.local',
        'strict_min_version': '109.0'
    }
}
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
  # Concatenate all background JS into a single non-module file, stripping
  # import/export statements so it runs in classic (non-module) context.
  cat "$OUT/background/command-handlers.js" "$OUT/background/service-worker.js" \
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
  rm "$OUT/background/command-handlers.js" "$OUT/background/service-worker.js"
  mv "$OUT/background/_bundled.js" "$OUT/background/service-worker.js"

  # Remove "type": "module" from manifest background section
  python3 -c "
import json
with open('$OUT/manifest.json') as f:
    m = json.load(f)
m['background'].pop('type', None)
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

    echo "  Opening Xcode project..."
    open "$XCODE_OUT/Webster/Webster.xcodeproj"
    echo ""
    echo "  Xcode is opening. To install:"
    echo "    1. Press Cmd+R to build and run"
    echo "    2. Open Safari > Settings > Extensions"
    echo "    3. Enable 'Webster'"
    echo "    4. Safari > Develop > Allow Unsigned Extensions (if prompted)"
  else
    echo "  Run with --xcode to also build the Safari app (requires macOS + Xcode)"
  fi
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
    --zip)      ZIP=true ;;
    *) echo "Unknown flag: $arg"
       echo "Usage: $0 [--chrome] [--firefox] [--safari] [--edge] [--all] [--xcode] [--zip]"
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

echo ""
echo "Done."
