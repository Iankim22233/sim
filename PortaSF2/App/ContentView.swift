import SwiftUI
import AVFoundation
import AudioToolbox
import CoreAudioKit
import AppKit

/// Standalone host: loads the PortaSF2 AUv3 component (once it and the container app have both
/// been built and run at least once, which registers the extension with the system), connects
/// it to the default output, and embeds the plugin's *actual* view — the same
/// AudioUnitViewController/SwiftUI view a DAW would show — so the whole plugin (SoundFont
/// picker, preset browser, portamento slider) can be tried out without needing a DAW at all.
@MainActor
final class TestHostViewModel: ObservableObject {
    @Published var statusMessage = "Not loaded yet — click Load Plug-in."
    @Published var portamentoSeconds: Double = 0
    @Published var pluginViewController: NSViewController?

    private let engine = AVAudioEngine()
    private var instrument: AVAudioUnitMIDIInstrument?

    func loadAndConnect() {
        AVAudioUnit.instantiate(with: PortaSF2Component.description, options: []) { [weak self] avAudioUnit, error in
            guard let self else { return }
            DispatchQueue.main.async {
                if let error {
                    self.statusMessage = "Failed to load: \(error.localizedDescription)"
                    return
                }
                guard let avAudioUnit, let midiInstrument = avAudioUnit as? AVAudioUnitMIDIInstrument else {
                    self.statusMessage = "Failed: component did not resolve to a MIDI instrument."
                    return
                }
                self.instrument = midiInstrument
                self.engine.attach(midiInstrument)
                self.engine.connect(midiInstrument, to: self.engine.mainMixerNode, format: nil)
                do {
                    try self.engine.start()
                    self.statusMessage = "Loaded. Use the plugin view below to pick a SoundFont and preset."
                } catch {
                    self.statusMessage = "Engine start failed: \(error.localizedDescription)"
                    return
                }

                midiInstrument.auAudioUnit.requestViewController { viewController in
                    DispatchQueue.main.async {
                        self.pluginViewController = viewController
                    }
                }
            }
        }
    }

    func playTestGlide() {
        guard let instrument else { return }
        instrument.startNote(60, withVelocity: 100, onChannel: 0) // C4
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            instrument.startNote(72, withVelocity: 100, onChannel: 0) // C5 — glides if portamento > 0
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.6) {
            instrument.stopNote(72, onChannel: 0)
            instrument.stopNote(60, onChannel: 0)
        }
    }
}

/// Bridges the plugin's AppKit/SwiftUI view controller (returned by requestViewController) into
/// this SwiftUI window.
private struct PluginViewContainer: NSViewControllerRepresentable {
    let viewController: NSViewController

    func makeNSViewController(context: Context) -> NSViewController { viewController }
    func updateNSViewController(_ nsViewController: NSViewController, context: Context) {}
}

struct ContentView: View {
    @StateObject private var host = TestHostViewModel()

    var body: some View {
        VStack(spacing: 16) {
            Text("PortaSF2 — Test Host")
                .font(.title2).bold()

            Text(host.statusMessage)
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 440)

            if host.pluginViewController == nil {
                Button("Load Plug-in") { host.loadAndConnect() }
            }

            if let vc = host.pluginViewController {
                PluginViewContainer(viewController: vc)
                    .frame(width: vc.preferredContentSize.width == 0 ? 460 : vc.preferredContentSize.width,
                           height: vc.preferredContentSize.height == 0 ? 420 : vc.preferredContentSize.height)

                Button("Play Test Glide (C4 → C5)") { host.playTestGlide() }
                    .help("Sends a note-on for C4, then C5 while C4 is still held — glides between them when the Portamento slider above is greater than 0.")
            }
        }
        .padding(20)
        .frame(minWidth: 500, minHeight: 460)
    }
}
