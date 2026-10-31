import SwiftUI

/// The connected app: the server's own interface in a web view, plus the
/// few native controls a browser can't provide (change server, sign out).
struct ServerScreen: View {
	@Environment(ServerStore.self) private var store
	let server: URL

	@State private var model = WebViewModel()
	@State private var showingConnect = false

	var body: some View {
		ZStack {
			Color.appBackground.ignoresSafeArea()
			// WKWebView keeps the page inside the safe area on its own.
			WebView(server: server, model: model)
				.opacity(model.loadError == nil ? 1 : 0)
			if let error = model.loadError {
				unreachable(error)
			} else if model.isFirstLoad {
				ProgressView().controlSize(.large)
			}
		}
		// The strip beside the home indicator is native space the page never
		// uses, so the menu sits there and never covers the page. Devices
		// without that strip get it in the bottom corner instead.
		.overlay {
			GeometryReader { area in
				let strip = area.safeAreaInsets.bottom
				// Bottom-anchored inside the strip (the page ends at the strip's top).
				menu.position(x: 40, y: area.size.height + (strip >= 26 ? strip - 6 : -16))
			}
		}
		.sheet(isPresented: $showingConnect) { ConnectView(isSheet: true) }
		.onChange(of: server) { model.load(server) }
	}

	/// Native controls, tucked into a small corner button.
	private var menu: some View {
		Menu {
			Section(server.host() ?? server.absoluteString) {
				Button("Reload", systemImage: "arrow.clockwise") { model.reload(server) }
				Button("Change Server…", systemImage: "server.rack") { showingConnect = true }
				Button("Sign Out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
					Task {
						await store.signOut()
						model.load(server)
					}
				}
			}
		} label: {
			Image(systemName: "ellipsis")
				.font(.system(size: 12, weight: .bold))
				.foregroundStyle(.secondary)
				.frame(width: 44, height: 26)
				.contentShape(Rectangle())
		}
		.accessibilityLabel("Server options")
	}

	private func unreachable(_ message: String) -> some View {
		VStack(spacing: 14) {
			Image(systemName: "wifi.exclamationmark").font(.system(size: 40)).foregroundStyle(.secondary)
			Text("Can't reach your LearnHarness server").font(.headline)
			Text(message).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
			HStack {
				Button("Change Server…") { showingConnect = true }.buttonStyle(.bordered)
				Button("Try Again") { model.reload(server) }.buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black)
			}
		}
		.padding(28)
	}
}
