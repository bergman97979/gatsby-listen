(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const rows = Array.from(document.querySelectorAll(".chapters .track"));
  const play = byId("play"), notice = byId("notice");
  const base = new URL(window.GATSBY_MEDIA_ROOT || "./media/", document.baseURI);
  const library = rows.map((row, index) => {
    const number = String(index + 1).padStart(2, "0");
    const start = Number(row.dataset.start);
    const minutes = String(Math.floor(start / 60) % 60).padStart(2, "0");
    const seconds = String(start % 60).padStart(2, "0");
    return {
      title: row.querySelector("strong").textContent,
      english: row.querySelector("em").textContent,
      start: Math.floor(start / 3600) + ":" + minutes + ":" + seconds,
      duration: row.querySelector("time").textContent,
      url: new URL(number + ".m4a", base).href,
    };
  });
  function mediaURL(index) {
    if (window.GATSBY_TRACK_URL) return window.GATSBY_TRACK_URL(index);
    const url = new URL(library[index].url);
    if (url.origin === location.origin && /^https?:$/.test(url.protocol)) url.searchParams.set("offline", "1");
    return url.href;
  }
  const audio = byId("audio") || byId("audio-slot").appendChild(document.createElement("audio"));
  audio.id = "audio";
  audio.controls = true;
  audio.setAttribute("controlslist", "nodownload");
  audio.preload = "none";
  audio.setAttribute("aria-label", "章节播放与进度");

  const key = "gatsby.audio.chapters.v2";
  let selected = -1;
  let pendingOffset = 0;
  let lastSaved = 0;

  const subtitleToggle = byId("subtitle-toggle");
  const subtitlePanel = byId("subtitle-panel");
  const subtitleStatus = byId("subtitle-status");
  const subtitleEnglish = byId("subtitle-en"), subtitleChinese = byId("subtitle-zh");
  const singleChoice = byId("subtitle-mode-single"), passageChoice = byId("subtitle-mode-passage");
  const passageText = byId("subtitle-passage");
  const glossToggle = byId("gloss-toggle"), wordNote = byId("word-note");
  const glossKey = "gatsby.subtitle-glosses.v1";
  let selectedWord = null, selectedGloss = null;
  const subtitleKey = "gatsby.bilingual-subtitles.v1";
  const modeKey = "gatsby.subtitle-mode.v1";
  const subtitleLoads = new Map();
  let subtitlesEnabled = false, activeCues = null, visibleCue = null;
  let passagePositions = [], visiblePassage = null, highlightedPair = null;
  let manuallyReading = false;
  try {
    subtitlesEnabled = localStorage.getItem(subtitleKey) === "on";
    if (localStorage.getItem(modeKey) === "passage") passageChoice.checked = true;
    if (glossToggle) glossToggle.checked = localStorage.getItem(glossKey) !== "off";
  } catch (_) {}
  if (glossToggle) byId("gloss-hint").hidden = !glossToggle.checked;

  function closeWordNote(restoreFocus = false, followAudio = true) {
    if (!selectedWord) return;
    const trigger = selectedWord;
    for (const mark of selectedGloss.marks) mark.setAttribute("aria-expanded", "false");
    wordNote.hidden = true;
    selectedWord = selectedGloss = null;
    if (followAudio) syncSubtitles();
    if (restoreFocus) (trigger.isConnected ? trigger : glossToggle).focus({preventScroll:true});
  }

  function positionWordNote() {
    if (!wordNote || wordNote.hidden) return;
    const gap = 8, height = document.documentElement.clientHeight, width = document.documentElement.clientWidth;
    const box = wordNote.getBoundingClientRect();
    const anchor = selectedWord?.isConnected ? selectedWord.getBoundingClientRect() : null;
    // Keep the two subtitle lines visible together when there is room for the note.
    const pair = selectedWord?.isConnected ? selectedWord.closest(".subtitle-pair, #subtitle-single").getBoundingClientRect() : null;
    let x = box.left, y = box.top;
    if (anchor && anchor.bottom > 0 && anchor.top < height) {
      x = anchor.left;
      if (pair.bottom + gap + box.height <= height - gap) y = pair.bottom + gap;
      else if (pair.top - gap - box.height >= gap) y = pair.top - gap - box.height;
      else y = anchor.top > height / 2 ? anchor.top - gap - box.height : anchor.bottom + gap;
    }
    wordNote.style.left = Math.max(gap, Math.min(x, width - box.width - gap)) + "px";
    wordNote.style.top = Math.max(gap, Math.min(y, height - box.height - gap)) + "px";
  }

  function openWordNote(button, gloss, keyboard) {
    if (selectedWord === button) { closeWordNote(); return; }
    closeWordNote(false, false);
    selectedWord = button;
    selectedGloss = gloss;
    const entry = gloss.entry;
    for (const mark of gloss.marks) mark.setAttribute("aria-expanded", "true");
    byId("note-term").textContent = entry[0];
    byId("note-zh").textContent = entry[1];
    byId("note-en").textContent = entry[2];
    wordNote.hidden = false;
    positionWordNote();
    if (keyboard) byId("note-close").focus({preventScroll:true});
  }

  byId("note-close")?.addEventListener("click", () => closeWordNote(true));
  byId("note-close")?.addEventListener("keydown", event => {
    // Let the native Tab continue from the word in reading order.
    if (event.key === "Tab") closeWordNote(true);
  });
  document.addEventListener("click", event => {
    if (selectedWord && !wordNote.contains(event.target) && !event.target.closest(".gloss-word")) closeWordNote();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && selectedWord) {
      event.preventDefault();
      closeWordNote(true);
    }
  });
  window.addEventListener("resize", positionWordNote);
  document.addEventListener("scroll", positionWordNote, {capture:true, passive:true});

  const glossTones = ["jade", "umber", "indigo", "plum", "slate", "olive"];

  function appendMarkedLine(target, original, glosses, termField) {
    const matches = [];
    for (const gloss of glosses) {
      const term = gloss.entry[termField];
      if (!term) continue;
      const start = original.indexOf(term);
      if (start >= 0) matches.push({gloss, start, term});
    }
    // Place each mark in its own language's word order while keeping the pair's style.
    matches.sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const {gloss, start, term} of matches) {
      if (start < cursor) continue;
      target.append(original.slice(cursor, start));
      const mark = document.createElement("button");
      mark.type = "button";
      mark.className = "gloss-word";
      mark.dataset.tone = gloss.tone;
      mark.textContent = term;
      mark.setAttribute("aria-expanded", "false");
      mark.setAttribute("aria-haspopup", "dialog");
      mark.setAttribute("aria-controls", "word-note");
      mark.addEventListener("click", event => openWordNote(mark, gloss, event.detail === 0));
      gloss.marks.push(mark);
      target.append(mark);
      cursor = start + term.length;
    }
    target.append(original.slice(cursor));
  }

  function renderSubtitlePair(english, chinese, fragments) {
    const en = document.createDocumentFragment(), zh = document.createDocumentFragment();
    let toneIndex = 0;
    for (const [index, cue] of fragments.entries()) {
      if (index) en.append(" ");
      // Match within the original timed cue, even when joining fragments in passage mode.
      const entries = glossToggle?.checked && Array.isArray(cue[6]) ? cue[6] : [];
      const glosses = entries.filter(entry => Array.isArray(entry) && entry[0] && entry[1] && entry[2] && cue[2].includes(entry[0]))
        .sort((a, b) => cue[2].indexOf(a[0]) - cue[2].indexOf(b[0]))
        .map(entry => ({entry, tone:glossTones[toneIndex++ % glossTones.length], marks:[]}));
      appendMarkedLine(en, cue[2], glosses, 0);
      appendMarkedLine(zh, cue[3], glosses, 3);
    }
    english.replaceChildren(en);
    chinese.replaceChildren(zh);
  }

  glossToggle?.addEventListener("change", () => {
    closeWordNote();
    byId("gloss-hint").hidden = !glossToggle.checked;
    try { localStorage.setItem(glossKey, glossToggle.checked ? "on" : "off"); } catch (_) {}
    visibleCue = undefined;
    visiblePassage = null;
    syncSubtitles();
  });

  function indexPassages(cues) {
    const hasGroups = cues.every(cue => Number.isInteger(cue[4]) && cue[4] > 0);
    const hasPairs = cues.every(cue => Number.isInteger(cue[5]) && cue[5] > 0);
    const pairs = [];
    cues.forEach((cue, index) => {
      const previous = cues[index - 1];
      const continues = previous && (!hasGroups || cue[4] === previous[4]) &&
        (hasPairs ? cue[5] === previous[5] : !/^Chapter \w+$/i.test(previous[2]) &&
          !/[.!?…][”’"')\]]*$/.test(previous[2]));
      if (continues) {
        const pair = pairs[pairs.length - 1];
        pair.fragments.push(cue);
      } else {
        pairs.push({first:index, group:cue[4], fragments:[cue]});
      }
    });
    const positions = [];
    let group, lastGroup;
    // Older chapter files have no group IDs. Keep five sentence pairs together
    // and fold a short final group into the preceding one.
    const firstIsTitle = pairs.length && /^Chapter \w+$/i.test(pairs[0].fragments[0][2]) ? 1 : 0;
    const fallbackGroups = Math.max(1, Math.floor((pairs.length - firstIsTitle) / 5));
    pairs.forEach((pair, index) => {
      const fallback = Math.max(0, Math.floor((index - firstIsTitle) / 5));
      const groupId = hasGroups ? pair.group : Math.min(fallbackGroups - 1, fallback);
      if (!group || groupId !== lastGroup) {
        group = [];
        lastGroup = groupId;
      }
      const position = {group, line:group.length};
      group.push(pair);
      const end = index + 1 < pairs.length ? pairs[index + 1].first : cues.length;
      for (let i = pair.first; i < end; i++) positions[i] = position;
    });
    return positions;
  }

  function revealSpokenPair() {
    if (manuallyReading || !highlightedPair || !passageText.clientHeight) return;
    const line = highlightedPair.getBoundingClientRect();
    const panel = passageText.getBoundingClientRect();
    if (line.top < panel.top || line.height >= panel.height) passageText.scrollTop += line.top - panel.top;
    else if (line.bottom > panel.bottom) passageText.scrollTop += line.bottom - panel.bottom;
  }

  // A reader can review the rest of this passage without fighting the audio.
  for (const type of ["wheel", "touchmove"]) {
    passageText.addEventListener(type, () => { manuallyReading = true; }, {passive:true});
  }
  passageText.addEventListener("pointermove", event => {
    if (event.buttons === 1) manuallyReading = true;
  });
  passageText.addEventListener("keydown", event => {
    if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp", " "].includes(event.key)) manuallyReading = true;
  });
  window.addEventListener("resize", revealSpokenPair);

  function showPassage(index, speaking) {
    const position = passagePositions[index];
    if (visiblePassage !== position.group) {
      const content = document.createDocumentFragment();
      for (const pair of position.group) {
        const row = document.createElement("div");
        row.className = "subtitle-pair";
        const english = document.createElement("p"), chinese = document.createElement("p");
        english.lang = "en";
        chinese.lang = "zh-CN";
        row.append(english, chinese);
        renderSubtitlePair(english, chinese, pair.fragments);
        content.append(row);
      }
      passageText.replaceChildren(content);
      passageText.scrollTop = 0;
      manuallyReading = false;
      visiblePassage = position.group;
      highlightedPair = null;
    }
    const current = speaking ? passageText.children[position.line] : null;
    if (current !== highlightedPair) {
      if (highlightedPair) highlightedPair.removeAttribute("aria-current");
      if (current) current.setAttribute("aria-current", "true");
      highlightedPair = current;
      revealSpokenPair();
    }
  }

  function displayMode() {
    byId("subtitle-single").hidden = passageChoice.checked;
    passageText.hidden = !passageChoice.checked;
    byId("player").classList.toggle("subtitles-on", subtitlesEnabled);
    byId("player").classList.toggle("passage-reading", subtitlesEnabled && passageChoice.checked);
  }

  function resetSubtitleText(status) {
    visibleCue = null;
    visiblePassage = null;
    highlightedPair = null;
    passageText.replaceChildren();
    renderSubtitlePair(subtitleEnglish, subtitleChinese, []);
    subtitleStatus.textContent = status;
  }
  function syncSubtitles() {
    if (selectedWord || !subtitlesEnabled || !activeCues || !activeCues.length) return;
    const seconds = audio.currentTime;
    let lo = 0, hi = activeCues.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (activeCues[mid][0] <= seconds) lo = mid + 1;
      else hi = mid;
    }
    const previous = activeCues[lo - 1];
    const cue = previous && seconds < previous[1] ? previous : null;
    const status = lo === 0 && !passageChoice.checked ? "字幕将在朗读开始时出现。" : "";
    if (subtitleStatus.textContent !== status) subtitleStatus.textContent = status;
    if (passageChoice.checked) {
      showPassage(Math.max(0, lo - 1), Boolean(cue));
      return;
    }
    if (cue === visibleCue) return;
    visibleCue = cue;
    renderSubtitlePair(subtitleEnglish, subtitleChinese, cue ? [cue] : []);
  }
  async function readCues(chapter) {
    let cues = window.GATSBY_SUBTITLES?.[chapter];
    if (cues === undefined) {
      const base = new URL(window.GATSBY_SUBTITLE_ROOT || "./subtitles/", document.baseURI);
      const file = String(chapter + 1).padStart(2, "0") + ".json";
      const response = await fetch(new URL(file, base), {credentials:"omit", referrerPolicy:"no-referrer"});
      if (!response.ok) throw new Error("Subtitle request failed");
      cues = await response.json();
    }
    if (!Array.isArray(cues) || !cues.every((cue, i) =>
      Array.isArray(cue) && Number.isFinite(cue[0]) && Number.isFinite(cue[1]) &&
      cue[0] >= 0 && cue[1] > cue[0] && (i === 0 || cue[0] >= cues[i-1][0]) &&
      typeof cue[2] === "string" && typeof cue[3] === "string"
    )) throw new Error("Invalid subtitles");
    return cues;
  }
  async function loadSubtitles() {
    closeWordNote();
    activeCues = null;
    displayMode();
    subtitleToggle.setAttribute("aria-checked", String(subtitlesEnabled));
    subtitlePanel.hidden = !subtitlesEnabled;
    if (!subtitlesEnabled) return;
    const chapter = selected;
    resetSubtitleText("正在加载本章字幕…");
    let load = subtitleLoads.get(chapter);
    if (!load) {
      load = readCues(chapter);
      subtitleLoads.set(chapter, load);
    }
    try {
      const cues = await load;
      if (chapter !== selected || !subtitlesEnabled) return;
      activeCues = cues;
      passagePositions = indexPassages(cues);
      if (!cues.length) resetSubtitleText("这一章暂无字幕。");
      else syncSubtitles();
    } catch (_) {
      if (subtitleLoads.get(chapter) === load) subtitleLoads.delete(chapter);
      if (chapter === selected && subtitlesEnabled) resetSubtitleText("字幕暂时无法载入，可关掉字幕再打开重试。");
    }
  }
  subtitleToggle.addEventListener("click", () => {
    subtitlesEnabled = !subtitlesEnabled;
    try { localStorage.setItem(subtitleKey, subtitlesEnabled ? "on" : "off"); } catch (_) {}
    loadSubtitles();
  });
  for (const choice of [singleChoice, passageChoice]) {
    choice.addEventListener("change", () => {
      if (!choice.checked) return;
      closeWordNote();
      try { localStorage.setItem(modeKey, choice.value); } catch (_) {}
      displayMode();
      syncSubtitles();
      if (passageChoice.checked) {
        manuallyReading = false;
        revealSpokenPair();
      }
    });
  }
  audio.addEventListener("seeking", () => { manuallyReading = false; });
  for (const event of ["timeupdate", "seeking", "seeked", "loadedmetadata", "pause", "ratechange", "ended"]) {
    audio.addEventListener(event, syncSubtitles);
  }
  audio.addEventListener("seeked", revealSpokenPair);

  const playerView = byId("player"), chapterView = byId("chapters");
  const openLibrary = byId("open-library"), backToPlayer = byId("back-to-player");
  let readingOffset = 0;
  let readingPassage = null, readingPair = null, passageOffset = 0;
  let libraryEntry;

  function showLibrary(open, focus = true) {
    if (open === !chapterView.hidden) return;
    if (open) {
      closeWordNote();
      readingOffset = window.scrollY;
      readingPassage = visiblePassage;
      readingPair = highlightedPair;
      passageOffset = passageText.scrollTop;
    }
    playerView.hidden = open;
    chapterView.hidden = !open;
    openLibrary.hidden = open;
    backToPlayer.hidden = !open;
    window.scrollTo(0, open ? 0 : readingOffset);
    if (!open) {
      if (readingPassage === visiblePassage) passageText.scrollTop = passageOffset;
      if (readingPair !== highlightedPair) revealSpokenPair();
    }
    if (focus) (open ? backToPlayer : openLibrary).focus({preventScroll:true});
  }
  openLibrary.addEventListener("click", () => {
    try {
      history.scrollRestoration = "manual";
      history.pushState({...history.state, gatsbyLibrary:libraryEntry}, "");
    } catch (_) { /* Standalone file viewers can restrict the History API. */ }
    showLibrary(true);
  });
  function returnToPlayer() {
    if (chapterView.hidden) return;
    showLibrary(false);
    if (history.state?.gatsbyLibrary === libraryEntry) history.back();
  }
  backToPlayer.addEventListener("click", returnToPlayer);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.defaultPrevented && !chapterView.hidden) {
      event.preventDefault();
      returnToPlayer();
    }
  });
  function openListeningView() {
    // Only a directory entry created during this visit can reopen it on Forward.
    libraryEntry = Math.random().toString(36);
    const url = new URL(location.href);
    if (url.searchParams.get("view") === "downloads" || history.state?.gatsbyLibrary) {
      if (url.searchParams.get("view") === "downloads") url.searchParams.delete("view");
      const state = {...history.state};
      delete state.gatsbyLibrary;
      try { history.replaceState(state, "", url.href); } catch (_) {}
    }
    showLibrary(false, false);
  }
  window.addEventListener("popstate", () => showLibrary(history.state?.gatsbyLibrary === libraryEntry));
  window.addEventListener("pageshow", event => { if (event.persisted) openListeningView(); });
  openListeningView();

  function message(text) {
    notice.textContent = text;
    notice.hidden = !text;
  }
  function updateState() {
    const playing = !audio.paused && !audio.ended && !audio.error;
    const text = audio.error ? "加载失败" : audio.ended ? "已播完" : playing ? "正在播放" :
      audio.currentTime > 0 ? "已暂停" : "所选章节";
    byId("player-state").textContent = text;
    play.classList.toggle("is-playing", playing);
    play.setAttribute("aria-label", (playing ? "暂停" : "播放") + library[selected].title);
  }
  function savePosition() {
    if (selected < 0 || pendingOffset > 0 || !Number.isFinite(audio.currentTime)) return;
    try {
      if (audio.ended && selected === rows.length - 1) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify({index:selected, seconds:audio.currentTime}));
    } catch (_) {}
  }
  function select(index, seconds = 0) {
    if (selected >= 0) rows[selected].removeAttribute("aria-current");
    selected = index;
    const track = library[index];
    rows[index].setAttribute("aria-current", "true");
    byId("current").replaceChildren(document.createTextNode(track.title + " "), rows[index].querySelector("em").cloneNode(true));
    byId("library-current").textContent = "当前章节 · " + track.title;
    byId("range").textContent = "本章时长 " + track.duration + " · 全书起点 " + track.start;
    play.href = rows[index].href;
    message("");
    pendingOffset = seconds;
    audio.src = mediaURL(index);
    if (seconds > 0) audio.preload = "metadata";
    updateState();
    loadSubtitles();
  }
  function start() {
    const index = selected;
    message("");
    if (audio.error) audio.load();
    audio.play().catch(error => {
      if (selected !== index || error.name === "AbortError") return;
      message(error.name === "NotAllowedError" ? "轻点播放器里的播放键即可开始。" : "音频暂时无法播放，请稍后再试。");
    });
  }
  function ordinaryClick(event) {
    return !(event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0);
  }
  rows.forEach((row,index) => {
    row.href = library[index].url;
    row.addEventListener("click", event => {
      if (!ordinaryClick(event)) return;
      event.preventDefault();
      if (index !== selected || audio.ended) {
        select(index);
        readingOffset = 0;
        readingPassage = null;
      }
      returnToPlayer();
      play.focus({preventScroll:true});
      start();
    });
  });
  // Without JavaScript this remains a normal audio-file link.
  play.setAttribute("role", "button");
  play.addEventListener("keydown", event => {
    if (event.key === " ") event.preventDefault();
  });
  play.addEventListener("keyup", event => {
    if (event.key === " ") {
      event.preventDefault();
      play.click();
    }
  });
  play.addEventListener("click", event => {
    if (!ordinaryClick(event)) return;
    event.preventDefault();
    if (audio.paused || audio.ended) start();
    else audio.pause();
  });
  audio.addEventListener("loadedmetadata", () => {
    if (pendingOffset > 0 && Number.isFinite(audio.duration)) {
      audio.currentTime = Math.min(pendingOffset, Math.max(0, audio.duration - 0.1));
      pendingOffset = 0;
    }
  });
  audio.addEventListener("play", () => { message(""); updateState(); });
  audio.addEventListener("pause", () => { updateState(); savePosition(); });
  audio.addEventListener("seeked", savePosition);
  audio.addEventListener("timeupdate", () => {
    if (!audio.paused && Date.now() - lastSaved > 3000) {
      savePosition(); lastSaved = Date.now();
    }
  });
  audio.addEventListener("ended", () => {
    if (selected === rows.length - 1) {
      savePosition();
      updateState();
    } else {
      select(selected + 1);
      start();
    }
  });
  audio.addEventListener("error", () => {
    updateState();
    message("音频暂时无法载入，请点播放重试。");
  });
  window.addEventListener("pagehide", savePosition);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) savePosition();
  });
  let initial = 0, seconds = 0;
  const requested = new URLSearchParams(location.search).get("chapter");
  if (/^[1-9]$/.test(requested || "")) initial = Number(requested) - 1;
  else {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      if (saved && Number.isInteger(saved.index) && library[saved.index] && Number.isFinite(saved.seconds) && saved.seconds >= 0) {
        initial = saved.index; seconds = saved.seconds;
      }
    } catch (_) {}
  }
  select(initial, seconds);
  if (seconds > 0) message("上次听到本章 " + Math.floor(seconds / 60) + " 分 " + Math.floor(seconds % 60) + " 秒，点播放继续。");
})();
