import AVFoundation
import AudioToolbox
import CoreAudioKit

/// Keys used in `fullState` for the plugin's non-AUParameter state (which soundfont/preset is
/// loaded). Stored as a security-scoped bookmark so the sandboxed extension can re-open a file
/// the user picked, across app/host relaunches, without needing an App Group.
private enum StateKey {
    static let soundFontBookmark = "sf2BookmarkData"
    static let soundFontSystemPath = "sf2SystemPath"
    static let soundFontDisplayName = "sf2DisplayName"
    static let presetProgram = "sf2PresetProgram"
    static let presetBankMSB = "sf2PresetBankMSB"
    static let presetBankLSB = "sf2PresetBankLSB"
    static let presetDisplayName = "sf2PresetDisplayName"
}

/// The plugin's AUAudioUnit. Rendering is delegated to an internal AVAudioUnitSampler (which
/// natively loads SF2/DLS banks) hosted inside a private AVAudioEngine running in "manual
/// rendering" mode — the standard, Apple-documented way to embed a full AVAudioEngine node
/// graph inside a v3 Audio Unit's own render block. On top of that, this class implements a
/// monophonic legato-glide portamento: when the portamento slider is above 0 and a new note
/// arrives while another is still held, the currently-sounding sample voice is pitch-bent to
/// the new note over the configured time instead of retriggering — the same technique
/// hardware/software mono synths use for glide. With portamento at 0 the instrument plays
/// normally and polyphonically.
public final class PortaSF2AudioUnit: AUAudioUnit {

    // MARK: Internal render graph

    private let engine = AVAudioEngine()
    private let sampler = AVAudioUnitSampler()
    private let reverb = AVAudioUnitReverb()

    private var outputBus: AUAudioUnitBus!
    private var _outputBusses: AUAudioUnitBusArray!
    private var _inputBusses: AUAudioUnitBusArray!

    // MARK: Parameters

    private var _parameterTree: AUParameterTree!
    private var masterVolumeParam: AUParameter!
    private var effectsEnabledParam: AUParameter!
    private var midiChannelParam: AUParameter!
    private var portamentoTimeParam: AUParameter!
    private var sustainAmountParam: AUParameter!

    /// Plain caches of the current parameter values, written only from `implementorValueObserver`
    /// (called on an arbitrary non-realtime thread) and read from the render thread. Scalar
    /// reads/writes of Double/Bool are effectively atomic on arm64/x86_64, which is the same
    /// assumption Apple's own AU sample code relies on for simple, infrequently-changing
    /// parameters like these — avoiding a lock on the render thread is the priority here.
    private var cachedPortamentoSeconds: Double = 0
    private var cachedMIDIChannelFilter: UInt8? = nil // nil == omni (not used by default UI, but supported)
    private var cachedEffectsEnabled: Bool = true
    private var cachedSustainPercent: Double = 20
    private var currentSampleRate: Double = 44100

    // MARK: SoundFont / preset state (non-realtime; touched from UI + fullState only)

    private(set) var soundFontURL: URL?
    private(set) var soundFontDisplayName: String = "No soundfont selected."
    private(set) var availablePresets: [SF2Preset] = []
    private(set) var currentSF2Preset: SF2Preset?
    private var soundFontBookmark: Data?
    private var soundFontSystemPath: String?
    private let loadQueue = DispatchQueue(label: "com.local.portasf2.load", qos: .userInitiated)

    /// Standard macOS locations for SoundFont/DLS banks: the system-wide folder (root-owned;
    /// rarely populated unless an admin dropped files there) and the per-user one under the
    /// caller's home directory, which is where most installers and users actually put things.
    /// Reading either needs a temporary-exception entitlement since App Sandbox otherwise only
    /// allows files the user explicitly picked via an open panel.
    static let systemBankDirectories: [URL] = [
        URL(fileURLWithPath: "/Library/Audio/Sounds/Banks", isDirectory: true),
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Audio/Sounds/Banks", isDirectory: true)
    ]

    /// Called on the main thread whenever soundfont/preset state changes, so the SwiftUI view can refresh.
    var stateDidChange: (() -> Void)?

    // MARK: Mono-glide (portamento) state — render-thread only, never touched from any other thread.

    private var heldNotes: [UInt8] = []       // physically-held notes, most-recent last
    private var soundingNote: UInt8?          // MIDI note number of the currently-triggered sample voice
    private var soundingVelocity: UInt8 = 100
    private var currentBendSemitones: Double = 0
    private var glideStartSemitones: Double = 0
    private var glideTargetSemitones: Double = 0
    private var glideElapsedSamples: Double = 0
    private var glideTotalSamples: Double = 0
    private var glideInProgress = false
    private static let pitchBendRangeSemitones: Double = 24

    // Notes currently sounding in plain polyphonic (portamento-off) mode.
    private var polyActiveNotes: Set<UInt8> = []

    // MARK: Init

    public override init(componentDescription: AudioComponentDescription,
                          options: AudioComponentInstantiationOptions = []) throws {
        try super.init(componentDescription: componentDescription, options: options)

        engine.attach(sampler)
        engine.attach(reverb)
        engine.connect(sampler, to: reverb, format: nil)
        engine.connect(reverb, to: engine.mainMixerNode, format: nil)
        // Reverb preset/wetDryMix are set from applyParameterValue instead of here: writes made
        // before the engine has actually started don't reliably stick (see allocateRenderResources).

        let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2)!
        outputBus = try AUAudioUnitBus(format: format)
        _outputBusses = AUAudioUnitBusArray(audioUnit: self, busType: .output, busses: [outputBus])
        _inputBusses = AUAudioUnitBusArray(audioUnit: self, busType: .input)

        try setupParameterTree()
        maximumFramesToRender = 512
    }

    // MARK: Bus arrays

    public override var outputBusses: AUAudioUnitBusArray { _outputBusses }
    public override var inputBusses: AUAudioUnitBusArray { _inputBusses }

    public override var channelCapabilities: [NSNumber]? { [0, 2] } // no audio input; stereo output only

    // MARK: Parameters

    private func setupParameterTree() throws {
        let masterVolume = AUParameterTree.createParameter(
            withIdentifier: "masterVolume", name: "Master Volume",
            address: PortaSF2Param.masterVolume.rawValue,
            min: -80, max: 6, unit: .decibels, unitName: nil,
            flags: [.flag_IsReadable, .flag_IsWritable],
            valueStrings: nil, dependentParameters: nil)
        masterVolume.value = -6

        let effectsEnabled = AUParameterTree.createParameter(
            withIdentifier: "effectsEnabled", name: "Effects",
            address: PortaSF2Param.effectsEnabled.rawValue,
            min: 0, max: 1, unit: .boolean, unitName: nil,
            flags: [.flag_IsReadable, .flag_IsWritable],
            valueStrings: nil, dependentParameters: nil)
        effectsEnabled.value = 1

        let midiChannel = AUParameterTree.createParameter(
            withIdentifier: "midiChannel", name: "MIDI Channel",
            address: PortaSF2Param.midiChannel.rawValue,
            min: 1, max: 16, unit: .indexed, unitName: nil,
            flags: [.flag_IsReadable, .flag_IsWritable],
            valueStrings: nil, dependentParameters: nil)
        midiChannel.value = 1

        let portamentoTime = AUParameterTree.createParameter(
            withIdentifier: "portamentoTime", name: "Portamento",
            address: PortaSF2Param.portamentoTime.rawValue,
            min: 0, max: 3, unit: .seconds, unitName: nil,
            flags: [.flag_IsReadable, .flag_IsWritable],
            valueStrings: nil, dependentParameters: nil)
        portamentoTime.value = 0

        let sustainAmount = AUParameterTree.createParameter(
            withIdentifier: "sustainAmount", name: "Sustain",
            address: PortaSF2Param.sustainAmount.rawValue,
            min: 0, max: 100, unit: .percent, unitName: nil,
            flags: [.flag_IsReadable, .flag_IsWritable],
            valueStrings: nil, dependentParameters: nil)
        sustainAmount.value = 20

        self.masterVolumeParam = masterVolume
        self.effectsEnabledParam = effectsEnabled
        self.midiChannelParam = midiChannel
        self.portamentoTimeParam = portamentoTime
        self.sustainAmountParam = sustainAmount

        _parameterTree = AUParameterTree.createTree(withChildren: [masterVolume, effectsEnabled, midiChannel, portamentoTime, sustainAmount])

        _parameterTree.implementorValueObserver = { [weak self] param, value in
            self?.applyParameterValue(address: param.address, value: value)
        }
        _parameterTree.implementorValueProvider = { [weak self] param in
            self?.currentParameterValue(address: param.address) ?? param.value
        }
        _parameterTree.implementorStringFromValueCallback = { param, valuePtr in
            let v = valuePtr?.pointee ?? param.value
            switch PortaSF2Param(rawValue: param.address) {
            case .masterVolume: return String(format: "%.1f dB", v)
            case .effectsEnabled: return v >= 0.5 ? "On" : "Off"
            case .midiChannel: return String(Int(v))
            case .portamentoTime: return String(format: "%.0f ms", v * 1000)
            case .sustainAmount: return String(format: "%.0f%%", v)
            case .none: return "\(v)"
            }
        }

        // Apply once so the sampler/reverb reflect the defaults set above.
        applyParameterValue(address: PortaSF2Param.masterVolume.rawValue, value: masterVolume.value)
        applyParameterValue(address: PortaSF2Param.effectsEnabled.rawValue, value: effectsEnabled.value)
        applyParameterValue(address: PortaSF2Param.midiChannel.rawValue, value: midiChannel.value)
        applyParameterValue(address: PortaSF2Param.portamentoTime.rawValue, value: portamentoTime.value)
        applyParameterValue(address: PortaSF2Param.sustainAmount.rawValue, value: sustainAmount.value)
    }

    public override var parameterTree: AUParameterTree? {
        get { _parameterTree }
        set { /* not supported */ }
    }

    private func applyParameterValue(address: AUParameterAddress, value: AUValue) {
        guard let param = PortaSF2Param(rawValue: address) else { return }
        switch param {
        case .masterVolume:
            sampler.overallGain = value
        case .effectsEnabled:
            cachedEffectsEnabled = value >= 0.5
            updateReverbForCurrentSettings()
        case .midiChannel:
            cachedMIDIChannelFilter = UInt8(max(1, min(16, value))) - 1
        case .portamentoTime:
            let seconds = Double(max(0, min(3, value)))
            cachedPortamentoSeconds = seconds
            if seconds <= 0.0005 {
                // Portamento just got switched off (or was already off): make sure we aren't
                // left holding a bent note from mono-glide mode.
                resetGlideVoiceIfNeeded()
            }
        case .sustainAmount:
            cachedSustainPercent = Double(max(0, min(100, value)))
            updateReverbForCurrentSettings()
        }
    }

    private func currentParameterValue(address: AUParameterAddress) -> AUValue? {
        guard let param = PortaSF2Param(rawValue: address) else { return nil }
        switch param {
        case .masterVolume: return sampler.overallGain
        case .effectsEnabled: return cachedEffectsEnabled ? 1 : 0
        case .midiChannel: return AUValue((cachedMIDIChannelFilter ?? 0)) + 1
        case .portamentoTime: return AUValue(cachedPortamentoSeconds)
        case .sustainAmount: return AUValue(cachedSustainPercent)
        }
    }

    /// "Sustain" doesn't just scale the reverb's wet level — `AVAudioUnitReverb`'s wet/dry mix
    /// barely changes how long the tail actually rings (confirmed by offline-rendering a note
    /// and measuring decay time across wet% values: 5% and 30% wet came out within ~0.3s of each
    /// other). What actually changes the tail *length* is which factory preset is loaded — those
    /// differ enormously in measured decay time, from ~0.2s (smallRoom) to ~7s (cathedral). So the
    /// knob steps through presets by tier, and uses wet% mainly for the loudness of that tail.
    private func updateReverbForCurrentSettings() {
        reverb.bypass = !cachedEffectsEnabled
        guard cachedEffectsEnabled, cachedSustainPercent > 0.5 else {
            reverb.wetDryMix = 0
            return
        }
        reverb.loadFactoryPreset(Self.reverbPreset(forSustainPercent: cachedSustainPercent))
        reverb.wetDryMix = Float(cachedSustainPercent)
    }

    private static func reverbPreset(forSustainPercent pct: Double) -> AVAudioUnitReverbPreset {
        switch pct {
        case ..<20: return .smallRoom      // measured tail ≈ 0.2s
        case ..<40: return .mediumRoom     // ≈ 0.5s
        case ..<60: return .largeRoom      // ≈ 2.4s
        case ..<80: return .mediumHall     // ≈ 2.9s
        default: return .cathedral         // ≈ 7.1s
        }
    }

    // MARK: Render resource lifecycle

    public override func allocateRenderResources() throws {
        try super.allocateRenderResources()
        currentSampleRate = outputBus.format.sampleRate

        do {
            try engine.enableManualRenderingMode(.realtime, format: outputBus.format,
                                                  maximumFrameCount: maximumFramesToRender)
        } catch {
            throw error
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            throw error
        }

        configureWidePitchBendRange()

        // AVAudioUnitSampler/AVAudioUnitReverb property writes made before the engine has
        // actually started can silently fail to stick (the underlying v2 AU's state isn't
        // guaranteed live until here), so re-push the authoritative AUParameter values — not
        // whatever the sampler/reverb currently report, which is exactly what may have reset —
        // now that rendering is actually up.
        applyParameterValue(address: PortaSF2Param.masterVolume.rawValue, value: masterVolumeParam.value)
        applyParameterValue(address: PortaSF2Param.effectsEnabled.rawValue, value: effectsEnabledParam.value)
        applyParameterValue(address: PortaSF2Param.midiChannel.rawValue, value: midiChannelParam.value)
        applyParameterValue(address: PortaSF2Param.portamentoTime.rawValue, value: portamentoTimeParam.value)
        applyParameterValue(address: PortaSF2Param.sustainAmount.rawValue, value: sustainAmountParam.value)
    }

    public override func deallocateRenderResources() {
        engine.stop()
        engine.disableManualRenderingMode()
        super.deallocateRenderResources()
    }

    /// SF2 presets can span many semitones between notes a user might glide across, so widen the
    /// sampler's pitch-bend range from the MIDI default of ±2 semitones via the standard RPN 0,0
    /// (pitch bend sensitivity) message, sent on every channel we might play on.
    private func configureWidePitchBendRange() {
        for channel: UInt8 in 0 ..< 16 {
            sampler.sendController(101, withValue: 0, onChannel: channel) // RPN MSB
            sampler.sendController(100, withValue: 0, onChannel: channel) // RPN LSB (0,0 = pitch bend range)
            sampler.sendController(6, withValue: UInt8(Self.pitchBendRangeSemitones), onChannel: channel) // data entry MSB: semitones
            sampler.sendController(38, withValue: 0, onChannel: channel) // data entry LSB: cents
            sampler.sendController(101, withValue: 127, onChannel: channel) // deselect RPN
            sampler.sendController(100, withValue: 127, onChannel: channel)
        }
    }

    // MARK: Render block

    public override var internalRenderBlock: AUInternalRenderBlock {
        return { [weak self] actionFlags, timestamp, frameCount, outputBusNumber, outputData, realtimeEventListHead, pullInputBlock in
            guard let self = self else { return kAudioUnitErr_NoConnection }

            var event = realtimeEventListHead
            while let e = event {
                if e.pointee.head.eventType == .MIDI {
                    self.handleMIDIEvent(e.pointee.MIDI)
                }
                event = UnsafePointer(e.pointee.head.next)
            }

            self.advancePortamento(frameCount: Int(frameCount))

            let status = self.engine.manualRenderingBlock(frameCount, outputData, nil)
            if status != .success {
                return kAudioUnitErr_CannotDoInCurrentContext
            }
            return noErr
        }
    }

    // MARK: MIDI handling

    private func handleMIDIEvent(_ midi: AUMIDIEvent) {
        guard midi.length >= 1 else { return }
        let status = midi.data.0 & 0xF0
        let channel = midi.data.0 & 0x0F

        if let filter = cachedMIDIChannelFilter, channel != filter {
            return
        }

        switch status {
        case 0x90 where midi.length >= 3: // note on
            let note = midi.data.1
            let velocity = midi.data.2
            if velocity == 0 {
                noteOff(note)
            } else {
                noteOn(note, velocity: velocity, channel: channel)
            }
        case 0x80 where midi.length >= 3: // note off
            noteOff(midi.data.1)
        case 0xE0: // pitch bend — only forward when we're not driving bend ourselves for glide
            if cachedPortamentoSeconds <= 0.0005, midi.length >= 3 {
                let bend = UInt16(midi.data.1) | (UInt16(midi.data.2) << 7)
                sampler.sendPitchBend(bend, onChannel: channel)
            }
        case 0xC0: // program change: preset selection is owned by the plugin's own UI
            break
        default:
            if midi.length == 3 {
                sampler.sendMIDIEvent(midi.data.0, data1: midi.data.1, data2: midi.data.2)
            } else if midi.length == 2 {
                sampler.sendMIDIEvent(midi.data.0, data1: midi.data.1)
            }
        }
    }

    private func noteOn(_ note: UInt8, velocity: UInt8, channel: UInt8) {
        guard cachedPortamentoSeconds > 0.0005 else {
            sampler.startNote(note, withVelocity: velocity, onChannel: channel)
            polyActiveNotes.insert(note)
            return
        }

        heldNotes.removeAll { $0 == note }
        heldNotes.append(note)

        if soundingNote == nil {
            soundingNote = note
            soundingVelocity = velocity
            currentBendSemitones = 0
            glideInProgress = false
            sendPitchBend(0)
            sampler.startNote(note, withVelocity: velocity, onChannel: channel)
        } else {
            beginGlide(to: note)
        }
    }

    private func noteOff(_ note: UInt8) {
        if polyActiveNotes.contains(note) {
            sampler.stopNote(note, onChannel: cachedMIDIChannelFilter ?? 0)
            polyActiveNotes.remove(note)
        }

        guard cachedPortamentoSeconds > 0.0005 || soundingNote != nil else { return }

        heldNotes.removeAll { $0 == note }

        guard let sounding = soundingNote else { return }

        if let stillHeld = heldNotes.last {
            beginGlide(to: stillHeld)
        } else {
            sampler.stopNote(sounding, onChannel: cachedMIDIChannelFilter ?? 0)
            soundingNote = nil
            glideInProgress = false
            currentBendSemitones = 0
            sendPitchBend(0)
        }
    }

    private func beginGlide(to note: UInt8) {
        guard let sounding = soundingNote else { return }
        glideStartSemitones = currentBendSemitones
        glideTargetSemitones = Double(note) - Double(sounding)
        glideTotalSamples = max(1, cachedPortamentoSeconds * currentSampleRate)
        glideElapsedSamples = 0
        glideInProgress = true
    }

    private func advancePortamento(frameCount: Int) {
        guard glideInProgress else { return }
        glideElapsedSamples += Double(frameCount)
        let t = min(1, glideElapsedSamples / glideTotalSamples)
        currentBendSemitones = glideStartSemitones + (glideTargetSemitones - glideStartSemitones) * t
        sendPitchBend(currentBendSemitones)
        if t >= 1 {
            glideInProgress = false
        }
    }

    private func sendPitchBend(_ semitoneOffset: Double) {
        let clamped = max(-Self.pitchBendRangeSemitones, min(Self.pitchBendRangeSemitones, semitoneOffset))
        let normalized = clamped / Self.pitchBendRangeSemitones
        let value = Int((8192 + normalized * 8191).rounded())
        let bend = UInt16(max(0, min(16383, value)))
        sampler.sendPitchBend(bend, onChannel: cachedMIDIChannelFilter ?? 0)
    }

    /// Called when portamento is switched off (or on init) to make sure no sample voice is left
    /// bent away from its natural pitch, and that mono-glide bookkeeping starts clean.
    private func resetGlideVoiceIfNeeded() {
        if let sounding = soundingNote {
            sampler.stopNote(sounding, onChannel: cachedMIDIChannelFilter ?? 0)
        }
        soundingNote = nil
        heldNotes.removeAll()
        glideInProgress = false
        currentBendSemitones = 0
        sendPitchBend(0)
    }

    // MARK: SoundFont loading (never called on the render thread)

    /// SoundFont files found under `systemBankDirectories`, so the UI can offer them directly
    /// instead of requiring the user to browse for a file every time.
    func discoverSystemSoundFonts() -> [URL] {
        let fm = FileManager.default
        var results: [URL] = []
        for dir in Self.systemBankDirectories {
            guard let enumerator = fm.enumerator(at: dir, includingPropertiesForKeys: [.isRegularFileKey],
                                                  options: [.skipsHiddenFiles]) else { continue }
            for case let url as URL in enumerator where url.pathExtension.lowercased() == "sf2" {
                results.append(url)
            }
        }
        return results.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
    }

    private func isSystemBankURL(_ url: URL) -> Bool {
        let path = url.resolvingSymlinksInPath().path
        return Self.systemBankDirectories.contains { path.hasPrefix($0.path) }
    }

    func loadSoundFont(at url: URL, completion: @escaping (Result<Void, Error>) -> Void) {
        loadQueue.async { [weak self] in
            guard let self = self else { return }
            let isSystemURL = self.isSystemBankURL(url)
            do {
                // No-op (returns false) for URLs that aren't security-scoped, e.g. the ones we
                // read via the temporary-exception entitlement below — safe to call unconditionally.
                let didStart = url.startAccessingSecurityScopedResource()
                defer { if didStart { url.stopAccessingSecurityScopedResource() } }

                let presets = try SF2Parser.readPresets(at: url)
                guard let first = presets.first else {
                    throw NSError(domain: "PortaSF2", code: 1,
                                   userInfo: [NSLocalizedDescriptionKey: "No presets found in this SoundFont."])
                }

                try self.sampler.loadSoundBankInstrument(at: url, program: first.program,
                                                          bankMSB: first.bankMSB, bankLSB: first.bankLSB)

                // System bank files are reachable every time via the temporary-exception
                // entitlement, so just remember their path; a security-scoped bookmark is only
                // needed (and only resolvable) for files the user picked via the open panel.
                let bookmark: Data? = isSystemURL ? nil : try? url.bookmarkData(
                    options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)

                DispatchQueue.main.async {
                    self.soundFontURL = url
                    self.soundFontDisplayName = url.lastPathComponent
                    self.availablePresets = presets
                    self.currentSF2Preset = first
                    self.soundFontBookmark = bookmark
                    self.soundFontSystemPath = isSystemURL ? url.path : nil
                    self.stateDidChange?()
                    completion(.success(()))
                }
            } catch {
                DispatchQueue.main.async { completion(.failure(error)) }
            }
        }
    }

    func selectPreset(_ preset: SF2Preset, completion: @escaping (Result<Void, Error>) -> Void) {
        loadQueue.async { [weak self] in
            guard let self = self, let url = self.soundFontURL else { return }
            do {
                let didStart = url.startAccessingSecurityScopedResource()
                defer { if didStart { url.stopAccessingSecurityScopedResource() } }
                try self.sampler.loadSoundBankInstrument(at: url, program: preset.program,
                                                          bankMSB: preset.bankMSB, bankLSB: preset.bankLSB)
                DispatchQueue.main.async {
                    self.currentSF2Preset = preset
                    self.stateDidChange?()
                    completion(.success(()))
                }
            } catch {
                DispatchQueue.main.async { completion(.failure(error)) }
            }
        }
    }

    private func reloadFromBookmark(_ bookmark: Data) {
        loadQueue.async { [weak self] in
            guard let self = self else { return }
            var isStale = false
            guard let url = try? URL(resolvingBookmarkData: bookmark, options: .withSecurityScope,
                                      relativeTo: nil, bookmarkDataIsStale: &isStale) else { return }
            let didStart = url.startAccessingSecurityScopedResource()
            defer { if didStart { url.stopAccessingSecurityScopedResource() } }

            guard let presets = try? SF2Parser.readPresets(at: url) else { return }

            DispatchQueue.main.async {
                self.soundFontURL = url
                self.soundFontDisplayName = url.lastPathComponent
                self.availablePresets = presets
                self.soundFontBookmark = bookmark
                self.soundFontSystemPath = nil
                self.stateDidChange?()
            }
        }
    }

    private func reloadFromSystemPath(_ path: String) {
        loadQueue.async { [weak self] in
            guard let self = self else { return }
            let url = URL(fileURLWithPath: path)
            guard let presets = try? SF2Parser.readPresets(at: url) else { return }

            DispatchQueue.main.async {
                self.soundFontURL = url
                self.soundFontDisplayName = url.lastPathComponent
                self.availablePresets = presets
                self.soundFontSystemPath = path
                self.soundFontBookmark = nil
                self.stateDidChange?()
            }
        }
    }

    // MARK: Persisted (non-AUParameter) state

    public override var fullState: [String: Any]? {
        get {
            var state = super.fullState ?? [:]
            if let path = soundFontSystemPath {
                state[StateKey.soundFontSystemPath] = path
            } else if let bookmark = soundFontBookmark {
                state[StateKey.soundFontBookmark] = bookmark
            }
            state[StateKey.soundFontDisplayName] = soundFontDisplayName
            if let preset = currentSF2Preset {
                state[StateKey.presetProgram] = Int(preset.program)
                state[StateKey.presetBankMSB] = Int(preset.bankMSB)
                state[StateKey.presetBankLSB] = Int(preset.bankLSB)
                state[StateKey.presetDisplayName] = preset.name
            }
            return state
        }
        set {
            super.fullState = newValue
            guard let newValue else { return }
            if let path = newValue[StateKey.soundFontSystemPath] as? String {
                reloadFromSystemPath(path)
            } else if let bookmark = newValue[StateKey.soundFontBookmark] as? Data {
                reloadFromBookmark(bookmark)
            }
        }
    }
}
