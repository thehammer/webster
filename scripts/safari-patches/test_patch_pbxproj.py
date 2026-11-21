"""Behavioural tests for patch-pbxproj.py.

Run: cd scripts/safari-patches && python3 -m unittest -v

The patcher must handle classic pbxproj text from older Xcode and the pbxproj
that Xcode 27 writes via `xcodebuild -convert-project pbxproj` (objectVersion
110). Fixtures are small hand-built snippets that mirror the real structure.
"""
import contextlib
import importlib.util
import io
import os
import re
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("patch_pbxproj", os.path.join(HERE, "patch-pbxproj.py"))
pp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pp)

SWIFT = ["StatusBarController.swift", "WebsterClient.swift", "HotkeyManager.swift"]
ICON = "icon-template.png"


def make_pbxproj(object_version, ids, xcode27=False):
    """Build a minimal pbxproj. `ids` supplies the 24-hex ids used."""
    i = ids
    extra_app = "\t\t\t\tSWIFT_APPROACHABLE_CONCURRENCY = YES;\n" if xcode27 else ""
    fileref_style = (
        'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "{n}"; sourceTree = "<group>";'
        if xcode27
        else "isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {n}; sourceTree = \"<group>\";"
    )

    def fref(n):
        return "\t\t%s /* %s */ = {%s};\n" % (i[n], n, fileref_style.format(n=n))

    app_cfg = lambda cfg_id, name: (
        "\t\t%s /* %s */ = {\n"
        "\t\t\tisa = XCBuildConfiguration;\n"
        "\t\t\tbuildSettings = {\n"
        "\t\t\t\tENABLE_APP_SANDBOX = YES;\n"
        "\t\t\t\tENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;\n"
        "\t\t\t\tOTHER_LDFLAGS = (\n"
        "\t\t\t\t\t\"-framework\",\n"
        "\t\t\t\t\tSafariServices,\n"
        "\t\t\t\t\t\"-framework\",\n"
        "\t\t\t\t\tWebKit,\n"
        "\t\t\t\t);\n"
        "\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.hammer.Webster;\n"
        "%s"
        "\t\t\t\tSWIFT_DEFAULT_ACTOR_ISOLATION = MainActor;\n"
        "\t\t\t};\n"
        "\t\t\tname = %s;\n"
        "\t\t};\n" % (cfg_id, name, extra_app, name)
    )
    ext_cfg = lambda cfg_id, name: (
        "\t\t%s /* %s */ = {\n"
        "\t\t\tisa = XCBuildConfiguration;\n"
        "\t\t\tbuildSettings = {\n"
        "\t\t\t\tENABLE_APP_SANDBOX = YES;\n"
        "\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.hammer.webster.Extension;\n"
        "\t\t\t};\n"
        "\t\t\tname = %s;\n"
        "\t\t};\n" % (cfg_id, name, name)
    )

    return (
        "// !$*UTF8*$!\n"
        "{\n"
        "\tarchiveVersion = 1;\n"
        "\tobjectVersion = %s;\n"
        "\tobjects = {\n\n"
        "/* Begin PBXBuildFile section */\n"
        "\t\t%s /* AppDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = %s /* AppDelegate.swift */; };\n"
        "\t\t%s /* ViewController.swift in Sources */ = {isa = PBXBuildFile; fileRef = %s /* ViewController.swift */; };\n"
        "\t\t%s /* Assets.xcassets in Resources */ = {isa = PBXBuildFile; fileRef = %s /* Assets.xcassets */; };\n"
        "/* End PBXBuildFile section */\n\n"
        "/* Begin PBXFileReference section */\n"
        "%s%s"
        "\t\t%s /* Assets.xcassets */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = \"<group>\"; };\n"
        "/* End PBXFileReference section */\n\n"
        "/* Begin PBXGroup section */\n"
        "\t\t%s /* Webster */ = {\n"
        "\t\t\tisa = PBXGroup;\n"
        "\t\t\tchildren = (\n"
        "\t\t\t\t%s /* AppDelegate.swift */,\n"
        "\t\t\t\t%s /* ViewController.swift */,\n"
        "\t\t\t\t%s /* Assets.xcassets */,\n"
        "\t\t\t);\n"
        "\t\t\tpath = Webster;\n"
        "\t\t\tsourceTree = \"<group>\";\n"
        "\t\t};\n"
        "/* End PBXGroup section */\n\n"
        "/* Begin PBXResourcesBuildPhase section */\n"
        "\t\t%s /* Resources */ = {\n"
        "\t\t\tisa = PBXResourcesBuildPhase;\n"
        "\t\t\tfiles = (\n"
        "\t\t\t\t%s /* Assets.xcassets in Resources */,\n"
        "\t\t\t);\n"
        "\t\t};\n"
        "/* End PBXResourcesBuildPhase section */\n\n"
        "/* Begin PBXSourcesBuildPhase section */\n"
        "\t\t%s /* Sources */ = {\n"
        "\t\t\tisa = PBXSourcesBuildPhase;\n"
        "\t\t\tfiles = (\n"
        "\t\t\t\t%s /* AppDelegate.swift in Sources */,\n"
        "\t\t\t\t%s /* ViewController.swift in Sources */,\n"
        "\t\t\t);\n"
        "\t\t};\n"
        "/* End PBXSourcesBuildPhase section */\n\n"
        "/* Begin XCBuildConfiguration section */\n"
        "%s%s%s%s"
        "/* End XCBuildConfiguration section */\n"
        "\t};\n"
        "}\n"
    ) % (
        object_version,
        i["bf_app"], i["fr_app"],
        i["bf_vc"], i["fr_vc"],
        i["bf_assets"], i["fr_assets"],
        fref("AppDelegate.swift"), fref("ViewController.swift"),
        i["fr_assets"],
        i["group"], i["fr_app"], i["fr_vc"], i["fr_assets"],
        i["res_phase"], i["bf_assets"],
        i["src_phase"], i["bf_app"], i["bf_vc"],
        app_cfg(i["cfg1"], "Debug"), app_cfg(i["cfg2"], "Release"),
        ext_cfg(i["cfg3"], "Debug"), ext_cfg(i["cfg4"], "Release"),
    )


def _ids(prefix):
    keys = ["fr_app", "fr_vc", "fr_assets", "bf_app", "bf_vc", "bf_assets", "group",
            "res_phase", "src_phase", "cfg1", "cfg2", "cfg3", "cfg4"]
    ids = {k: "%s%020X" % (prefix, n + 1) for n, k in enumerate(keys)}
    ids["AppDelegate.swift"] = ids["fr_app"]
    ids["ViewController.swift"] = ids["fr_vc"]
    return ids


CLASSIC = make_pbxproj(77, _ids("1A2B"))
XCODE27 = make_pbxproj(110, _ids("7C9D"), xcode27=True)

FIXTURES = {"classic (objectVersion 77)": CLASSIC, "xcode27 (objectVersion 110)": XCODE27}


def section(text, name):
    m = re.search(r"/\* Begin %s section \*/(.*?)/\* End %s section \*/" % (name, name), text, re.S)
    assert m, "section %s missing" % name
    return m.group(1)


def config_blocks(text):
    """Return {bundle_id: block_text} for each XCBuildConfiguration."""
    blocks = re.findall(r"\t\t\w+ /\* \w+ \*/ = \{\n\t\t\tisa = XCBuildConfiguration;.*?\n\t\t\};\n", text, re.S)
    return blocks


def app_blocks(text):
    return [b for b in config_blocks(text) if "ENABLE_OUTGOING_NETWORK_CONNECTIONS" in b]


def ext_blocks(text):
    return [b for b in config_blocks(text) if "ENABLE_OUTGOING_NETWORK_CONNECTIONS" not in b]


class PatchContentTests(unittest.TestCase):
    def each(self):
        for label, fixture in FIXTURES.items():
            with self.subTest(fixture=label):
                yield fixture, pp.patch(fixture)

    def test_fixtures_are_unpatched_to_begin_with(self):
        for label, fixture in FIXTURES.items():
            for name in SWIFT + [ICON]:
                self.assertNotIn(name, fixture, label)

    def test_swift_files_and_icon_are_registered_as_file_references(self):
        for _, out in self.each():
            refs = section(out, "PBXFileReference")
            for name in SWIFT:
                self.assertRegex(refs, r"%s.*sourcecode\.swift" % re.escape(name))
            self.assertRegex(refs, r"%s.*image\.png" % re.escape(ICON))

    def test_build_files_exist_for_swift_sources_and_icon_resource(self):
        for _, out in self.each():
            bfs = section(out, "PBXBuildFile")
            for name in SWIFT:
                self.assertIn("%s in Sources" % name, bfs)
            self.assertIn("%s in Resources" % ICON, bfs)

    def test_every_build_file_points_at_a_defined_file_reference(self):
        for _, out in self.each():
            refs = section(out, "PBXFileReference")
            for fid in re.findall(r"fileRef = (\w+)", section(out, "PBXBuildFile")):
                self.assertIn("\t\t%s " % fid, refs)

    def test_files_are_listed_in_the_webster_group(self):
        for _, out in self.each():
            group = section(out, "PBXGroup")
            for name in SWIFT + [ICON]:
                self.assertIn("/* %s */," % name, group)

    def test_swift_files_compile_in_sources_phase_and_icon_ships_in_resources_phase(self):
        for _, out in self.each():
            sources = section(out, "PBXSourcesBuildPhase")
            resources = section(out, "PBXResourcesBuildPhase")
            for name in SWIFT:
                self.assertIn("%s in Sources" % name, sources)
                self.assertNotIn(name, resources)
            self.assertIn("%s in Resources" % ICON, resources)
            self.assertNotIn(ICON, sources)

    def test_carbon_is_linked_after_webkit_in_app_target_only(self):
        for fixture, out in self.each():
            for block in app_blocks(out):
                self.assertRegex(
                    block, r'WebKit,\s*"-framework",\s*Carbon,',
                )
            for block in ext_blocks(out):
                self.assertNotIn("Carbon", block)
            self.assertEqual(out.count("Carbon"), len(app_blocks(fixture)))

    def test_app_sandbox_is_off_for_app_target_but_on_for_extension(self):
        for fixture, out in self.each():
            self.assertEqual(len(app_blocks(out)), 2)
            self.assertEqual(len(ext_blocks(out)), 2)
            for block in app_blocks(out):
                self.assertIn("ENABLE_APP_SANDBOX = NO;", block)
                self.assertNotIn("ENABLE_APP_SANDBOX = YES;", block)
                self.assertIn("ENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;", block)
            for block in ext_blocks(out):
                self.assertIn("ENABLE_APP_SANDBOX = YES;", block)

    def test_app_bundle_id_is_lowercased_and_extension_id_is_untouched(self):
        for _, out in self.each():
            self.assertNotIn("com.hammer.Webster;", out)
            for block in app_blocks(out):
                self.assertIn("PRODUCT_BUNDLE_IDENTIFIER = com.hammer.webster;", block)
            for block in ext_blocks(out):
                self.assertIn("PRODUCT_BUNDLE_IDENTIFIER = com.hammer.webster.Extension;", block)

    def test_default_actor_isolation_is_removed_without_damaging_neighbours(self):
        for _, out in self.each():
            self.assertNotIn("SWIFT_DEFAULT_ACTOR_ISOLATION", out)
            for block in app_blocks(out):
                self.assertIn("PRODUCT_BUNDLE_IDENTIFIER", block)
                self.assertIn("name = ", block)

    def test_xcode27_only_settings_survive_patching(self):
        out = pp.patch(XCODE27)
        self.assertIn("objectVersion = 110;", out)
        self.assertIn("SWIFT_APPROACHABLE_CONCURRENCY = YES;", out)

    def test_object_version_is_preserved(self):
        self.assertIn("objectVersion = 77;", pp.patch(CLASSIC))

    def test_patching_is_idempotent(self):
        for fixture, once in self.each():
            self.assertEqual(pp.patch(once), once)

    def test_patch_does_not_mutate_unrelated_existing_entries(self):
        for fixture, out in self.each():
            for name in ("AppDelegate.swift", "ViewController.swift", "Assets.xcassets"):
                self.assertGreaterEqual(out.count(name), fixture.count(name))


class PatchFailureTests(unittest.TestCase):
    def assert_raises_for(self, text):
        with self.assertRaises(pp.PatchError):
            pp.patch(text)

    def test_missing_viewcontroller_reference_raises(self):
        for label, fixture in FIXTURES.items():
            with self.subTest(fixture=label):
                self.assert_raises_for(fixture.replace("ViewController.swift", "Other.swift"))

    def test_missing_appdelegate_sources_entry_raises(self):
        for label, fixture in FIXTURES.items():
            with self.subTest(fixture=label):
                self.assert_raises_for(fixture.replace("AppDelegate.swift in Sources", "Other.swift in Sources"))

    def test_missing_assets_resources_entry_raises(self):
        for label, fixture in FIXTURES.items():
            with self.subTest(fixture=label):
                self.assert_raises_for(fixture.replace("Assets.xcassets in Resources", "Other in Resources"))

    def test_missing_webkit_link_flag_raises(self):
        for label, fixture in FIXTURES.items():
            with self.subTest(fixture=label):
                self.assert_raises_for(fixture.replace("WebKit,", "Foundation,"))

    def test_missing_app_target_configs_raises(self):
        for label, fixture in FIXTURES.items():
            with self.subTest(fixture=label):
                self.assert_raises_for(
                    fixture.replace("ENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;", "SOMETHING_ELSE = YES;")
                )

    def test_missing_file_reference_section_raises(self):
        for label, fixture in FIXTURES.items():
            with self.subTest(fixture=label):
                self.assert_raises_for(fixture.replace("/* End PBXFileReference section */", ""))

    def test_non_pbxproj_input_raises(self):
        self.assert_raises_for('{"objects": {}, "rootObject": "x"}')
        self.assert_raises_for("")


class MainTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "project.pbxproj")

    def write(self, text):
        with open(self.path, "w") as f:
            f.write(text)

    def read(self):
        with open(self.path) as f:
            return f.read()

    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = pp.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_success_returns_zero_and_rewrites_file_with_patched_content(self):
        for label, fixture in FIXTURES.items():
            with self.subTest(fixture=label):
                self.write(fixture)
                code, _, _ = self.run_main(["patch-pbxproj.py", self.path])
                self.assertEqual(code, 0)
                self.assertEqual(self.read(), pp.patch(fixture))
                self.assertNotEqual(self.read(), fixture)

    def test_rerunning_on_an_already_patched_file_returns_zero_and_changes_nothing(self):
        self.write(CLASSIC)
        self.assertEqual(self.run_main(["x", self.path])[0], 0)
        patched = self.read()
        self.assertEqual(self.run_main(["x", self.path])[0], 0)
        self.assertEqual(self.read(), patched)

    def test_patch_error_returns_one_reports_to_stderr_and_leaves_file_untouched(self):
        broken = CLASSIC.replace("ViewController.swift", "Other.swift")
        self.write(broken)
        code, _, err = self.run_main(["x", self.path])
        self.assertEqual(code, 1)
        self.assertTrue(err.strip())
        self.assertEqual(self.read(), broken)

    def test_wrong_argument_count_returns_two(self):
        self.write(CLASSIC)
        self.assertEqual(self.run_main(["x"])[0], 2)
        self.assertEqual(self.run_main(["x", self.path, "extra"])[0], 2)
        self.assertEqual(self.read(), CLASSIC)


if __name__ == "__main__":
    unittest.main()
