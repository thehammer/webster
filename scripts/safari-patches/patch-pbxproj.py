#!/usr/bin/env python3
# patch-pbxproj.py — Adds Webster menu bar source files to the Xcode project.
# Run after xcrun safari-web-extension-converter (and, on Xcode 27+, after
# `xcodebuild -convert-project pbxproj` — see build-extension.sh) to wire in:
#   StatusBarController.swift, WebsterClient.swift, HotkeyManager.swift,
#   icon-template.png, Carbon framework, and disables app sandbox.
#
# Input must be a classic OpenStep project.pbxproj. Xcode 27's converter emits
# a different file (project.xcproj, a JSON-like description); build-extension.sh
# converts it back with xcodebuild before calling this script.
#
# Uses deterministic UUIDs so the patch is idempotent across rebuilds.
# Fails loudly (PatchError, exit 1) if an expected anchor is missing, rather
# than writing a project that silently lacks the menu bar sources.

import re, sys

MARKER = "AABBCC001122334455660001"

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
SWIFT_FILES = ["StatusBarController.swift", "WebsterClient.swift", "HotkeyManager.swift"]


class PatchError(Exception):
    pass


def _insert_after(content, pattern, new_lines, what):
    """Insert new_lines after the first line matching pattern; raise if absent."""
    patched, n = re.subn(pattern, lambda m: m.group(0) + "\n" + new_lines.rstrip("\n"), content, count=1)
    if n != 1:
        raise PatchError(f"anchor not found for {what}: {pattern}")
    return patched


def _insert_before(content, marker, new_text, what):
    if marker not in content:
        raise PatchError(f"anchor not found for {what}: {marker}")
    return content.replace(marker, new_text + marker, 1)


def fix_bundle_id(content):
    """Converter uses capital W for the app's bundle id; Safari needs lowercase."""
    return content.replace(
        "PRODUCT_BUNDLE_IDENTIFIER = com.hammer.Webster;",
        "PRODUCT_BUNDLE_IDENTIFIER = com.hammer.webster;",
    )


def disable_sandbox_in_app_target(text):
    """Set ENABLE_APP_SANDBOX = NO in the app target's build configs only.

    The app target configs contain ENABLE_OUTGOING_NETWORK_CONNECTIONS = YES
    (the extension's do not), so use it as a sentinel and flip the closest
    preceding ENABLE_APP_SANDBOX = YES. The extension keeps its sandbox.
    """
    sentinel = "ENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;"
    flag_yes, flag_no = "ENABLE_APP_SANDBOX = YES;", "ENABLE_APP_SANDBOX = NO;"
    parts = text.split(sentinel)
    if len(parts) < 2:
        raise PatchError("app target build configs not found (no ENABLE_OUTGOING_NETWORK_CONNECTIONS)")
    result = []
    for part in parts[:-1]:
        idx = part.rfind(flag_yes)
        if idx != -1:
            part = part[:idx] + flag_no + part[idx + len(flag_yes):]
        result.append(part)
    result.append(parts[-1])
    return sentinel.join(result)


def patch(content):
    """Return content with the Webster menu bar sources wired in."""
    if MARKER in content:
        return content  # already patched

    content = fix_bundle_id(content)

    # 1. PBXBuildFile entries
    new_buildfiles = "".join(
        f'\t\t{BF[n]} /* {n} in Sources */ = '
        f'{{isa = PBXBuildFile; fileRef = {FR[n]} /* {n} */; }};\n'
        for n in SWIFT_FILES
    ) + (
        f'\t\t{BF["icon-template.png"]} /* icon-template.png in Resources */ = '
        f'{{isa = PBXBuildFile; fileRef = {FR["icon-template.png"]} /* icon-template.png */; }};\n'
    )
    content = _insert_before(content, "/* End PBXBuildFile section */", new_buildfiles, "PBXBuildFile section")

    # 2. PBXFileReference entries
    new_filerefs = "".join(
        f'\t\t{FR[n]} /* {n} */ = '
        f'{{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {n}; sourceTree = "<group>"; }};\n'
        for n in SWIFT_FILES
    ) + (
        f'\t\t{FR["icon-template.png"]} /* icon-template.png */ = '
        f'{{isa = PBXFileReference; lastKnownFileType = image.png; path = "icon-template.png"; sourceTree = "<group>"; }};\n'
    )
    content = _insert_before(content, "/* End PBXFileReference section */", new_filerefs, "PBXFileReference section")

    # 3. Add file refs to the Webster group (anchored on ViewController.swift)
    group_entries = "".join(f'\t\t\t\t{FR[n]} /* {n} */,\n' for n in SWIFT_FILES + ["icon-template.png"])
    content = _insert_after(content, r'\t+\w+ /\* ViewController\.swift \*/,', group_entries, "Webster group")

    # 4a. Swift build files into the Sources phase (anchored on AppDelegate.swift)
    sources = "".join(f'\t\t\t\t{BF[n]} /* {n} in Sources */,\n' for n in SWIFT_FILES)
    content = _insert_after(content, r'\t+\w+ /\* AppDelegate\.swift in Sources \*/,', sources, "Sources build phase")

    # 4b. Icon into the Resources phase (anchored on Assets.xcassets)
    resources = f'\t\t\t\t{BF["icon-template.png"]} /* icon-template.png in Resources */,\n'
    content = _insert_after(content, r'\t+\w+ /\* Assets\.xcassets in Resources \*/,', resources, "Resources build phase")

    # 5. Carbon framework (app target only — it is the one linking WebKit)
    link_webkit = '"-framework",\n\t\t\t\t\tWebKit,'
    if link_webkit not in content:
        raise PatchError("WebKit OTHER_LDFLAGS entry not found (cannot add Carbon)")
    content = content.replace(
        link_webkit,
        link_webkit + '\n\t\t\t\t\t"-framework",\n\t\t\t\t\tCarbon,',
    )

    # 6. Disable app sandbox for the app target so it can spawn bun.
    content = disable_sandbox_in_app_target(content)

    # 7. Remove SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor from the app target.
    #    HotkeyManager's Carbon callback is a C function pointer and can't be
    #    implicitly @MainActor; StatusBarController uses explicit @MainActor.
    #    The setting only appears in the app target configs.
    content = re.sub(r'[ \t]*SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor;\n', "", content)

    return content


def main(argv):
    if len(argv) != 2:
        print("usage: patch-pbxproj.py <path/to/project.pbxproj>", file=sys.stderr)
        return 2
    path = argv[1]
    with open(path) as f:
        original = f.read()
    try:
        patched = patch(original)
    except PatchError as e:
        print(f"  ✗ patch-pbxproj: {e}", file=sys.stderr)
        return 1
    if patched == original:
        print("  pbxproj already patched — skipping")
        return 0
    with open(path, "w") as f:
        f.write(patched)
    print("  Patched pbxproj: StatusBarController + WebsterClient + HotkeyManager + icon + Carbon + no sandbox + no default actor isolation")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
