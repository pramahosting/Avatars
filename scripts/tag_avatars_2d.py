"""
Two-step bulk tagging workflow for gender/ethnicity across every avatar
in data/Avatars_2D/ - there's no way to automatically detect these from
a LiteAvatar model folder (it's just neural network weights and a
background video, no such metadata exists in it), and with dozens or
hundreds of avatars, hand-editing individual meta.json files one at a
time isn't practical. This instead:

  1. `export` - scans every avatar, extracts a preview frame from each
     one's bg_video.mp4 (same approach the app itself uses for
     thumbnails), and writes:
       - avatars_2d_contact_sheet.html - a single page showing every
         avatar's photo next to its ID, so you can actually look at all
         of them at once instead of clicking through the app one by one.
       - avatars_2d_tags.csv - one row per avatar (id, name, gender,
         ethnicity), pre-filled with whatever's already tagged. Open
         this in Excel/Sheets/Notepad, fill in gender/ethnicity while
         cross-referencing the contact sheet, leave blank to skip.

  2. `apply` - reads your filled-in avatars_2d_tags.csv and writes/
     updates each avatar's meta.json accordingly.

Usage:
    python scripts/tag_avatars_2d.py export
    # ... edit avatars_2d_tags.csv ...
    python scripts/tag_avatars_2d.py apply
"""
import csv
import json
import subprocess
import sys
from pathlib import Path
from typing import Optional

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
AVATARS_2D_DIR = DATA_DIR / "Avatars_2D"
CSV_PATH = ROOT_DIR / "avatars_2d_tags.csv"
CONTACT_SHEET_PATH = ROOT_DIR / "avatars_2d_contact_sheet.html"

REQUIRED_AVATAR_FILES = ["net_encode.pt", "net_decode.pt", "neutral_pose.npy", "bg_video.mp4", "face_box.txt"]


def find_avatar_folders():
    """Same logic as server.py's find_avatars(), simplified - returns the
    display folder (not the internal preload/ subfolder, if present) for
    every valid avatar."""
    results = []
    if not AVATARS_2D_DIR.exists():
        return results
    for candidate in sorted(AVATARS_2D_DIR.glob("**/")):
        if all((candidate / f).exists() for f in REQUIRED_AVATAR_FILES):
            is_preload_wrapped = candidate.name.lower() == "preload"
            display_folder = candidate.parent if is_preload_wrapped else candidate
            results.append((display_folder, candidate))  # (display folder, actual model folder)
    return results


def get_ffmpeg():
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        return get_ffmpeg_exe()
    except ImportError:
        print("Missing dependency - run: pip install imageio-ffmpeg")
        sys.exit(1)


def extract_thumbnail(model_folder: Path) -> Optional[Path]:
    bg_video = model_folder / "bg_video.mp4"
    if not bg_video.exists():
        return None
    thumb_path = model_folder / ".thumbnail_cache.jpg"
    if thumb_path.exists():
        return thumb_path
    try:
        cmd = [get_ffmpeg(), "-y", "-i", str(bg_video), "-vframes", "1", "-q:v", "3", str(thumb_path)]
        result = subprocess.run(cmd, capture_output=True, timeout=20)
        if result.returncode == 0 and thumb_path.exists():
            return thumb_path
    except Exception:
        pass
    return None


def load_current_metadata(display_folder: Path) -> dict:
    meta_path = display_folder / "meta.json"
    if meta_path.exists():
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return {"gender": (data.get("gender") or "").strip(), "ethnicity": (data.get("ethnicity") or "").strip()}
        except Exception:
            pass
    return {"gender": "", "ethnicity": ""}


def cmd_export():
    avatars = find_avatar_folders()
    if not avatars:
        print(f"No avatars found in {AVATARS_2D_DIR}")
        sys.exit(1)

    print(f"Found {len(avatars)} avatars. Extracting preview frames...")
    rows = []
    thumbs_html = []
    for display_folder, model_folder in avatars:
        avatar_id = display_folder.relative_to(AVATARS_2D_DIR).as_posix()
        thumb = extract_thumbnail(model_folder)
        current = load_current_metadata(display_folder)
        rows.append({
            "avatar_id": avatar_id,
            "name": display_folder.name,
            "gender": current["gender"],
            "ethnicity": current["ethnicity"],
        })
        thumb_src = thumb.relative_to(ROOT_DIR).as_posix() if thumb else ""
        thumbs_html.append(f"""
        <div class="card">
          {"<img src='" + thumb_src + "'>" if thumb_src else "<div class='no-thumb'>no preview</div>"}
          <div class="id">{avatar_id}</div>
          <div class="tags">gender: {current['gender'] or '-'} &middot; ethnicity: {current['ethnicity'] or '-'}</div>
        </div>""")
        print(f"  {avatar_id} - {'ok' if thumb else 'no bg_video.mp4 preview'}")

    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["avatar_id", "name", "gender", "ethnicity"])
        writer.writeheader()
        writer.writerows(rows)

    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Avatars_2D contact sheet</title>
<style>
body {{ background:#14161c; color:#e8e8ec; font-family:sans-serif; margin:0; padding:24px; }}
h1 {{ font-size:18px; }}
p {{ color:#8b8fa3; font-size:13px; }}
.grid {{ display:flex; flex-wrap:wrap; gap:16px; margin-top:20px; }}
.card {{ width:160px; background:#191b22; border:1px solid #2a2d38; border-radius:8px; padding:8px; }}
.card img {{ width:100%; height:180px; object-fit:cover; border-radius:6px; background:#23262f; }}
.no-thumb {{ width:100%; height:180px; display:flex; align-items:center; justify-content:center; color:#6b6f80; font-size:11px; background:#23262f; border-radius:6px; }}
.id {{ font-size:11px; margin-top:6px; word-break:break-all; }}
.tags {{ font-size:10px; color:#8b8fa3; margin-top:2px; }}
</style></head>
<body>
<h1>{len(avatars)} avatars in data/Avatars_2D</h1>
<p>Cross-reference this with avatars_2d_tags.csv while filling in gender/ethnicity.</p>
<div class="grid">{"".join(thumbs_html)}</div>
</body></html>"""
    with open(CONTACT_SHEET_PATH, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"\nWrote {CSV_PATH.name} - open it, fill in gender/ethnicity, save.")
    print(f"Wrote {CONTACT_SHEET_PATH.name} - open it in a browser to see all avatars at once.")
    print(f"\nThen run: python scripts/tag_avatars_2d.py apply")


def cmd_apply():
    if not CSV_PATH.exists():
        print(f"{CSV_PATH.name} not found - run 'export' first, fill it in, then run 'apply'.")
        sys.exit(1)

    updated = 0
    skipped = 0
    with open(CSV_PATH, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            avatar_id = (row.get("avatar_id") or "").strip()
            gender = (row.get("gender") or "").strip()
            ethnicity = (row.get("ethnicity") or "").strip()
            if not avatar_id:
                continue
            display_folder = AVATARS_2D_DIR / avatar_id
            if not display_folder.exists():
                print(f"  SKIPPED {avatar_id} - folder not found")
                skipped += 1
                continue
            if not gender and not ethnicity:
                skipped += 1
                continue
            meta_path = display_folder / "meta.json"
            with open(meta_path, "w", encoding="utf-8") as mf:
                json.dump({"gender": gender, "ethnicity": ethnicity}, mf, indent=2)
            print(f"  {avatar_id} -> gender={gender or '-'}, ethnicity={ethnicity or '-'}")
            updated += 1

    print(f"\nDone. {updated} meta.json files written, {skipped} rows skipped (blank or missing folder).")
    print("Restart the server (or reload the page) to see the filters pick these up.")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("export", "apply"):
        print(__doc__)
        sys.exit(1)
    if sys.argv[1] == "export":
        cmd_export()
    else:
        cmd_apply()
