import Foundation

/// One playable preset (instrument) entry read from an SF2 file's "phdr" sub-chunk.
struct SF2Preset: Identifiable, Equatable {
    var id: Int { Int(bank) << 16 | Int(program) }
    let name: String
    let program: UInt8   // MIDI program number (0-127), matches the SF2 file's wPreset field
    let bank: UInt16     // SF2 file's raw wBank field (128 == percussion by SoundFont convention)

    /// The MIDI controller-0/32 bank values AVAudioUnitSampler expects when loading this
    /// preset from a SoundFont, per AUSamplerInstrumentData's documented GM2 convention.
    var bankMSB: UInt8 { bank == 128 ? 0x78 : 0x79 } // kAUSampler_DefaultPercussionBankMSB / MelodicBankMSB
    var bankLSB: UInt8 { bank == 128 ? 0x00 : UInt8(bank & 0x7F) }
}

/// Minimal RIFF/SoundFont2 reader. Only reads the "phdr" preset-header list so the plugin UI
/// can populate a preset picker without needing a full synthesis-capable SF2 parser
/// (actual sample playback is delegated to AVAudioUnitSampler, which parses the whole file itself).
enum SF2Parser {

    enum ParseError: Error {
        case notARIFFFile
        case notASoundFont
        case missingPresetHeaderChunk
        case truncatedData
    }

    static func readPresets(at url: URL) throws -> [SF2Preset] {
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        return try readPresets(from: data)
    }

    static func readPresets(from data: Data) throws -> [SF2Preset] {
        guard data.count >= 12 else { throw ParseError.truncatedData }

        var offset = 0
        func readFourCC(_ at: Int) -> String {
            let bytes = data[data.startIndex + at ..< data.startIndex + at + 4]
            return String(bytes: bytes, encoding: .ascii) ?? ""
        }
        func readUInt32LE(_ at: Int) -> UInt32 {
            let bytes = data[data.startIndex + at ..< data.startIndex + at + 4]
            return bytes.enumerated().reduce(UInt32(0)) { acc, el in
                acc | (UInt32(el.element) << (8 * el.offset))
            }
        }
        func readUInt16LE(_ at: Int) -> UInt16 {
            let bytes = data[data.startIndex + at ..< data.startIndex + at + 2]
            return bytes.enumerated().reduce(UInt16(0)) { acc, el in
                acc | (UInt16(el.element) << (8 * el.offset))
            }
        }

        guard readFourCC(0) == "RIFF" else { throw ParseError.notARIFFFile }
        guard readFourCC(8) == "sfbk" else { throw ParseError.notASoundFont }
        offset = 12

        var phdrRange: Range<Int>?

        // Walk top-level RIFF chunks looking for the "pdta" LIST, then its "phdr" sub-chunk.
        while offset + 8 <= data.count {
            let chunkID = readFourCC(offset)
            let chunkSize = Int(readUInt32LE(offset + 4))
            let chunkDataStart = offset + 8
            guard chunkDataStart + chunkSize <= data.count else { break }

            if chunkID == "LIST" {
                let listType = readFourCC(chunkDataStart)
                if listType == "pdta" {
                    var sub = chunkDataStart + 4
                    let listEnd = chunkDataStart + chunkSize
                    while sub + 8 <= listEnd {
                        let subID = readFourCC(sub)
                        let subSize = Int(readUInt32LE(sub + 4))
                        let subDataStart = sub + 8
                        guard subDataStart + subSize <= listEnd else { break }
                        if subID == "phdr" {
                            phdrRange = subDataStart ..< (subDataStart + subSize)
                        }
                        sub = subDataStart + subSize + (subSize % 2) // chunks are word-aligned
                    }
                }
            }

            offset = chunkDataStart + chunkSize + (chunkSize % 2)
        }

        guard let range = phdrRange else { throw ParseError.missingPresetHeaderChunk }

        // Each sfPresetHeader record is 38 bytes; the file always ends with a terminal "EOP" sentinel.
        let recordSize = 38
        let recordCount = range.count / recordSize
        guard recordCount > 0 else { return [] }

        var presets: [SF2Preset] = []
        presets.reserveCapacity(max(0, recordCount - 1))

        for i in 0 ..< max(0, recordCount - 1) { // skip the terminal sentinel record
            let recordStart = range.lowerBound + i * recordSize
            let nameBytes = data[data.startIndex + recordStart ..< data.startIndex + recordStart + 20]
            var name = String(bytes: nameBytes.prefix(while: { $0 != 0 }), encoding: .utf8) ?? ""
            name = name.trimmingCharacters(in: .whitespacesAndNewlines)
            if name.isEmpty { name = "Preset \(i)" }

            let program = readUInt16LE(recordStart + 20)
            let bank = readUInt16LE(recordStart + 22)

            presets.append(SF2Preset(name: name, program: UInt8(truncatingIfNeeded: program), bank: bank))
        }

        return presets.sorted { ($0.bank, $0.program) < ($1.bank, $1.program) }
    }
}
