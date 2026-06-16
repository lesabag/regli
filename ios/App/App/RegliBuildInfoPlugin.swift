import Foundation
import Capacitor

@objc(RegliBuildInfoPlugin)
public class RegliBuildInfoPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RegliBuildInfoPlugin"
    public let jsName = "RegliBuildInfo"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPushRegistrationInfo", returnType: CAPPluginReturnPromise)
    ]

    @objc func getPushRegistrationInfo(_ call: CAPPluginCall) {
        let buildConfiguration = resolveBuildConfiguration()
        let installSource = resolveInstallSource(buildConfiguration: buildConfiguration)
        let apnsEnvironment = buildConfiguration == "debug" ? "sandbox" : "production"

        call.resolve([
            "apnsEnvironment": apnsEnvironment,
            "installSource": installSource,
            "buildConfiguration": buildConfiguration,
            "isDebugBuild": buildConfiguration == "debug",
        ])
    }

    private func resolveBuildConfiguration() -> String {
#if DEBUG
        return "debug"
#else
        return "release"
#endif
    }

    private func resolveInstallSource(buildConfiguration: String) -> String {
        if buildConfiguration == "debug" {
            return "xcode_debug"
        }

        guard let receiptName = Bundle.main.appStoreReceiptURL?.lastPathComponent else {
            return "unknown"
        }

        if receiptName == "sandboxReceipt" {
            return "testflight"
        }

        if receiptName == "receipt" {
            return "app_store"
        }

        return "unknown"
    }
}
