import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var statusLabel: NSTextField!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let content = NSStackView()
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 16
        content.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)

        let title = NSTextField(labelWithString: "Codelit computer lifecycle QA")
        title.font = .systemFont(ofSize: 20, weight: .semibold)

        let detail = NSTextField(wrappingLabelWithString: "Use only with the signed-candidate lifecycle runbook. This fixture has no network or file access.")
        detail.textColor = .secondaryLabelColor

        let quickButton = NSButton(title: "Complete quick action", target: self, action: #selector(completeQuickAction))
        quickButton.bezelStyle = .rounded
        quickButton.setAccessibilityLabel("Complete quick action")

        let heldButton = NSButton(title: "Hold action for 20 seconds", target: self, action: #selector(holdAction))
        heldButton.bezelStyle = .rounded
        heldButton.setAccessibilityLabel("Hold action for 20 seconds")

        statusLabel = NSTextField(labelWithString: "Ready")
        statusLabel.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        statusLabel.setAccessibilityLabel("Lifecycle fixture status")

        content.addArrangedSubview(title)
        content.addArrangedSubview(detail)
        content.addArrangedSubview(quickButton)
        content.addArrangedSubview(heldButton)
        content.addArrangedSubview(statusLabel)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 280),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Lifecycle QA"
        window.contentView = content
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    @objc private func completeQuickAction() {
        statusLabel.stringValue = "Quick action completed"
    }

    @objc private func holdAction() {
        statusLabel.stringValue = "Action in progress"
        window.displayIfNeeded()
        Thread.sleep(forTimeInterval: 20)
        statusLabel.stringValue = "Held action completed"
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
