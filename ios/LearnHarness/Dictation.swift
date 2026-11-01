import AVFoundation
import Speech
import SwiftUI

/// Dictation for the native composer.
///
/// When the server reports an STT engine, a tap records 16 kHz mono PCM and
/// the next tap uploads it to POST /api/stt/transcribe. The server calls
/// OpenRouter's Deepgram Nova-3 (or Deepgram directly when that is the
/// engine). The API key stays on the server. The transcript is inserted
/// once it comes back.
///
/// Apple's on-device recognizer is the fallback: the server has no STT
/// engine, the engine check fails, or the transcription request fails.
@MainActor
@Observable
final class Dictation {
	enum Phase: Equatable { case idle, recording, transcribing }

	private(set) var phase: Phase = .idle
	var error: String?
	/// Ten minutes of 16 kHz 16-bit mono, matching the server's cap.
	static let maxPCMBytes = 10 * 60 * 16_000 * 2

	@ObservationIgnored private let audio = AVAudioEngine()
	@ObservationIgnored private var converter: AVAudioConverter?
	@ObservationIgnored private var appleRequest: SFSpeechAudioBufferRecognitionRequest?
	@ObservationIgnored private var appleTask: SFSpeechRecognitionTask?
	@ObservationIgnored private var pcm = Data()
	@ObservationIgnored private let pcmLock = NSLock()
	@ObservationIgnored private var mode: Mode = .idle
	@ObservationIgnored private var generation = 0
	@ObservationIgnored private var baseText = ""
	@ObservationIgnored private var read: (() -> String)?
	@ObservationIgnored private var write: ((String) -> Void)?
	@ObservationIgnored private var api: ServerAPI?
	@ObservationIgnored private var delivering = false
	@ObservationIgnored private var tapInstalled = false
	@ObservationIgnored private var waiter: CheckedContinuation<Void, Never>?

	private enum Mode { case idle, server, apple }

	var isRecording: Bool { phase == .recording }

	/// Joins a finished transcript onto whatever is already in the field.
	static func join(_ current: String, _ spoken: String) -> String {
		let spoken = spoken.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !spoken.isEmpty else { return current }
		let prefix = current.trimmingCharacters(in: .whitespacesAndNewlines)
		return prefix.isEmpty ? spoken : prefix + " " + spoken
	}

	func dismissError() { error = nil }

	/// Tap. Recording starts or stops. A transcription in flight is left alone.
	func toggle(api: ServerAPI, read: @escaping () -> String, write: @escaping (String) -> Void) async {
		self.api = api
		self.read = read
		self.write = write
		switch phase {
		case .idle: await start(api: api)
		case .recording: await stopAndDeliver(api: api)
		case .transcribing: break
		}
	}

	/// Stops a live recording and waits until its transcript has been written.
	/// Send uses this so the spoken words are in the field first.
	func finish(api: ServerAPI, read: @escaping () -> String, write: @escaping (String) -> Void) async {
		self.api = api
		self.read = read
		self.write = write
		if phase == .recording { await stopAndDeliver(api: api) }
		if phase == .transcribing {
			await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
				waiter = cont
			}
		}
	}

	/// Drops the recording. Used when the screen goes away.
	func cancel() {
		generation += 1
		delivering = false
		teardown()
		phase = .idle
		mode = .idle
		releaseWaiter()
	}

	private func start(api: ServerAPI) async {
		error = nil
		generation += 1
		let gen = generation
		let engine: String?
		do { engine = try await api.transcriptionEngine() } catch { engine = nil }
		guard gen == generation else { return }
		if engine == "openrouter" || engine == "deepgram" {
			await beginServerCapture()
		} else {
			await beginApple()
		}
	}

	private func beginServerCapture() async {
		guard await Self.micAllowed() else {
			error = "Allow Microphone for LearnHarness in Settings to dictate."
			return
		}
		do {
			let session = AVAudioSession.sharedInstance()
			try session.setCategory(.record, mode: .measurement, options: .duckOthers)
			try session.setActive(true, options: .notifyOthersOnDeactivation)
			let input = audio.inputNode
			let format = input.outputFormat(forBus: 0)
			guard format.sampleRate > 0, let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true), let converter = AVAudioConverter(from: format, to: target) else {
				error = "Couldn't start the microphone."
				return
			}
			self.converter = converter
			pcmLock.lock()
			pcm = Data()
			pcmLock.unlock()
			input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
				self?.capture(buffer, converter: converter)
			}
			tapInstalled = true
			audio.prepare()
			try audio.start()
			mode = .server
			phase = .recording
		} catch {
			teardown()
			self.error = "Couldn't start the microphone (\(error.localizedDescription))."
		}
	}

	private func capture(_ buffer: AVAudioPCMBuffer, converter: AVAudioConverter) {
		let ratio = 16_000 / buffer.format.sampleRate
		let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
		guard let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: max(capacity, 1)) else { return }
		var consumed = false
		var convertError: NSError?
		let status = converter.convert(to: output, error: &convertError) { _, outStatus in
			if consumed {
				outStatus.pointee = .noDataNow
				return nil
			}
			consumed = true
			outStatus.pointee = .haveData
			return buffer
		}
		guard convertError == nil, status != .error, output.frameLength > 0, let channel = output.int16ChannelData?[0] else { return }
		let count = Int(output.frameLength) * MemoryLayout<Int16>.size
		let bytes = Data(UnsafeRawBufferPointer(start: channel, count: count))
		pcmLock.lock()
		let room = Self.maxPCMBytes - pcm.count
		if room > 0 { pcm.append(bytes.prefix(room)) }
		let full = pcm.count >= Self.maxPCMBytes
		pcmLock.unlock()
		if full {
			Task { @MainActor in
				guard self.phase == .recording, self.mode == .server, let api = self.api else { return }
				await self.stopAndDeliver(api: api)
			}
		}
	}

	private func beginApple() async {
		guard await Self.speechAllowed() else {
			error = "Allow Microphone and Speech Recognition for LearnHarness in Settings to dictate."
			return
		}
		guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
			error = "Speech recognition isn't available right now."
			return
		}
		baseText = read?() ?? ""
		do {
			let session = AVAudioSession.sharedInstance()
			try session.setCategory(.record, mode: .measurement, options: .duckOthers)
			try session.setActive(true, options: .notifyOthersOnDeactivation)
			let request = SFSpeechAudioBufferRecognitionRequest()
			request.shouldReportPartialResults = true
			request.addsPunctuation = true
			if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
			appleRequest = request
			let input = audio.inputNode
			let format = input.outputFormat(forBus: 0)
			input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
				request.append(buffer)
			}
			tapInstalled = true
			audio.prepare()
			try audio.start()
			mode = .apple
			phase = .recording
			let gen = generation
			appleTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
				let text = result?.bestTranscription.formattedString
				let final = result?.isFinal ?? false
				Task { @MainActor in
					guard let self, gen == self.generation else { return }
					if let text { self.write?(Self.join(self.baseText, text)) }
					if final || error != nil { self.endApple() }
				}
			}
		} catch {
			teardown()
			self.error = "Couldn't start the microphone (\(error.localizedDescription))."
		}
	}

	private func stopAndDeliver(api: ServerAPI) async {
		guard !delivering else { return }
		if mode == .apple {
			// Let the recognizer deliver its last words. The callback ends the run.
			appleRequest?.endAudio()
			removeTapAndStop()
			appleTask?.finish()
			phase = .idle
			mode = .idle
			releaseWaiter()
			return
		}
		delivering = true
		let gen = generation
		let recorded = takePCM()
		teardown()
		guard !recorded.isEmpty else {
			phase = .idle
			mode = .idle
			delivering = false
			releaseWaiter()
			return
		}
		phase = .transcribing
		do {
			let language = await api.dictationLanguage()
			guard gen == generation else { delivering = false; return }
			let spoken = try await api.transcribe(pcm: recorded, language: language)
			guard gen == generation else { delivering = false; return }
			if let read, let write { write(Self.join(read(), spoken)) }
			error = nil
		} catch {
			guard gen == generation else { return }
			if let spoken = await Self.appleTranscribe(recorded), let read, let write {
				write(Self.join(read(), spoken))
				self.error = nil
			} else {
				self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
			}
		}
		guard gen == generation else { delivering = false; return }
		phase = .idle
		mode = .idle
		delivering = false
		releaseWaiter()
	}

	private func endApple() {
		teardown()
		phase = .idle
		mode = .idle
		releaseWaiter()
	}

	private func takePCM() -> Data {
		pcmLock.lock()
		let copy = pcm
		pcm = Data()
		pcmLock.unlock()
		return copy
	}

	private func removeTapAndStop() {
		if tapInstalled {
			audio.inputNode.removeTap(onBus: 0)
			tapInstalled = false
		}
		if audio.isRunning { audio.stop() }
	}

	private func teardown() {
		removeTapAndStop()
		converter = nil
		appleRequest?.endAudio()
		appleRequest = nil
		appleTask?.cancel()
		appleTask = nil
		try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
	}

	private func releaseWaiter() {
		waiter?.resume()
		waiter = nil
	}

	private static func micAllowed() async -> Bool {
		await AVAudioApplication.requestRecordPermission()
	}

	private static func speechAllowed() async -> Bool {
		let speech = await withCheckedContinuation { done in
			SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0 == .authorized) }
		}
		guard speech else { return false }
		return await micAllowed()
	}

	/// On-device transcription of a recording the server could not transcribe.
	private static func appleTranscribe(_ pcm: Data) async -> String? {
		guard await speechAllowed() else { return nil }
		guard pcm.count >= 2, let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else { return nil }
		guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
		      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(pcm.count / 2)) else { return nil }
		buffer.frameLength = buffer.frameCapacity
		pcm.withUnsafeBytes { raw in
			guard let source = raw.bindMemory(to: Int16.self).baseAddress, let dest = buffer.int16ChannelData?[0] else { return }
			dest.update(from: source, count: Int(buffer.frameLength))
		}
		let request = SFSpeechAudioBufferRecognitionRequest()
		request.shouldReportPartialResults = false
		request.addsPunctuation = true
		request.append(buffer)
		request.endAudio()
		return await withCheckedContinuation { cont in
			let gate = ResumeOnce()
			let task = recognizer.recognitionTask(with: request) { result, error in
				let done = result?.isFinal == true || error != nil
				guard done else { return }
				gate.resume(cont, result?.bestTranscription.formattedString)
			}
			Task {
				try? await Task.sleep(nanoseconds: 20_000_000_000)
				task.cancel()
				gate.resume(cont, nil)
			}
		}
	}
}

/// A small button at the side of a composer. One tap records, the next
/// stops and inserts the transcript.
struct DictationButton: View {
	@Binding var text: String
	let dictation: Dictation
	@Environment(AppModel.self) private var model

	var body: some View {
		Button {
			Task {
				await dictation.toggle(api: model.api, read: { text }, write: { text = $0 })
			}
		} label: {
			Group {
				if dictation.phase == .transcribing {
					ProgressView()
						.controlSize(.small)
				} else {
					Image(systemName: dictation.phase == .recording ? "stop.circle.fill" : "mic")
						.font(.system(size: 18, weight: .medium))
						.foregroundStyle(dictation.phase == .recording ? Theme.destructive : Theme.muted)
						.symbolEffect(.pulse, isActive: dictation.phase == .recording)
				}
			}
			.frame(width: 36, height: 36)
			.contentShape(Rectangle())
		}
		.disabled(dictation.phase == .transcribing)
		.accessibilityLabel(label)
	}

	private var label: String {
		switch dictation.phase {
		case .idle: "Dictate"
		case .recording: "Stop dictation"
		case .transcribing: "Transcribing"
		}
	}
}

/// Lets the speech callback and the timeout resume one continuation.
private final class ResumeOnce: @unchecked Sendable {
	private let lock = NSLock()
	private var done = false

	func resume(_ cont: CheckedContinuation<String?, Never>, _ value: String?) {
		lock.lock()
		let first = !done
		done = true
		lock.unlock()
		if first { cont.resume(returning: value) }
	}
}
