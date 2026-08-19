"""
Pre-bakes a handful of static mouth-shape ("viseme") images for each 2D
LiteAvatar preset, so the web app can offer an **Instant 2D Avatar** mode:
swap between a few ready-made images in real time as audio plays, instead
of running the full neural pipeline (audio2mouth -> 32-dim mouth params ->
per-frame image synthesis -> ffmpeg mux) frame-by-frame, which is what
makes normal Generate take real minutes on CPU.

This is the same trade LiteAvatar itself already made for the 3D mode
(data/Avatars_3D/): pre-built shapes swapped instantly at zero inference
cost, in exchange for an *approximation* of speech rather than a
pixel-accurate generated performance. Here the "shapes" are just images
instead of glTF blend shapes.

How the shapes are chosen: this avatar's own model has no labelled
concept of "open" vs "closed" mouth - the 32 values LiteAvatar predicts
per audio frame are opaque learned parameters (see lite_avatar.py's
audio2mouth/param2img), not named blend shapes. So instead of guessing
which of the 32 values means what, this runs the avatar's real
audio2mouth model once over a phonetically varied sample clip
(data/Audio/sample_03_pangram.wav - deliberately picked because it's a
pangram, i.e. it exercises every letter of the alphabet, so it should
exercise a wide spread of mouth shapes too) and looks at which frames
ended up *furthest* from that avatar's own neutral/idle pose in that
32-dimensional space. Frames near the top of that distance ranking are,
empirically, the moments the mouth was doing the most - i.e. the open
shapes - without needing to know what any individual parameter means.

Usage:
    python scripts/generate_2d_visemes.py                 # all avatars
    python scripts/generate_2d_visemes.py --avatar avatar_01
    python scripts/generate_2d_visemes.py --force          # regenerate existing too

Requires the same dependencies as the rest of the app (torch, funasr,
etc. - see requirements.txt) and the downloaded model weights
(download_model.bat / download_model.sh) - it reuses the exact same
liteAvatar class the normal Generate button uses, just to render three
still frames instead of a whole video.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
AUDIO_DIR = DATA_DIR / "Audio"

# Same file list server.py's REQUIRED_AVATAR_FILES uses to recognize a
# folder as a usable 2D avatar preset - duplicated here (rather than
# imported from server.py) so this script can run standalone without
# pulling in FastAPI/uvicorn just to scan a directory.
REQUIRED_AVATAR_FILES = [
    "net_encode.pt",
    "net_decode.pt",
    "neutral_pose.npy",
    "bg_video.mp4",
    "face_box.txt",
]

# Three shapes: silence/rest, a middling shape, and the widest shape this
# clip produced. Three is enough to read as "talking" when swapped live
# (the 3D mode's own README calls out that picking one clear shape at a
# time, not blending many, is what actually reads as speech) while
# keeping generation - and the per-avatar disk footprint - small.
VISEME_PERCENTILES = {
    "closed": None,  # handled specially: the avatar's own neutral_pose, not a percentile of the clip
    "mid": 55,
    "open": 92,
}

SAMPLE_AUDIO_NAME = "sample_03_pangram.wav"


def find_avatar_dirs():
    """Every folder under data/ that has the files a 2D avatar preset
    needs - mirrors server.py's find_avatars(), see the note above on
    why this isn't just imported from there."""
    if not DATA_DIR.exists():
        return []
    return sorted(
        candidate for candidate in DATA_DIR.glob("**/")
        if all((candidate / f).exists() for f in REQUIRED_AVATAR_FILES)
    )


def pick_sample_audio() -> Path:
    manifest_path = AUDIO_DIR / "manifest.json"
    preferred = AUDIO_DIR / SAMPLE_AUDIO_NAME
    if preferred.exists():
        return preferred
    if manifest_path.exists():
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        for entry in manifest:
            candidate = AUDIO_DIR / entry["file"]
            if candidate.exists():
                return candidate
    raise RuntimeError(
        f"No sample audio found in {AUDIO_DIR} to drive viseme selection. "
        "Run scripts/generate_sample_audio.bat (or the real-voices variant) first."
    )


def generate_visemes_for_avatar(data_dir: Path, progress_callback=None) -> dict:
    """Bakes closed/mid/open viseme images for one avatar folder and
    writes data_dir/visemes/manifest.json. Returns that manifest dict.
    Safe to call directly from server.py (e.g. behind a button), not
    just from this script's own __main__ - matches the pattern
    scripts/generate_sample_audio.py already uses for the same reason:
    never calls sys.exit(), only raises, so a caller embedding this in a
    running server doesn't get taken down by it."""
    from lite_avatar import liteAvatar  # imported lazily, same reasoning as server.py's get_avatar()

    def report(msg):
        if progress_callback:
            progress_callback(msg)

    report(f"Loading avatar model from {data_dir}...")
    avatar = liteAvatar(data_dir=str(data_dir), num_threads=1, generate_offline=True, use_gpu=False)

    sample_audio = pick_sample_audio()
    report(f"Running audio2mouth over {sample_audio.name}...")
    audio_bytes = avatar.read_wav_to_bytes(str(sample_audio))
    if audio_bytes is None:
        raise RuntimeError(f"Could not read {sample_audio} as a WAV file")
    param_res = avatar.audio2param(audio_bytes, is_complete=True)
    if not param_res:
        raise RuntimeError("audio2mouth produced no frames for the sample clip")

    neutral = np.asarray(avatar.neutral_pose, dtype=np.float64)

    def to_vector(frame_params: dict) -> np.ndarray:
        return np.asarray([frame_params[key] for key in avatar.p_list], dtype=np.float64)

    distances = np.asarray([np.linalg.norm(to_vector(p) - neutral) for p in param_res])

    # A fixed background frame for every shape (rather than whatever
    # frame each audio moment happened to line up with) - so the three
    # images differ *only* in mouth shape, not head position/eyes/pose
    # too, which would make swapping between them look like jump-cuts
    # instead of one talking avatar.
    bg_frame_id = 0

    out_dir = data_dir / "visemes"
    out_dir.mkdir(exist_ok=True)

    manifest = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "source_audio": sample_audio.name, "shapes": {}}

    for name, percentile in VISEME_PERCENTILES.items():
        report(f"Rendering '{name}' shape...")
        if percentile is None:
            # True rest pose, not just "whatever frame happened to be
            # closest to neutral" - the neutral_pose array *is* the
            # avatar's own idle/silence parameters.
            frame_params = {key: float(neutral[i]) for i, key in enumerate(avatar.p_list)}
        else:
            target_distance = np.percentile(distances, percentile)
            frame_idx = int(np.argmin(np.abs(distances - target_distance)))
            frame_params = param_res[frame_idx]

        mouth_img = avatar.param2img(frame_params, bg_frame_id)
        full_img, _ = avatar.merge_mouth_to_bg(mouth_img, bg_frame_id)
        out_path = out_dir / f"{name}.jpg"
        cv2.imwrite(str(out_path), full_img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        manifest["shapes"][name] = out_path.name

    manifest_path = out_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    report(f"Wrote {manifest_path}")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--avatar", help="Only regenerate this one avatar (folder name under data/Avatars_2D, e.g. avatar_01)")
    parser.add_argument("--force", action="store_true", help="Regenerate even if visemes/manifest.json already exists")
    args = parser.parse_args()

    avatar_dirs = find_avatar_dirs()
    if args.avatar:
        avatar_dirs = [d for d in avatar_dirs if args.avatar in d.parts]
        if not avatar_dirs:
            print(f"No avatar folder matching '{args.avatar}' found under {DATA_DIR}")
            sys.exit(1)

    if not avatar_dirs:
        print(f"No 2D avatar presets found under {DATA_DIR}. Run app.cmd once first to download the bundled sample.")
        sys.exit(1)

    todo = [d for d in avatar_dirs if args.force or not (d / "visemes" / "manifest.json").exists()]
    skipped = len(avatar_dirs) - len(todo)
    if skipped:
        print(f"Skipping {skipped} avatar(s) that already have visemes (use --force to redo them).")

    if not todo:
        print("Nothing to do.")
        return

    for i, data_dir in enumerate(todo, 1):
        print(f"\n[{i}/{len(todo)}] {data_dir}")
        try:
            generate_visemes_for_avatar(data_dir, progress_callback=lambda m: print(f"  {m}"))
        except Exception as e:
            print(f"  FAILED: {e}")

    print(f"\nDone. Restart the server (or reload the page) to see the Instant 2D toggle for these avatars.")


if __name__ == "__main__":
    main()
