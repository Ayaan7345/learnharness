import SwiftUI

@main
struct LearnHarnessApp: App {
	@State private var store = ServerStore()

	var body: some Scene {
		WindowGroup {
			Group {
				if let server = store.server {
					ServerScreen(server: server)
				} else {
					ConnectView()
				}
			}
			.environment(store)
			.preferredColorScheme(.dark)
		}
	}
}

extension Color {
	/// The web app's background, so native screens and loading states match it.
	static let appBackground = Color(red: 0x14 / 255, green: 0x14 / 255, blue: 0x14 / 255)
}
