import Foundation

// HTTP client for the Webster server API

struct ServerStatus: Decodable {
    let running: Bool
    let uptime: String
    let pid: Int
    let port: Int
    let extensions: [BrowserExtension]
    let capture: CaptureStatus
    let sessionCount: Int
}

struct BrowserExtension: Decodable {
    let id: String
    let browser: String
    let version: String
    let transport: String
    let active: Bool
}

struct CaptureStatus: Decodable {
    let active: Bool
    let sessionId: String?
    let duration: String?
    let eventCount: Int?
    let frameCount: Int?
}

struct SessionInfo: Decodable {
    let id: String
    let status: String?
    let startedAt: String?
    let finishedAt: String?
    let eventCount: Int?
    let frameCount: Int?
    let replayUrl: String?
    let config: SessionConfig?
}

struct SessionConfig: Decodable {
    let urlFilter: String?
    let includeInput: Bool?
    let recordFrames: Bool?
    let fps: Int?
}

struct CaptureSnapshot: Decodable {
    let sessionId: String
    let active: Bool
    let duration: String
    let eventCount: Int
    let frameCount: Int
    let replayUrl: String?
}

actor WebsterClient {
    private let baseURL: String
    private let session: URLSession
    private let decoder = JSONDecoder()

    init(port: Int = 3456) {
        self.baseURL = "http://localhost:\(port)"
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 5
        self.session = URLSession(configuration: config)
    }

    func fetchStatus() async -> ServerStatus? {
        guard let url = URL(string: "\(baseURL)/api/status") else { return nil }
        do {
            let (data, _) = try await session.data(from: url)
            return try decoder.decode(ServerStatus.self, from: data)
        } catch {
            return nil
        }
    }

    func fetchSessions() async -> [SessionInfo] {
        guard let url = URL(string: "\(baseURL)/api/sessions") else { return [] }
        do {
            let (data, _) = try await session.data(from: url)
            return try decoder.decode([SessionInfo].self, from: data)
        } catch {
            return []
        }
    }

    func startCapture(urlFilter: String?, includeInput: Bool, recordFrames: Bool) async -> CaptureSnapshot? {
        guard let url = URL(string: "\(baseURL)/api/capture/start") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = [
            "includeInput": includeInput,
            "recordFrames": recordFrames,
        ]
        if let filter = urlFilter, !filter.isEmpty {
            body["urlFilter"] = filter
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, _) = try await session.data(for: request)
            return try decoder.decode(CaptureSnapshot.self, from: data)
        } catch {
            return nil
        }
    }

    func stopCapture() async -> CaptureSnapshot? {
        guard let url = URL(string: "\(baseURL)/api/capture/stop") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        do {
            let (data, _) = try await session.data(for: request)
            return try decoder.decode(CaptureSnapshot.self, from: data)
        } catch {
            return nil
        }
    }

    func deleteSession(id: String) async -> Bool {
        guard let url = URL(string: "\(baseURL)/api/sessions/\(id)") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        do {
            let (_, response) = try await session.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 204
        } catch {
            return false
        }
    }

    nonisolated func dashboardURL() -> URL? {
        URL(string: "\(baseURL)/dashboard")
    }

    nonisolated func replayURL(sessionId: String) -> URL? {
        URL(string: "\(baseURL)/replay/\(sessionId)")
    }
}
