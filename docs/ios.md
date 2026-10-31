# iPhone app

`ios/` is a native SwiftUI app that connects to your self-hosted LearnHarness
server (see [self-hosting.md](self-hosting.md)). Like the desktop app, it
shows the server's own interface, so it can do everything the desktop app
does — teaching and practice sessions, the knowledge graph, notes import,
dictation — and everything stays in sync because it all lives on the server.

## What the app adds

- **Connect to Server** screen: type the address (e.g. `code.lab.lan:3000`);
  the app checks it really is a LearnHarness server before saving it, and
  warns before using plain `http://` outside a home network or Tailscale.
- **Stays signed in** for 30 days, like the desktop app.
- **⋯ menu** in the strip beside the home indicator: Reload, Change
  Server…, Sign Out (signs out this phone only).
- **Microphone** for dictation (asked the first time you dictate; granted
  to your server's pages only).
- Links to other sites open in Safari; exported files open the share sheet.
- A "Can't reach your server" screen with Try Again / Change Server when
  you're away from home without Tailscale.

## Install it on your iPhone

You need a Mac with Xcode and an Apple ID. No App Store or TestFlight needed.

1. Open `ios/LearnHarness.xcodeproj` in Xcode.
2. Select the **LearnHarness** target → **Signing & Capabilities** → set
   **Team** to your Apple ID (Xcode → Settings → Accounts to add it). If
   Xcode says the bundle ID is taken, change `com.ayaan7345.learnharness`
   to something unique.
3. Plug in your iPhone (or pick it over Wi-Fi), choose it as the run
   destination at the top of the window, and press **Run** (⌘R).
4. First time only, on the iPhone:
   - **Settings → Privacy & Security → Developer Mode** → on (restarts the phone).
   - **Settings → General → VPN & Device Management** → trust your developer certificate.
5. Open LearnHarness, enter `code.lab.lan:3000`, tap **Connect**, then sign
   in with the server password ([server-password.md](server-password.md)).
   Allow **Local Network** access when iOS asks.

With a free Apple ID the app stops opening after 7 days; press Run in
Xcode again to renew it. A paid Apple Developer account ($99/year) makes it
last a year and allows TestFlight.

## Using it away from home

`code.lab.lan` only resolves on your home network. To learn on the go,
install [Tailscale](https://tailscale.com) on the server and the iPhone,
then use **⋯ → Change Server…** with the server's Tailscale name
(e.g. `code.your-tailnet.ts.net:3000`).

## Development

```bash
brew install xcodegen
cd ios && xcodegen generate        # after editing project.yml
xcodebuild -project LearnHarness.xcodeproj -scheme LearnHarness \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

`project.yml` is the source of truth for the Xcode project; the generated
`LearnHarness.xcodeproj` is committed so you can open it without XcodeGen.
The app's address rules match the desktop app's
(`electron/remote-server.cjs`) and are covered by
`LearnHarnessTests/ServerAddressTests.swift`.
