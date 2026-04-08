// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WebsterMenu",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "WebsterMenu",
            path: "Sources/WebsterMenu"
        ),
    ]
)
