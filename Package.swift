// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "FreezeFocused",
    platforms: [.macOS(.v11)],
    targets: [
        .executableTarget(
            name: "FreezeFocused",
            path: "Sources/FreezeFocused"
        )
    ]
)
