import * as THREE from 'three';
import { GLTFLoader } from '/vendor/three/GLTFLoader.js';
import { OrbitControls } from '/vendor/three/OrbitControls.js';
import { MeshoptDecoder } from '/vendor/three/meshopt_decoder.module.js';

// ---------------------------------------------------------------
// Catch absolutely everything, as early as possible - a script error
// anywhere in this file otherwise fails completely silently to anyone
// without devtools open, leaving every "Loading..." state stuck forever
// with zero visible explanation. This turns that into a message on the
// page itself instead.
// ---------------------------------------------------------------
function showFatalError(message) {
  let banner = document.getElementById('fatal-error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'fatal-error-banner';
    banner.style.cssText =
      'position:fixed; top:0; left:0; right:0; z-index:99999; background:#3a1d22; ' +
      'color:#ff9fa8; padding:12px 16px; font:12px/1.5 ui-monospace,monospace; ' +
      'white-space:pre-wrap; max-height:45vh; overflow:auto; border-bottom:2px solid #ff9fa8;';
    document.body.prepend(banner);
  }
  banner.textContent = 'Something failed to load on this page. Please copy this entire message and send it back:\n\n' + message;
}
// See webapp/app.js for why this filter exists: this exact message is a
// benign browser-internal notice (ResizeObserver callback didn't settle
// within one frame), not a real script error - filtering it here stops it
// from throwing up the fatal-error banner over a page that's actually fine.
function isBenignResizeObserverNotice(message) {
  return typeof message === 'string' && message.startsWith('ResizeObserver loop');
}
window.addEventListener('error', (e) => {
  if (isBenignResizeObserverNotice(e.message)) return;
  showFatalError(`${e.message}\n${e.filename ? 'at ' + e.filename + ':' + e.lineno + ':' + e.colno : ''}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  const message = reason && reason.stack ? reason.stack : String(reason);
  if (isBenignResizeObserverNotice(message)) return;
  showFatalError(message);
});

// ---------------------------------------------------------------
// This page never runs any AI model. It loads one of 210 pre-built 3D
// avatars (data/Avatars_3D/, MIT-licensed VALID avatar library) and
// animates its mouth in real time from the audio's own volume + frequency
// content while it plays. There's no neural network involved anywhere in
// this file - that's what makes avatar browsing and playback instant
// instead of another generation step to wait on. The scene setup (studio
// backdrop, 3-point lighting, camera framing, T-pose arm/hand correction)
// and the sidebar filter UI are adapted directly from the VALID Avatar
// Viewer this dataset ships with, for a consistent look; the mouth
// animation itself is this project's own (real audio analysis instead of
// the viewer's browser-TTS-driven demo).
// ---------------------------------------------------------------

const el = {
  list: document.getElementById('list'),
  countLabel: document.getElementById('count-label'),
  search: document.getElementById('search'),
  filterEthnicity: document.getElementById('filter-ethnicity'),
  filterGender: document.getElementById('filter-gender'),
  filterOutfit: document.getElementById('filter-outfit'),
  currentName: document.getElementById('current-name'),
  currentTags: document.getElementById('current-tags'),
  tabs: document.querySelectorAll('.audio-tab'),
  panels: document.querySelectorAll('.audio-panel'),
  dropzone: document.getElementById('dropzone'),
  dropzoneText: document.getElementById('dropzoneText'),
  audioInput: document.getElementById('audioInput'),
  sampleSelect: document.getElementById('sampleSelect'),
  audioStatus: document.getElementById('audioStatus'),
  playBtn: document.getElementById('playBtn'),
  errorBanner: document.getElementById('error-banner'),
  empty: document.getElementById('empty'),
  loading: document.getElementById('loading'),
  canvasContainer: document.getElementById('canvas-container'),
  audioEl: document.getElementById('player'),
  rot90: document.getElementById('rot-90'),
};

const state = {
  avatars: [],       // full 210-entry manifest
  audioMode: 'upload',
  audioFile: null,
  samples: [],
  currentAvatarId: null,
  detectedGender: null,
  audioCtx: null,
  analyser: null,
  freqData: null,
  mediaSourceConnected: false,
  audioUrl: null,
};

function showError(msg) {
  el.errorBanner.textContent = msg;
  el.errorBanner.hidden = !msg;
}

// ---------- Three.js scene setup (matches the VALID Avatar Viewer) ----------

const scene = new THREE.Scene();

function makeStudioBackdrop() {
  const canvas = document.createElement('canvas');
  canvas.width = 2; canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, '#22242e');
  gradient.addColorStop(0.55, '#1a1c24');
  gradient.addColorStop(1, '#101116');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 2, 512);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
scene.background = makeStudioBackdrop();

const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
camera.position.set(0, 1.5, 2.6);

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true });
} catch (e) {
  showFatalError(
    'This browser blocked or does not support WebGL, which this page needs to render 3D avatars.\n\n' +
    'If you are using Brave, try turning Shields off for this page (the lion icon in the address bar), ' +
    'or try a different browser (Chrome/Edge/Firefox).\n\nOriginal error: ' + e.message
  );
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
el.canvasContainer.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.4, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.4;
controls.maxDistance = 6;
controls.update();

scene.add(new THREE.AmbientLight(0xffffff, 0.28));
const keyLight = new THREE.DirectionalLight(0xfff3e6, 2.0);
keyLight.position.set(1.4, 2.6, 2.2);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.near = 0.5;
keyLight.shadow.camera.far = 8;
keyLight.shadow.radius = 3;
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xdbe6ff, 0.55);
fillLight.position.set(-2, 1.2, 1.2);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xbcd2ff, 0.9);
rimLight.position.set(-0.6, 2.2, -2.4);
scene.add(rimLight);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(2.2, 64),
  new THREE.ShadowMaterial({ opacity: 0.35 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const floorRing = new THREE.Mesh(
  new THREE.RingGeometry(2.15, 2.2, 64),
  new THREE.MeshBasicMaterial({ color: 0x2c2f3a, side: THREE.DoubleSide, transparent: true, opacity: 0.6 })
);
floorRing.rotation.x = -Math.PI / 2;
scene.add(floorRing);

function resizeRenderer() {
  const w = el.canvasContainer.clientWidth || 1;
  const h = el.canvasContainer.clientHeight || 1;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resizeRenderer);
resizeRenderer();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  updateVisemes();
  animateFace();
  renderer.render(scene, camera);
}
// The actual first call to animate() happens at the very end of this
// file, not here - see the bottom for why.

// ---------- Avatar loading ----------

let currentModel = null;
let morphMeshes = [];
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

function clearCurrentModel() {
  eyeCloseMorphs = null;
  browMorphs = null;
  eyeNodes = null;
  headNode = null;
  headBaseQuat = null;
  morphMeshes = [];
  if (currentModel) {
    scene.remove(currentModel);
    currentModel.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => {
          Object.values(m).forEach((v) => { if (v && v.isTexture) v.dispose(); });
          m.dispose();
        });
      }
    });
    currentModel = null;
  }
}

function frameCameraOnModel(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const height = size.y || 1.7;

  // Anchor on the actual "Head" bone's real position rather than a
  // percentage-of-bounding-box guess. The guess broke on outfit variants
  // with extra gear (e.g. military props) - equipment geometry can
  // extend the overall bounding box in ways that throw off a percentage-
  // based estimate, landing the camera on the boots instead of the
  // face. A named bone's position doesn't care what the mesh geometry
  // around it looks like.
  const headBone = findBone(root, 'Head');
  const targetY = headBone
    ? headBone.getWorldPosition(new THREE.Vector3()).y
    : box.max.y - height * 0.12; // fallback for any model with no "Head" bone

  controls.target.set(center.x, targetY, center.z);
  camera.position.set(center.x, targetY, center.z + height * 0.35);
  controls.update();
}

// A morph-target pruning optimization was tried here and removed - the
// evidence (loading got slower, not faster, after adding it) suggests it
// backfired somehow, and it can't be verified in this sandbox (no real
// browser/GPU to actually measure against). Reverting an unproven change
// that made things worse beats defending it on theory alone.

function loadAvatarModel(entry) {
  return new Promise((resolve, reject) => {
    el.loading.hidden = false;
    el.empty.hidden = true;
    showError('');
    el.currentName.textContent = entry.name;
    el.currentTags.textContent = `${entry.ethnicity} \u00b7 ${entry.gender === 'male' ? 'Male' : 'Female'} \u00b7 ${entry.outfit}`;

    const loadingTextEl = el.loading.querySelector('.loading-status') || (() => {
      const p = document.createElement('div');
      p.className = 'loading-status';
      el.loading.appendChild(p);
      return p;
    })();
    loadingTextEl.textContent = 'Downloading\u2026';
    const slowNoticeTimer = setTimeout(() => {
      loadingTextEl.textContent = 'Still working \u2013 this model has a lot of facial detail (65 blend shapes), which can take a while to set up on some machines.';
    }, 6000);

    loader.load(
      entry.model,
      (gltf) => {
        clearTimeout(slowNoticeTimer);
        loadingTextEl.textContent = 'Setting up the face rig\u2026';
        clearCurrentModel();
        currentModel = gltf.scene;
        currentModel.traverse((obj) => { if (obj.isMesh) obj.castShadow = true; });
        scene.add(currentModel);
        frameCameraOnModel(currentModel);
        el.loading.hidden = true;

        currentModel.traverse((obj) => {
          if (obj.isMesh && obj.morphTargetDictionary && obj.morphTargetInfluences) {
            morphMeshes.push(obj);
          }
        });
        findFaceRig(currentModel);
        lowerArms(currentModel);
        relaxHands(currentModel);

        state.currentAvatarId = entry.id;
        document.querySelectorAll('.item').forEach((c) => c.classList.toggle('active', c.dataset.id === entry.id));
        resolve();
      },
      (progressEvent) => {
        if (progressEvent.lengthComputable) {
          const pct = Math.round((progressEvent.loaded / progressEvent.total) * 100);
          loadingTextEl.textContent = `Downloading\u2026 ${pct}%`;
        }
      },
      (err) => {
        clearTimeout(slowNoticeTimer);
        el.loading.hidden = true;
        el.empty.hidden = false;
        showError(`Couldn't load that avatar: ${err && err.message ? err.message : err}`);
        reject(err);
      }
    );
  });
}

document.getElementById('rot-90').addEventListener('click', () => {
  if (currentModel) currentModel.rotation.y += Math.PI / 2;
});

// ---------- T-pose correction (arms/hands) - adapted from the VALID
// Avatar Viewer: these avatars ship in a T-pose by default, which reads
// as broken/unnatural on screen. Measures each arm segment's actual
// current world-space direction and rotates it to hang down naturally,
// rather than assuming a specific rest-pose convention. ----------

function applyDirectionCorrection(bone, currentDir, targetDir) {
  const correctionWorldQuat = new THREE.Quaternion().setFromUnitVectors(currentDir, targetDir);
  const parentWorldQuat = new THREE.Quaternion();
  bone.parent.getWorldQuaternion(parentWorldQuat);
  const currentWorldQuat = new THREE.Quaternion();
  bone.getWorldQuaternion(currentWorldQuat);
  const newWorldQuat = correctionWorldQuat.clone().multiply(currentWorldQuat);
  const newLocalQuat = parentWorldQuat.clone().invert().multiply(newWorldQuat);
  bone.quaternion.copy(newLocalQuat);
}

function findBone(root, name) {
  let found = null;
  root.traverse((obj) => { if (!found && obj.name === name) found = obj; });
  return found;
}

function pointBoneDown(root, boneName, childBoneName, targetDir) {
  const bone = findBone(root, boneName);
  const child = findBone(root, childBoneName);
  if (!bone || !child) return false;
  root.updateMatrixWorld(true);
  const bonePos = new THREE.Vector3();
  const childPos = new THREE.Vector3();
  bone.getWorldPosition(bonePos);
  child.getWorldPosition(childPos);
  const currentDir = childPos.clone().sub(bonePos).normalize();
  if (currentDir.lengthSq() < 1e-6) return false;
  applyDirectionCorrection(bone, currentDir, targetDir.clone().normalize());
  root.updateMatrixWorld(true);
  return true;
}

function lowerArms(root) {
  pointBoneDown(root, 'RightArm', 'RightForeArm', new THREE.Vector3(0.25, -1, 0.05));
  pointBoneDown(root, 'LeftArm', 'LeftForeArm', new THREE.Vector3(-0.25, -1, 0.05));
  pointBoneDown(root, 'RightForeArm', 'RightHand', new THREE.Vector3(0.55, -1, 0.1));
  pointBoneDown(root, 'LeftForeArm', 'LeftHand', new THREE.Vector3(-0.55, -1, 0.1));
}

function relaxHands(root) {
  const FINGER_NAME = /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)[1-4]$/;
  const curl = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.21, 0, 0));
  root.traverse((obj) => { if (FINGER_NAME.test(obj.name)) obj.quaternion.copy(curl); });
}

// ---------- Idle liveliness: blink, gaze saccades, head bob while
// speaking - adapted from the VALID Avatar Viewer so avatars don't look
// frozen between mouth movements. ----------

let eyeCloseMorphs = null;
let browMorphs = null;
let eyeNodes = null;
let headNode = null;
let headBaseQuat = null;
let nextBlinkAt = 0;
let blinkPhase = 0;
let nextSaccadeAt = 0;
let gazeOffset = { x: 0, y: 0 };
let gazeTarget = { x: 0, y: 0 };
let headTargetOffset = { x: 0, y: 0, z: 0 };
let headCurrentOffset = { x: 0, y: 0, z: 0 };
let nextBrowPulseAt = 0;
let browPulseUntil = 0;
let activeVisemeCategory = 'AE_AA';
let nextVisemeSwitchAt = 0;

function findFaceRig(root) {
  eyeCloseMorphs = null;
  browMorphs = null;
  eyeNodes = { left: null, right: null };
  headNode = null;
  headBaseQuat = null;

  root.traverse((obj) => {
    if (obj.morphTargetDictionary) {
      const d = obj.morphTargetDictionary;
      if ('h_expressions.ReyeClose_h' in d && 'h_expressions.LeyeClose_h' in d) {
        eyeCloseMorphs = { mesh: obj, rIndex: d['h_expressions.ReyeClose_h'], lIndex: d['h_expressions.LeyeClose_h'] };
      }
      if ('h_expressions.RbrowUp_h' in d && 'h_expressions.LbrowUp_h' in d) {
        browMorphs = { mesh: obj, rUpIndex: d['h_expressions.RbrowUp_h'], lUpIndex: d['h_expressions.LbrowUp_h'] };
      }
    }
    if (obj.name === 'h_L_eye') eyeNodes.left = obj;
    if (obj.name === 'h_R_eye') eyeNodes.right = obj;
    if (obj.name === 'Head') headNode = obj;
  });

  if (headNode) headBaseQuat = headNode.quaternion.clone();
  gazeOffset = { x: 0, y: 0 };
  gazeTarget = { x: 0, y: 0 };
  headTargetOffset = { x: 0, y: 0, z: 0 };
  headCurrentOffset = { x: 0, y: 0, z: 0 };
  nextBlinkAt = performance.now() + 1500 + Math.random() * 2500;
  nextSaccadeAt = performance.now() + 800 + Math.random() * 1500;
  nextBrowPulseAt = performance.now() + 2500 + Math.random() * 4000;
  browPulseUntil = 0;
  activeVisemeCategory = 'AE_AA';
  nextVisemeSwitchAt = 0;
}

function isSpeaking() {
  return state.analyser && !el.audioEl.paused && !el.audioEl.ended;
}

function animateFace() {
  const now = performance.now();
  const speaking = isSpeaking();

  if (eyeCloseMorphs && eyeCloseMorphs.mesh.morphTargetInfluences) {
    if (blinkPhase === 0 && now >= nextBlinkAt) blinkPhase = 0.001;
    if (blinkPhase > 0) {
      blinkPhase += 16 / 220;
      const closeAmount = blinkPhase < 0.45 ? blinkPhase / 0.45 : Math.max(0, 1 - (blinkPhase - 0.45) / 0.55);
      eyeCloseMorphs.mesh.morphTargetInfluences[eyeCloseMorphs.rIndex] = closeAmount;
      eyeCloseMorphs.mesh.morphTargetInfluences[eyeCloseMorphs.lIndex] = closeAmount;
      if (blinkPhase >= 1) {
        blinkPhase = 0;
        nextBlinkAt = now + 1800 + Math.random() * 3500;
      }
    }
  }

  if (eyeNodes && (eyeNodes.left || eyeNodes.right)) {
    if (now >= nextSaccadeAt) {
      gazeTarget = { x: (Math.random() - 0.5) * 0.25, y: (Math.random() - 0.5) * 0.18 };
      nextSaccadeAt = now + 600 + Math.random() * 2200;
    }
    gazeOffset.x += (gazeTarget.x - gazeOffset.x) * 0.12;
    gazeOffset.y += (gazeTarget.y - gazeOffset.y) * 0.12;
    [eyeNodes.left, eyeNodes.right].forEach((eye) => {
      if (!eye) return;
      eye.rotation.y = gazeOffset.x;
      eye.rotation.x = gazeOffset.y;
    });
  }

  if (headNode && headBaseQuat) {
    if (speaking) {
      headTargetOffset = {
        x: Math.sin(now / 700) * 0.035,
        y: Math.sin(now / 950 + 1) * 0.045,
        z: Math.sin(now / 1300 + 2) * 0.02,
      };
    } else {
      headTargetOffset = { x: 0, y: 0, z: 0 };
    }
    headCurrentOffset.x += (headTargetOffset.x - headCurrentOffset.x) * 0.06;
    headCurrentOffset.y += (headTargetOffset.y - headCurrentOffset.y) * 0.06;
    headCurrentOffset.z += (headTargetOffset.z - headCurrentOffset.z) * 0.06;
    const offsetQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(headCurrentOffset.x, headCurrentOffset.y, headCurrentOffset.z)
    );
    headNode.quaternion.copy(headBaseQuat).multiply(offsetQuat);
  }

  // Occasional brow raise while speaking, for a bit of expressiveness -
  // this was being detected (browMorphs) but never actually animated.
  if (browMorphs && browMorphs.mesh.morphTargetInfluences) {
    if (speaking && now >= nextBrowPulseAt) {
      browPulseUntil = now + 350 + Math.random() * 250;
      nextBrowPulseAt = now + 2500 + Math.random() * 4000;
    }
    const target = now < browPulseUntil ? 0.3 : 0;
    const rCurrent = browMorphs.mesh.morphTargetInfluences[browMorphs.rUpIndex] || 0;
    const lCurrent = browMorphs.mesh.morphTargetInfluences[browMorphs.lUpIndex] || 0;
    browMorphs.mesh.morphTargetInfluences[browMorphs.rUpIndex] = rCurrent + (target - rCurrent) * 0.15;
    browMorphs.mesh.morphTargetInfluences[browMorphs.lUpIndex] = lCurrent + (target - lCurrent) * 0.15;
  }
}

// ---------- Sidebar catalog: search + ethnicity/gender/outfit filters,
// matching the VALID Avatar Viewer exactly (this satisfies "left pane
// should be the same as the valid avatars frontend"). ----------

let activeItemEl = null;

function renderList() {
  const search = el.search.value.trim().toLowerCase();
  const eth = el.filterEthnicity.value;
  const gender = el.filterGender.value;
  const outfit = el.filterOutfit.value;

  const filtered = state.avatars.filter((e) => {
    if (eth && e.ethnicity !== eth) return false;
    if (gender && e.gender !== gender) return false;
    if (outfit && e.outfit !== outfit) return false;
    if (search && !e.name.toLowerCase().includes(search)) return false;
    return true;
  });

  el.countLabel.textContent = `${filtered.length} / ${state.avatars.length} avatars`;

  el.list.innerHTML = '';
  if (filtered.length === 0) {
    el.list.innerHTML = `<div class="list-empty">No avatars match these filters.</div>`;
    return;
  }
  for (const entry of filtered) {
    const item = document.createElement('div');
    item.className = 'item';
    item.dataset.id = entry.id;
    if (entry.id === state.currentAvatarId) item.classList.add('active');
    item.innerHTML = `
      <img class="thumb" src="${entry.thumbnail}" loading="lazy" alt="">
      <div class="meta">
        <div class="name">${entry.name}<span class="badge">${entry.gender}</span></div>
        <div class="tags">${entry.ethnicity} \u00b7 ${entry.outfit}</div>
      </div>
    `;
    item.addEventListener('click', () => {
      loadAvatarModel(entry)
        .then(() => { el.playBtn.disabled = !state.audioUrl; })
        .catch(() => {});
    });
    el.list.appendChild(item);
  }
}

['search', 'filter-ethnicity', 'filter-gender', 'filter-outfit'].forEach((id) => {
  document.getElementById(id).addEventListener('input', renderList);
});

async function loadCatalog() {
  try {
    const res = await fetch('/api/lipsync/avatars');
    const data = await res.json();
    state.avatars = data.avatars || [];
  } catch (e) {
    el.list.innerHTML = `<div class="list-empty">Couldn't reach the server. Is app.cmd still running?</div>`;
    el.countLabel.textContent = 'Not connected';
    return;
  }

  if (state.avatars.length === 0) {
    el.list.innerHTML = `<div class="list-empty">No 3D avatars found in <code>data/Avatars_3D</code>.</div>`;
    el.countLabel.textContent = 'No avatars found';
    return;
  }

  const uniq = (key) => [...new Set(state.avatars.map((d) => d[key]))].sort();
  uniq('ethnicity').forEach((v) => el.filterEthnicity.insertAdjacentHTML('beforeend', `<option value="${v}">${v}</option>`));
  uniq('gender').forEach((v) => el.filterGender.insertAdjacentHTML('beforeend', `<option value="${v}">${v === 'male' ? 'Male' : 'Female'}</option>`));
  uniq('outfit').forEach((v) => el.filterOutfit.insertAdjacentHTML('beforeend', `<option value="${v}">${v}</option>`));

  renderList();
  loadAvatarModel(state.avatars[0]).catch(() => {});
}

// ---------- Sample audio dropdown ----------

async function loadSamples() {
  try {
    const res = await fetch('/api/audio/list');
    const data = await res.json();
    state.samples = data.samples || [];
  } catch (e) {
    state.samples = [];
  }
  el.sampleSelect.innerHTML = state.samples.length
    ? state.samples.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')
    : `<option value="">No sample audio found in data/Audio</option>`;
}

// ---------- audio tabs / upload ----------

el.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    el.tabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.audioMode = tab.dataset.tab;
    el.panels.forEach((p) => { p.hidden = p.dataset.panel !== state.audioMode; });
    // Selecting a <select>'s already-selected default option never fires
    // 'change' - so without this, switching to "Use sample" and leaving
    // it on the first (pre-selected) clip would silently do nothing
    // until you picked a *different* option. Processing on tab-switch
    // too covers that case.
    if (state.audioMode === 'sample' && el.sampleSelect.value) {
      processAudioAndFilterAvatars();
    }
  });
});

function handleFile(file) {
  if (!file) return;
  state.audioFile = file;
  el.dropzone.classList.add('has-file');
  el.dropzoneText.innerHTML = `Selected: <b>${file.name}</b><br><small>Click to choose a different file</small>`;
}
el.audioInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
['dragenter', 'dragover'].forEach((evt) =>
  el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); el.dropzone.classList.add('drag-over'); })
);
['dragleave', 'drop'].forEach((evt) =>
  el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); el.dropzone.classList.remove('drag-over'); })
);
el.dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// ---------- "Analyze" happens automatically once audio is ready:
// process it server-side (gender guess), then apply that as the Gender
// filter on the left pane so the browsable list narrows to matching
// avatars - selection itself happens by clicking one there. ----------

async function processAudioAndFilterAvatars() {
  showError('');
  el.audioStatus.textContent = 'Analyzing audio\u2026';
  el.playBtn.disabled = true;

  const form = new FormData();
  if (state.audioMode === 'sample') {
    if (!el.sampleSelect.value) {
      el.audioStatus.textContent = 'No sample selected';
      return;
    }
    form.append('audio_sample_id', el.sampleSelect.value);
  } else {
    if (!state.audioFile) {
      el.audioStatus.textContent = '';
      return;
    }
    form.append('audio', state.audioFile);
  }

  try {
    const res = await fetch('/api/lipsync/audio', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Could not process that audio.');

    state.detectedGender = data.detected_gender;
    state.audioUrl = data.audio_url;

    const pitchNote = data.detected_pitch_hz ? ` (~${data.detected_pitch_hz} Hz)` : '';
    el.audioStatus.textContent = `Detected voice: ${data.detected_gender}${pitchNote} \u2013 list filtered on the left`;

    el.filterGender.value = data.detected_gender;
    renderList();

    // If nothing's selected yet, or the current selection no longer
    // matches the new filter, auto-load the first matching avatar so
    // there's always something ready to press Play on - still just a
    // starting point though, click any other avatar in the list to
    // change it.
    const stillMatches = state.avatars.find((a) => a.id === state.currentAvatarId && a.gender === data.detected_gender);
    if (!stillMatches) {
      const firstMatch = state.avatars.find((a) => a.gender === data.detected_gender) || state.avatars[0];
      if (firstMatch) await loadAvatarModel(firstMatch).catch(() => {});
    }

    el.playBtn.disabled = !state.currentAvatarId;
  } catch (e) {
    showError(e.message || 'Something went wrong analyzing that audio.');
    el.audioStatus.textContent = '';
  }
}

el.sampleSelect.addEventListener('change', processAudioAndFilterAvatars);
el.audioInput.addEventListener('change', () => { if (state.audioFile) processAudioAndFilterAvatars(); });
el.dropzone.addEventListener('drop', () => { if (state.audioFile) processAudioAndFilterAvatars(); });

// ---------- Web Audio graph (created once, on first playback) ----------

function ensureAudioGraph() {
  if (state.mediaSourceConnected) return;
  state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = state.audioCtx.createMediaElementSource(el.audioEl);
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 1024;
  state.analyser.smoothingTimeConstant = 0.6;
  state.freqData = new Uint8Array(state.analyser.frequencyBinCount);
  source.connect(state.analyser);
  state.analyser.connect(state.audioCtx.destination);
  state.mediaSourceConnected = true;
}

// ---------- viseme categories -> morph target name patterns ----------
// Six visually distinct shapes, matching the categories the reference
// VALID Avatar Viewer itself cycles between (open vowel, lip-rounding,
// bilabial closure, lip-to-teeth, postalveolar/sibilant, mid vowel) -
// picking one at a time rather than blending several together is what
// actually reads as clear mouth shapes instead of a constant muddy
// blend. That viewer drives this from TTS word-boundary events (exact
// timing, no audio content to analyze); this drives it from the actual
// audio's amplitude and spectral shape instead, since it's animating
// pre-recorded/uploaded audio with no word-timing information available -
// an approximation from a different signal, not the same technique.
const VISEME_CATEGORIES = ['AE_AA', 'UW_U', 'MPB', 'FV', 'SH_CH', 'Ax_E'];

function setViseme(category, weight) {
  // MPB (bilabial m/p/b closure - also used here for near-silence) is a
  // special case: the head mesh splits it into two separate shapes -
  // MPB_Up_h (upper lip moving down) and MPB_Down_h (lower lip moving
  // up) - confirmed by inspecting the model's actual morph target list
  // directly. Only driving MPB_Down (the original version of this code)
  // meant the upper lip never participated in mouth closure at all -
  // every other category here is a single shape, so this asymmetry is
  // specific to MPB. The teeth mesh, separately, has only one combined
  // MPB variant (t_MPB_h, no Up/Down split) rather than following the
  // same "t_<category>_h" pattern every other category uses there.
  const headKeys = category === 'MPB'
    ? ['h_expressions.MPB_Up_h', 'h_expressions.MPB_Down_h']
    : [`h_expressions.${category}_h`];
  const teethKey = category === 'MPB' ? 'h_teeth.t_MPB_h' : `h_teeth.t_${category}_h`;

  for (const mesh of morphMeshes) {
    const dict = mesh.morphTargetDictionary;
    for (const headKey of headKeys) {
      if (headKey in dict) mesh.morphTargetInfluences[dict[headKey]] = weight;
    }
    if (teethKey in dict) mesh.morphTargetInfluences[dict[teethKey]] = weight;
  }
}

// General upper-lip engagement, blended in on top of whichever category
// shape is active - independent confirmation the phoneme shapes
// themselves keep the upper lip fairly still can't be done without a
// live render to look at, so rather than assume, this adds a modest,
// always-present upper-lip raise proportional to how open the mouth is,
// so the upper lip visibly moves regardless of which base shape is
// driving at any given moment.
function setUpperLipRaise(weight) {
  const rKey = 'h_expressions.RlipUp_h';
  const lKey = 'h_expressions.LlipUp_h';
  for (const mesh of morphMeshes) {
    const dict = mesh.morphTargetDictionary;
    if (rKey in dict) mesh.morphTargetInfluences[dict[rKey]] = weight;
    if (lKey in dict) mesh.morphTargetInfluences[dict[lKey]] = weight;
  }
}

let smoothedAmp = 0;

function updateVisemes() {
  if (morphMeshes.length === 0) return;

  if (!isSpeaking()) {
    smoothedAmp += (0 - smoothedAmp) * 0.15;
    if (smoothedAmp > 0.01) {
      VISEME_CATEGORIES.forEach((c) => setViseme(c, 0));
      setViseme('MouthOpen', 0);
      setUpperLipRaise(0);
    }
    return;
  }

  const now = performance.now();
  state.analyser.getByteFrequencyData(state.freqData);
  const bins = state.freqData;
  const n = bins.length;

  let sum = 0;
  for (let i = 0; i < n; i++) sum += bins[i];
  const rawAmp = (sum / n) / 255;
  const attack = 0.55, release = 0.2;
  smoothedAmp += (rawAmp - smoothedAmp) * (rawAmp > smoothedAmp ? attack : release);

  // Four-way band split (was three) - separates a narrow very-high band
  // from the general high band, since that's what distinguishes a
  // labiodental ("f"/"v") sound from a broader sibilant ("sh"/"ch").
  const lowEnd = Math.floor(n * 0.1);
  const midEnd = Math.floor(n * 0.35);
  const highEnd = Math.floor(n * 0.6);
  let low = 0, mid = 0, high = 0, veryHigh = 0;
  for (let i = 0; i < lowEnd; i++) low += bins[i];
  for (let i = lowEnd; i < midEnd; i++) mid += bins[i];
  for (let i = midEnd; i < highEnd; i++) high += bins[i];
  for (let i = highEnd; i < n; i++) veryHigh += bins[i];
  low /= lowEnd || 1;
  mid /= (midEnd - lowEnd) || 1;
  high /= (highEnd - midEnd) || 1;
  veryHigh /= (n - highEnd) || 1;

  let category;
  if (smoothedAmp < 0.08) category = 'MPB'; // near-silence -> lips closing (b/p/m)
  else if (veryHigh > high && veryHigh > mid) category = 'FV';
  else if (high > mid && high > low) category = 'SH_CH';
  else if (low > mid && smoothedAmp > 0.35) category = 'UW_U'; // loud + low-freq -> rounded
  else if (mid > low) category = 'Ax_E';
  else category = 'AE_AA';

  // Switch shape on a short timer rather than every frame, the same way
  // the reference only changes shape once per word rather than
  // continuously - holding a shape briefly reads as an actual mouth
  // position; changing it every single frame just looks like noise.
  if (now >= nextVisemeSwitchAt) {
    activeVisemeCategory = category;
    nextVisemeSwitchAt = now + 90 + Math.random() * 90;
  }

  // A pure smoothed envelope alone looks like slow breathing, not
  // talking - this layers in the same kind of fast sine-wave flutter
  // the reference pulses its active shape with, on top of the real
  // audio envelope instead of instead of it.
  const flutter = 0.15 * Math.abs(Math.sin(now / 90));
  const weight = Math.min(1, smoothedAmp * 1.3 + flutter);

  VISEME_CATEGORIES.forEach((c) => setViseme(c, c === activeVisemeCategory ? weight : 0));
  setViseme('MouthOpen', Math.min(1, smoothedAmp * 1.1));
  // Skip this during MPB - MPB_Up_h already raises the upper lip for
  // that shape specifically, and adding this on top would double it up.
  setUpperLipRaise(activeVisemeCategory === 'MPB' ? 0 : weight * 0.35);
}

// ---------- Play ----------

el.playBtn.addEventListener('click', async () => {
  showError('');
  const entry = state.avatars.find((a) => a.id === state.currentAvatarId);
  if (!entry || !state.audioUrl) {
    showError('Pick audio and an avatar (click one on the left) first.');
    return;
  }

  el.playBtn.disabled = true;
  el.playBtn.classList.add('busy');
  el.playBtn.textContent = 'Loading';

  try {
    el.audioEl.src = state.audioUrl;
    ensureAudioGraph();
    if (state.audioCtx.state === 'suspended') await state.audioCtx.resume();
    await el.audioEl.play();
    el.playBtn.textContent = 'Playing';
  } catch (e) {
    showError(e.message || 'Something went wrong starting playback.');
    el.playBtn.textContent = 'Play';
  } finally {
    el.playBtn.disabled = false;
    el.playBtn.classList.remove('busy');
  }
});

el.audioEl.addEventListener('ended', () => { el.playBtn.textContent = 'Play again'; });

loadCatalog();
loadSamples();

// Starting the render loop here, as the very last thing in the file,
// rather than right after animate() was defined further up: animate()
// calls updateVisemes() and animateFace(), which read a whole list of
// `let` variables (morphMeshes, eyeCloseMorphs, headNode, smoothedAmp,
// and others) that are declared further down in this file. Calling
// animate() before execution had reached those declarations threw
// "Cannot access '...' before initialization" - a guaranteed crash on
// every single page load, not an intermittent one, since this file
// always runs top-to-bottom the same way. Every declaration those
// functions need now runs before this line does.
animate();
