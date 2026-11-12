import AppKit
import Foundation

/// Ends a request at its redirect: the redirect's own response is the answer.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Follows the installer's download only to its own HTTPS hosts: ovis.sh hands it over from herdrweb.dev.
private final class InstallerRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(request.url.map(Ovis.isInstallerSource) == true ? request : nil)
    }
}

struct Status: Equatable {
    var running: Bool
    var origin: URL?

    /// `plugin.ts status`'s first line: "running http://127.0.0.1:7317 (pid 1)" or "down …".
    static func parse(_ line: String) -> Status {
        let words = line.split(separator: " ")
        return Status(running: words.first == "running", origin: words.count > 1 ? serverOrigin(String(words[1])) : nil)
    }

    /// The address in `plugin.ts status`'s line, when it is a web address.
    static func serverOrigin(_ text: String) -> URL? {
        guard let url = URL(string: text), isWeb(url), url.host?.isEmpty == false else { return nil }
        return url
    }

    static func isWeb(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "http" || url.scheme?.lowercased() == "https"
    }
}

@MainActor
final class Model: ObservableObject {
    enum Phase: Equatable {
        case checking
        case notInstalled
        case working(String)
        case failed(String)
        case installed
    }

    @Published var phase: Phase = .checking
    @Published var log: [String] = []
    @Published var status: Status?
    /// The Ovis page the main window shows: the running server's address, nil while it is not running.
    @Published private(set) var webOrigin: URL?
    /// Bumped to load the page again: View > Reload, or the server answering again after it was gone.
    @Published private(set) var reloads = 0
    /// The main window's page, for Open in Browser.
    weak var page: WebPageController?
    /// Unsent drafts read from the page the window left (another port is another origin, with storage of
    /// its own), for the next page to take up. Kept until a page has loaded with them.
    private(set) var carriedDrafts: [String: String] = [:]
    /// The page did not load: it loads again once the server answers. A page that did load reconnects
    /// by itself, as it does in a browser, and keeps what the user had open in it.
    private var pageFailedToLoad = false
    /// Bumped as Install, Restart or Remove starts: a check that began before it
    /// must not put its result over theirs.
    private var work = 0
    private var pluginRoot: String?
    enum Action { case install, restart, remove }
    /// What Try again repeats: the action that failed, not the whole install.
    private var retryAction = Action.install

    var logText: String { log.joined(separator: "\n") }

    /// Install, Restart or Remove is under way, and waits for the server itself.
    var busy: Bool {
        if case .working = phase { return true }
        return false
    }

    func refresh() async {
        let started = work
        let plugin = FileManager.default.isExecutableFile(atPath: Paths.herdr) ? await findPlugin() : nil
        guard work == started else { return }
        guard let plugin else {
            pluginRoot = nil
            status = nil
            webOrigin = nil
            phase = .notInstalled
            return
        }
        pluginRoot = plugin.root
        let status = await readStatus(root: plugin.root)
        guard work == started else { return }
        self.status = status
        let origin = status.running ? status.origin : nil
        if origin != webOrigin, let old = webOrigin, WebPageController.isLoopback(old), let page {
            // the page about to go holds its drafts in its own origin's storage: read them while it runs (only
            // this Mac's own server's, and WebPageController writes them only into another of its addresses)
            let drafts = await page.unsentDrafts()
            // a check that Install, Restart or Remove overtook drops what it read: their own refresh reads
            // the page again, and a copy left here could later bring back a draft sent meanwhile
            guard work == started else { return }
            carriedDrafts.merge(drafts) { $1 }
        }
        if origin != webOrigin {
            // a page at a new address loads by itself
            webOrigin = origin
            pageFailedToLoad = false
        }
        phase = .installed
    }

    /// Keeps the main window on a live page for as long as the app runs. A running page reconnects by
    /// itself to a server that comes back, and tells the user itself when the server it meets was
    /// updated; a page that did not load, or whose code never started, loads again once the server
    /// answers. Every fifth miss (about 15 s) reads the status again: the server may be on another port
    /// now, or stopped, and then the window shows Start. A server started outside the app (a terminal,
    /// herdr's own start) is picked up the same way.
    func monitor() async {
        var misses = 0
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            // Install, Restart and Remove wait for the server themselves, and a failure stays on screen
            guard phase == .installed || phase == .notInstalled else {
                misses = 0
                continue
            }
            let started = work
            var up = false
            if let origin = status?.origin { up = await answers(origin) }
            guard work == started else { continue }
            if up {
                let wasGone = misses >= 1
                misses = 0
                if webOrigin == nil {
                    await refresh()
                } else if pageFailedToLoad {
                    pageFailedToLoad = false
                    reloads += 1
                } else if wasGone {
                    page?.reloadIfNotStarted()
                }
                continue
            }
            misses += 1
            if misses % 5 == 0 { await refresh() }
        }
    }

    func pageFailed() {
        pageFailedToLoad = true
    }

    func pageLoaded() {
        pageFailedToLoad = false
    }

    /// These carried drafts are in the new page's storage now; any other stays for the next try.
    func draftsCarried(_ keys: Set<String>) {
        carriedDrafts = carriedDrafts.filter { !keys.contains($0.key) }
    }

    func reload() {
        reloads += 1
    }

    /// The page as it is now (a pane's address), or the server's own address: only a web address, never
    /// another app's link, goes to the browser.
    func openInBrowser() {
        if let url = [page?.webView.url, webOrigin, status?.origin].compactMap({ $0 }).first(where: Status.isWeb) { open(url) }
    }

    func retry() async {
        switch retryAction {
        case .install: await install()
        case .restart: await restart()
        case .remove: await uninstall()
        }
    }

    func install() async {
        work += 1
        retryAction = .install
        log = []
        phase = .working(L("Downloading the installer…", "설치 프로그램을 받는 중…"))
        let script: URL
        do {
            // the script runs as this user: it comes over HTTPS from ovis.sh's own hosts or not at all
            let (data, response) = try await URLSession.shared.data(from: Ovis.installScript, delegate: InstallerRedirects())
            guard (response as? HTTPURLResponse)?.statusCode == 200, let source = response.url, Ovis.isInstallerSource(source) else {
                throw URLError(.badServerResponse)
            }
            script = FileManager.default.temporaryDirectory.appendingPathComponent("ovis-install-\(UUID().uuidString).sh")
            try data.write(to: script)
        } catch {
            fail(L("Could not download the installer from ovis.sh. Check the internet connection.", "ovis.sh에서 설치 프로그램을 받지 못했습니다. 인터넷 연결을 확인해 주세요."), detail: error.localizedDescription)
            return
        }
        defer { try? FileManager.default.removeItem(at: script) }
        phase = .working(L("Installing herdr, Bun, Node and the Ovis server…", "herdr, Bun, Node, Ovis 서버를 설치하는 중…"))
        let result = await run("/bin/sh", [script.path], env: ["OVIS_NO_OPEN": "1"], onLine: appendLine)
        guard result.status == 0 else {
            fail(L("The installer stopped with an error.", "설치 중 오류가 났습니다."))
            return
        }
        phase = .working(L("Starting herdr…", "herdr를 시작하는 중…"))
        do {
            try await LaunchAgent.install()
        } catch {
            fail(L("Could not set herdr to start at login.", "로그인할 때 herdr가 켜지도록 설정하지 못했습니다."), detail: error.localizedDescription)
            return
        }
        await waitUntilRunning()
    }

    func restart() async {
        work += 1
        retryAction = .restart
        log = []
        phase = .working(L("Restarting…", "다시 시작하는 중…"))
        if await herdrRunning(), let root = pluginRoot {
            // `herdr plugin action invoke` only queues the action, so a start invoked right after a stop
            // finds the old server still up and fails: run them here and wait for each, with the locale
            // the login item gives herdr. The output is in the log: a failure only names which one stopped.
            guard await run(Paths.bun, ["\(root)/scripts/plugin.ts", "stop"], env: ["LC_CTYPE": "UTF-8"], timeout: 60, onLine: appendLine).status == 0 else {
                fail(L("Could not stop the Ovis server.", "Ovis 서버를 멈추지 못했습니다."))
                return
            }
            guard await run(Paths.bun, ["\(root)/scripts/plugin.ts", "start"], env: ["LC_CTYPE": "UTF-8"], timeout: 60, onLine: appendLine).status == 0 else {
                fail(L("Could not start the Ovis server.", "Ovis 서버를 시작하지 못했습니다."))
                return
            }
        } else if !(await LaunchAgent.start()) {
            // herdr installed from a terminal has no login item to start, and Start makes none: herdr runs
            // for this login only, as `herdr` in a terminal would
            do {
                try await LaunchAgent.startOnce()
            } catch {
                fail(L("Could not start herdr.", "herdr를 시작하지 못했습니다."), detail: error.localizedDescription)
                return
            }
        }
        await waitUntilRunning()
    }

    /// Takes the Ovis server off this Mac, as the guide's Uninstall does. herdr, Bun and Node stay, and
    /// herdr keeps running: stopping it would end every agent in it.
    func uninstall() async {
        work += 1
        retryAction = .remove
        log = []
        phase = .working(L("Removing…", "제거하는 중…"))
        let appPort = status?.origin.map { $0.port ?? ($0.scheme == "https" ? 443 : 80) }
        // looked up again, so Try again goes on from where a failed try stopped; a lookup that failed is
        // not a plugin that is gone
        let lookup = await lookupPlugin()
        if case .failed = lookup {
            fail(L("herdr did not list its plugins, so nothing was removed.", "herdr가 플러그인 목록을 알려 주지 않아 아무것도 제거하지 않았습니다."))
            return
        }
        if case let .found(id, root) = lookup {
            let plugin = (id: id, root: root)
            // the stop has to end before the uninstall removes the plugin's files: run it here, not as a queued action
            guard await run(Paths.bun, ["\(plugin.root)/scripts/plugin.ts", "stop"], env: ["LC_CTYPE": "UTF-8"], timeout: 60, onLine: appendLine).status == 0 else {
                fail(L("Could not stop the Ovis server, so it was not removed.", "Ovis 서버를 멈추지 못해 제거하지 않았습니다."))
                return
            }
            guard await run(Paths.herdr, ["plugin", "uninstall", plugin.id], timeout: 60, onLine: appendLine).status == 0 else {
                fail(L("herdr could not remove the Ovis plugin.", "herdr가 Ovis 플러그인을 제거하지 못했습니다."))
                return
            }
        }
        var stillServed: [Int] = []
        if let tailscale = Paths.tailscale {
            var ports: [Int] = []
            if let appPort {
                // what Tailscale itself serves for the app's port
                let serve = await run(tailscale, ["serve", "status", "--json"], keepStderr: false, timeout: 10)
                guard serve.status == 0 else {
                    await LaunchAgent.remove()
                    fail(L("The Ovis server is removed, but Tailscale did not say what it serves. Check with: tailscale serve status",
                           "Ovis 서버는 제거했지만, Tailscale이 무엇을 열어 두고 있는지 알려 주지 않았습니다. 확인할 명령: tailscale serve status"))
                    return
                }
                ports = Self.servedHTTPSPorts(Data(serve.output.utf8), appPort: appPort)
            }
            for port in ports {
                if await run(tailscale, ["serve", "--https=\(port)", "off"], timeout: 30, onLine: appendLine).status != 0 { stillServed.append(port) }
            }
        }
        await LaunchAgent.remove()
        guard stillServed.isEmpty else {
            let commands = stillServed.map { "tailscale serve --https=\($0) off" }.joined(separator: "; ")
            fail(L("The Ovis server is removed, but Tailscale still serves its address. Run: \(commands)",
                   "Ovis 서버는 제거했지만 Tailscale이 아직 앱 주소를 열어 두고 있습니다. 실행할 명령: \(commands)"))
            return
        }
        await refresh()
    }

    enum PluginLookup: Equatable {
        case found(id: String, root: String)
        case none
        /// herdr did not answer, or not with a list: whether the plugin is there is not known
        case failed
    }

    /// The plugin under its id or, for an install of an older release, the old one, in `herdr plugin list --json`.
    nonisolated static func plugin(in output: String, status: Int32) -> PluginLookup {
        guard status == 0,
              let json = try? JSONSerialization.jsonObject(with: Data(output.utf8)) as? [String: Any],
              let plugins = (json["result"] as? [String: Any])?["plugins"] as? [[String: Any]]
        else { return .failed }
        for id in [Ovis.pluginID, Ovis.legacyPluginID] {
            if let root = plugins.first(where: { $0["plugin_id"] as? String == id })?["plugin_root"] as? String {
                return .found(id: id, root: root)
            }
        }
        return .none
    }

    /// The HTTPS ports `tailscale serve status --json` serves the app's port on, as `server/tailscale.ts` reads them.
    nonisolated static func servedHTTPSPorts(_ json: Data, appPort: Int) -> [Int] {
        guard let serve = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { return [] }
        let tcp = serve["TCP"] as? [String: Any] ?? [:]
        var ports: [Int] = []
        for (hostPort, site) in serve["Web"] as? [String: Any] ?? [:] {
            guard let colon = hostPort.lastIndex(of: ":"), let port = Int(hostPort[hostPort.index(after: colon)...]),
                  (tcp[String(port)] as? [String: Any])?["HTTPS"] as? Bool == true,
                  let handlers = (site as? [String: Any])?["Handlers"] as? [String: Any],
                  let proxy = (handlers["/"] as? [String: Any])?["Proxy"] as? String,
                  let target = URL(string: proxy), let host = target.host?.lowercased(),
                  ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host),
                  (target.port ?? (target.scheme == "https" ? 443 : 80)) == appPort,
                  target.path.isEmpty || target.path == "/" else { continue }
            ports.append(port)
        }
        return ports.sorted()
    }

    func open(_ url: URL) {
        NSWorkspace.shared.open(url)
    }

    func copyLog() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(logText, forType: .string)
    }

    private func fail(_ message: String, detail: String? = nil) {
        if let detail { log.append(detail) }
        phase = .failed(message)
    }

    /// Called on the pipe's thread for each line a child prints; the log is appended on the main thread, in order.
    private nonisolated var appendLine: @Sendable (String) -> Void {
        { [weak self] line in
            // a QR code drawn in block characters means nothing in a log
            guard !line.isEmpty, line.contains(where: { !"█▀▄ ".contains($0) }) else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.log.append(line) }
            }
        }
    }

    private func lookupPlugin() async -> PluginLookup {
        let result = await run(Paths.herdr, ["plugin", "list", "--json"], keepStderr: false, timeout: 10)
        return Self.plugin(in: result.output, status: result.status)
    }

    private func findPlugin() async -> (id: String, root: String)? {
        if case let .found(id, root) = await lookupPlugin() { return (id, root) }
        return nil
    }

    /// `plugin.ts status` knows the port the plugin settled on: "running http://127.0.0.1:7317 (pid 1)" or "down …".
    private func readStatus(root: String) async -> Status {
        let result = await run(Paths.bun, ["\(root)/scripts/plugin.ts", "status"], keepStderr: false, timeout: 10)
        return Status.parse(String(result.output.split(separator: "\n").first ?? ""))
    }

    /// The server's health check that leaves herdr alone (`scope=bridge`); it answers without a sign-in.
    /// Only Ovis's own answer counts, as in `scripts/plugin.ts`: another program can take a port Ovis
    /// left, and its 200 would hide the server's new address. A redirect is not followed: one to the new
    /// address would hide it the same way.
    private func answers(_ origin: URL) async -> Bool {
        guard let url = URL(string: "api/health?scope=bridge", relativeTo: origin)?.absoluteURL else { return false }
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        guard let (data, response) = try? await URLSession.shared.data(for: request, delegate: NoRedirects()),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return body["ok"] as? Bool == true && body["bridge_protocol"] is Int
    }

    private func herdrRunning() async -> Bool {
        let result = await run(Paths.herdr, ["status", "server", "--json"], keepStderr: false, timeout: 10)
        return result.output.contains("\"running\":true")
    }

    /// herdr starts the app from its startup hook; give it up to two minutes, checking every two seconds,
    /// then show where it stopped instead of the spinner or the Install button.
    private func waitUntilRunning() async {
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline {
            if let plugin = await findPlugin(), await readStatus(root: plugin.root).running {
                await refresh()
                return
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
        // herdr's own output from the login item: what it printed while it started, or failed to
        let logTail = (try? String(contentsOfFile: Paths.serverLog, encoding: .utf8))?
            .split(separator: "\n").suffix(10).joined(separator: "\n")
        if await findPlugin() == nil {
            fail(L("herdr does not list the Ovis plugin. Try again, or copy the log and get help.",
                   "herdr에 Ovis 플러그인이 보이지 않습니다. 다시 시도하거나, 오류 내용을 복사해 도움을 받으세요."), detail: logTail)
        } else {
            fail(L("The Ovis server did not start within two minutes. Try again, or copy the log and get help.",
                   "Ovis 서버가 2분 안에 시작되지 않았습니다. 다시 시도하거나, 오류 내용을 복사해 도움을 받으세요."),
                 detail: logTail)
        }
    }
}

/// `herdr server` as a login item of this user, so herdr, and the app with it, is up without a terminal.
enum LaunchAgent {
    private static var domain: String { "gui/\(getuid())" }
    private static var service: String { "\(domain)/\(Ovis.agentLabel)" }

    static func install() async throws {
        try FileManager.default.createDirectory(atPath: (Paths.launchAgent as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try write(Paths.launchAgent)
        try await load(Paths.launchAgent)
    }

    /// Starts herdr for this login only, with no login item: launchd loads the job from a copy that is
    /// deleted right after, so nothing starts it at the next login. Only Install makes a login item.
    static func startOnce() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ovis-agent-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("\(Ovis.agentLabel).plist").path
        try write(file)
        try await load(file)
    }

    /// launchd appends herdr's output to its log for as long as herdr runs and never trims it: past `limit`
    /// the log moves to herdr-server.log.1 (replacing the one before) and starts again. It is copied and
    /// emptied in place, not renamed: launchd keeps it open, and its appends go on at the new end.
    static func rotateLog(_ log: String = Paths.serverLog, limit: Int = 10 << 20) {
        let manager = FileManager.default
        // a log that is a link is measured, copied and emptied where it points
        let path = URL(fileURLWithPath: log).resolvingSymlinksInPath().path
        guard let size = (try? manager.attributesOfItem(atPath: path))?[.size] as? Int, size > limit else { return }
        let old = "\(path).1"
        try? manager.removeItem(atPath: old)
        guard (try? manager.copyItem(atPath: path, toPath: old)) != nil, let handle = FileHandle(forWritingAtPath: path) else { return }
        try? handle.truncate(atOffset: 0)
        try? handle.close()
    }

    private static func write(_ path: String) throws {
        try FileManager.default.createDirectory(atPath: Paths.logDir, withIntermediateDirectories: true)
        rotateLog()
        let plist: [String: Any] = [
            "Label": Ovis.agentLabel,
            "ProgramArguments": [Paths.herdr, "server"],
            "RunAtLoad": true,
            // launchd starts herdr with no locale, and its panes' shells inherit that: without a
            // character set they read Korean and emoji as bytes
            "EnvironmentVariables": ["PATH": Paths.path, "HOME": Paths.home, "LC_CTYPE": "UTF-8"],
            // launchd kills the job's whole process group when herdr exits; a server herdr hands its
            // sessions to (an update) would go with it, and every agent in it
            "AbandonProcessGroup": true,
            "StandardOutPath": Paths.serverLog,
            "StandardErrorPath": Paths.serverLog,
            "ProcessType": "Interactive",
        ]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: URL(fileURLWithPath: path))
    }

    private static func load(_ path: String) async throws {
        _ = await run("/bin/launchctl", ["enable", service])
        // a loaded agent may be running herdr with the user's agents in it: never boot it out to reload
        if await loaded() { _ = await start(); return }
        let result = await run("/bin/launchctl", ["bootstrap", domain, path])
        guard result.status == 0 else { throw NSError(domain: "Ovis", code: Int(result.status), userInfo: [NSLocalizedDescriptionKey: result.output]) }
    }

    /// Starts herdr when it is not running; a running herdr is left as it is. False when launchd has
    /// no such agent (herdr set up from a terminal, or the plist removed).
    @discardableResult
    static func start() async -> Bool {
        await run("/bin/launchctl", ["kickstart", service]).status == 0
    }

    /// Stops it from starting at the next login without stopping the herdr that runs now.
    static func remove() async {
        _ = await run("/bin/launchctl", ["disable", service])
        try? FileManager.default.removeItem(atPath: Paths.launchAgent)
    }

    private static func loaded() async -> Bool {
        await run("/bin/launchctl", ["print", service], keepStderr: false).status == 0
    }
}
