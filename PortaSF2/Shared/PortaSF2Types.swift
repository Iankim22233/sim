import AudioToolbox

/// Parameter addresses published on the AU's `parameterTree`. Shared between the extension
/// (which implements them) and the container app's test host (which drives them for local
/// testing without a full DAW).
enum PortaSF2Param: AUParameterAddress {
    case masterVolume = 0
    case effectsEnabled = 1
    case midiChannel = 2
    case portamentoTime = 3
    case sustainAmount = 4
}

/// Identity of the registered AUv3 instrument component. Shared so the container app's test
/// host can look up and instantiate the exact same component the Info.plist declares.
enum PortaSF2Component {
    static let type: OSType = fourCC("aumu")
    static let subtype: OSType = fourCC("Pts2")
    static let manufacturer: OSType = fourCC("Zsim")

    static var description: AudioComponentDescription {
        AudioComponentDescription(componentType: type, componentSubType: subtype,
                                   componentManufacturer: manufacturer,
                                   componentFlags: 0, componentFlagsMask: 0)
    }

    private static func fourCC(_ s: String) -> OSType {
        var result: UInt32 = 0
        for c in s.utf8 { result = (result << 8) | UInt32(c) }
        return result
    }
}
