import AVFoundation
import AudioToolbox
import Combine
#if os(macOS)
import AppKit
#endif

/// Bridges the SwiftUI plugin view to the AUAudioUnit: mirrors AUParameter values for display
/// and forwards UI edits back to the parameter tree / soundfont-loading methods.
final class PluginViewModel: ObservableObject {

    @Published var masterVolumeDB: Double = -6
    @Published var effectsOn: Bool = true
    @Published var midiChannel: Int = 1
    @Published var portamentoSeconds: Double = 0
    @Published var sustainPercent: Double = 20

    @Published var soundFontName: String = "No soundfont selected."
    @Published var systemSoundFonts: [URL] = []
    @Published var presets: [SF2Preset] = []
    @Published var currentPreset: SF2Preset?
    @Published var isLoading: Bool = false
    @Published var errorMessage: String?

    private let audioUnit: PortaSF2AudioUnit
    private var observerToken: AUParameterObserverToken?

    init(audioUnit: PortaSF2AudioUnit) {
        self.audioUnit = audioUnit

        refreshFromAudioUnit()
        refreshSystemSoundFonts()

        audioUnit.stateDidChange = { [weak self] in
            self?.refreshFromAudioUnit()
        }

        if let tree = audioUnit.parameterTree {
            observerToken = tree.token(byAddingParameterObserver: { [weak self] address, value in
                DispatchQueue.main.async {
                    self?.applyExternalParameterChange(address: address, value: value)
                }
            })
        }
    }

    deinit {
        if let token = observerToken {
            audioUnit.parameterTree?.removeParameterObserver(token)
        }
    }

    private func refreshFromAudioUnit() {
        soundFontName = audioUnit.soundFontDisplayName
        presets = audioUnit.availablePresets
        currentPreset = audioUnit.currentSF2Preset
    }

    private func applyExternalParameterChange(address: AUParameterAddress, value: AUValue) {
        switch PortaSF2Param(rawValue: address) {
        case .masterVolume: masterVolumeDB = Double(value)
        case .effectsEnabled: effectsOn = value >= 0.5
        case .midiChannel: midiChannel = Int(value)
        case .portamentoTime: portamentoSeconds = Double(value)
        case .sustainAmount: sustainPercent = Double(value)
        case .none: break
        }
    }

    // MARK: UI -> parameter writes

    func setMasterVolume(_ db: Double) {
        masterVolumeDB = db
        audioUnit.parameterTree?.parameter(withAddress: PortaSF2Param.masterVolume.rawValue)?.value = AUValue(db)
    }

    func setEffectsOn(_ on: Bool) {
        effectsOn = on
        audioUnit.parameterTree?.parameter(withAddress: PortaSF2Param.effectsEnabled.rawValue)?.value = on ? 1 : 0
    }

    func setMIDIChannel(_ channel: Int) {
        midiChannel = channel
        audioUnit.parameterTree?.parameter(withAddress: PortaSF2Param.midiChannel.rawValue)?.value = AUValue(channel)
    }

    func setPortamentoSeconds(_ seconds: Double) {
        portamentoSeconds = seconds
        audioUnit.parameterTree?.parameter(withAddress: PortaSF2Param.portamentoTime.rawValue)?.value = AUValue(seconds)
    }

    func setSustainPercent(_ percent: Double) {
        sustainPercent = percent
        audioUnit.parameterTree?.parameter(withAddress: PortaSF2Param.sustainAmount.rawValue)?.value = AUValue(percent)
    }

    // MARK: SoundFont / preset selection

    func chooseSoundFont() {
        #if os(macOS)
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.init(filenameExtension: "sf2")!]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.message = "Choose a SoundFont (.sf2) file"
        panel.begin { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.load(url: url)
        }
        #endif
    }

    /// Re-scans /Library/Audio/Sounds/Banks/ in case files were added or removed since launch.
    func refreshSystemSoundFonts() {
        systemSoundFonts = audioUnit.discoverSystemSoundFonts()
    }

    func load(url: URL) {
        isLoading = true
        errorMessage = nil
        audioUnit.loadSoundFont(at: url) { [weak self] result in
            self?.isLoading = false
            switch result {
            case .success: break
            case .failure(let error): self?.errorMessage = error.localizedDescription
            }
        }
    }

    func selectPreset(_ preset: SF2Preset) {
        isLoading = true
        errorMessage = nil
        audioUnit.selectPreset(preset) { [weak self] result in
            self?.isLoading = false
            switch result {
            case .success: break
            case .failure(let error): self?.errorMessage = error.localizedDescription
            }
        }
    }

    func stepPreset(by delta: Int) {
        guard !presets.isEmpty, let current = currentPreset,
              let index = presets.firstIndex(of: current) else { return }
        let newIndex = (index + delta + presets.count) % presets.count
        selectPreset(presets[newIndex])
    }
}
