#!/usr/bin/env python3
# patch-pbxproj.py — Adds Webster menu bar source files to the Xcode project.
# Run after xcrun safari-web-extension-converter to wire in:
#   StatusBarController.swift, WebsterClient.swift, HotkeyManager.swift,
#   icon-template.png, Carbon framework, and disables app sandbox.
#
# Uses deterministic UUIDs so the patch is idempotent across rebuilds.

import re, sys

PBXPROJ = sys.argv[1]
with open(PBXPROJ) as f:
    content = f.read()

# Skip if already patched
if "AABBCC001122334455660001" in content:
    print("  pbxproj already patched — skipping")
    sys.exit(0)

# ---------------------------------------------------------------------------
# Deterministic UUIDs for our new entries
# ---------------------------------------------------------------------------
FR = {  # PBXFileReference IDs
    "StatusBarController.swift": "AABBCC001122334455660001",
    "WebsterClient.swift":       "AABBCC001122334455660002",
    "HotkeyManager.swift":       "AABBCC001122334455660003",
    "icon-template.png":         "AABBCC001122334455660004",
}
BF = {  # PBXBuildFile IDs
    "StatusBarController.swift": "AABBCC001122334455660011",
    "WebsterClient.swift":       "AABBCC001122334455660012",
    "HotkeyManager.swift":       "AABBCC001122334455660013",
    "icon-template.png":         "AABBCC001122334455660014",
}

# ---------------------------------------------------------------------------
# 1. PBXBuildFile entries
# ---------------------------------------------------------------------------
new_buildfiles = (
    f'\t\t{BF["StatusBarController.swift"]} /* StatusBarController.swift in Sources */ = '
    f'{{isa = PBXBuildFile; fileRef = {FR["StatusBarController.swift"]} /* StatusBarController.swift */; }};\n'
    f'\t\t{BF["WebsterClient.swift"]} /* WebsterClient.swift in Sources */ = '
    f'{{isa = PBXBuildFile; fileRef = {FR["WebsterClient.swift"]} /* WebsterClient.swift */; }};\n'
    f'\t\t{BF["HotkeyManager.swift"]} /* HotkeyManager.swift in Sources */ = '
    f'{{isa = PBXBuildFile; fileRef = {FR["HotkeyManager.swift"]} /* HotkeyManager.swift */; }};\n'
    f'\t\t{BF["icon-template.png"]} /* icon-template.png in Resources */ = '
    f'{{isa = PBXBuildFile; fileRef = {FR["icon-template.png"]} /* icon-template.png */; }};\n'
)
content = content.replace(
    "/* End PBXBuildFile section */",
    new_buildfiles + "/* End PBXBuildFile section */"
)

# ---------------------------------------------------------------------------
# 2. PBXFileReference entries
# ---------------------------------------------------------------------------
new_filerefs = (
    f'\t\t{FR["StatusBarController.swift"]} /* StatusBarController.swift */ = '
    f'{{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = StatusBarController.swift; sourceTree = "<group>"; }};\n'
    f'\t\t{FR["WebsterClient.swift"]} /* WebsterClient.swift */ = '
    f'{{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = WebsterClient.swift; sourceTree = "<group>"; }};\n'
    f'\t\t{FR["HotkeyManager.swift"]} /* HotkeyManager.swift */ = '
    f'{{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = HotkeyManager.swift; sourceTree = "<group>"; }};\n'
    f'\t\t{FR["icon-template.png"]} /* icon-template.png */ = '
    f'{{isa = PBXFileReference; lastKnownFileType = image.png; path = "icon-template.png"; sourceTree = "<group>"; }};\n'
)
content = content.replace(
    "/* End PBXFileReference section */",
    new_filerefs + "/* End PBXFileReference section */"
)

# ---------------------------------------------------------------------------
# 3. Add file refs to the Webster group (anchored on ViewController.swift)
# ---------------------------------------------------------------------------
new_group_entries = (
    f'\t\t\t\t{FR["StatusBarController.swift"]} /* StatusBarController.swift */,\n'
    f'\t\t\t\t{FR["WebsterClient.swift"]} /* WebsterClient.swift */,\n'
    f'\t\t\t\t{FR["HotkeyManager.swift"]} /* HotkeyManager.swift */,\n'
    f'\t\t\t\t{FR["icon-template.png"]} /* icon-template.png */,\n'
)
# Find ViewController.swift ref line in the group (matches any UUID prefix)
content = re.sub(
    r'(\t+\w+ /\* ViewController\.swift \*/,)',
    r'\1\n' + new_group_entries.rstrip('\n'),
    content
)

# ---------------------------------------------------------------------------
# 4a. Add Swift build files to Webster Sources build phase
#     (anchored on AppDelegate.swift in Sources)
# ---------------------------------------------------------------------------
new_sources = (
    f'\t\t\t\t{BF["StatusBarController.swift"]} /* StatusBarController.swift in Sources */,\n'
    f'\t\t\t\t{BF["WebsterClient.swift"]} /* WebsterClient.swift in Sources */,\n'
    f'\t\t\t\t{BF["HotkeyManager.swift"]} /* HotkeyManager.swift in Sources */,\n'
)
content = re.sub(
    r'(\t+\w+ /\* AppDelegate\.swift in Sources \*/,)',
    r'\1\n' + new_sources.rstrip('\n'),
    content
)

# ---------------------------------------------------------------------------
# 4b. Add icon to Webster Resources build phase
#     (anchored on Assets.xcassets in Resources)
# ---------------------------------------------------------------------------
new_resources = (
    f'\t\t\t\t{BF["icon-template.png"]} /* icon-template.png in Resources */,\n'
)
content = re.sub(
    r'(\t+\w+ /\* Assets\.xcassets in Resources \*/,)',
    r'\1\n' + new_resources.rstrip('\n'),
    content
)

# ---------------------------------------------------------------------------
# 5. Add Carbon framework to OTHER_LDFLAGS (app target only — has WebKit)
# ---------------------------------------------------------------------------
content = content.replace(
    '"-framework",\n\t\t\t\tWebKit,',
    '"-framework",\n\t\t\t\tWebKit,\n\t\t\t\t"-framework",\n\t\t\t\tCarbon,'
)

# ---------------------------------------------------------------------------
# 6. Disable app sandbox for the Webster app target so it can spawn bun.
#    Only the two configs that have ENABLE_OUTGOING_NETWORK_CONNECTIONS
#    (the app target) need this change — the extension target keeps its sandbox.
# ---------------------------------------------------------------------------
# The app target configs contain ENABLE_OUTGOING_NETWORK_CONNECTIONS = YES.
# Replace ENABLE_APP_SANDBOX = YES only in those sections.
def disable_sandbox_in_app_target(text):
    # Split on the sentinel that only appears in app target configs
    sentinel = "ENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;"
    parts = text.split(sentinel)
    result = []
    for i, part in enumerate(parts):
        if i < len(parts) - 1:
            # This part precedes a sentinel — replace ENABLE_APP_SANDBOX in it
            # We only want to replace the one closest to the sentinel
            replaced = re.sub(
                r'(ENABLE_APP_SANDBOX = )YES(;)',
                r'\1NO\2',
                part,
                count=1,
                flags=re.REVERSE if hasattr(re, 'REVERSE') else 0
            )
            # re doesn't have REVERSE — do it manually: replace last occurrence
            idx = part.rfind("ENABLE_APP_SANDBOX = YES;")
            if idx != -1:
                part = part[:idx] + "ENABLE_APP_SANDBOX = NO;" + part[idx + len("ENABLE_APP_SANDBOX = YES;"):]
            result.append(part)
            result.append(sentinel)
        else:
            result.append(part)
    return "".join(result)

content = disable_sandbox_in_app_target(content)

# ---------------------------------------------------------------------------
# 7. Remove SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor from the app target.
#    HotkeyManager's Carbon callback can't be implicitly @MainActor — it's a
#    C function pointer. StatusBarController uses explicit @MainActor so the
#    build-level default isn't needed.
#    This setting only appears in the app target configs (not extension), so a
#    simple removal is safe.
# ---------------------------------------------------------------------------
content = content.replace("\t\t\t\tSWIFT_DEFAULT_ACTOR_ISOLATION = MainActor;\n", "")

with open(PBXPROJ, 'w') as f:
    f.write(content)

print("  Patched pbxproj: StatusBarController + WebsterClient + HotkeyManager + icon + Carbon + no sandbox + no default actor isolation")
