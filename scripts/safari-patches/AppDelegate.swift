//  AppDelegate.swift — Webster companion app (menu bar only)
//  Patched by build-extension.sh — do not edit the copy in safari-xcode directly.

import Cocoa
import SafariServices

// extensionBundleIdentifier is declared in ViewController.swift (same module)

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem?
    var extensionStatusMenuItem: NSMenuItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Hide Dock icon and suppress storyboard windows — menu bar only
        NSApp.setActivationPolicy(.accessory)
        NSApp.windows.forEach { $0.orderOut(nil) }

        // Build menu bar item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem?.button {
            if #available(macOS 11, *) {
                button.image = NSImage(systemSymbolName: "globe.americas.fill", accessibilityDescription: "Webster")
            } else {
                button.title = "W"
            }
        }

        let menu = NSMenu()

        extensionStatusMenuItem = NSMenuItem(title: "Checking…", action: nil, keyEquivalent: "")
        extensionStatusMenuItem?.isEnabled = false
        menu.addItem(extensionStatusMenuItem!)

        menu.addItem(.separator())

        let settingsItem = NSMenuItem(title: "Open Safari Settings…", action: #selector(openSafariSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

        menu.addItem(.separator())

        menu.addItem(NSMenuItem(title: "Quit Webster", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

        statusItem?.menu = menu

        // Refresh state when menu is about to open
        NotificationCenter.default.addObserver(self, selector: #selector(menuWillOpen), name: NSMenu.didBeginTrackingNotification, object: menu)

        refreshExtensionState()
    }

    @objc func menuWillOpen() {
        refreshExtensionState()
    }

    @objc func openSafariSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
    }

    func refreshExtensionState() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, error in
            DispatchQueue.main.async {
                if let state = state {
                    self.extensionStatusMenuItem?.title = state.isEnabled ? "Extension: On ✓" : "Extension: Off"
                } else {
                    self.extensionStatusMenuItem?.title = "Extension: Unknown"
                }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false  // Never quit when window closes — we live in the menu bar
    }
}
