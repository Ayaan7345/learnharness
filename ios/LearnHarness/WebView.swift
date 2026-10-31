import SwiftUI
import WebKit

/// Owns the one WKWebView for the connected server so it survives SwiftUI
/// view updates, and publishes load state for the native overlays.
@MainActor
@Observable
final class WebViewModel: NSObject {
	private(set) var loadError: String?
	private(set) var isFirstLoad = true

	@ObservationIgnored private var server: URL?
	@ObservationIgnored private var downloads: [ObjectIdentifier: URL] = [:]
	@ObservationIgnored private(set) lazy var webView: WKWebView = makeWebView()

	func load(_ server: URL) {
		self.server = server
		loadError = nil
		webView.load(URLRequest(url: server))
	}

	func reload(_ server: URL) {
		if webView.url == nil || loadError != nil || self.server != server { load(server) } else { webView.reload() }
	}

	private func makeWebView() -> WKWebView {
		let config = WKWebViewConfiguration()
		// Persistent store: the 30-day sign-in cookie survives app restarts.
		config.websiteDataStore = .default()
		config.allowsInlineMediaPlayback = true
		config.mediaTypesRequiringUserActionForPlayback = []
		// Keep the mobile Safari tokens so the web app sees a phone; the suffix
		// identifies this app (apps-only servers refuse anything else).
		config.applicationNameForUserAgent = "Mobile/15E148 \(ServerAddress.appUserAgentToken)"
		config.userContentController.addUserScript(WKUserScript(source: Self.viewportScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))

		let webView = WKWebView(frame: .zero, configuration: config)
		webView.navigationDelegate = self
		webView.uiDelegate = self
		webView.isOpaque = false
		webView.backgroundColor = UIColor(red: 0x14 / 255, green: 0x14 / 255, blue: 0x14 / 255, alpha: 1)
		webView.scrollView.backgroundColor = webView.backgroundColor
		// The web app is a fixed-height shell with its own scrolling panes.
		webView.scrollView.bounces = false
		webView.scrollView.contentInsetAdjustmentBehavior = .never
		webView.allowsBackForwardNavigationGestures = true
		#if DEBUG
		webView.isInspectable = true
		#endif
		return webView
	}

	/// iOS zooms the page when focusing an input with text under 16px and
	/// never zooms back; pinning the maximum scale stops that jump.
	private static let viewportScript = """
	(() => {
		let meta = document.querySelector('meta[name=viewport]');
		if (!meta) { meta = document.createElement('meta'); meta.name = 'viewport'; document.head.appendChild(meta); }
		meta.content = 'width=device-width, initial-scale=1, maximum-scale=1';
	})();
	"""

	private func isServerOrigin(_ url: URL?) -> Bool {
		guard let url, let server else { return false }
		return url.scheme == server.scheme && url.host == server.host && url.port == server.port
	}

	fileprivate func present(_ controller: UIViewController) {
		var top = webView.window?.rootViewController
		while let presented = top?.presentedViewController { top = presented }
		if let popover = controller.popoverPresentationController {
			popover.sourceView = webView
			popover.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 0, height: 0)
		}
		top?.present(controller, animated: true)
	}
}

// MARK: - Navigation: stay on the server, everything else opens in Safari

extension WebViewModel: WKNavigationDelegate {
	func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
		if action.shouldPerformDownload { return .download }
		guard action.targetFrame?.isMainFrame ?? true, let url = action.request.url else { return .allow }
		if isServerOrigin(url) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return .allow }
		if ["http", "https", "mailto", "tel"].contains(url.scheme ?? "") { await UIApplication.shared.open(url) }
		return .cancel
	}

	func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
		let attachment = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") ?? false
		return response.canShowMIMEType && !attachment ? .allow : .download
	}

	func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
		download.delegate = self
	}

	func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
		download.delegate = self
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		loadError = nil
		isFirstLoad = false
	}

	func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		fail(error)
	}

	func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
		fail(error)
	}

	private func fail(_ error: Error) {
		let error = error as NSError
		// Cancelled loads (a newer navigation replaced this one) are not failures.
		if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
		if error.domain == "WebKitErrorDomain" && error.code == 102 { return } // frame load interrupted (download handoff)
		isFirstLoad = false
		loadError = error.localizedDescription
	}

	func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
		// iOS may reclaim the page's process in the background; start fresh.
		if let server { load(server) }
	}
}

// MARK: - Browser features the page relies on

extension WebViewModel: WKUIDelegate {
	/// window.open / target=_blank: the app has a single window, so these go to Safari.
	func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
		if let url = action.request.url {
			if isServerOrigin(url) { webView.load(action.request) } else { UIApplication.shared.open(url) }
		}
		return nil
	}

	/// Dictation: the microphone is granted to the server's own pages only.
	func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin, initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
		guard let server else { return .deny }
		let port = origin.port == 0 ? nil : origin.port
		return origin.protocol == server.scheme && origin.host == server.host && port == server.port && type == .microphone ? .grant : .deny
	}

	func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
		await withCheckedContinuation { done in
			let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
			alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done.resume() })
			present(alert)
		}
	}

	func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
		await withCheckedContinuation { done in
			let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
			alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done.resume(returning: false) })
			alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done.resume(returning: true) })
			present(alert)
		}
	}

	func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
		await withCheckedContinuation { done in
			let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
			alert.addTextField { $0.text = defaultText }
			alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done.resume(returning: nil) })
			alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done.resume(returning: alert.textFields?.first?.text ?? "") })
			present(alert)
		}
	}
}

// MARK: - Downloads (e.g. Markdown export) go to the share sheet

extension WebViewModel: WKDownloadDelegate {
	func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
		let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
		try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
		let file = folder.appending(path: suggestedFilename)
		downloads[ObjectIdentifier(download)] = file
		return file
	}

	func downloadDidFinish(_ download: WKDownload) {
		guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
		present(UIActivityViewController(activityItems: [file], applicationActivities: nil))
	}

	func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
		downloads.removeValue(forKey: ObjectIdentifier(download))
		let alert = UIAlertController(title: "Download failed", message: error.localizedDescription, preferredStyle: .alert)
		alert.addAction(UIAlertAction(title: "OK", style: .default))
		present(alert)
	}
}

/// SwiftUI host for the model's long-lived web view.
struct WebView: UIViewRepresentable {
	let server: URL
	let model: WebViewModel

	func makeUIView(context: Context) -> WKWebView {
		let webView = model.webView
		if webView.url == nil { model.load(server) }
		return webView
	}

	func updateUIView(_ webView: WKWebView, context: Context) {}
}
