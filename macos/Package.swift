// swift-tools-version:5.9
// Sheepdog menu bar app. Build the .app and .dmg with ./build.sh, publish with ./release.sh.
// Sparkle (the updater) is vendored as a prebuilt framework in vendor/sparkle; build.sh copies it
// into Sheepdog.app/Contents/Frameworks.
import PackageDescription

let package = Package(
    name: "Sheepdog",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "Sheepdog",
            path: "Sources/Sheepdog",
            swiftSettings: [.unsafeFlags(["-F", "vendor/sparkle"])],
            linkerSettings: [.unsafeFlags([
                "-F", "vendor/sparkle", "-framework", "Sparkle",
                "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
            ])]
        )
    ]
)
