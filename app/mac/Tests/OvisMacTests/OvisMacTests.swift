import Foundation
import XCTest
@testable import OvisMac

final class InstallerSourceTests: XCTestCase {
    func testTakesTheInstallerOnlyOverHTTPSFromItsOwnHosts() {
        XCTAssertTrue(Ovis.isInstallerSource(URL(string: "https://ovis.sh/install.sh")!))
        XCTAssertTrue(Ovis.isInstallerSource(URL(string: "https://herdrweb.dev/install.sh")!))
        XCTAssertFalse(Ovis.isInstallerSource(URL(string: "http://herdrweb.dev/install.sh")!))
        XCTAssertFalse(Ovis.isInstallerSource(URL(string: "https://herdrweb.dev.example.com/install.sh")!))
        XCTAssertFalse(Ovis.isInstallerSource(URL(string: "https://example.com/install.sh")!))
        XCTAssertFalse(Ovis.isInstallerSource(URL(string: "https://ovis.sh@example.com/install.sh")!))
    }
}

final class StatusAddressTests: XCTestCase {
    func testTakesOnlyAWebAddressAsTheServersOrigin() {
        XCTAssertEqual(Status.serverOrigin("http://127.0.0.1:7317")?.port, 7317)
        XCTAssertNil(Status.serverOrigin("file:///etc/passwd"))
        XCTAssertNil(Status.serverOrigin("x-other-app://open"))
        XCTAssertNil(Status.serverOrigin("(pid"))
    }
}

final class PluginLookupTests: XCTestCase {
    func testTellsAFailedListFromAPluginThatIsGone() {
        let list = { (plugins: String) in "{\"result\": {\"plugins\": [\(plugins)]}}" }
        XCTAssertEqual(Model.plugin(in: list("{\"plugin_id\": \"devswha.herdr-web-ui\", \"plugin_root\": \"/old\"}"), status: 0), .found(id: "devswha.herdr-web-ui", root: "/old"))
        XCTAssertEqual(Model.plugin(in: list("{\"plugin_id\": \"someone.else\", \"plugin_root\": \"/x\"}"), status: 0), .none)
        XCTAssertEqual(Model.plugin(in: list(""), status: 1), .failed)
        XCTAssertEqual(Model.plugin(in: "herdr: not running", status: 0), .failed)
        XCTAssertEqual(Model.plugin(in: "", status: 15), .failed)
    }
}

final class ServedPortsTests: XCTestCase {
    func testFindsTheHTTPSPortsThatServeTheAppsPort() {
        let json = """
        {"TCP": {"443": {"HTTPS": true}, "8443": {"HTTPS": true}, "10000": {"HTTPS": true}, "8080": {"HTTP": true}},
         "Web": {"mac.tail1e211e.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3000"}}},
                 "mac.tail1e211e.ts.net:8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:7317"}}},
                 "mac.tail1e211e.ts.net:10000": {"Handlers": {"/": {"Proxy": "http://localhost:7317/"}}},
                 "mac.tail1e211e.ts.net:8080": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:7317"}}}}}
        """
        XCTAssertEqual(Model.servedHTTPSPorts(Data(json.utf8), appPort: 7317), [8443, 10000])
        XCTAssertEqual(Model.servedHTTPSPorts(Data("{}".utf8), appPort: 7317), [])
        XCTAssertEqual(Model.servedHTTPSPorts(Data("not json".utf8), appPort: 7317), [])
    }
}

final class LogRotationTests: XCTestCase {
    func testMovesALongLogAsideAndLaunchdsAppendsStartAgainAtItsBeginning() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ovis-log-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = dir.appendingPathComponent("herdr-server.log").path
        try Data("0123456789abcdef\n".utf8).write(to: URL(fileURLWithPath: log))
        // launchd opens the log for appending and keeps it open while herdr runs
        let launchd = open(log, O_WRONLY | O_APPEND)
        XCTAssertGreaterThanOrEqual(launchd, 0)
        defer { close(launchd) }

        LaunchAgent.rotateLog(log, limit: 100)
        XCTAssertEqual(try String(contentsOfFile: log, encoding: .utf8), "0123456789abcdef\n", "under the limit it stays")

        LaunchAgent.rotateLog(log, limit: 8)
        XCTAssertEqual(try String(contentsOfFile: "\(log).1", encoding: .utf8), "0123456789abcdef\n")
        XCTAssertEqual(try String(contentsOfFile: log, encoding: .utf8), "")
        _ = "after\n".withCString { write(launchd, $0, 6) }
        XCTAssertEqual(try String(contentsOfFile: log, encoding: .utf8), "after\n")
    }

    func testRotatesTheFileALinkedLogPointsAt() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ovis-log-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let target = dir.appendingPathComponent("real.log").path
        let link = dir.appendingPathComponent("herdr-server.log").path
        try Data(String(repeating: "x", count: 64).utf8).write(to: URL(fileURLWithPath: target))
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: target)
        LaunchAgent.rotateLog(link, limit: 8)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: target)[.size] as? Int, 0)
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: link), target)
        XCTAssertEqual(try String(contentsOfFile: "\(target).1", encoding: .utf8).count, 64)
    }
}
