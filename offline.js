(() => {
  "use strict";

  const card = document.getElementById("offline-save");
  const button = document.getElementById("offline-download");
  const help = document.getElementById("offline-help");
  const status = document.getElementById("offline-status");
  const scope = new URL("./", location.href).href;
  const script = new URL("offline-worker.js", scope).href;
  let services;
  try {
    const sw = navigator.serviceWorker;
    if (typeof sw?.getRegistration === "function" && typeof sw.register === "function") services = sw;
  } catch (_) { /* Restricted webview. */ }
  const canSave = window.isSecureContext && Boolean(services) &&
    typeof MessageChannel === "function" && /^https?:$/.test(location.protocol);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const inWeChat = /MicroMessenger/i.test(navigator.userAgent) && /^https?:$/.test(location.protocol);
  const appleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let registration, fallback, subscription, refreshTimer;
  let requestId = 0;
  const handoff = document.getElementById("wechat-handoff");

  function showBrowserSteps() {
    handoff.hidden = false;
    document.getElementById("wechat-browser-step").textContent = appleMobile
      ? "若微信里下载不了，点右上角「…」，选择用 Safari 或「在浏览器打开」。找不到这项，就复制链接粘贴到 Safari 地址栏。"
      : "若微信里下载不了，点右上角「…」，选择「在浏览器打开」。找不到这项，就复制链接粘贴到系统浏览器地址栏。";
  }

  document.getElementById("wechat-copy").addEventListener("click", async () => {
    const url = new URL(location.href);
    const copyStatus = document.getElementById("wechat-copy-status");
    const addressBox = document.getElementById("wechat-address-box");
    try {
      await navigator.clipboard.writeText(url.href);
      addressBox.hidden = true;
      copyStatus.textContent = "链接已复制，可以粘贴到浏览器地址栏。";
    } catch (_) {
      addressBox.hidden = false;
      const field = document.getElementById("wechat-address");
      field.value = url.href;
      field.focus();
      field.select();
      copyStatus.textContent = "请选中上面的链接并复制。手机上可长按选择「复制」。";
    }
  });

  function render(state, message, label = "下载九章离线听书版") {
    card.dataset.state = state;
    button.disabled = !["idle", "error", "file"].includes(state) && !(state === "handoff" && canSave);
    button.textContent = label;
    if (status.textContent !== message) status.textContent = message;
    if (state === "ready") handoff.hidden = true;
    help.hidden = !(appleMobile && !standalone && !inWeChat && state === "idle");
    if (!help.hidden) {
      help.textContent = "想从主屏幕离线听？先在 Safari 点「分享」→「添加到主屏幕」，打开新图标后再下载。";
    }
  }

  function offerFallback() {
    if (inWeChat) {
      if (handoff.hidden) render("idle", "包含播放器、全部录音和中英字幕。");
      else render("handoff", "微信中暂时无法保存离线版，请按下方步骤打开。");
    } else if (window.GATSBY_OFFLINE_FILE) {
      fallback = new URL(window.GATSBY_OFFLINE_FILE, document.baseURI);
      render("file", "此浏览器可下载一个 HTML 文件，内含九章录音和中英字幕。");
    } else if (canSave) {
      render("error", "离线功能暂未就绪，联网后再试一次。", "重试下载九章离线听书版");
    } else {
      render("unavailable", "请用 Safari 或 Chrome 打开听书网址，再下载离线版。");
    }
  }

  function exchange(type) {
    const worker = registration?.active;
    if (!worker || worker.state === "redundant") {
      registration = null;
      offerFallback();
      return;
    }
    clearTimeout(refreshTimer);
    if (subscription) subscription.close();
    let channel;
    try {
      channel = new MessageChannel();
    } catch (_) {
      registration = null;
      offerFallback();
      return;
    }
    subscription = channel.port1;
    const id = ++requestId;
    const later = delay => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => exchange("OFFLINE_STATUS"), delay);
    };

    channel.port1.onmessage = ({data}) => {
      if (requestId !== id) return;
      clearTimeout(refreshTimer);
      if (data.state === "saving") {
        const count = Math.min(9, Math.max(0, Number(data.completed) || 0));
        render("saving", "正在保存录音和字幕，请先保持页面打开。", "已保存 " + count + " / 9 章");
        // A second window may own the download. Check back even if this port
        // received only a status snapshot or the first window was suspended.
        later(type === "OFFLINE_SAVE" ? 30000 : 3000);
        return;
      }

      channel.port1.close();
      subscription = null;
      if (data.state === "ready") {
        const where = standalone ? "从主屏幕打开即可离线收听。" : "在这个浏览器重新打开本页，即可离线收听。";
        render("ready", "九章录音和中英字幕已保存。" + where, "已下载九章离线听书版");
      } else if (data.state === "error") {
        const reason = data.reason === "space" ? "设备空间不足，清出空间后可重试。" : "保存中断，请检查网络后重试。";
        render("error", reason, "重试下载九章离线听书版");
      } else {
        render("idle", "包含播放器、全部录音和中英字幕。");
      }
    };
    try {
      worker.postMessage({type}, [channel.port2]);
      if (type === "OFFLINE_SAVE") later(30000);
      else refreshTimer = setTimeout(() => {
        if (id !== requestId) return;
        channel.port1.close();
        subscription = null;
        render("error", "离线状态暂时无法读取，稍后可以重试。", "重试下载九章离线听书版");
      }, 15000);
    } catch (_) {
      channel.port1.close();
      subscription = null;
      registration = null;
      offerFallback();
    }
  }

  async function connect(save = false) {
    if (!canSave) { offerFallback(); return; }
    const id = ++requestId;
    render("checking", save ? "正在准备下载…" : "正在检查离线版…");
    let timer;
    try {
      const findWorker = async () => {
        const existing = await services.getRegistration(scope);
        if (existing?.scope === scope && existing.active?.scriptURL === script) return existing;
        const reg = await services.register(script, {scope, updateViaCache:"none"});
        if (reg.active?.scriptURL === script) return reg;
        return services.ready;
      };
      const reg = await Promise.race([findWorker(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Activation timed out")), 20000);
      })]);
      if (id !== requestId) return;
      if (reg.scope !== scope || reg.active?.scriptURL !== script) throw new Error("Wrong worker scope");
      registration = reg;
      exchange(save ? "OFFLINE_SAVE" : "OFFLINE_STATUS");
    } catch (_) {
      if (id === requestId) offerFallback();
    } finally {
      clearTimeout(timer);
    }
  }

  button.addEventListener("click", () => {
    if (inWeChat) showBrowserSteps();
    if (fallback) {
      const file = document.createElement("a");
      file.href = fallback.href;
      file.download = "盖茨比-九章离线听书.html";
      document.body.append(file);
      file.click();
      file.remove();
      render("file", "已请求下载。文件保存在浏览器的下载位置。");
    } else if (registration) {
      render("saving", "正在准备九章录音和中英字幕…", "正在保存…");
      exchange("OFFLINE_SAVE");
    } else {
      connect(true);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && registration) exchange("OFFLINE_STATUS");
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted && registration) exchange("OFFLINE_STATUS");
  });
  if (inWeChat) {
    // Make the action available even when the embedded browser blocks registration.
    // A previously saved copy can still announce its ready state on a return visit.
    render("idle", "包含播放器、全部录音和中英字幕。");
    if (canSave) Promise.resolve().then(() => services.getRegistration(scope)).then(reg => {
      if (requestId === 0 && reg?.scope === scope && reg.active?.scriptURL === script) {
        registration = reg;
        exchange("OFFLINE_STATUS");
      }
    }).catch(() => {});
  } else {
    connect();
  }
})();
