// Service worker. Policy: navigations are network-first (so a
// fresh build always wins when online) falling back to the cached shell when
// offline; static assets (hashed bundles, icons, favicons) are cache-first since
// they are content-addressed or rarely change. The web manifest is not: its URL
// never changes and the browser rereads it to update the installed app, so a
// cached copy would pin every install to its first manifest. API and websocket
// traffic is never intercepted so live workspace data is always fresh.
// Nothing is precached. The typefaces are /assets/ files too (src/fonts/fonts.css): Pretendard
// comes as 92 chunks split by unicode-range and the browser asks only for those whose characters
// a page draws, so each is cached as it is first fetched and a phone that has shown Korean once
// draws it offline. Never list them for install: that would download all 3 MB on every device.
// A new cache starts empty for the same reason, so the cache of the name before it is kept
// until this one holds a shell and the files it starts with: the page that brought this worker
// was loaded through the old one, and its shell, bundles and font chunks are all there. Deleted
// at activation, the first reload without a network would find no shell at all. Only the new
// build's files (BUILD_FILES), the retired shell's entry files, typefaces and icons are copied
// across, so no other bundle of an old build outlives the first navigation that reaches the server.
// Every build is a worker of its own: the build stamps BUILD into dist/sw.js
// (scripts/service-worker-build.ts), so its cache is named after it and the last build's
// bundles go with the last build's cache. CACHE_NAME is the part a person moves.
// The typefaces and icons are not a build's: a font chunk's name changes only with its contents,
// and most are the same file release after release. They live in FILES, which no build retires,
// so an update does not cost a phone the glyphs it had drawn offline.
// BUILD_FILES, stamped beside BUILD, names the build's own /assets/ files (names only, no typefaces).
// A file of this build that the worker before kept (the reload after an update is still answered
// by it, KaTeX or Mermaid fetched early among them) is moved into this cache when that one is
// retired, and a file of another build is not copied forward. A worker no build stamped has no
// list: any file is copied forward, as before.
// A retired cache's own shell keeps its entry script and stylesheet here too: a page that started
// from that shell offline and has not asked for them yet still boots, then offers a reload.
const CACHE_NAME = "ovis-v4-factory";
const BRAND = {"name":"Widal Factory","icon":"/icons/icon-192.png?v=factory1","badge":"/icons/badge-96.png?v=factory1"};
const BUILD = "";
const BUILD_FILES = null;
const CACHE = BUILD ? `${CACHE_NAME}-${BUILD}` : CACHE_NAME;
const FILES = "ovis-files-v1";
const buildFiles = BUILD_FILES ? new Set(BUILD_FILES) : null;

/** Whether `pathname` is a file this build uses; any file, for a worker no build stamped. */
function ofThisBuild(pathname) {
  return !buildFiles || buildFiles.has(pathname);
}

const CACHE_FIRST_PATHS = new Set([
  "/favicon.png",
  "/favicon.ico",
  "/apple-touch-icon.png",
]);

function isCacheFirst(pathname) {
  if (pathname.startsWith("/assets/") || pathname.startsWith("/icons/")) return true;
  return CACHE_FIRST_PATHS.has(pathname);
}

/** A typeface or an icon: kept in FILES across builds. */
function isLongLived(pathname) {
  if (pathname.startsWith("/icons/") || CACHE_FIRST_PATHS.has(pathname)) return true;
  return pathname.startsWith("/assets/") && /\.(woff2?|ttf)$/.test(pathname);
}

/** A page where a file was asked for: a server that had no such file answered with its shell. */
function isPage(response) {
  return (response.headers.get("content-type") || "").startsWith("text/html");
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // no cache is deleted here: see CACHE_NAME, BUILD and keepShell
  event.waitUntil(self.clients.claim());
});

/** The files a shell cannot start without: its entry script and its stylesheet. */
function shellFiles(html) {
  const files = new Set();
  for (const [, path] of html.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)) files.add(path);
  return [...files];
}

/** A file from a cache of another name, else from the network; null when neither has it. */
async function fileFor(path) {
  const older = await caches.match(path);
  if (older && !isPage(older)) return older;
  try {
    const response = await fetch(path);
    return response.ok && response.type === "basic" && !isPage(response) ? response : null;
  } catch (err) {
    return null;
  }
}

/**
 * The shell just fetched becomes this cache's "/" once the cache holds every file that shell
 * starts with: the worker before may have answered them, and a network that drops before the
 * page asks again must not leave a shell without them. Until then the old caches and their
 * shell stay, a complete start offline. Then the caches of other names go, their typefaces and
 * icons moved to FILES first, except `spare`: the cache whose shell a page is running right now,
 * which may still ask for a file of its build. The next open, from the shell kept here, retires it.
 */
async function keepShell(response, spare) {
  const html = await response.clone().text();
  const cache = await caches.open(CACHE);
  for (const path of shellFiles(html)) {
    if (await cache.match(path)) continue;
    const file = await fileFor(path);
    if (!file) return;
    await cache.put(path, file);
  }
  await cache.put("/", response);
  const files = await caches.open(FILES);
  const names = (await caches.keys()).filter((name) => name !== CACHE && name !== FILES && name !== spare);
  for (const name of names) {
    const old = await caches.open(name);
    // the files the retired cache's shell starts with: a page given that shell may not have asked yet
    const oldShell = await old.match("/");
    const starts = new Set(oldShell ? shellFiles(await oldShell.text()) : []);
    for (const request of await old.keys()) {
      const path = new URL(request.url).pathname;
      const into = isLongLived(path) ? files
        : starts.has(path) || (buildFiles && buildFiles.has(path)) ? cache : null;
      if (!into || (await into.match(request))) continue;
      const file = await old.match(request);
      if (file && !isPage(file)) await into.put(request, file);
    }
  }
  await Promise.all(names.map((name) => caches.delete(name)));
}

/** The shell to start from offline: this cache's, else the one a cache not yet deleted holds. */
async function cachedShell() {
  for (const name of [CACHE, ...(await caches.keys()).filter((name) => name !== CACHE && name !== FILES)]) {
    const response = await (await caches.open(name)).match("/");
    if (response) return response;
  }
  return undefined;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        let response;
        try {
          response = await fetch(request);
        } catch (err) {
          return (await cachedShell()) || Response.error();
        }
        if (response.ok) {
          // not awaited: the page gets its shell as it comes, and the worker lives until the
          // copy is kept (a put reads the whole body). A bundle asked for meanwhile may still
          // be answered by the old cache: a hashed file is the same file in either, and only
          // what the network gave is put in this one. A cache that cannot be written does not
          // cost the page.
          event.waitUntil(keepShell(response.clone()).catch(() => undefined));
        }
        return response;
      })(),
    );
    return;
  }

  if (isCacheFirst(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(isLongLived(url.pathname) ? FILES : CACHE);
        const own = await cache.match(request);
        if (own) return own;
        const older = await caches.match(request);
        // a shell an older worker kept under a file's URL is no copy of that file
        if (older && !isPage(older)) {
          // a file only the cache of the name before still holds, asked for while the new shell's
          // copy is being kept: it is kept here too, so keepShell's retirement of that cache does
          // not take the only copy of a file the new shell uses. Another build's file is only answered.
          if (ofThisBuild(url.pathname)) event.waitUntil(cache.put(request, older.clone()).catch(() => undefined));
          return older;
        }
        const response = await fetch(request);
        // a file the server no longer has is not kept: an old page asking for its own build's
        // bundle after an update gets a 404, or the shell from a server older than that answer
        if (response.ok && response.type === "basic" && !isPage(response)) {
          cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
});

// Web push (server/push.ts sends, shared/protocol.ts PushPayload is the JSON). Every
// push shows a notification: Safari revokes a subscription whose pushes stay silent.
// A window of the app that is visible right now already shows the change in its
// sidebar, so the notification then arrives without sound or vibration.

// The tag replaces the pane's last alert everywhere but iOS, whose webpushd files each one
// under an id of its own (WebKit bugs 258922, 319860): the pane's earlier alerts are closed by
// hand. Their alert_ids are noted before showing, so an alert shown meanwhile (another push for
// the pane) is never closed, and the handles are listed again after showing: where the tag did
// replace, an old handle names the new alert. iOS refuses close() for 30 s after showing, so a
// quicker repeat waits for the next alert. A failed listing closes nothing.
async function earlierAlerts(tag) {
  try {
    return new Set((await self.registration.getNotifications({ tag })).map((alert) => alert.data?.alert_id));
  } catch {
    return new Set();
  }
}

async function closeEarlierAlerts(tag, earlier) {
  if (earlier.size === 0) return;
  try {
    for (const alert of await self.registration.getNotifications({ tag })) {
      if (earlier.has(alert.data?.alert_id)) alert.close();
    }
  } catch {
    /* the new alert is up: a failed clean-up leaves only the old ones */
  }
}

// Answer buttons (#2916): an alert for a question the server found answerable whole (server/push.ts
// promptActions) carries its options as buttons. A tap answers through POST /api/pane/prompt/answer
// with the prompt's id, so the server's own check decides: a prompt that changed or was answered on
// another device takes nothing, and a new alert says so; its tap opens the pane. Where a platform shows no
// buttons (iOS), the alert is as it was.
function answerButtons(payload) {
  if (typeof payload.prompt_id !== "string" || !payload.pane_id || (payload.machine_id || "local") !== "local") return null;
  if (!Array.isArray(payload.actions)) return null;
  const answers = payload.actions.slice(0, 2).filter((action) => Number.isInteger(action?.option_index) && typeof action.label === "string" && action.label !== "");
  return answers.length > 0 ? answers : null;
}

/** The answer a button picked, sent; a new alert in its place when it did not take. */
async function answerFromAlert(data, index) {
  const answer = data.actions[index];
  if (!answer) return;
  let body;
  try {
    const response = await self.fetch("/api/pane/prompt/answer", {
      method: "POST",
      headers: { "content-type": "application/json", "x-herdr-machine": "1" },
      body: JSON.stringify({ pane_id: data.pane_id, prompt_id: data.prompt_id, option_index: answer.option_index }),
    });
    if (response.ok) return;
    body = response.status === 409 ? "This question changed or was already answered. Tap to open it." : "The answer may not have gone through. Tap to open the question.";
  } catch {
    body = "The answer may not have gone through. Tap to open the question.";
  }
  // the tapped alert is closed: one showing under its tag now is the pane's newer alert, which says what holds now
  try {
    if ((await self.registration.getNotifications({ tag: data.tag })).length > 0) return;
  } catch {
    /* no listing: the follow-up shows */
  }
  // and one whose push came in while that was listed: checked with no wait before the notice goes up
  const latest = latestAlerts.get(data.tag);
  if (latest !== undefined && latest !== data.alert_id) return;
  await self.registration.showNotification(data.title, {
    body,
    tag: data.tag,
    data: { pane_id: data.pane_id, machine_id: data.machine_id, workspace_id: data.workspace_id, alert_id: crypto.randomUUID() },
    icon: BRAND.icon,
    badge: BRAND.badge,
  });
}

/** the newest alert each tag was given in this worker's life, noted as its push arrives (answerFromAlert) */
const latestAlerts = new Map();

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    payload = { body: event.data ? event.data.text() : "" };
  }
  // noted before anything is awaited: an answer's notice that comes back meanwhile sees it is no longer the newest
  const tag = payload.tag || "herdr";
  const alertId = crypto.randomUUID();
  latestAlerts.set(tag, alertId);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const watching = windows.some((client) => client.visibilityState === "visible");
      const earlier = await earlierAlerts(tag);
      const answers = answerButtons(payload);
      await self.registration.showNotification(payload.title || BRAND.name, {
        body: payload.body || "",
        tag,
        renotify: !watching,
        silent: watching,
        ...(answers ? { actions: answers.map((answer, index) => ({ action: `answer-${index}`, title: answer.label })) } : {}),
        data: {
          pane_id: payload.pane_id || null, machine_id: payload.machine_id || "local", workspace_id: payload.workspace_id || null, alert_id: alertId,
          ...(answers ? { prompt_id: payload.prompt_id, actions: answers, title: payload.title || BRAND.name, tag } : {}),
        },
        icon: BRAND.icon,
        // Android's status bar and small icon: white on transparent, or Chrome's bell
        badge: BRAND.badge,
      });
      await closeEarlierAlerts(tag, earlier);
    })(),
  );
});

/**
 * A window that runs the app and so takes a "select-pane": the shell's own paths only. Not a
 * markdown reader tab (`?read=`; src/lib/fileReader.ts renders FileReader there instead of App),
 * nor a raw file or HTML page the file viewer opened in a tab of its own (those are /api/
 * responses), nor any shipped file (an icon, /social-preview.png, a notice): a path whose last
 * part has an extension is a file, except the shell's own index.html.
 */
function isAppWindow(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const path = parsed.pathname;
  if (path.startsWith("/api/") || path === "/ws") return false;
  const last = path.slice(path.lastIndexOf("/") + 1);
  if (last.includes(".") && last !== "index.html") return false;
  return (parsed.searchParams.get("read") ?? "").trim() === "";
}

// Tap: bring the app forward on that pane - an open window is told which pane
// (App listens), a closed app opens on /?pane=<id>.
let latestNotificationClick = 0;
let latestNotificationSelection = null;
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const button = /^answer-(\d)$/.exec(event.action || "");
  if (button && event.notification.data?.prompt_id) {
    event.waitUntil(answerFromAlert(event.notification.data, Number(button[1])));
    return;
  }
  const click = ++latestNotificationClick;
  const paneId = event.notification.data ? event.notification.data.pane_id : null;
  const machineId = event.notification.data?.machine_id || "local";
  // the workspace the pane was last seen in: an ended pane's tap opens it (src/lib/deepLink.ts)
  const workspaceId = event.notification.data?.workspace_id || null;
  const selection = paneId ? { type: "select-pane", pane_id: paneId, machine_id: machineId, view: "chat", ...(workspaceId ? { workspace_id: workspaceId } : {}) } : null;
  // Remember the intent before any lookup: an older focus can finish while this one
  // is still finding its window.
  latestNotificationSelection = selection;
  // a tapped pane alert, for the daily anonymous usage counts (server/telemetry.ts): posted only when
  // the server says the counts are on and their notice was shown, so nothing tells it of a tap while
  // they are off; a refusal (signed out, an older server) changes nothing
  if (paneId && typeof self.fetch === "function") {
    event.waitUntil((async () => {
      const status = await self.fetch("/api/telemetry", { cache: "no-store" });
      if (!status.ok) return;
      const counts = await status.json();
      if (counts?.enabled !== true || counts.blocked_by_env !== false || counts.notice_seen !== true) return;
      await self.fetch("/api/telemetry", {
        method: "POST",
        headers: { "content-type": "application/json", "x-herdr-update": "1" },
        body: JSON.stringify({ alert_opened: true }),
      });
    })().catch(() => {}));
  }
  event.waitUntil(
    (async () => {
      // only an app window handles the selection: focusing a reader tab would swallow the tap
      const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
        .filter((client) => isAppWindow(client.url));
      if (click !== latestNotificationClick) return;
      const home = "/";
      const url = paneId ? `${home}?machine=${encodeURIComponent(machineId)}${workspaceId ? `&ws=${encodeURIComponent(workspaceId)}` : ""}&pane=${encodeURIComponent(paneId)}&view=chat` : home;
      const selectLatest = (client) => { if (client && latestNotificationSelection) client.postMessage(latestNotificationSelection); };
      const open = async () => {
        // An opening can also finish after a newer tap. Repair that returned
        // window, while its URL still selects the original pane on a cold start.
        selectLatest(await self.clients.openWindow(url));
      };
      const target = windows.find((client) => client.focused) || windows[0];
      if (target) {
        const select = () => { if (selection) target.postMessage(selection); };
        // Name the pane before focus(): a focus() that iOS refuses or resolves late must not
        // swallow it. A page frozen in the background may need the selection again
        // once its focus completes.
        select();
        try {
          await target.focus();
        } catch (err) {
          // that window cannot be brought forward: open the app on the pane instead
          if (click === latestNotificationClick) await open();
          return;
        }
        // Different windows finish focus independently. A late older focus can put
        // its window in front after a newer tap focused another one. Give whichever
        // window just came forward the latest selection, without another focus loop.
        selectLatest(target);
        return;
      }
      await open();
    })(),
  );
});

// The browser rotated the subscription (Firefox does; Chrome rarely): hand the server
// the new endpoint and drop the old one, or pushes stop until the app is next opened.
self.addEventListener("pushsubscriptionchange", (event) => {
  const post = (method, body) =>
    fetch("/api/push/subscribe", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  event.waitUntil(
    (async () => {
      const previous = event.oldSubscription;
      let fresh = event.newSubscription;
      if (!fresh) {
        const key = previous && previous.options.applicationServerKey
          ? previous.options.applicationServerKey
          : (await (await fetch("/api/push")).json()).public_key;
        fresh = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await post("POST", { subscription: fresh.toJSON() });
      if (previous) await post("DELETE", { endpoint: previous.endpoint });
    })(),
  );
});
