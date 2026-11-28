// Bump this revision when the player or its captions change. Audio is keyed by digest.
const revision = "2026-11-28-3";
const scope = self.registration.scope;
const prefix = "gatsby-listen:" + scope + ":";
const audioCacheName = prefix + "audio";
const metadataCacheName = prefix + "state";
const bundleCacheName = prefix + "player-" + revision;
const absolute = path => new URL(path, scope).href;
const readyKey = absolute(".offline/complete");
const mediaHashes = [
  "48da4845f65ee142dff081705b1f06c2696a1fc3140119a273c3a6ece9ac97b3",
  "187f3df7bdd7d5c352602742503ab2a6ef457ad9de3d9840444b7e4c223cdfd8",
  "f281a8ba8436e62c324047679f626164ae115552f748b5655ea1da8cf3d30f62",
  "1c73577200e5e9e43eb0e660d28e202e1451fdd0d0e3dad4df574392309e2e16",
  "a0db54feb58594cb9e3914297bc494cd244823dce22541fafb492d54c57a076d",
  "a3222a0fe30f39e09fb2131731d6e7d814a186b493e0f2e8a9e1c115aff7dbec",
  "39edae162f6cdde51aa2e7b5e7b8f264974a83c47ab8dbc0f4c98eb43a8617e2",
  "ec4f7af5643fa6eae0d9b054f8c3d95e4a4af7771cbc8f9be8e2fd23b2a7748f",
  "5f4827d98f2c346646510eeb1be01d7bc601923ea7c8c04b31e75acb8abbd3f4"
];
const chapters = mediaHashes.map((hash, i) => {
  const number = String(i + 1).padStart(2, "0");
  return {media:"media/" + number + ".m4a", captions:"subtitles/" + number + ".json", key:absolute(".offline/audio/" + hash), hash};
});
const assets = ["index.html", "listen.js", "listen.css", "offline.js", "config.js",
  "app.webmanifest", "app-192.png", "app-512.png", ...chapters.map(chapter => chapter.captions)];
const total = chapters.length;
const ports = new Set();
let saving = null;
let completed = 0;
let lastFailure = null;

function sameRecordings(bundle) {
  return chapters.every((chapter, i) => chapter.key === bundle.audio[i]);
}

// Stage a complete replacement while the previous worker still serves its own
// bundle. An interrupted update leaves the previously downloaded book intact.
self.addEventListener("install", event => event.waitUntil((async () => {
  const previous = await activeBundle();
  if (previous && previous.cache !== bundleCacheName && sameRecordings(previous) && await isComplete(previous)) {
    await stagePlayer();
    await self.skipWaiting();
  }
})()));

self.addEventListener("activate", event => event.waitUntil((async () => {
  const previous = await activeBundle();
  if (previous && previous.cache !== bundleCacheName && sameRecordings(previous) && await isComplete(nextBundle())) {
    await publishPlayer(previous);
  }
  await self.clients.claim();
})()));

async function activeBundle() {
  const marker = await caches.match(readyKey, {cacheName:metadataCacheName});
  const bundle = marker && await marker.json().catch(() => null);
  return typeof bundle?.cache === "string" && bundle.cache.startsWith(prefix + "player-") &&
    Array.isArray(bundle.audio) && bundle.audio.length === total && Array.isArray(bundle.assets) ? bundle : null;
}

async function isComplete(bundle) {
  if (!bundle) return false;
  const [audioKeys, shellKeys] = await Promise.all([
    caches.open(audioCacheName).then(cache => cache.keys()),
    caches.open(bundle.cache).then(cache => cache.keys())
  ]);
  const media = new Set(audioKeys.map(request => request.url));
  const shell = new Set(shellKeys.map(request => request.url));
  return bundle.audio.every(key => media.has(key)) &&
    bundle.assets.every(path => shell.has(absolute(path)));
}

function notify(state, reason) {
  const message = {state, completed, total, reason};
  for (const port of ports) port.postMessage(message);
}

async function load(path) {
  const response = await fetch(absolute(path), {credentials:"same-origin", cache:"no-store"});
  if (response.url !== absolute(path) && !(path === "index.html" && requestedPage(new URL(response.url)))) {
    throw new Error("Unexpected redirect");
  }
  if (response.status !== 200) throw new Error("Incomplete download");
  return response;
}

async function storeAsset(cache, path) {
  const response = await load(path);
  const bytes = await response.arrayBuffer();
  if (path.endsWith(".png")) {
    const view = new Uint8Array(bytes);
    if (view[0] !== 137 || view[1] !== 80 || view[2] !== 78 || view[3] !== 71) throw new Error("Invalid icon");
  } else {
    const text = new TextDecoder().decode(bytes);
    if (path === "index.html") {
      if (!text.includes('id="player"') || !text.includes("offline.js")) throw new Error("Invalid player");
    } else if (path.endsWith(".json")) {
      const cues = JSON.parse(text);
      if (!Array.isArray(cues) || !cues.length || !cues.every(cue =>
        Number.isFinite(cue[0]) && Number.isFinite(cue[1]) && typeof cue[2] === "string" && typeof cue[3] === "string"
      )) throw new Error("Invalid subtitles");
    } else if (path.endsWith(".webmanifest")) {
      if (!JSON.parse(text).start_url) throw new Error("Invalid manifest");
    } else if (!text.trim() || /^\s*</.test(text)) {
      throw new Error("Invalid player asset");
    }
  }
  // Rebuild from validated bytes so transfer encodings and request-specific Vary values are not replayed.
  const headers = new Headers(response.headers);
  for (const field of ["content-encoding", "transfer-encoding", "vary"]) headers.delete(field);
  headers.set("content-length", String(bytes.byteLength));
  await cache.put(absolute(path), new Response(bytes, {headers}));
}

async function storeChapter(cache, chapter) {
  if (await cache.match(chapter.key)) return;
  const response = await load(chapter.media + "?offline=1");
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hex !== chapter.hash) throw new Error("Audio checksum mismatch");
  await cache.put(chapter.key, new Response(bytes, {headers:{
    "Content-Type":"audio/mp4", "Content-Length":String(bytes.byteLength), "Accept-Ranges":"bytes", "ETag":'"' + hex + '"'
  }}));
}

async function stagePlayer() {
  const shell = await caches.open(bundleCacheName);
  const transfers = await Promise.allSettled(assets.map(path => storeAsset(shell, path)));
  const failed = transfers.find(item => item.status === "rejected");
  if (failed) throw failed.reason;
}

function nextBundle() {
  return {cache:bundleCacheName, audio:chapters.map(chapter => chapter.key), assets};
}

async function publishPlayer(previous) {
  const meta = await caches.open(metadataCacheName);
  await meta.put(readyKey, new Response(JSON.stringify(nextBundle())));
  if (previous && previous.cache !== bundleCacheName) await caches.delete(previous.cache);
}

async function save(reuseAudioOnly = false) {
  const previous = await activeBundle();
  if (previous?.cache === bundleCacheName && await isComplete(previous)) {
    completed = total;
    return;
  }
  await stagePlayer();
  const audio = await caches.open(audioCacheName);
  for (const chapter of chapters) {
    if (reuseAudioOnly) {
      if (!(await audio.match(chapter.key))) throw new Error("Saved audio no longer available");
    } else {
      await storeChapter(audio, chapter);
    }
    completed++;
    notify("saving");
  }
  await publishPlayer(previous);
}

function startSave(reuseAudioOnly = false) {
  if (saving) return saving;
  completed = 0;
  lastFailure = null;
  saving = save(reuseAudioOnly).then(() => notify("ready"), error => {
    lastFailure = error.name === "QuotaExceededError" ? "space" : "download";
    notify("error", lastFailure);
  }).finally(() => { ports.clear(); saving = null; });
  return saving;
}

function requestedPage(url) {
  return url.origin === new URL(scope).origin &&
    (url.pathname === new URL(scope).pathname || url.pathname === new URL("index.html", scope).pathname);
}
self.addEventListener("message", event => {
  const port = event.ports[0];
  if (!port || !event.source?.url || !requestedPage(new URL(event.source.url))) return;
  if (event.data?.type === "OFFLINE_STATUS") {
    event.waitUntil((async () => {
      try {
        if (saving) { port.postMessage({state:"saving", completed, total}); return; }
        const bundle = await activeBundle();
        const ready = await isComplete(bundle);
        if (!ready && lastFailure) {
          port.postMessage({state:"error", completed, total, reason:lastFailure});
          return;
        }
        const previousVersion = ready && bundle.cache !== bundleCacheName;
        // A release with new recordings needs an explicit tap. Keep the previously saved book playable.
        if (previousVersion && !sameRecordings(bundle)) {
          port.postMessage({state:"idle", completed:0, total});
          return;
        }
        port.postMessage({state:ready ? "ready" : "idle", completed:ready ? total : 0, total});
        if (previousVersion && self.navigator.onLine) await startSave(true);
      } catch (_) {
        port.postMessage({state:"error", completed:0, total, reason:"download"});
      }
    })());
  } else if (event.data?.type === "OFFLINE_SAVE") {
    ports.add(port);
    const task = startSave();
    port.postMessage({state:"saving", completed, total});
    event.waitUntil(task);
  }
});

async function serveAudio(request, response) {
  const head = request.method === "HEAD";
  const range = request.headers.get("Range");
  const ifRange = request.headers.get("If-Range");
  if (!range || (ifRange && ifRange !== response.headers.get("ETag"))) {
    return head ? new Response(null, {headers:response.headers}) : response;
  }
  const size = Number(response.headers.get("Content-Length"));
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  const invalid = () => new Response(null, {status:416, headers:{"Content-Range":"bytes */" + size,"Accept-Ranges":"bytes"}});
  if (!match || !(match[1] || match[2])) return invalid();
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end || start >= size || !Number.isSafeInteger(start)) return invalid();
  const bytes = head ? null : (await response.blob()).slice(start, end + 1);
  const headers = new Headers(response.headers);
  headers.set("Content-Range", "bytes " + start + "-" + end + "/" + size);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(bytes, {status:206, headers});
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (!["GET", "HEAD"].includes(request.method) || !request.url.startsWith(scope)) return;
  const url = new URL(request.url);
  let path = url.pathname.slice(new URL(scope).pathname.length);
  if (!path) path = "index.html";
  const chapterIndex = chapters.findIndex(chapter => chapter.media === path);
  // Legacy direct downloads must keep their Content-Disposition response and source bytes.
  if (chapterIndex >= 0 && url.search && url.search !== "?offline=1") return;
  if (chapterIndex < 0 && !assets.includes(path)) return;
  const cached = async () => {
    const bundle = await activeBundle();
    if (!bundle) return null;
    const response = chapterIndex < 0
      ? await caches.match(absolute(path), {cacheName:bundle.cache})
      : await caches.match(bundle.audio[chapterIndex], {cacheName:audioCacheName});
    if (!response) return null;
    if (chapterIndex >= 0) return serveAudio(request, response);
    return request.method === "HEAD" ? new Response(null, {headers:response.headers}) : response;
  };
  event.respondWith(cached().catch(() => null).then(response => response || fetch(request)));
});
