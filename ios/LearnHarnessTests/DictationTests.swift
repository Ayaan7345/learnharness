import XCTest
@testable import LearnHarness

final class DictationTests: XCTestCase {
	@MainActor
	func testJoinKeepsWhatWasAlreadyTyped() {
		XCTAssertEqual(Dictation.join("", "IPv6"), "IPv6")
		XCTAssertEqual(Dictation.join("   ", "IPv6"), "IPv6")
		XCTAssertEqual(Dictation.join("The address is", "IPv6"), "The address is IPv6")
		XCTAssertEqual(Dictation.join("The address is  ", "  a /64  "), "The address is a /64")
		XCTAssertEqual(Dictation.join("kept", "   "), "kept")
	}
}