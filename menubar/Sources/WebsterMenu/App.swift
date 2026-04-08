import AppKit

@main
struct WebsterMenuApp {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory) // menu bar only — no Dock icon

        let port = Int(ProcessInfo.processInfo.environment["WEBSTER_PORT"] ?? "3456") ?? 3456
        let client = WebsterClient(port: port)

        // Must retain — if deallocated, menu action targets become nil
        let controller = StatusBarController(client: client)
        withExtendedLifetime(controller) {
            app.run()
        }
    }
}
