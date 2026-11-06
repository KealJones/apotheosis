// swift-tools-version:5.9
import Foundation
import PackageDescription

// The daemon is a bare executable, not an .app bundle, so its Info.plist has to be
// embedded in the binary (__TEXT,__info_plist) for TCC to see the usage descriptions
// (NSMicrophoneUsageDescription etc.). Without them macOS won't prompt for the mic.
let infoPlist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

let package = Package(
    name: "Capture",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Capture",
            path: "Sources/Capture",
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist])
            ]
        )
    ]
)
