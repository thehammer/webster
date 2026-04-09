//  AppDelegate.swift — Webster Safari Extension + Menu Bar App
//  Spawns the bun MCP server as a subprocess and provides a full menu bar UI.
//  Patched by build-extension.sh — do not edit the copy inside safari-xcode directly.

import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    private var serverProcess: Process?
    private var statusBarController: StatusBarController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Menu bar only — no Dock icon, no windows
        NSApp.setActivationPolicy(.accessory)
        NSApp.windows.forEach { $0.orderOut(nil) }

        startBunServer()

        let port = Int(ProcessInfo.processInfo.environment["WEBSTER_PORT"] ?? "3456") ?? 3456
        statusBarController = StatusBarController(client: WebsterClient(port: port))
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverProcess?.terminate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    // MARK: - Bun server

    private func startBunServer() {
        let env = ProcessInfo.processInfo.environment
        guard let bunPath = resolveBun(env: env) else {
            NSLog("[Webster] bun not found — MCP server will not start")
            return
        }
        guard let projectDir = env["WEBSTER_PROJECT_DIR"], !projectDir.isEmpty else {
            NSLog("[Webster] WEBSTER_PROJECT_DIR not set — MCP server will not start")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: bunPath)
        process.arguments = ["run", "\(projectDir)/src/index.ts"]
        process.currentDirectoryURL = URL(fileURLWithPath: projectDir)
        process.environment = env.merging([
            "HOME": NSHomeDirectory(),
            "PATH": "\(URL(fileURLWithPath: bunPath).deletingLastPathComponent().path):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        ]) { _, new in new }

        // Append to log file
        let logDir = "\(NSHomeDirectory())/.webster"
        try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        let logPath = "\(logDir)/webster.log"
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }
        if let fh = FileHandle(forWritingAtPath: logPath) {
            fh.seekToEndOfFile()
            process.standardOutput = fh
            process.standardError = fh
        }

        do {
            try process.run()
            serverProcess = process
            NSLog("[Webster] bun server started (PID %d) on port %@",
                  process.processIdentifier, env["WEBSTER_PORT"] ?? "3456")
        } catch {
            NSLog("[Webster] Failed to start bun server: %@", error.localizedDescription)
        }
    }

    private func resolveBun(env: [String: String]) -> String? {
        // 1. Explicit override via environment variable
        if let explicit = env["WEBSTER_BUN_PATH"],
           FileManager.default.fileExists(atPath: explicit) {
            return explicit
        }
        // 2. Common install locations
        let home = NSHomeDirectory()
        let candidates = [
            "\(home)/.bun/bin/bun",
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
        ]
        // 3. Scan asdf installs (newest version first)
        let asdfBase = "\(home)/.asdf/installs/bun"
        let asdfCandidates = (try? FileManager.default.contentsOfDirectory(atPath: asdfBase))?
            .sorted().reversed()
            .map { "\(asdfBase)/\($0)/bin/bun" } ?? []

        for path in candidates + asdfCandidates {
            if FileManager.default.fileExists(atPath: path) { return path }
        }
        return nil
    }
}
