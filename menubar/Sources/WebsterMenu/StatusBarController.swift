import AppKit

@MainActor
final class StatusBarController: NSObject {
    private var statusItem: NSStatusItem
    private let client: WebsterClient
    private var pollTimer: Timer?
    private let hotkeyManager = HotkeyManager()

    // Cached state
    private var serverStatus: ServerStatus?
    private var sessions: [SessionInfo] = []

    // Capture preferences (persisted in UserDefaults)
    private var prefIncludeInput: Bool {
        get { UserDefaults.standard.object(forKey: "captureIncludeInput") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "captureIncludeInput") }
    }
    private var prefRecordFrames: Bool {
        get { UserDefaults.standard.object(forKey: "captureRecordFrames") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "captureRecordFrames") }
    }

    init(client: WebsterClient) {
        self.client = client
        self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()

        if let button = statusItem.button {
            button.image = Self.makeIcon(recording: false)
            button.image?.isTemplate = true
        }

        buildMenu()
        startPolling()
        setupHotkey()
    }

    // MARK: - Hotkey

    private func setupHotkey() {
        hotkeyManager.register { [weak self] in
            guard let self else { return }
            self.toggleCapture()
        }
    }

    private func toggleCapture() {
        let isActive = serverStatus?.capture.active ?? false
        if isActive {
            stopCapture()
        } else {
            startCapture()
        }
    }

    // MARK: - Polling

    private func startPolling() {
        // Initial fetch
        Task { await poll() }

        // Poll status every 2s, sessions every 10s
        pollTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                await self.poll()
            }
        }
    }

    private var pollCount = 0

    private func poll() async {
        let status = await client.fetchStatus()
        self.serverStatus = status

        pollCount += 1
        if pollCount % 5 == 0 || sessions.isEmpty {
            self.sessions = await client.fetchSessions()
        }

        updateIcon()
        buildMenu()
    }

    // MARK: - Icon

    private func updateIcon() {
        let recording = serverStatus?.capture.active ?? false
        if let button = statusItem.button {
            button.image = Self.makeIcon(recording: recording)
            button.image?.isTemplate = true
        }
    }

    static func makeIcon(recording: Bool) -> NSImage {
        // Load the spider template PNG from the Resources directory next to the binary,
        // or fall back to a bundled resource, or finally draw a "W" glyph.
        var baseImage: NSImage?

        // Try loading from known locations:
        // 1. Next to the binary (installed)
        // 2. /usr/local/share/webster-menu/ (installed via script)
        // 3. Walk up from binary to find Resources/ (dev build in .build/)
        // 4. Bundle resources
        let execDir = Bundle.main.executableURL?.deletingLastPathComponent()
        let shareDir = URL(fileURLWithPath: "/usr/local/share/webster-menu")
        // In dev, binary is at .build/arm64-apple-macosx/debug/ — walk up 3 to menubar/
        let devResources = execDir?.appendingPathComponent("../../../Resources")
        for dir in [execDir,
                    shareDir,
                    devResources,
                    Bundle.main.resourceURL] {
            if let d = dir {
                let path = d.appendingPathComponent("icon-template.png").path
                if let img = NSImage(contentsOfFile: path) {
                    baseImage = img
                    break
                }
            }
        }

        // Fallback: draw a "W"
        if baseImage == nil {
            let size = NSSize(width: 18, height: 18)
            baseImage = NSImage(size: size, flipped: false) { rect in
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: NSFont.systemFont(ofSize: 13, weight: .bold),
                    .foregroundColor: NSColor.black,
                ]
                let str = NSAttributedString(string: "W", attributes: attrs)
                let strSize = str.size()
                str.draw(at: NSPoint(x: (rect.width - strSize.width) / 2, y: (rect.height - strSize.height) / 2))
                return true
            }
        }

        guard let image = baseImage else { return NSImage() }

        if recording {
            // Composite the base image with a red recording dot
            let size = image.size
            let composite = NSImage(size: size, flipped: false) { rect in
                image.draw(in: rect)
                let dotSize: CGFloat = 5
                let dotRect = NSRect(x: rect.width - dotSize - 1, y: rect.height - dotSize - 1, width: dotSize, height: dotSize)
                NSColor.systemRed.setFill()
                NSBezierPath(ovalIn: dotRect).fill()
                return true
            }
            return composite
        }

        return image
    }

    // MARK: - Menu Construction

    private func buildMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false

        // Server status
        if let status = serverStatus {
            let serverItem = NSMenuItem(title: "Server: Running (:\(status.port))", action: nil, keyEquivalent: "")
            serverItem.isEnabled = false
            menu.addItem(serverItem)

            let uptimeItem = NSMenuItem(title: "Uptime: \(status.uptime)  |  PID \(status.pid)", action: nil, keyEquivalent: "")
            uptimeItem.isEnabled = false
            menu.addItem(uptimeItem)

            if status.extensions.isEmpty {
                let item = NSMenuItem(title: "No browser connected", action: nil, keyEquivalent: "")
                item.isEnabled = false
                menu.addItem(item)
            } else {
                for ext in status.extensions {
                    let label = "\(ext.browser) v\(ext.version) (\(ext.transport))"
                    let item = NSMenuItem(title: label, action: nil, keyEquivalent: "")
                    item.isEnabled = false
                    item.image = Self.dotImage(color: .systemGreen)
                    menu.addItem(item)
                }
            }
        } else {
            let item = NSMenuItem(title: "Server: Not Reachable", action: nil, keyEquivalent: "")
            item.isEnabled = false
            item.image = Self.dotImage(color: .systemRed)
            menu.addItem(item)
        }

        menu.addItem(.separator())

        // Capture controls
        if let status = serverStatus, status.capture.active {
            let capItem = NSMenuItem(
                title: "Recording — \(status.capture.duration ?? "?") (\(status.capture.eventCount ?? 0) events)",
                action: nil, keyEquivalent: ""
            )
            capItem.isEnabled = false
            capItem.image = Self.dotImage(color: .systemRed)
            menu.addItem(capItem)

            let stopItem = NSMenuItem(title: "Stop Capture  (⌃⌥R)", action: #selector(stopCapture), keyEquivalent: "")
            stopItem.target = self
            menu.addItem(stopItem)
        } else {
            let startItem = NSMenuItem(title: "Start Capture  (⌃⌥R)", action: #selector(startCapture), keyEquivalent: "")
            startItem.target = self
            startItem.isEnabled = serverStatus != nil && !(serverStatus?.extensions.isEmpty ?? true)
            menu.addItem(startItem)

            // Options
            let inputItem = NSMenuItem(title: "  Include Input", action: #selector(toggleInput), keyEquivalent: "")
            inputItem.target = self
            inputItem.state = prefIncludeInput ? .on : .off
            menu.addItem(inputItem)

            let framesItem = NSMenuItem(title: "  Record Frames", action: #selector(toggleFrames), keyEquivalent: "")
            framesItem.target = self
            framesItem.state = prefRecordFrames ? .on : .off
            menu.addItem(framesItem)
        }

        menu.addItem(.separator())

        // Recent sessions
        if sessions.isEmpty {
            let item = NSMenuItem(title: "No Sessions", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        } else {
            let sessionsSubmenu = NSMenu()
            for session in sessions.prefix(15) {
                let shortId = String(session.id.prefix(8))
                let events = session.eventCount ?? 0
                let frames = session.frameCount ?? 0
                let status = session.status ?? "?"
                let date = formatDate(session.startedAt)
                let title = "\(shortId) — \(date) — \(events)ev \(frames)fr (\(status))"
                let item = NSMenuItem(title: title, action: #selector(openReplay(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = session.id
                sessionsSubmenu.addItem(item)
            }
            let sessionsItem = NSMenuItem(title: "Recent Sessions (\(sessions.count))", action: nil, keyEquivalent: "")
            sessionsItem.submenu = sessionsSubmenu
            menu.addItem(sessionsItem)
        }

        menu.addItem(.separator())

        // Dashboard
        let dashItem = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "")
        dashItem.target = self
        menu.addItem(dashItem)

        menu.addItem(.separator())

        // Quit
        let quitItem = NSMenuItem(title: "Quit Webster Menu", action: #selector(quit), keyEquivalent: "")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    // MARK: - Actions

    @objc private func startCapture() {
        Task {
            _ = await client.startCapture(
                urlFilter: nil,
                includeInput: prefIncludeInput,
                recordFrames: prefRecordFrames
            )
            await poll()
        }
    }

    @objc private func stopCapture() {
        Task {
            let result = await client.stopCapture()
            await poll()
            self.sessions = await client.fetchSessions()
            buildMenu()

            // Open replay if we got a result with frames
            if let snap = result, snap.frameCount > 0 {
                if let url = self.client.replayURL(sessionId: snap.sessionId) {
                    NSWorkspace.shared.open(url)
                }
            }
        }
    }

    @objc private func toggleInput() {
        prefIncludeInput.toggle()
        buildMenu()
    }

    @objc private func toggleFrames() {
        prefRecordFrames.toggle()
        buildMenu()
    }

    @objc private func openReplay(_ sender: NSMenuItem) {
        guard let sessionId = sender.representedObject as? String else { return }
        if let url = client.replayURL(sessionId: sessionId) {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func openDashboard() {
        if let url = client.dashboardURL() {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func quit() {
        NSApplication.shared.terminate(nil)
    }

    // MARK: - Helpers

    static func dotImage(color: NSColor) -> NSImage {
        let size = NSSize(width: 8, height: 8)
        let image = NSImage(size: size, flipped: false) { rect in
            color.setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1)).fill()
            return true
        }
        return image
    }

    private func formatDate(_ isoString: String?) -> String {
        guard let str = isoString else { return "?" }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: str) else { return str.prefix(10).description }
        let rel = RelativeDateTimeFormatter()
        rel.unitsStyle = .abbreviated
        return rel.localizedString(for: date, relativeTo: Date())
    }
}
