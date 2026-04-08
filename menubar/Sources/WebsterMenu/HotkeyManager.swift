import AppKit
import Carbon

// Global hotkey registration using Carbon API (no Accessibility permission needed)

@MainActor
final class HotkeyManager {
    private var hotKeyRef: EventHotKeyRef?
    private var handler: (() -> Void)?

    // Carbon event handler must be a C function — use a global to bridge
    fileprivate static var shared: HotkeyManager?

    init() {
        HotkeyManager.shared = self
    }

    /// Register Ctrl+Option+R as global hotkey for toggling capture
    func register(action: @escaping () -> Void) {
        self.handler = action

        // Install Carbon event handler
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), hotKeyHandler, 1, &eventType, nil, nil)

        // Register Ctrl+Option+R
        // Key code 15 = 'R' on US keyboard
        let modifiers: UInt32 = UInt32(controlKey | optionKey)  // Carbon modifier flags
        let hotKeyID = EventHotKeyID(signature: OSType(0x5742_5354), id: 1) // 'WBST'
        let status = RegisterEventHotKey(15, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
        if status != noErr {
            print("[webster-menu] Failed to register hotkey: \(status)")
        }
    }

    func fire() {
        handler?()
    }

    deinit {
        if let ref = hotKeyRef {
            UnregisterEventHotKey(ref)
        }
    }
}

// C-compatible callback — bridges to the Swift handler
private func hotKeyHandler(
    nextHandler: EventHandlerCallRef?,
    event: EventRef?,
    userData: UnsafeMutableRawPointer?
) -> OSStatus {
    Task { @MainActor in
        HotkeyManager.shared?.fire()
    }
    return noErr
}
