import CoreAudioKit
import SwiftUI

/// Principal class of the AUv3 App Extension. Per AUAudioUnitFactory's contract, this single
/// class both creates the AUAudioUnit instance the host renders through and supplies the view
/// the host displays for it.
public final class AudioUnitViewController: AUViewController, AUAudioUnitFactory {

    private var audioUnit: PortaSF2AudioUnit?
    private var hostingController: NSHostingController<PluginRootView>?

    public override func viewDidLoad() {
        super.viewDidLoad()
        preferredContentSize = NSSize(width: 460, height: 480)
        embedSwiftUIIfNeeded()
    }

    public func createAudioUnit(with componentDescription: AudioComponentDescription) throws -> AUAudioUnit {
        let au = try PortaSF2AudioUnit(componentDescription: componentDescription, options: [])
        audioUnit = au
        DispatchQueue.main.async { [weak self] in
            self?.embedSwiftUIIfNeeded()
        }
        return au
    }

    private func embedSwiftUIIfNeeded() {
        guard hostingController == nil, isViewLoaded, let au = audioUnit else { return }

        let viewModel = PluginViewModel(audioUnit: au)
        let root = PluginRootView(viewModel: viewModel)
        let hosting = NSHostingController(rootView: root)

        addChild(hosting)
        hosting.view.frame = view.bounds
        hosting.view.autoresizingMask = [.width, .height]
        view.addSubview(hosting.view)
        hostingController = hosting
    }
}
