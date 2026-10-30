# PortaSF2

A macOS AUv3 instrument plugin that plays SoundFont (.sf2) files, with a portamento glide
slider — the feature the reference "SF2 Player" screenshot didn't have.

## Opening the project

```bash
open PortaSF2.xcodeproj
```

The project was generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen) from
`project.yml`. If you change `project.yml`, regenerate with `xcodegen generate` (run from this
directory) rather than hand-editing the `.xcodeproj`.

Two targets:
- **PortaSF2** — a small container app. It's required for the extension to be embeddable at all,
  and it doubles as a standalone test host: click "Load Plug-in" and it loads the *actual* plugin
  view (SoundFont picker, preset browser, portamento slider) in-window, so you can try the whole
  thing without opening a DAW.
- **PortaSF2Extension** — the AUv3 App Extension itself; this is what DAWs load.

Build with `Cmd+R` (builds & runs the container app) or `Cmd+B`. Signing is set to Automatic; if
you don't have an Apple Developer account, Xcode will fall back to "Sign to Run Locally," which
is enough for local use in a DAW — it does not require an Apple ID/team.

## Using it in a DAW

Build and run the app once (this registers the extension with the system). Then in Logic Pro,
GarageBand, MainStage, or AUM, add an instrument track and look for **Zsim: PortaSF2** under
Audio Units → Instruments.

To validate the plugin outside of any host:

```bash
auval -v aumu Pts2 Zsim
```

## How portamento works here

AVAudioUnitSampler (which does the actual SF2 playback) has no native glide/portamento control,
so this plugin implements it at the MIDI level, the same way hardware/software mono synths do:

- **Portamento = 0 (off):** normal polyphonic playback — every note-on/off is independent.
- **Portamento > 0:** the instrument becomes monophonic with legato glide. While a note is still
  held and a new one comes in, the *currently-sounding* sample voice is pitch-bent to the new
  note's pitch over the configured time, instead of retriggering. Releasing a note falls back to
  the previous still-held note (last-note priority), matching classic mono-synth behavior. The
  sampler's pitch-bend range is widened to ±24 semitones via a standard RPN 0,0 message so glides
  can span more than the MIDI-default ±2 semitones.

This is a deliberate simplification: true *polyphonic* portamento (every new voice glides from
whatever note was last played, while other held notes keep sounding independently) is
significantly more involved and out of scope here.

## Other implementation notes

- Rendering is done by hosting a private `AVAudioEngine` (containing `AVAudioUnitSampler` +
  `AVAudioUnitReverb`) inside the AU's own `internalRenderBlock`, using the engine's
  [manual rendering mode](https://developer.apple.com/documentation/avfaudio/avaudioengine/1387100-enablemanualrenderingmode) —
  the standard way to embed a full `AVAudioEngine` graph inside a v3 Audio Unit.
- SoundFont selection uses a small hand-rolled RIFF/SF2 parser (`Shared/SF2Parser.swift`) that
  reads just the preset-header (`phdr`) chunk to populate the preset list; actual sample playback
  parsing is left entirely to `AVAudioUnitSampler`.
- The chosen SoundFont is remembered via a security-scoped bookmark stored in the AU's
  `fullState`, so it survives project reloads in a sandboxed host without needing an App Group.
- Effects = a bypassable `AVAudioUnitReverb` (medium hall, 30% wet) chained after the sampler.

## Known limitations

- No sustain-pedal-aware "hold" handling beyond plain MIDI CC64 passthrough.
- Host pitch-bend messages are ignored while portamento is active (the plugin owns pitch bend on
  the sampler for glide purposes in that mode) and passed through untouched otherwise.
- Program-change MIDI messages from the host aren't used to switch presets — preset selection is
  driven by the plugin's own UI only, to avoid fighting with it.
