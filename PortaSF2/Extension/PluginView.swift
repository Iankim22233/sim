import SwiftUI

private enum Theme {
    static let background = Color(red: 0.11, green: 0.12, blue: 0.14)
    static let panel = Color(red: 0.16, green: 0.17, blue: 0.20)
    static let text = Color(white: 0.92)
    static let subtext = Color(white: 0.6)
    static let accent = Color(red: 0.35, green: 0.85, blue: 0.55)
}

struct PluginRootView: View {
    @ObservedObject var viewModel: PluginViewModel

    var body: some View {
        VStack(spacing: 16) {
            Text("PortaSF2")
                .font(.system(size: 18, weight: .semibold))
                .foregroundColor(Theme.text)

            soundFontRow
            presetRow

            HStack(spacing: 24) {
                labeledStack("MIDI Channel") {
                    Picker("", selection: Binding(
                        get: { viewModel.midiChannel },
                        set: { viewModel.setMIDIChannel($0) }
                    )) {
                        ForEach(1...16, id: \.self) { ch in
                            Text("\(ch)").tag(ch)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 60)
                }

                labeledStack("Effects") {
                    Button {
                        viewModel.setEffectsOn(!viewModel.effectsOn)
                    } label: {
                        Image(systemName: "power")
                            .foregroundColor(viewModel.effectsOn ? Theme.accent : Theme.subtext)
                            .font(.system(size: 18, weight: .bold))
                    }
                    .buttonStyle(.plain)
                }

                labeledStack("Master Volume") {
                    Text(String(format: "%.1f dB", viewModel.masterVolumeDB))
                        .foregroundColor(Theme.text)
                        .font(.system(size: 13, design: .monospaced))
                        .frame(width: 90, height: 24)
                        .background(RoundedRectangle(cornerRadius: 4).stroke(Theme.subtext.opacity(0.5)))
                }
            }

            Slider(
                value: Binding(get: { viewModel.masterVolumeDB }, set: { viewModel.setMasterVolume($0) }),
                in: -80...6
            )

            portamentoRow
            sustainRow

            if viewModel.isLoading {
                ProgressView().scaleEffect(0.6)
            }
            if let error = viewModel.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.red)
                    .lineLimit(2)
            }

            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(minWidth: 440, minHeight: 440)
        .background(Theme.background)
    }

    private var soundFontRow: some View {
        HStack(spacing: 8) {
            Menu {
                if viewModel.systemSoundFonts.isEmpty {
                    Text("No SoundFonts found in /Library/Audio/Sounds/Banks/")
                } else {
                    ForEach(viewModel.systemSoundFonts, id: \.self) { url in
                        Button(url.deletingPathExtension().lastPathComponent) {
                            viewModel.load(url: url)
                        }
                    }
                }
                Divider()
                Button("Browse for File…") { viewModel.chooseSoundFont() }
            } label: {
                HStack {
                    Text(viewModel.soundFontName)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(Theme.subtext)
                }
                .foregroundColor(Theme.text)
                .padding(.horizontal, 10)
                .frame(height: 30)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.panel))
            }
            .menuStyle(.borderlessButton)
            .frame(maxWidth: .infinity)

            Button { viewModel.refreshSystemSoundFonts() } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.plain)
            .foregroundColor(Theme.text)
            .help("Rescan /Library/Audio/Sounds/Banks/ for SoundFonts")

            Button { viewModel.chooseSoundFont() } label: {
                Image(systemName: "folder")
            }
            .buttonStyle(.plain)
            .foregroundColor(Theme.text)
            .help("Browse for a SoundFont file")
        }
    }

    private var presetRow: some View {
        HStack(spacing: 8) {
            Menu {
                if viewModel.presets.isEmpty {
                    Text("Load a SoundFont first")
                } else {
                    ForEach(viewModel.presets) { preset in
                        Button {
                            viewModel.selectPreset(preset)
                        } label: {
                            if preset == viewModel.currentPreset {
                                Label(preset.name, systemImage: "checkmark")
                            } else {
                                Text(preset.name)
                            }
                        }
                    }
                }
            } label: {
                HStack {
                    Text(viewModel.currentPreset?.name ?? "No preset selected.")
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(Theme.subtext)
                }
                .foregroundColor(Theme.text)
                .padding(.horizontal, 10)
                .frame(height: 30)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.panel))
            }
            .menuStyle(.borderlessButton)
            .frame(maxWidth: .infinity)
            .disabled(viewModel.presets.isEmpty)

            Button { viewModel.stepPreset(by: -1) } label: {
                Image(systemName: "chevron.left")
            }
            .buttonStyle(.plain)
            .foregroundColor(Theme.text)
            .disabled(viewModel.presets.isEmpty)

            Button { viewModel.stepPreset(by: 1) } label: {
                Image(systemName: "chevron.right")
            }
            .buttonStyle(.plain)
            .foregroundColor(Theme.text)
            .disabled(viewModel.presets.isEmpty)
        }
    }

    private var portamentoRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Portamento")
                    .foregroundColor(Theme.text)
                    .font(.system(size: 13, weight: .medium))
                Spacer()
                Text(viewModel.portamentoSeconds <= 0.0005 ? "Off" : String(format: "%.0f ms", viewModel.portamentoSeconds * 1000))
                    .foregroundColor(Theme.subtext)
                    .font(.system(size: 12, design: .monospaced))
            }
            Slider(
                value: Binding(get: { viewModel.portamentoSeconds }, set: { viewModel.setPortamentoSeconds($0) }),
                in: 0...3
            )
            .tint(Theme.accent)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel))
    }

    private var sustainRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Sustain")
                    .foregroundColor(Theme.text)
                    .font(.system(size: 13, weight: .medium))
                Spacer()
                Text(viewModel.sustainPercent <= 0.5 ? "Off" : String(format: "%.0f%%", viewModel.sustainPercent))
                    .foregroundColor(Theme.subtext)
                    .font(.system(size: 12, design: .monospaced))
            }
            Slider(
                value: Binding(get: { viewModel.sustainPercent }, set: { viewModel.setSustainPercent($0) }),
                in: 0...100
            )
            .tint(Theme.accent)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel))
    }

    private func labeledStack<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 6) {
            Text(title)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(Theme.subtext)
            content()
        }
    }
}
