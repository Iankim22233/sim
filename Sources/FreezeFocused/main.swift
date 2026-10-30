import Cocoa
import Carbon.HIToolbox

// Menu-bar utility that makes the frontmost application LOOK frozen without
// truly halting it: it rapidly cycles the app's process tree between
// SIGSTOP and SIGCONT with a small duty cycle (e.g. 50ms running out of
// every 1000ms). Rendering/input effectively stalls, but background
// scripts/timers still get their sliver of CPU each cycle and keep firing.
// Toggle with the global hotkey (default: Control+Option+F) or the menu.

struct Intensity {
    let name: String
    let onMs: UInt32   // how long the process runs per cycle
    let offMs: UInt32  // how long the process is stopped per cycle
}

let intensityPresets: [Intensity] = [
    Intensity(name: "Light Lag",  onMs: 150, offMs: 150),  // ~50% duty
    Intensity(name: "Heavy Lag",  onMs: 60,  offMs: 340),  // ~15% duty
    Intensity(name: "Near-Freeze", onMs: 20, offMs: 980),  // ~2% duty
]

final class Throttler {
    private let lock = NSLock()
    private var running = false
    private var pids: [pid_t] = []
    private var onMs: UInt32 = 50
    private var offMs: UInt32 = 950

    func start(pids: [pid_t], intensity: Intensity) {
        lock.lock()
        self.pids = pids
        self.onMs = intensity.onMs
        self.offMs = intensity.offMs
        running = true
        lock.unlock()

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.runLoop()
        }
    }

    func updateIntensity(_ intensity: Intensity) {
        lock.lock()
        onMs = intensity.onMs
        offMs = intensity.offMs
        lock.unlock()
    }

    private func runLoop() {
        while true {
            lock.lock()
            guard running else { lock.unlock(); break }
            let currentPids = pids
            let on = onMs
            lock.unlock()

            for p in currentPids { kill(p, SIGCONT) }
            usleep(on * 1000)

            lock.lock()
            guard running else { lock.unlock(); break }
            let off = offMs
            lock.unlock()

            for p in currentPids { kill(p, SIGSTOP) }
            usleep(off * 1000)
        }
        lock.lock()
        let finalPids = pids
        lock.unlock()
        for p in finalPids { kill(p, SIGCONT) } // always leave it resumed
    }

    func stop() {
        lock.lock()
        running = false
        lock.unlock()
    }
}

struct LaggedApp {
    let name: String
    let throttler: Throttler
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var lagged: [pid_t: LaggedApp] = [:] // keyed by the app's main pid
    var hotKeyRef: EventHotKeyRef?
    var currentIntensity = intensityPresets[1] // Heavy Lag by default

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        setupStatusItem()
        registerHotKey()
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Never leave an app stuck lagging when we quit.
        for app in lagged.values { app.throttler.stop() }
    }

    // MARK: - UI

    func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "snowflake", accessibilityDescription: "Lag Focused App")
        }
        rebuildMenu()
    }

    func rebuildMenu() {
        let menu = NSMenu()

        let toggleItem = NSMenuItem(title: "Lag/Unlag Frontmost App", action: #selector(toggleAction), keyEquivalent: "f")
        toggleItem.keyEquivalentModifierMask = [.control, .option]
        toggleItem.target = self
        menu.addItem(toggleItem)

        menu.addItem(NSMenuItem.separator())
        let intensityHeader = NSMenuItem(title: "Intensity:", action: nil, keyEquivalent: "")
        intensityHeader.isEnabled = false
        menu.addItem(intensityHeader)
        for preset in intensityPresets {
            let item = NSMenuItem(title: "  \(preset.name)", action: #selector(selectIntensity(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = preset.name
            item.state = (preset.name == currentIntensity.name) ? .on : .off
            menu.addItem(item)
        }

        if !lagged.isEmpty {
            menu.addItem(NSMenuItem.separator())
            let header = NSMenuItem(title: "Lagging:", action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)
            for (pid, app) in lagged.sorted(by: { $0.value.name < $1.value.name }) {
                let item = NSMenuItem(title: "  Restore \(app.name)", action: #selector(restoreAction(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = pid
                menu.addItem(item)
            }
        }

        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

        statusItem.menu = menu
        statusItem.button?.title = lagged.isEmpty ? "" : " \(lagged.count)"
    }

    @objc func toggleAction() {
        toggleLagFrontmost()
    }

    @objc func restoreAction(_ sender: NSMenuItem) {
        guard let pid = sender.representedObject as? pid_t else { return }
        restore(pid: pid)
    }

    @objc func selectIntensity(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String,
              let preset = intensityPresets.first(where: { $0.name == name }) else { return }
        currentIntensity = preset
        for app in lagged.values { app.throttler.updateIntensity(preset) }
        rebuildMenu()
    }

    // MARK: - Lag logic

    func toggleLagFrontmost() {
        guard let app = NSWorkspace.shared.frontmostApplication else { return }
        let pid = app.processIdentifier
        if pid == ProcessInfo.processInfo.processIdentifier { return } // never lag ourselves

        if lagged[pid] != nil {
            restore(pid: pid)
        } else {
            let name = app.localizedName ?? "Unknown App"
            let pids = [pid] + descendantPIDs(of: pid)
            let throttler = Throttler()
            throttler.start(pids: pids, intensity: currentIntensity)
            lagged[pid] = LaggedApp(name: name, throttler: throttler)
            rebuildMenu()
        }
    }

    func restore(pid: pid_t) {
        guard let app = lagged[pid] else { return }
        app.throttler.stop()
        lagged.removeValue(forKey: pid)
        rebuildMenu()
    }

    // MARK: - Process tree helpers

    func childPIDs(of pid: pid_t) -> [pid_t] {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        task.arguments = ["-P", "\(pid)"]
        let outPipe = Pipe()
        task.standardOutput = outPipe
        task.standardError = Pipe()
        do {
            try task.run()
        } catch {
            return []
        }
        task.waitUntilExit()
        let data = outPipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return [] }
        return output.split(separator: "\n").compactMap { pid_t($0) }
    }

    func descendantPIDs(of pid: pid_t) -> [pid_t] {
        var result: [pid_t] = []
        var queue: [pid_t] = [pid]
        while !queue.isEmpty {
            let current = queue.removeFirst()
            let children = childPIDs(of: current)
            result.append(contentsOf: children)
            queue.append(contentsOf: children)
        }
        return result
    }

    // MARK: - Global hotkey (Control+Option+F)

    func registerHotKey() {
        let hotKeyID = EventHotKeyID(signature: OSType(0x46525A31), id: 1) // 'FRZ1'
        let modifiers: UInt32 = UInt32(controlKey | optionKey)
        let keyCode: UInt32 = UInt32(kVK_ANSI_F)

        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))

        InstallEventHandler(GetApplicationEventTarget(), { (_, event, _) -> OSStatus in
            var hkID = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hkID)
            if hkID.id == 1 {
                (NSApp.delegate as? AppDelegate)?.toggleLagFrontmost()
            }
            return noErr
        }, 1, &eventType, nil, nil)

        RegisterEventHotKey(keyCode, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
