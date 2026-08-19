"""
LiteAvatar local web app server.

LiteAvatar itself (lite_avatar.py) is a batch command-line tool: you give it
an audio file and a folder full of pre-trained avatar assets, it thinks for
a while, and it writes an .mp4 to disk. There's no browser UI in the
original project at all.

This file wraps that same pipeline behind a tiny local web server, so you
get a normal-looking webpage (index.html) where you can pick the avatar,
choose an audio file (or use the bundled sample), click Generate, and watch
the resulting video play right there in the browser - instead of hunting
for the .mp4 in a results folder.

It also serves a second, separate mode: an instant 3D avatar viewer
(webapp/lipsync.html). Instead of generating a video frame-by-frame with a
neural net (slow, CPU-bound), it picks from a fixed set of 210 pre-built 3D
avatar models (see data/Avatars_3D/, sourced from the MIT-licensed VALID
avatar library) and animates their mouth in real time in the browser while
your audio plays - no per-request AI inference at all, so it's effectively
instant, at the cost of not being a pixel-accurate generated performance.
A quick server-side pitch analysis of the chosen audio (see
detect_voice_gender below) suggests male/female so the browser can filter
the avatar dropdown to matching voices - the final pick is still yours.

Run it with: python server.py
Then open:   http://localhost:8000
(app.cmd does both of those steps for you.)
"""
import io
import json
import hashlib
import os
import random
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import zipfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, UploadFile, Form, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydub import AudioSegment
from imageio_ffmpeg import get_ffmpeg_exe

# Make sure pydub can find an ffmpeg binary even if the machine doesn't have
# one on PATH - imageio-ffmpeg (already a dependency) ships its own.
AudioSegment.converter = get_ffmpeg_exe()

ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"
RESULTS_DIR = ROOT_DIR / "output" / "web_results"
UPLOADS_DIR = ROOT_DIR / "output" / "web_uploads"
LIPSYNC_AUDIO_DIR = ROOT_DIR / "output" / "web_lipsync_audio"
RESULTS_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
LIPSYNC_AUDIO_DIR.mkdir(parents=True, exist_ok=True)

# How many frames to decode in parallel. This was previously hardcoded to
# 1 (one frame at a time, regardless of how many CPU cores the machine
# has) - bumping it to the actual core count is the single biggest lever
# for generation speed on CPU. See the matching torch.set_num_threads(1)
# note in lite_avatar.py for why this pairs with, rather than fights,
# PyTorch's own internal threading.
NUM_DECODE_THREADS = max(1, os.cpu_count() or 4)

REQUIRED_AVATAR_FILES = [
    "net_encode.pt",
    "net_decode.pt",
    "neutral_pose.npy",
    "bg_video.mp4",
    "face_box.txt",
]

AVATARS_3D_DIR = DATA_DIR / "Avatars_3D"
AUDIO_DIR = DATA_DIR / "Audio"


def load_audio_samples():
    manifest_path = AUDIO_DIR / "manifest.json"
    if not manifest_path.exists():
        return []
    with open(manifest_path, "r", encoding="utf-8") as f:
        samples = json.load(f)

    # Cache-bust every sample's URL with its .wav file's current mtime.
    # Without this, "Regenerate with edge-tts" genuinely overwrites the
    # file on disk (see generate_all_samples() in
    # scripts/generate_sample_audio.py - same filename, new bytes), but
    # the browser doesn't know that: the URL never changed, so it can
    # keep serving the old cached audio from before the regenerate,
    # making it look like nothing was replaced even though the file
    # underneath genuinely was. Appending ?v=<mtime> means the URL itself
    # changes the instant the file's contents do, so a stale cached copy
    # is never served again after a regenerate.
    for sample in samples:
        wav_path = AUDIO_DIR / sample.get("file", "")
        try:
            sample["url"] = f"/audio_samples/{sample['file']}?v={int(wav_path.stat().st_mtime)}"
        except OSError:
            pass  # file missing - leave the manifest's own url as-is, resolve_audio_source() will surface the real error
    return samples


def load_avatars_3d():
    manifest_path = AVATARS_3D_DIR / "manifest.json"
    if not manifest_path.exists():
        return []
    with open(manifest_path, "r", encoding="utf-8") as f:
        return json.load(f)


def detect_voice_gender(wav_path: Path):
    """Rough male/female guess from the uploaded audio's pitch, so the 3D
    avatar mode can auto-pick a matching voice. This is a lightweight
    fundamental-frequency (F0) heuristic, not a trained classifier - it
    uses librosa's pYIN pitch tracker (already a pinned dependency, used
    elsewhere in this project for the audio2mouth pipeline) to estimate
    the median pitch over voiced frames, then applies the standard ~165Hz
    male/female speaking-pitch cutoff. It's right most of the time for
    clear single-speaker speech, but can be wrong on unusual voices,
    singing, or noisy/music-heavy clips - there's no ML model involved,
    just a frequency measurement, so treat it as a best guess rather than
    a guarantee."""
    import librosa
    import numpy as np

    y, sr = librosa.load(str(wav_path), sr=16000, mono=True)
    # Cap analysis to the first ~12s - plenty for a stable pitch estimate,
    # and keeps this step fast even on a long upload.
    y = y[: sr * 12]
    if len(y) < sr // 4:
        return "female", None  # too short to say anything meaningful

    f0, _voiced_flag, _voiced_prob = librosa.pyin(
        y,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C7"),
        sr=sr,
    )
    voiced_f0 = f0[~np.isnan(f0)]
    if len(voiced_f0) == 0:
        return "female", None
    median_f0 = float(np.median(voiced_f0))
    gender = "male" if median_f0 < 165 else "female"
    return gender, round(median_f0, 1)

app = FastAPI(title="LiteAvatar")


@app.middleware("http")
async def no_cache_headers(request, call_next):
    # This app's frontend files change between test runs while you're
    # iterating (exactly the situation you're in right now) - browsers
    # caching an old index.html/style.css/app.js without you noticing is
    # a real, recurring source of "why doesn't my fix show up" confusion.
    # Since this only ever serves one local user testing changes, there's
    # no real benefit to caching here - force every request to always
    # fetch fresh content instead.
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    return response

# liteAvatar() loads a handful of neural-net weights from disk, which takes
# real time - so each avatar is loaded once and reused, not reloaded on
# every single generate request.
_avatar_cache = {}
_avatar_cache_lock = threading.Lock()

# Only one generation runs at a time (this is a CPU pipeline; running two
# at once would just make both slower and could corrupt the shared
# tmp_frames folder each avatar writes to).
_generate_lock = threading.Lock()


def load_avatar_metadata(display_folder: Path) -> dict:
    """Optional per-avatar tags (gender/ethnicity), read from an
    optional meta.json sitting next to the avatar's own folder, e.g.
    data/Avatars_2D/avatar_01/meta.json - like:
        {"gender": "female", "ethnicity": ""}
    There's no way to automatically determine these from a LiteAvatar
    model folder itself (it's just neural network weights and a
    background video - no such metadata exists in it, unlike the 3D
    avatars which ship with real ethnicity/gender data already). This
    is purely optional user-supplied tagging; defaults to blank
    ("Unspecified" in the UI) for any avatar that doesn't have one."""
    meta_path = display_folder / "meta.json"
    if meta_path.exists():
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return {
                "gender": (data.get("gender") or "").strip(),
                "ethnicity": (data.get("ethnicity") or "").strip(),
            }
        except Exception:
            pass
    return {"gender": "", "ethnicity": ""}


def get_or_create_bg_thumbnail(candidate: Path) -> Optional[str]:
    """The ref_frames/*.jpg files are tiny (194x134px, confirmed by
    direct inspection) close-up face crops meant for the neural
    rendering pipeline internally - not representative of the avatar as
    a preview image, which is what was showing "only face" instead of
    the full avatar on selection. bg_video.mp4 is much larger (890x1920
    in the bundled sample) and actually shows the full avatar - head to
    waist, in the sample's case. This extracts a single frame from it
    once and caches the result, rather than re-running ffmpeg on every
    request for the avatar list."""
    bg_video = candidate / "bg_video.mp4"
    if not bg_video.exists():
        return None
    thumb_path = candidate / ".thumbnail_cache.jpg"
    if not thumb_path.exists():
        try:
            cmd = [get_ffmpeg_exe(), "-y", "-i", str(bg_video), "-vframes", "1", "-q:v", "3", str(thumb_path)]
            result = subprocess.run(cmd, capture_output=True, timeout=20)
            if result.returncode != 0 or not thumb_path.exists():
                return None
        except Exception:
            return None
    return thumb_path.relative_to(DATA_DIR).as_posix()


def find_avatars():
    """Scan data/ for any folder that looks like a usable LiteAvatar preset
    (i.e. has the model + background files LiteAvatar needs). This picks up
    the bundled sample avatar automatically, and any extra avatars dropped
    in later from https://modelscope.cn/models/HumanAIGC-Engineering/LiteAvatarGallery
    without needing code changes."""
    avatars = []
    if not DATA_DIR.exists():
        return avatars
    for candidate in sorted(DATA_DIR.glob("**/")):
        if all((candidate / f).exists() for f in REQUIRED_AVATAR_FILES):
            thumb = get_or_create_bg_thumbnail(candidate)
            if thumb is None:
                # Fallback for the rare case ffmpeg extraction fails -
                # a face-crop thumbnail beats no thumbnail at all.
                ref_frames = candidate / "ref_frames"
                if ref_frames.exists():
                    first_frames = sorted(ref_frames.glob("ref_*.jpg"))
                    if first_frames:
                        thumb = first_frames[0].relative_to(DATA_DIR).as_posix()
            avatar_id = candidate.relative_to(DATA_DIR).as_posix()
            # candidate is the deepest folder that actually contains the
            # model files - for the bundled avatar that's .../avatar_01/
            # preload/, so candidate.name is literally "preload", an
            # internal implementation detail, not a name anyone picked.
            # Showing the parent folder's name instead ("avatar_01") is
            # what's actually meaningful - falls back to candidate.name
            # itself for any avatar that doesn't use this preload/
            # wrapper structure.
            is_preload_wrapped = candidate.name.lower() == "preload"
            display_folder = candidate.parent if is_preload_wrapped else candidate
            display_name = display_folder.name
            metadata = load_avatar_metadata(display_folder)
            visemes_manifest_path = candidate / "visemes" / "manifest.json"
            avatars.append(
                {
                    "id": avatar_id,
                    "name": display_name.replace("_", " ").title(),
                    "thumbnail": f"/assets/{thumb}" if thumb else None,
                    "gender": metadata["gender"],
                    "ethnicity": metadata["ethnicity"],
                    # Whether scripts/generate_2d_visemes.py (or the
                    # "Generate Instant Preview" button) has already baked
                    # this avatar's closed/mid/open mouth-shape images -
                    # the browser uses this to decide whether to offer the
                    # instant, no-wait playback mode for this avatar at all.
                    "has_instant": visemes_manifest_path.exists(),
                }
            )
    return avatars


def get_avatar(avatar_id: str):
    data_dir = (DATA_DIR / avatar_id).resolve()
    # Guard against a crafted avatar_id trying to escape the data/ folder.
    if DATA_DIR.resolve() not in data_dir.parents and data_dir != DATA_DIR.resolve():
        raise HTTPException(status_code=400, detail="Invalid avatar id")
    if not all((data_dir / f).exists() for f in REQUIRED_AVATAR_FILES):
        raise HTTPException(status_code=404, detail=f"Unknown avatar '{avatar_id}'")

    with _avatar_cache_lock:
        if avatar_id not in _avatar_cache:
            # Imported lazily so the server can still start up (and show a
            # friendly error) even if torch/onnxruntime aren't installed yet.
            from lite_avatar import liteAvatar

            print(f"[server] loading avatar '{avatar_id}' (first use, this can take a bit)...")
            _avatar_cache[avatar_id] = liteAvatar(
                data_dir=str(data_dir),
                num_threads=NUM_DECODE_THREADS,
                generate_offline=True,
                use_gpu=False,
            )
        return _avatar_cache[avatar_id]


def to_pcm_wav(src_path: Path, dst_path: Path):
    """LiteAvatar's audio loader expects a plain 16-bit PCM .wav file.
    Convert whatever the browser gave us (webm/ogg/mp3/wav/...) into that,
    mono, so uploads of any common audio format work."""
    audio = AudioSegment.from_file(src_path)
    audio = audio.set_frame_rate(16000).set_channels(1).set_sample_width(2)
    audio.export(dst_path, format="wav")


def resolve_audio_source(audio_sample_id: Optional[str], audio: Optional[UploadFile], dest_dir: Path, job_id: str) -> Path:
    """Both modes accept audio the same two ways: pick one of the 10
    bundled samples (data/Audio/) by id, or upload a file. This resolves
    either into a real path on disk, so the rest of each endpoint doesn't
    need to care which one was used."""
    if audio_sample_id:
        samples = {s["id"]: s for s in load_audio_samples()}
        sample = samples.get(audio_sample_id)
        if sample is None:
            raise HTTPException(status_code=400, detail=f"Unknown sample audio id '{audio_sample_id}'")
        sample_path = AUDIO_DIR / sample["file"]
        if not sample_path.exists():
            raise HTTPException(status_code=400, detail=f"Sample audio file missing: {sample['file']}")
        return sample_path
    if audio is not None:
        raw_path = dest_dir / f"{job_id}_raw_{audio.filename or 'upload'}"
        with open(raw_path, "wb") as f:
            shutil.copyfileobj(audio.file, f)
        return raw_path
    raise HTTPException(status_code=400, detail="No audio provided - pick a sample or upload a file")


@app.get("/api/avatars")
def api_avatars():
    return {"avatars": find_avatars()}


@app.post("/api/avatars_2d/tag")
async def api_avatars_2d_tag(avatar_id: str = Form(...), gender: str = Form(""), ethnicity: str = Form("")):
    """Writes gender/ethnicity into the given avatar's meta.json - the
    in-app equivalent of hand-editing that file (or the bulk CSV
    workflow in scripts/tag_avatars_2d.py), for tagging a single avatar
    right from the sidebar as you're looking at it."""
    candidate = (DATA_DIR / avatar_id).resolve()
    # Same containment check pattern used elsewhere avatar_id comes from
    # the client - refuse anything that would resolve outside DATA_DIR.
    try:
        candidate.relative_to(DATA_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid avatar_id")
    if not candidate.exists() or not candidate.is_dir():
        raise HTTPException(status_code=404, detail=f"Avatar folder not found: {avatar_id}")

    # avatar_id points at the folder containing the model files directly
    # (e.g. .../avatar_03, or .../avatar_03/preload for the preload-
    # wrapped bundled avatar) - meta.json belongs next to the
    # meaningful display folder, not buried in an internal preload/
    # subfolder, matching find_avatars()'s own display_folder logic.
    display_folder = candidate.parent if candidate.name.lower() == "preload" else candidate

    meta_path = display_folder / "meta.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump({"gender": gender.strip(), "ethnicity": ethnicity.strip()}, f, indent=2)

    return {"ok": True, "avatar_id": avatar_id, "gender": gender.strip(), "ethnicity": ethnicity.strip()}


# Same two source folders and exclusion list as scripts/reorganize_avatars_2d.ps1
# - kept in sync deliberately, this is a Python port of that same script
# made callable from the UI instead of needing to run it separately.
AVATARS_2D_IMPORT_SOURCE_DIRS = ["20250408", "20250612"]
AVATARS_2D_IMPORT_EXCLUDED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".md", ".txt", ".json", ".yml", ".yaml"}
AVATARS_2D_IMPORT_EXCLUDED_NAMES = {"avatar.md", "configuration"}
# Filenames pruned from *inside* each extracted avatar, not from the
# candidate-zip list above (that list decides which files next to the
# zips get treated as zips at all - a different thing). net.pth ships
# in the LiteAvatarGallery download layout but is never read by any code
# in this project (net_encode.pt/net_decode.pt are what's actually used,
# confirmed by grepping for it project-wide) - roughly 1MB of dead
# weight per avatar for zero functional benefit.
AVATARS_2D_IMPORT_DEAD_WEIGHT_FILES = {"net.pth"}


def _fingerprint_avatar_folder(folder: Path) -> Optional[str]:
    """A stable fingerprint for detecting duplicate imports - hashes the
    actual content of net_encode.pt (the per-identity trained model
    weights). Two genuinely different avatars will always have
    different weights; the same avatar extracted twice from the same
    zip (e.g. from running Import more than once, since the original
    zips are deliberately never deleted) will have byte-identical ones."""
    net_encode = folder / "net_encode.pt"
    if not net_encode.exists():
        return None
    h = hashlib.sha256()
    with open(net_encode, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _run_avatars_2d_import():
    """Blocking work (extracting zips, moving files) - always called via
    run_in_threadpool, same reasoning as video generation: doing this
    directly in an async route would freeze the whole server for
    everyone else using it while the import runs."""
    avatars_2d_dir = DATA_DIR / "Avatars_2D"
    if not avatars_2d_dir.exists():
        return {"imported": [], "skipped": [], "error": "data/Avatars_2D does not exist"}

    existing_numbers = []
    known_fingerprints = set()
    for p in avatars_2d_dir.iterdir():
        if p.is_dir():
            m = re.match(r"^avatar_(\d+)$", p.name)
            if m:
                existing_numbers.append(int(m.group(1)))
                fp = _fingerprint_avatar_folder(p)
                if fp:
                    known_fingerprints.add(fp)
    next_number = (max(existing_numbers) + 1) if existing_numbers else 1

    imported = []
    skipped = []

    for source_name in AVATARS_2D_IMPORT_SOURCE_DIRS:
        source_dir = avatars_2d_dir / source_name
        if not source_dir.exists():
            continue

        for file in sorted(source_dir.iterdir()):
            if not file.is_file():
                continue
            if file.suffix.lower() in AVATARS_2D_IMPORT_EXCLUDED_EXTENSIONS or file.name in AVATARS_2D_IMPORT_EXCLUDED_NAMES:
                continue

            tmp_dir = source_dir / f"_extract_tmp_{uuid.uuid4().hex[:8]}"
            tmp_dir.mkdir()
            try:
                with zipfile.ZipFile(file, "r") as zf:
                    zf.extractall(tmp_dir)
            except Exception as e:
                shutil.rmtree(tmp_dir, ignore_errors=True)
                skipped.append({"file": file.name, "reason": f"not a valid zip ({e})"})
                continue

            # If the zip contained one single top-level folder, use its
            # contents directly rather than nesting an extra folder level
            # inside avatar_NN.
            top_level = list(tmp_dir.iterdir())
            source_for_move = tmp_dir
            if len(top_level) == 1 and top_level[0].is_dir():
                source_for_move = top_level[0]

            for dead_weight_name in AVATARS_2D_IMPORT_DEAD_WEIGHT_FILES:
                dead_weight_path = Path(source_for_move) / dead_weight_name
                if dead_weight_path.exists():
                    dead_weight_path.unlink()

            # Skip if this exact avatar (by trained-weights content, not
            # just filename) has already been imported - prevents the
            # duplicate-numbered-folder problem that running Import more
            # than once used to cause, since the source zips are
            # deliberately never deleted and would otherwise get
            # re-extracted into a brand new avatar_NN every time.
            fingerprint = _fingerprint_avatar_folder(Path(source_for_move))
            if fingerprint and fingerprint in known_fingerprints:
                shutil.rmtree(tmp_dir, ignore_errors=True)
                skipped.append({"file": file.name, "reason": "already imported (duplicate content) - skipped"})
                continue

            dest_name = f"avatar_{next_number:02d}"
            dest_path = avatars_2d_dir / dest_name
            if dest_path.exists():
                shutil.rmtree(tmp_dir, ignore_errors=True)
                skipped.append({"file": file.name, "reason": f"{dest_name} already exists"})
                continue

            shutil.move(str(source_for_move), str(dest_path))
            shutil.rmtree(tmp_dir, ignore_errors=True)  # removes the now-empty wrapper, if any
            if fingerprint:
                known_fingerprints.add(fingerprint)
            imported.append({"file": file.name, "avatar_id": dest_name})
            next_number += 1

    return {"imported": imported, "skipped": skipped}


@app.post("/api/avatars_2d/import")
async def api_avatars_2d_import():
    """Extracts each zip file in data/Avatars_2D/20250408 and /20250612
    (the LiteAvatarGallery download layout), moves the extracted content
    up into data/Avatars_2D itself, and renames it avatar_NN - continuing
    numbering from whatever's already there. The original zip files are
    never deleted or modified; anything that isn't a valid zip is
    skipped and reported rather than stopping the whole import."""
    result = await run_in_threadpool(_run_avatars_2d_import)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@app.get("/api/audio/list")
def api_audio_list():
    return {"samples": load_audio_samples()}


@app.post("/api/audio/detect_gender")
async def api_audio_detect_gender(audio_sample_id: Optional[str] = Form(None), audio: Optional[UploadFile] = None):
    """Male/female guess for the chosen sample or uploaded audio - used by
    the 2D (AI Video Generator) page to auto-filter the avatar list in the
    left pane down to matching-gender avatars the moment audio is picked.
    Same idea, and the same detect_voice_gender() pitch heuristic, as the
    3D lipsync page already uses for this (see api_lipsync_audio below);
    just reused here for the 2D flow.

    A bundled sample's gender is already known - tagged in
    data/Audio/manifest.json when it was generated (see SAMPLES in
    scripts/generate_sample_audio.py) - so that's returned directly with
    no audio analysis needed. Only an uploaded file actually needs the
    audio itself analyzed."""
    if audio_sample_id:
        samples = {s["id"]: s for s in load_audio_samples()}
        sample = samples.get(audio_sample_id)
        if sample is None:
            raise HTTPException(status_code=400, detail=f"Unknown sample audio id '{audio_sample_id}'")
        return {"detected_gender": sample.get("gender") or None, "detected_pitch_hz": None}

    if audio is None:
        raise HTTPException(status_code=400, detail="No audio provided - pick a sample or upload a file")

    job_id = uuid.uuid4().hex[:12]
    tmp_dir = UPLOADS_DIR / f"gender_{job_id}"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    try:
        raw_path = tmp_dir / (audio.filename or "upload")
        with open(raw_path, "wb") as f:
            shutil.copyfileobj(audio.file, f)
        wav_path = tmp_dir / "normalized.wav"
        try:
            await run_in_threadpool(to_pcm_wav, raw_path, wav_path)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not read that audio file: {e}")

        try:
            gender, f0 = await run_in_threadpool(detect_voice_gender, wav_path)
        except Exception:
            # Best-effort only - a failed guess should never block audio
            # selection, it just means the avatar list won't auto-filter.
            gender, f0 = None, None

        return {"detected_gender": gender, "detected_pitch_hz": f0}
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _resolve_avatar_dir(avatar_id: str) -> Path:
    data_dir = (DATA_DIR / avatar_id).resolve()
    # Same containment check used elsewhere avatar_id comes from the
    # client - refuse anything that would resolve outside DATA_DIR.
    if DATA_DIR.resolve() not in data_dir.parents and data_dir != DATA_DIR.resolve():
        raise HTTPException(status_code=400, detail="Invalid avatar id")
    if not all((data_dir / f).exists() for f in REQUIRED_AVATAR_FILES):
        raise HTTPException(status_code=404, detail=f"Unknown avatar '{avatar_id}'")
    return data_dir


@app.get("/api/avatars_2d/{avatar_id:path}/visemes")
def api_avatars_2d_visemes(avatar_id: str):
    """Returns the pre-baked closed/mid/open mouth-shape image URLs for
    one avatar, if scripts/generate_2d_visemes.py (or the in-app
    'Generate Instant Preview' button) has already produced them - this
    is what the Instant 2D playback mode swaps between live, instead of
    waiting on the normal frame-by-frame neural generation."""
    data_dir = _resolve_avatar_dir(avatar_id)
    manifest_path = data_dir / "visemes" / "manifest.json"
    if not manifest_path.exists():
        raise HTTPException(status_code=404, detail="No instant-preview visemes generated yet for this avatar")
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    rel = data_dir.relative_to(DATA_DIR).as_posix()
    shapes = {name: f"/assets/{rel}/visemes/{filename}" for name, filename in manifest.get("shapes", {}).items()}
    return {"shapes": shapes, "generated_at": manifest.get("generated_at"), "source_audio": manifest.get("source_audio")}


@app.post("/api/avatars_2d/generate_visemes")
async def api_avatars_2d_generate_visemes(avatar_id: str = Form(...)):
    """Bakes the closed/mid/open viseme images for one avatar - the
    in-app equivalent of `python scripts/generate_2d_visemes.py --avatar
    <id> --force`, reusing that exact same code. This is real (if brief -
    three frames, not a whole clip's worth) CPU inference, so it runs via
    run_in_threadpool like video generation does, rather than blocking
    the event loop for every other request while it works."""
    data_dir = _resolve_avatar_dir(avatar_id)
    try:
        from scripts.generate_2d_visemes import generate_visemes_for_avatar
    except ImportError as e:
        raise HTTPException(status_code=500, detail=f"Could not import the viseme generator: {e}")

    def _run():
        with _generate_lock:  # same lock video generation uses - both are CPU-bound avatar-model work
            return generate_visemes_for_avatar(data_dir)

    try:
        manifest = await run_in_threadpool(_run)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Instant-preview generation failed: {e}")

    rel = data_dir.relative_to(DATA_DIR).as_posix()
    shapes = {name: f"/assets/{rel}/visemes/{filename}" for name, filename in manifest.get("shapes", {}).items()}
    return {"shapes": shapes}


@app.post("/api/audio/regenerate_edge_tts")
async def api_audio_regenerate_edge_tts():
    """Regenerates all 10 sample_XX_*.wav files via Microsoft's free
    neural TTS (edge-tts) - the in-app equivalent of running
    scripts/generate_sample_audio.bat, reusing that exact same code
    rather than a separate copy of it. Needs this machine to reach
    speech.platform.bing.com; if it can't (offline, corporate firewall),
    this fails with a clear reason rather than a generic error.

    No thread pool here, unlike video generation/avatar import - the
    slow part of this is waiting on network I/O (async by nature, so it
    already yields the event loop to other requests while waiting)
    rather than CPU-bound blocking work like those other endpoints do."""
    try:
        from scripts.generate_sample_audio import generate_all_samples
    except ImportError as e:
        raise HTTPException(status_code=500, detail=f"edge-tts is not installed: {e}. Run: pip install edge-tts")

    try:
        manifest = await generate_all_samples()
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))

    return {"samples": manifest}


# Content hash of each bundled sample clip, computed once and reused -
# these files never change, so re-hashing them every time someone just
# browses the sample dropdown (as opposed to actually generating) would
# be wasted disk I/O for no benefit. Uploaded files always get hashed
# fresh, since their content is different every time by definition.
_sample_hash_cache = {}


def compute_cache_key(avatar_id: str, wav_path: Path) -> str:
    audio_hash = hashlib.sha256(wav_path.read_bytes()).hexdigest()[:16]
    safe_avatar_id = avatar_id.replace("/", "_")
    return f"{safe_avatar_id}__{audio_hash}"


def get_cache_key_for_sample(avatar_id: str, sample_id: str) -> str:
    if sample_id not in _sample_hash_cache:
        samples = {s["id"]: s for s in load_audio_samples()}
        sample = samples.get(sample_id)
        if sample is None:
            raise HTTPException(status_code=400, detail=f"Unknown sample audio id '{sample_id}'")
        sample_path = AUDIO_DIR / sample["file"]
        if not sample_path.exists():
            raise HTTPException(status_code=400, detail=f"Sample audio file missing: {sample['file']}")
        with tempfile.TemporaryDirectory() as tmp:
            wav_path = Path(tmp) / "normalized.wav"
            to_pcm_wav(sample_path, wav_path)
            _sample_hash_cache[sample_id] = hashlib.sha256(wav_path.read_bytes()).hexdigest()[:16]
    safe_avatar_id = avatar_id.replace("/", "_")
    return f"{safe_avatar_id}__{_sample_hash_cache[sample_id]}"


@app.post("/api/check_cache")
async def api_check_cache(avatar_id: str = Form(...), audio_sample_id: Optional[str] = Form(None), audio: Optional[UploadFile] = None):
    """Called whenever the avatar or audio selection changes - before
    Generate is clicked - so a combination that's already been generated
    plays back immediately on selection instead of making you press
    Generate again and wait for what's actually an instant cache hit
    under the hood. Never triggers generation itself - a combination
    that hasn't been made yet just reports not cached, and Generate
    still requires an explicit click, since that's real CPU work worth
    asking permission for."""
    if audio_sample_id:
        cache_key = await run_in_threadpool(get_cache_key_for_sample, avatar_id, audio_sample_id)
    elif audio is not None:
        job_id = uuid.uuid4().hex[:12]
        tmp_dir = UPLOADS_DIR / f"check_{job_id}"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        try:
            raw_path = tmp_dir / (audio.filename or "upload")
            with open(raw_path, "wb") as f:
                shutil.copyfileobj(audio.file, f)
            wav_path = tmp_dir / "normalized.wav"
            await run_in_threadpool(to_pcm_wav, raw_path, wav_path)
            cache_key = compute_cache_key(avatar_id, wav_path)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
    else:
        raise HTTPException(status_code=400, detail="No audio provided")

    cached_mp4 = RESULTS_DIR / cache_key / "test_demo.mp4"
    if cached_mp4.exists():
        return {"cached": True, "video_url": f"/results/{cache_key}/test_demo.mp4"}
    return {"cached": False}


@app.post("/api/generate")
async def api_generate(avatar_id: str = Form(...), audio_sample_id: Optional[str] = Form(None), audio: Optional[UploadFile] = None):
    job_id = uuid.uuid4().hex[:12]
    job_upload_dir = UPLOADS_DIR / job_id
    job_upload_dir.mkdir(parents=True, exist_ok=True)

    raw_path = resolve_audio_source(audio_sample_id, audio, job_upload_dir, job_id)

    wav_path = job_upload_dir / "input_16k_mono.wav"
    try:
        to_pcm_wav(raw_path, wav_path)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read that audio file: {e}")

    # Cache key = hash of the *normalized* audio content (post-conversion,
    # so the same audio re-uploaded under a different filename or
    # container still matches) plus the avatar id. This is what makes a
    # repeat (avatar, audio) combination play back instantly instead of
    # re-running the generation pipeline - the video for that exact pair
    # already exists on disk from last time.
    cache_key = compute_cache_key(avatar_id, wav_path)
    job_result_dir = RESULTS_DIR / cache_key
    cached_mp4 = job_result_dir / "test_demo.mp4"

    if cached_mp4.exists():
        shutil.rmtree(job_upload_dir, ignore_errors=True)  # no longer needed - already cached
        return {"video_url": f"/results/{cache_key}/test_demo.mp4", "seconds": 0, "cached": True}

    job_result_dir.mkdir(parents=True, exist_ok=True)
    avatar = await run_in_threadpool(get_avatar, avatar_id)

    def _run_generation():
        # This runs for real minutes on CPU. Called via run_in_threadpool
        # below rather than directly - avatar.handle() is a long blocking
        # synchronous call, and calling it directly inside this async
        # route would block uvicorn's entire event loop for the whole
        # duration, freezing every other request to the server (including
        # totally unrelated ones, like the 3D avatar page's own API
        # calls) until generation finished. _generate_lock still applies
        # here to serialize concurrent generations - it just blocks this
        # background thread instead of the event loop while it waits.
        with _generate_lock:
            avatar.handle(str(wav_path), str(job_result_dir))

    start = time.time()
    try:
        await run_in_threadpool(_run_generation)
    except Exception as e:
        # Surface the real failure reason on the page itself, instead of a
        # generic message that sends you hunting for a console window you
        # may not have easy access to (e.g. if it's minimized, or you're
        # on a machine you're remoted into).
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")
    elapsed = round(time.time() - start, 1)

    mp4_path = job_result_dir / "test_demo.mp4"
    if not mp4_path.exists():
        raise HTTPException(status_code=500, detail="Generation finished but no video was produced, and no specific error was reported. Check the server console window for details.")

    return {"video_url": f"/results/{cache_key}/test_demo.mp4", "seconds": elapsed, "cached": False}


@app.get("/api/lipsync/avatars")
def api_lipsync_avatars():
    return {"avatars": load_avatars_3d()}


@app.post("/api/lipsync/audio")
async def api_lipsync_audio(audio_sample_id: Optional[str] = Form(None), audio: Optional[UploadFile] = None):
    """Processes the chosen audio (sample or upload) and returns a
    playable URL plus a detected male/female guess. Avatar selection
    itself is not decided here - the browser already has the full
    210-avatar list (GET /api/lipsync/avatars) and filters it by the
    returned gender to populate its own avatar dropdown, so you get to
    pick which specific avatar speaks rather than having one assigned."""
    job_id = uuid.uuid4().hex[:12]
    raw_path = resolve_audio_source(audio_sample_id, audio, LIPSYNC_AUDIO_DIR, job_id)

    # Standardize to .wav: guarantees both librosa (for pitch detection)
    # and the browser's <audio>/Web Audio API can read it, regardless of
    # what format was actually uploaded.
    wav_path = LIPSYNC_AUDIO_DIR / f"{job_id}.wav"
    try:
        audio_seg = AudioSegment.from_file(raw_path)
        audio_seg.export(wav_path, format="wav")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read that audio file: {e}")

    try:
        gender, f0 = await run_in_threadpool(detect_voice_gender, wav_path)
    except Exception as e:
        # Pitch detection failing shouldn't block playback - fall back to
        # a coin flip rather than erroring the whole request out.
        gender, f0 = random.choice(["male", "female"]), None

    return {
        "detected_gender": gender,
        "detected_pitch_hz": f0,
        "audio_url": f"/lipsync_audio/{wav_path.name}",
    }


app.mount("/results", StaticFiles(directory=str(RESULTS_DIR)), name="results")
app.mount("/assets", StaticFiles(directory=str(DATA_DIR)), name="assets")
app.mount("/api/lipsync/assets", StaticFiles(directory=str(AVATARS_3D_DIR)), name="lipsync_assets")
app.mount("/lipsync_audio", StaticFiles(directory=str(LIPSYNC_AUDIO_DIR)), name="lipsync_audio")
app.mount("/audio_samples", StaticFiles(directory=str(AUDIO_DIR)), name="audio_samples")
app.mount("/", StaticFiles(directory=str(ROOT_DIR / "webapp"), html=True), name="webapp")


if __name__ == "__main__":
    import sys

    if sys.platform == "win32":
        # Windows' default asyncio event loop (Proactor) logs a harmless
        # but alarming-looking "ConnectionResetError...forcibly closed by
        # the remote host" whenever a browser closes a connection
        # abruptly - e.g. seeking a video mid-stream, or switching tabs
        # while a request is in flight. It doesn't indicate anything is
        # actually broken (the server keeps working fine right through
        # it), but it clutters the console and looks like a real error.
        # The selector event loop doesn't have this quirk, and this app
        # doesn't use anything Proactor-specific (subprocess calls here
        # go through a background thread, not asyncio's own subprocess
        # machinery), so switching is safe.
        import asyncio

        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
