// swift-tools-version: 5.10
//
// DripKit — every module of the native app except the thin app target.
//
// Dependency-free on purpose. The one third-party SDK the app needs
// (Stripe PaymentSheet, for PCI-compliant card entry and Apple Pay) is linked
// by the app target only and reaches Commerce through the `PaymentPresenting`
// protocol, so every module here builds and tests with `swift test` alone —
// on macOS and on Linux CI (UI files are gated behind `canImport(SwiftUI)`).

import PackageDescription

let strict: [SwiftSetting] = [
    .enableUpcomingFeature("StrictConcurrency"),
    .enableUpcomingFeature("ExistentialAny"),
]

let package = Package(
    name: "DripKit",
    defaultLocalization: "en",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "AppCore", targets: ["AppCore"]),
    ],
    targets: [
        // Foundation-only layers.
        .target(name: "DripModels", swiftSettings: strict),
        .target(name: "Networking", dependencies: ["DripModels"], swiftSettings: strict),
        .target(name: "Authentication", dependencies: ["Networking"], swiftSettings: strict),
        .target(name: "Analytics", dependencies: ["Networking"], swiftSettings: strict),
        .target(name: "DesignSystem", dependencies: ["DripModels"], swiftSettings: strict),
        .target(name: "Media", dependencies: ["DripModels", "Analytics"], swiftSettings: strict),

        // Features.
        .target(name: "Products", dependencies: ["DesignSystem", "Networking"], swiftSettings: strict),
        .target(name: "Commerce", dependencies: ["Products", "Analytics"], swiftSettings: strict),
        .target(name: "Discover",
                dependencies: ["Media", "Products", "Commerce", "Analytics", "DesignSystem"],
                swiftSettings: strict),
        .target(name: "Explore", dependencies: ["Discover"], swiftSettings: strict),
        .target(name: "Creators",
                dependencies: ["Discover", "Media", "Authentication"],
                swiftSettings: strict),
        .target(name: "Profile",
                dependencies: ["Discover", "Authentication", "Creators"],
                swiftSettings: strict),

        // Composition root: configuration, dependency container, routing.
        .target(name: "AppCore",
                dependencies: ["Discover", "Explore", "Creators", "Profile", "Commerce",
                               "Authentication", "Analytics"],
                swiftSettings: strict),

        .target(name: "TestSupport", dependencies: ["DripModels", "Networking", "Authentication"],
                path: "Tests/TestSupport"),
        .testTarget(name: "DripKitTests",
                    dependencies: ["AppCore", "TestSupport"],
                    path: "Tests/DripKitTests"),
    ]
)
