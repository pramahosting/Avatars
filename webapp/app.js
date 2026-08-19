// Catch absolutely everything, as early as possible - a script error
// anywhere in this file otherwise fails completely silently to anyone
// without devtools open, leaving "Loading..." stuck forever with zero
// visible explanation. This turns that into a message on the page.
function showFatalError(message) {
  let banner = document.getElementById("fatal-error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "fatal-error-banner";
    banner.style.cssText =
      "position:fixed; top:0; left:0; right:0; z-index:99999; background:#3a1d22; " +
      "color:#ff9fa8; padding:12px 16px; font:12px/1.5 ui-monospace,monospace; " +
      "white-space:pre-wrap; max-height:45vh; overflow:auto; border-bottom:2px solid #ff9fa8;";
    document.body.prepend(banner);
  }
  banner.textContent = "Something failed to load on this page. Please copy this entire message and send it back:\n\n" + message;
}
// Chrome/Edge dispatch a genuine window "error" event with this exact
// message whenever a ResizeObserver callback doesn't finish reacting to a
// resize within one animation frame (e.g. the scale-transform zoom below
// changing #stage-container's effective size while it's being observed).
// It's a long-documented browser-internal notice, not a script failure -
// nothing actually breaks - but left unfiltered it tripped this page's
// catch-all handler and threw up the fatal-error banner over top of a
// zoom that was in fact working, making zoom look broken when it wasn't.
function isBenignResizeObserverNotice(message) {
  return typeof message === "string" && message.startsWith("ResizeObserver loop");
}
window.addEventListener("error", (e) => {
  if (isBenignResizeObserverNotice(e.message)) return;
  showFatalError(`${e.message}\n${e.filename ? "at " + e.filename + ":" + e.lineno + ":" + e.colno : ""}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason;
  const message = reason && reason.stack ? reason.stack : String(reason);
  if (isBenignResizeObserverNotice(message)) return;
  showFatalError(message);
});

const state = {
  avatars: [],
  selectedAvatar: null,
  audioMode: "upload", // "upload" | "sample"
  audioFile: null,
  samples: [],
  instantShapes: null, // { closed, mid, open } image URLs for the selected avatar, once loaded
};

const el = {
  list: document.getElementById("list"),
  countLabel: document.getElementById("count-label"),
  search: document.getElementById("search"),
  filterEthnicity: document.getElementById("filter-ethnicity"),
  filterGender: document.getElementById("filter-gender"),
  currentName: document.getElementById("current-name"),
  currentTags: document.getElementById("current-tags"),
  tabs: document.querySelectorAll(".audio-tab"),
  panels: document.querySelectorAll(".audio-panel"),
  dropzone: document.getElementById("dropzone"),
  dropzoneText: document.getElementById("dropzoneText"),
  audioInput: document.getElementById("audioInput"),
  sampleSelect: document.getElementById("sampleSelect"),
  regenSamplesBtn: document.getElementById("regenSamplesBtn"),
  regenSamplesStatus: document.getElementById("regenSamplesStatus"),
  generateBtn: document.getElementById("generateBtn"),
  importBtn: document.getElementById("importBtn"),
  importStatus: document.getElementById("importStatus"),
  tagAvatarName: document.getElementById("tagAvatarName"),
  tagGender: document.getElementById("tagGender"),
  tagEthnicity: document.getElementById("tagEthnicity"),
  tagSaveBtn: document.getElementById("tagSaveBtn"),
  tagStatus: document.getElementById("tagStatus"),
  errorBanner: document.getElementById("error-banner"),
  player: document.getElementById("player"),
  stageScroll: document.getElementById("stage-scroll"),
  stageContainer: document.getElementById("stage-container"),
  avatarPreview: document.getElementById("avatarPreview"),
  empty: document.getElementById("empty"),
  loading: document.getElementById("loading"),
  stageFooter: document.getElementById("stage-footer"),
  downloadLink: document.getElementById("downloadLink"),
  instantSection: document.getElementById("instant-section"),
  instantHintText: document.getElementById("instantHintText"),
  generateInstantBtn: document.getElementById("generateInstantBtn"),
  playInstantBtn: document.getElementById("playInstantBtn"),
  instantStatus: document.getElementById("instantStatus"),
  instantAudio: document.getElementById("instantAudio"),
};

// Zoom state, declared up here rather than near its own event listener
// further down - selectAvatar() and the generate/cache-play handlers all
// need to reset this on new content, and calling that before this had
// executed would risk the same "used before initialization" crash this
// project hit once already in lipsync.js.
let zoomLevel = 1;
const ZOOM_MIN = 1;
const ZOOM_MAX = 3;

// Scales #stage-container (the shared parent of both #player and
// #avatarPreview - not #player specifically, since the old version only
// ever scaled the video, so zoom silently did nothing while looking at
// an avatar's static preview photo, which is the most common first
// interaction) and keeps #stage-scroll's real scroll position in sync.
//
// #stage-container uses a top-left transform-origin, so scaling it up
// always grows the painted content down and to the right - genuine
// overflow that #stage-scroll (overflow: auto once zoomed, see
// style.css's .zoomed class) can natively scroll, giving real
// browser-native vertical/horizontal scrollbars that appear only once
// zoom actually pushes content past the window and disappear again the
// moment zoom returns to 1x.
//
// (anchorFracX, anchorFracY), if given, is the 0..1 point within the
// full scaled content that should stay centered in the viewport after
// this call - if omitted, it's computed from wherever's centered right
// now, so a wheel-zoom tick feels anchored around what you're already
// looking at instead of always snapping back to the top-left corner.
function applyZoom(anchorFracX, anchorFracY) {
  const sc = el.stageScroll;
  const cw = sc.clientWidth || 1;
  const ch = sc.clientHeight || 1;

  let fracX = anchorFracX;
  let fracY = anchorFracY;
  if (fracX == null || fracY == null) {
    // Read the CURRENT (pre-update) scroll extents before touching the
    // transform below - once the transform changes, the DOM's own
    // scrollWidth/scrollHeight would already reflect the new zoom level,
    // making this reflect the wrong scale if read afterward.
    const curScrollW = Math.max(cw, sc.scrollWidth);
    const curScrollH = Math.max(ch, sc.scrollHeight);
    fracX = (sc.scrollLeft + cw / 2) / curScrollW;
    fracY = (sc.scrollTop + ch / 2) / curScrollH;
  }

  sc.classList.toggle("zoomed", zoomLevel > ZOOM_MIN + 0.001);
  el.stageContainer.style.transform = `scale(${zoomLevel})`;

  // Computed algebraically (container size × zoom) rather than read back
  // from the DOM, since #stage-container's transform transition means
  // scrollWidth/scrollHeight wouldn't have caught up to the target size
  // yet on this same tick.
  const newScrollW = cw * zoomLevel;
  const newScrollH = ch * zoomLevel;
  sc.scrollLeft = fracX * newScrollW - cw / 2;
  sc.scrollTop = fracY * newScrollH - ch / 2;
}

// Zoom is per-piece-of-content, not a persistent global setting - without
// this, zooming in on one avatar's video left every subsequently selected
// avatar or freshly generated video zoomed in too, with no way back since
// there's no reset button (removed on request) - looked exactly like "the
// full avatar isn't visible" even though nothing was actually broken,
// just stuck zoomed in from an earlier scroll.
function resetZoom() {
  zoomLevel = 1;
  applyZoom(0.5, 0.5);
}

function showError(msg) {
  el.errorBanner.textContent = msg;
  el.errorBanner.hidden = !msg;
}

function updateGenerateEnabled() {
  const audioReady = state.audioMode === "sample" ? state.samples.length > 0 : state.audioFile !== null;
  el.generateBtn.disabled = !(state.selectedAvatar && audioReady);
}

// ---- sample audio dropdown (shared 10-clip set in data/Audio/) ----

async function loadSamples() {
  try {
    const res = await fetch("/api/audio/list");
    const data = await res.json();
    state.samples = data.samples || [];
  } catch (e) {
    state.samples = [];
  }
  el.sampleSelect.innerHTML = state.samples.length
    ? state.samples.map((s) => `<option value="${s.id}">${s.label}</option>`).join("")
    : `<option value="">No sample audio found in data/Audio</option>`;
  updateGenerateEnabled();
}

// ---- avatar list ----

async function loadAvatars() {
  try {
    const res = await fetch("/api/avatars");
    const data = await res.json();
    state.avatars = data.avatars || [];

    // Only real, non-blank values populate each dropdown - most 2D
    // avatars won't have gender/ethnicity tagged (there's no way to
    // auto-detect these from a LiteAvatar model folder, unlike the 3D
    // avatars which ship with that data already), so an untagged
    // avatar set just leaves these at "All" until you add a meta.json
    // for it (see the sidebar hint below).
    // Reset to just "All" before repopulating - loadAvatars() can now
    // run more than once (re-called after an import), and appending
    // without clearing first would pile up duplicate options each time.
    el.filterEthnicity.innerHTML = `<option value="">All</option>`;
    el.filterGender.innerHTML = `<option value="">All</option>`;

    const uniq = (key) => [...new Set(state.avatars.map((a) => a[key]).filter(Boolean))].sort();
    uniq("ethnicity").forEach((v) => el.filterEthnicity.insertAdjacentHTML("beforeend", `<option value="${v}">${v}</option>`));
    uniq("gender").forEach((v) => el.filterGender.insertAdjacentHTML("beforeend", `<option value="${v}">${v}</option>`));

    renderList();

    if (state.avatars.length === 0) {
      el.countLabel.textContent = "No avatars found in data/";
    } else {
      selectAvatar(state.avatars[0].id);
    }
  } catch (e) {
    el.list.innerHTML = `<div class="list-empty">Couldn't reach the LiteAvatar server. Is it still running?</div>`;
    el.countLabel.textContent = "Not connected";
  }
}

function renderList() {
  const search = el.search.value.trim().toLowerCase();
  const ethnicity = el.filterEthnicity.value;
  const gender = el.filterGender.value;

  const filtered = state.avatars.filter((a) => {
    if (search && !a.name.toLowerCase().includes(search)) return false;
    if (ethnicity && a.ethnicity !== ethnicity) return false;
    if (gender && a.gender !== gender) return false;
    return true;
  });

  el.countLabel.textContent = state.avatars.length
    ? `${filtered.length} / ${state.avatars.length} avatars`
    : "No avatars found in data/";

  el.list.innerHTML = "";
  if (state.avatars.length === 0) {
    el.list.innerHTML = `<div class="list-empty">No avatars found in <code>data/</code> yet.<br>Run <code>app.cmd</code> first to download the sample avatar.</div>`;
    return;
  }
  if (filtered.length === 0) {
    el.list.innerHTML = `<div class="list-empty">No avatars match these filters.</div>`;
    return;
  }

  for (const avatar of filtered) {
    const item = document.createElement("div");
    item.className = "item";
    item.dataset.id = avatar.id;
    if (avatar.id === state.selectedAvatar) item.classList.add("active");
    item.innerHTML = `
      ${avatar.thumbnail ? `<img class="thumb" src="${avatar.thumbnail}" loading="lazy" alt="">` : `<div class="thumb"></div>`}
      <div class="meta">
        <div class="name">${avatar.name}</div>
        <div class="tags">${avatar.id}</div>
      </div>
    `;
    item.addEventListener("click", () => selectAvatar(avatar.id));
    el.list.appendChild(item);
  }
}

function selectAvatar(id) {
  state.selectedAvatar = id;
  const avatar = state.avatars.find((a) => a.id === id);
  document.querySelectorAll(".item").forEach((c) => {
    c.classList.toggle("active", c.dataset.id === id);
  });
  if (avatar) {
    el.currentName.textContent = avatar.name;
    // Show the avatar's own reference photo right away - previously
    // selecting an avatar changed only the name text at the top and the
    // display window stayed completely blank until a video was
    // generated or a cached one played, which looked like nothing had
    // happened at all.
    if (avatar.thumbnail) {
      el.avatarPreview.src = avatar.thumbnail;
      el.avatarPreview.hidden = false;
    } else {
      el.avatarPreview.hidden = true;
    }
    el.player.pause();
    el.player.dataset.empty = "true";
    el.stageFooter.hidden = true;
    el.empty.hidden = true;
    resetZoom();

    // Populate the tagging dropdowns with this avatar's current tags -
    // gender/ethnicity come straight from find_avatars()'s meta.json
    // reading, already loaded into state.avatars.
    el.tagAvatarName.textContent = avatar.name;
    el.tagGender.value = avatar.gender || "";
    el.tagEthnicity.value = avatar.ethnicity || "";
    el.tagGender.disabled = false;
    el.tagEthnicity.disabled = false;
    el.tagSaveBtn.disabled = false;
    el.tagStatus.textContent = "";

    stopInstantPlayback();
    state.instantShapes = null;
    el.instantSection.hidden = false;
    el.instantStatus.textContent = "";
    el.generateInstantBtn.hidden = !!avatar.has_instant;
    el.playInstantBtn.disabled = !avatar.has_instant;
    el.instantHintText.textContent = avatar.has_instant
      ? "Swaps between three pre-baked mouth shapes live as the audio plays - starts immediately instead of waiting on CPU generation. Lower fidelity than Generate Video, same idea as the Instant 3D Avatar mode."
      : "Not baked for this avatar yet - bake it once (a few seconds of CPU work, unlike a full Generate) and instant playback is available every time after.";
  } else {
    el.instantSection.hidden = true;
  }
  updateGenerateEnabled();
  checkCacheAndMaybePlay();
}

el.search.addEventListener("input", renderList);
el.filterEthnicity.addEventListener("change", renderList);
el.filterGender.addEventListener("change", renderList);

// ---- instant playback for already-generated (avatar, audio) pairs ----
// Runs on every selection change, not just Generate clicks: if this
// exact avatar+audio combination has been generated before, it plays
// immediately - Generate is still a real, explicit click for anything
// new, since that's genuine CPU work worth asking permission for, but a
// repeat combination shouldn't need you to click through and wait for
// what the server already has sitting on disk.
let _checkToken = 0;

async function checkCacheAndMaybePlay() {
  const audioReady = state.audioMode === "sample" ? !!el.sampleSelect.value : state.audioFile !== null;
  if (!state.selectedAvatar || !audioReady) return;

  const myToken = ++_checkToken;
  const form = new FormData();
  form.append("avatar_id", state.selectedAvatar);
  if (state.audioMode === "sample") {
    form.append("audio_sample_id", el.sampleSelect.value);
  } else {
    form.append("audio", state.audioFile);
  }

  let data;
  try {
    const res = await fetch("/api/check_cache", { method: "POST", body: form });
    data = await res.json();
  } catch (e) {
    return; // silent - this is a proactive convenience check, not a user-facing action
  }
  if (myToken !== _checkToken) return; // a newer selection has since superseded this check

  if (data.cached) {
    el.empty.hidden = true;
    el.loading.hidden = true;
    el.avatarPreview.hidden = true;
    showError("");
    el.player.src = data.video_url;
    el.player.dataset.empty = "false";
    resetZoom();
    el.player.play().catch(() => {});
    el.downloadLink.href = data.video_url;
    el.stageFooter.hidden = false;
  } else {
    el.player.dataset.empty = "true";
    el.stageFooter.hidden = true;
    el.empty.hidden = false;
    el.empty.textContent = "Not generated yet for this avatar + audio - press Generate Video.";
  }
}

// ---- audio tabs ----

el.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    el.tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.audioMode = tab.dataset.tab;
    el.panels.forEach((p) => {
      p.hidden = p.dataset.panel !== state.audioMode;
    });
    updateGenerateEnabled();
    checkCacheAndMaybePlay();
  });
});

// ---- auto-filter the left-pane avatar list by the selected audio's
// voice gender: pick male audio and only male-tagged avatars stay
// visible, and likewise for female - this literally just drives the
// same manual Gender filter dropdown already in the sidebar, then
// re-renders the list, so it behaves exactly like setting that dropdown
// by hand. Sample audio already carries a "gender" tag straight from
// data/Audio/manifest.json (see SAMPLES in
// scripts/generate_sample_audio.py) - free, no request needed. An
// uploaded file has no such tag, so its gender is guessed server-side
// from pitch (the same heuristic the 3D lipsync page already uses for
// this) via /api/audio/detect_gender. Best-effort only: if the gender
// can't be determined, or nothing's tagged with it, the filter is left
// exactly as the user last set it - this never blocks picking audio. ----
let _genderFilterToken = 0;

async function applyGenderFilterFromAudio() {
  const myToken = ++_genderFilterToken;
  let gender = null;

  if (state.audioMode === "sample") {
    const sample = state.samples.find((s) => s.id === el.sampleSelect.value);
    gender = (sample && sample.gender) || null;
  } else if (state.audioFile) {
    const form = new FormData();
    form.append("audio", state.audioFile);
    try {
      const res = await fetch("/api/audio/detect_gender", { method: "POST", body: form });
      const data = await res.json();
      if (res.ok) gender = data.detected_gender || null;
    } catch (e) {
      gender = null; // best-effort - a failed guess just means no auto-filter, never an error shown to the user
    }
  }

  if (myToken !== _genderFilterToken) return; // a newer selection has since superseded this
  if (!gender) return;

  // Setting the <select> to a value with no matching <option> silently
  // does nothing anyway, but check explicitly so intent stays clear -
  // this only ever narrows to avatars that are actually tagged.
  const hasOption = [...el.filterGender.options].some((o) => o.value === gender);
  if (!hasOption) return;

  el.filterGender.value = gender;
  renderList();
}

// ---- file upload / drag&drop ----

function handleFile(file) {
  if (!file) return;
  state.audioFile = file;
  el.dropzone.classList.add("has-file");
  el.dropzoneText.innerHTML = `Selected: <b>${file.name}</b><br><small>Click to choose a different file</small>`;
  updateGenerateEnabled();
  checkCacheAndMaybePlay();
  applyGenderFilterFromAudio();
}

el.audioInput.addEventListener("change", (e) => handleFile(e.target.files[0]));
el.sampleSelect.addEventListener("change", () => {
  updateGenerateEnabled();
  checkCacheAndMaybePlay();
  applyGenderFilterFromAudio();
});

["dragenter", "dragover"].forEach((evt) =>
  el.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach((evt) =>
  el.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.remove("drag-over");
  })
);
el.dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// ---- generate ----
//
// The real generated video is CPU inference - a short clip usually takes
// a minute or two (see the loading copy in index.html) - so waiting on
// it before showing anything left the window either stuck on a spinner
// or, before that, entirely blank. Generate Video now starts the actual
// generation request and an immediate stand-in playback at the same
// time: if this avatar has an instant preview baked (pre-baked mouth
// shapes swapped live off the audio, see startInstantPreviewPlayback
// above), that starts playing right away while the real request runs in
// the background, then the player swaps over to the real generated
// video the moment it lands - so pressing Generate Video never means
// staring at nothing while it renders. If no instant preview exists for
// this avatar yet, it falls back to the plain loading spinner, since
// there's nothing to stand in with.

el.generateBtn.addEventListener("click", async () => {
  showError("");
  el.generateBtn.disabled = true;
  el.generateBtn.classList.add("busy");
  el.empty.hidden = true;
  el.player.dataset.empty = "true";
  el.stageFooter.hidden = true;

  const avatarId = state.selectedAvatar;
  const form = new FormData();
  form.append("avatar_id", avatarId);
  if (state.audioMode === "sample") {
    form.append("audio_sample_id", el.sampleSelect.value);
  } else if (state.audioFile) {
    form.append("audio", state.audioFile);
  }

  // Fire the slow, CPU-bound request off first so it's already running
  // in the background for the entire time the stand-in preview below is
  // getting set up and starting to play - not awaited yet.
  const generationPromise = fetch("/api/generate", { method: "POST", body: form }).then(async (res) => {
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Generation failed.");
    return data;
  });

  let playingStandIn = false;
  try {
    playingStandIn = await startInstantPreviewPlayback(avatarId);
  } catch (e) {
    playingStandIn = false; // no instant preview baked for this avatar yet (or similar) - fall back to the spinner below
  }
  if (!playingStandIn) {
    el.loading.hidden = false;
  }

  try {
    const data = await generationPromise;
    stopInstantPlayback(); // no-op if the stand-in never started
    el.avatarPreview.hidden = true;
    el.player.src = data.video_url;
    el.player.dataset.empty = "false";
    resetZoom();
    el.player.play().catch(() => {});
    el.downloadLink.href = data.video_url;
    el.stageFooter.hidden = false;
    el.empty.hidden = true;
  } catch (e) {
    stopInstantPlayback();
    showError(e.message || "Something went wrong talking to the LiteAvatar server.");
    el.empty.hidden = false;
  } finally {
    el.loading.hidden = true;
    el.generateBtn.disabled = false;
    el.generateBtn.classList.remove("busy");
    updateGenerateEnabled();
  }
});

// ---- instant preview (2D): pre-baked closed/mid/open mouth-shape
// images (see scripts/generate_2d_visemes.py) swapped live from the
// audio's own volume, the same technique lipsync.js already uses to
// drive the 3D mode's blend shapes - here driving an <img> src instead.
// Zero server inference at playback time, so it starts the instant you
// press play instead of waiting on the normal frame-by-frame pipeline. ----

let instantAudioCtx = null;
let instantAnalyser = null;
let instantFreqData = null;
let instantSourceNode = null;
let instantSourceEl = null; // the <audio> element currently wired into instantSourceNode - createMediaElementSource() can only ever be called once per element
let instantRafId = null;
let instantObjectUrl = null; // revoked on next use / avatar switch, so uploaded-file blobs don't leak
let instantSmoothedAmp = 0;

function stopInstantPlayback() {
  if (instantRafId !== null) {
    cancelAnimationFrame(instantRafId);
    instantRafId = null;
  }
  el.instantAudio.pause();
  el.playInstantBtn.classList.remove("busy");
  if (state.selectedAvatar) el.playInstantBtn.disabled = !state.instantShapes;
  instantSmoothedAmp = 0;
}

function ensureInstantAudioGraph() {
  // createMediaElementSource() throws if called twice on the same
  // element - only (re)create the graph if this is genuinely the first
  // time, or a fresh Audio() instance was swapped in.
  if (instantSourceNode && instantSourceEl === el.instantAudio) return;
  instantAudioCtx = instantAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
  instantSourceNode = instantAudioCtx.createMediaElementSource(el.instantAudio);
  instantAnalyser = instantAudioCtx.createAnalyser();
  instantAnalyser.fftSize = 1024;
  instantAnalyser.smoothingTimeConstant = 0.6;
  instantFreqData = new Uint8Array(instantAnalyser.frequencyBinCount);
  instantSourceNode.connect(instantAnalyser);
  instantAnalyser.connect(instantAudioCtx.destination);
  instantSourceEl = el.instantAudio;
}

function currentInstantAudioUrl() {
  if (state.audioMode === "sample") {
    const sample = state.samples.find((s) => s.id === el.sampleSelect.value);
    return sample ? sample.url : null;
  }
  if (state.audioFile) {
    if (instantObjectUrl) URL.revokeObjectURL(instantObjectUrl);
    instantObjectUrl = URL.createObjectURL(state.audioFile);
    return instantObjectUrl;
  }
  return null;
}

async function fetchInstantShapes(avatarId) {
  const res = await fetch(`/api/avatars_2d/${encodeURIComponent(avatarId)}/visemes`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "No instant preview baked for this avatar yet.");
  return data.shapes; // { closed, mid, open }
}

// ---- shared: start the instant (pre-baked mouth-shape) preview playing
// for the given avatar against whatever audio is currently selected or
// uploaded. Used by "Play instant preview" directly, and also by
// Generate Video as an immediate stand-in while the real video renders
// in the background - see the generate handler above, which calls this
// the moment it's clicked so something is already playing instead of
// leaving the window blank/spinning for the minute or two CPU inference
// takes. Returns false (without throwing) if there's no audio picked
// yet; throws if shapes can't be fetched for some other reason. ----
async function startInstantPreviewPlayback(avatarId) {
  const audioUrl = currentInstantAudioUrl();
  if (!audioUrl) return false;

  if (!state.instantShapes) {
    state.instantShapes = await fetchInstantShapes(avatarId);
  }

  // Instant mode takes over the shared preview <img>/window - stop any
  // video playback first so the two never fight over it.
  el.player.pause();
  el.player.dataset.empty = "true";
  el.stageFooter.hidden = true;
  el.empty.hidden = true;
  el.loading.hidden = true;
  el.avatarPreview.hidden = false;
  el.avatarPreview.src = state.instantShapes.closed || state.instantShapes.mid || state.instantShapes.open;
  resetZoom();

  el.instantAudio.src = audioUrl;
  ensureInstantAudioGraph();
  await el.instantAudio.play();
  instantActiveShape = "closed";
  instantLastAppliedShape = "closed"; // already applied above, just before play() started
  instantNextSwitchAt = 0;
  if (instantRafId === null) instantAnimationLoop();
  return true;
}

// Same amplitude-envelope + shape-hold-timer approach as lipsync.js's
// updateVisemes(), simplified to three discrete images instead of
// continuously-blended morph targets: swapping the <img> src on every
// single frame would just look like flicker, not speech, so a shape is
// held briefly once picked rather than re-evaluated every frame.
let instantActiveShape = "closed";
let instantNextSwitchAt = 0;
let instantLastAppliedShape = null;

function instantAnimationLoop() {
  instantRafId = requestAnimationFrame(instantAnimationLoop);
  if (!instantAnalyser || el.instantAudio.paused || el.instantAudio.ended) return;

  instantAnalyser.getByteFrequencyData(instantFreqData);
  let sum = 0;
  for (let i = 0; i < instantFreqData.length; i++) sum += instantFreqData[i];
  const rawAmp = sum / instantFreqData.length / 255;
  const attack = 0.55, release = 0.2;
  instantSmoothedAmp += (rawAmp - instantSmoothedAmp) * (rawAmp > instantSmoothedAmp ? attack : release);

  const now = performance.now();
  if (now >= instantNextSwitchAt) {
    instantActiveShape = instantSmoothedAmp < 0.06 ? "closed" : instantSmoothedAmp < 0.32 ? "mid" : "open";
    instantNextSwitchAt = now + 90 + Math.random() * 90;
  }

  const url = state.instantShapes && state.instantShapes[instantActiveShape];
  if (url && instantActiveShape !== instantLastAppliedShape) {
    el.avatarPreview.src = url;
    instantLastAppliedShape = instantActiveShape;
  }
}

el.generateInstantBtn.addEventListener("click", async () => {
  if (!state.selectedAvatar) return;
  const avatarId = state.selectedAvatar;
  el.generateInstantBtn.disabled = true;
  el.generateInstantBtn.classList.add("busy");
  el.instantStatus.textContent = "Baking closed/mid/open mouth shapes - runs the model briefly, once, for this avatar\u2026";

  const form = new FormData();
  form.append("avatar_id", avatarId);
  try {
    const res = await fetch("/api/avatars_2d/generate_visemes", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Baking instant preview failed.");
    state.instantShapes = data.shapes;
    const avatar = state.avatars.find((a) => a.id === avatarId);
    if (avatar) avatar.has_instant = true;
    if (state.selectedAvatar === avatarId) {
      el.generateInstantBtn.hidden = true;
      el.playInstantBtn.disabled = false;
      el.instantStatus.textContent = "Ready - instant preview is now available for this avatar every time.";
    }
  } catch (e) {
    el.instantStatus.textContent = e.message || "Something went wrong baking the instant preview.";
  } finally {
    el.generateInstantBtn.disabled = false;
    el.generateInstantBtn.classList.remove("busy");
  }
});

el.playInstantBtn.addEventListener("click", async () => {
  if (!state.selectedAvatar) return;

  el.playInstantBtn.disabled = true;
  el.playInstantBtn.classList.add("busy");
  el.instantStatus.textContent = "";
  showError("");

  try {
    const started = await startInstantPreviewPlayback(state.selectedAvatar);
    if (!started) el.instantStatus.textContent = "Pick or upload audio first.";
  } catch (e) {
    showError(e.message || "Something went wrong starting the instant preview.");
  } finally {
    el.playInstantBtn.disabled = !state.instantShapes;
    el.playInstantBtn.classList.remove("busy");
  }
});

el.instantAudio.addEventListener("ended", () => {
  if (instantRafId !== null) {
    cancelAnimationFrame(instantRafId);
    instantRafId = null;
  }
  if (state.instantShapes) el.avatarPreview.src = state.instantShapes.closed;
});

// The video player and instant preview share the same window - starting
// the other one should stop this one, so playback never overlaps.
el.player.addEventListener("play", stopInstantPlayback);

loadAvatars();
loadSamples();

// ---- tag the currently selected avatar's gender/ethnicity ----

el.tagSaveBtn.addEventListener("click", async () => {
  if (!state.selectedAvatar) return;
  const taggedAvatarId = state.selectedAvatar; // loadAvatars() below re-selects avatars[0] internally - capture this first so we can restore the right selection afterward
  el.tagSaveBtn.disabled = true;
  el.tagSaveBtn.classList.add("busy");
  el.tagStatus.textContent = "Saving\u2026";

  const form = new FormData();
  form.append("avatar_id", taggedAvatarId);
  form.append("gender", el.tagGender.value);
  form.append("ethnicity", el.tagEthnicity.value);

  try {
    const res = await fetch("/api/avatars_2d/tag", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Save failed.");
    el.tagStatus.textContent = "Saved.";
    await loadAvatars(); // refreshes filters with the new tag, but auto-selects avatars[0] internally
    selectAvatar(taggedAvatarId); // restore the avatar actually being tagged, not whatever loadAvatars() defaulted to
  } catch (e) {
    el.tagStatus.textContent = e.message || "Something went wrong saving tags.";
  } finally {
    el.tagSaveBtn.disabled = false;
    el.tagSaveBtn.classList.remove("busy");
  }
});

// ---- regenerate sample audio via edge-tts (runs on this machine's own
// server, which has normal internet access, unlike the environment this
// app was built in - the button itself works fine even though I
// couldn't run this generation step myself while building it) ----

el.regenSamplesBtn.addEventListener("click", async () => {
  el.regenSamplesBtn.disabled = true;
  el.regenSamplesBtn.classList.add("busy");
  el.regenSamplesStatus.textContent = "Generating 10 clips via Microsoft neural TTS - this calls out over the network, give it a moment\u2026";

  try {
    const res = await fetch("/api/audio/regenerate_edge_tts", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Regeneration failed.");
    el.regenSamplesStatus.textContent = `Done - ${data.samples.length} clips regenerated.`;
    await loadSamples(); // refresh the dropdown with the new (same-named, now overwritten, now cache-busted) files
    applyGenderFilterFromAudio(); // sample genders can differ after a regenerate - resync the left-pane filter to whatever's currently selected
  } catch (e) {
    el.regenSamplesStatus.textContent = e.message || "Something went wrong regenerating samples.";
  } finally {
    el.regenSamplesBtn.disabled = false;
    el.regenSamplesBtn.classList.remove("busy");
  }
});

// ---- import avatars from the LiteAvatarGallery download layout ----

el.importBtn.addEventListener("click", async () => {
  el.importBtn.disabled = true;
  el.importBtn.classList.add("busy");
  el.importStatus.textContent = "Scanning and extracting\u2026";

  try {
    const res = await fetch("/api/avatars_2d/import", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Import failed.");

    const importedCount = data.imported.length;
    const skippedCount = data.skipped.length;
    let msg = importedCount
      ? `Imported ${importedCount} avatar${importedCount === 1 ? "" : "s"}.`
      : "No new avatars found.";
    if (skippedCount) msg += ` ${skippedCount} skipped.`;
    el.importStatus.textContent = msg;

    if (importedCount > 0) {
      await loadAvatars(); // refresh the sidebar list with the newly imported avatars
    }
  } catch (e) {
    el.importStatus.textContent = e.message || "Something went wrong during import.";
  } finally {
    el.importBtn.disabled = false;
    el.importBtn.classList.remove("busy");
  }
});

// ---- zoom the video within its bounded window (the window itself and
// the pane around it never change size - only the video content scales) ----

// Scroll-to-zoom, scoped to the window itself - scrolling anywhere
// else on the page (e.g. the sidebars) behaves normally. No on-screen
// zoom buttons - scroll is the only control.
//
// { capture: true } matters here: the native <video controls> browser
// UI can otherwise intercept wheel/scroll input before it bubbles up to
// a listener on an ancestor element (e.g. when the cursor is over the
// native control bar at the bottom of the video) - the 3D page's
// OrbitControls-based zoom doesn't run into this since it isn't
// competing with a native browser media control for the same input.
// Capture phase runs top-down, before the event reaches the video's own
// native handling, which is what actually fixes that - attaching this
// same listener again on child elements as well would NOT add
// robustness, it would make the handler fire multiple times per single
// scroll tick (each capture-phase listener along the path fires
// independently), making zoom feel 2-3x too sensitive.
document.getElementById("avatar-window").addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomLevel - Math.sign(e.deltaY) * 0.15));
    applyZoom();
  },
  { passive: false, capture: true }
);

// ---- drag to pan, once zoomed in - lets you shift the view after
// zooming to see a specific part (a face, a hand) rather than being
// stuck looking at whatever's dead-center. Right-click-drag specifically
// (not plain left-drag), matching the 3D page's own pan convention, and
// deliberately avoiding the video's native left-click-based controls
// (play/pause, dragging the seek bar) - a plain left-drag listener here
// would fight with those instead of coexisting with them. ----

(function setUpPan() {
  const avatarWindowEl = document.getElementById("avatar-window");
  let isPanning = false;
  let dragStart = { x: 0, y: 0 };
  let scrollStart = { x: 0, y: 0 };

  avatarWindowEl.addEventListener("contextmenu", (e) => {
    e.preventDefault(); // suppress the right-click menu - right-drag is repurposed for panning here
  });

  avatarWindowEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 2) return; // right mouse button only
    if (zoomLevel <= ZOOM_MIN) return; // nothing to pan at 1x - the content already exactly fills the window
    isPanning = true;
    dragStart = { x: e.clientX, y: e.clientY };
    scrollStart = { x: el.stageScroll.scrollLeft, y: el.stageScroll.scrollTop };
    avatarWindowEl.setPointerCapture(e.pointerId);
    avatarWindowEl.classList.add("panning");
  });

  avatarWindowEl.addEventListener("pointermove", (e) => {
    if (!isPanning) return;
    // Drives the real scrollLeft/scrollTop directly - the browser clamps
    // these to the valid range on its own, and the scrollbar thumbs move
    // in step since they're reading the same live scroll position.
    el.stageScroll.scrollLeft = scrollStart.x - (e.clientX - dragStart.x);
    el.stageScroll.scrollTop = scrollStart.y - (e.clientY - dragStart.y);
  });

  ["pointerup", "pointercancel"].forEach((evt) => {
    avatarWindowEl.addEventListener(evt, () => {
      isPanning = false;
      avatarWindowEl.classList.remove("panning");
    });
  });
})();

