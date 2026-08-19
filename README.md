# LiteAvatar
We introduce a audio2face model for realtime 2D chat avatar, which can run in 30fps on only CPU devices without GPU acceleration.
## Pipeline
- An efficient ASR model from [modelsope](https://modelscope.cn/models/iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch) for audio feature extraction.
- A mouth parameter prediction model given audio feature inputs for voice synchronized mouth movement generation.
- A lightweight 2D face generator model for mouth movement rendering, which can also be deployed on mobile devices realizing realtime inference.
🔥More avatars can be found at [LiteAvatarGallery](https://modelscope.cn/models/HumanAIGC-Engineering/LiteAvatarGallery/summary)

## Quick start (Windows) — one command, no setup

Double-click **`app.cmd`**. On first run it will, entirely on its own:
1. Find/verify a compatible Python (3.9–3.12),
2. Create a local virtual environment and install all CPU dependencies,
3. Download the model weights (`download_model.bat`),
4. Start a local web server and open `http://localhost:8000` in your browser.

From there, pick an avatar in the sidebar, choose or upload an audio file,
press **Generate**, and watch the result play back right in the page.
Subsequent runs skip everything already in place and just start the server —
no separate setup script needed. Everything stays on your machine; nothing
is uploaded anywhere.

## Second mode: Instant 3D Avatar

Once the server is running, click **Instant 3D Avatar** at the top of the
sidebar (or open `http://localhost:8000/lipsync.html` directly) for a much
faster, lower-fidelity alternative: instead of generating a video frame by
frame with a neural net, it picks from **210 pre-built 3D avatars** (105
male, 105 female, see Acknowledgement below) and animates the mouth live in
your browser while the audio plays - no AI inference at all, so there's no
wait. The left sidebar (search, ethnicity/gender/outfit filters, browsable
list) matches the standalone VALID Avatar Viewer this dataset ships with;
drag to rotate and scroll to zoom on the model in the main pane.

To make an avatar speak:
1. Pick a clip from the **sample audio dropdown**, or upload your own.
2. The app runs a quick pitch (F0) analysis (`librosa`) to guess male/female
   - not a trained classifier, so unusual voices can be guessed wrong - and
   filters the **"Avatar to speak" dropdown** to matching avatars.
3. Pick one from that dropdown and press **Play**.

Mouth movement is driven in real time from the audio's own volume and
frequency content, mapped onto the real viseme blend shapes built into
these models (Three.js, entirely client-side). It approximates speech
shapes rather than reading exact phonemes - true phoneme-accurate lip sync
would need its own model, which defeats the point of this mode being
instant. Blinking, eye movement, and a bit of head motion while speaking
run independently of the mouth, adapted from the VALID Avatar Viewer's own
idle-animation system, so avatars don't look frozen between words. These
avatars also ship in a T-pose by default; the app corrects the arms/hands
to a relaxed pose on load, also adapted from that viewer.

Note on realism: these 210 models are stylized, low-poly figures, not
photorealistic faces - a different look entirely from the photographic 2D
avatar in the AI Video Generator mode. See "Getting more avatars" below if
you want to swap in more realistic ones.

## Data layout

- `data/Avatars_2D/` - assets for the AI Video Generator mode: the bundled
  avatar (`avatar_01/`, shipped pre-extracted) and any extra 2D LiteAvatar
  presets you add (see "Getting more avatars" below).
- `data/Avatars_3D/` - all 210 pre-built 3D avatar models for the Instant
  3D Avatar mode (`avatars/<ethnicity>/*.glb` + `images/*.jpg` thumbnails,
  as shipped by the source dataset), plus `manifest.json` indexing them
  (id/name/gender/ethnicity/outfit/file paths) - this manifest is the
  in-app "database"; there's no separate database server involved.
- `data/Audio/` - 10 bundled English sample clips for the audio dropdown
  in both modes, plus `manifest.json` indexing them (id/label/gender/file
  paths). Add more `.wav`/`.mp3` files here and an entry to
  `manifest.json` to extend the dropdown. Two scripts can replace these:
  - `scripts\generate_sample_audio.bat` - free Microsoft neural voices
    (5 male, 5 female), synthesized, not real human voices, but
    genuinely natural-sounding rather than robotic.
  - `scripts\generate_sample_audio_real_voices.bat` - real, actual human
    voices from [Mozilla Common Voice](https://commonvoice.mozilla.org/)
    (CC0/public domain - contributors explicitly donate their
    recordings, free to use with no attribution required), 5 male + 5
    female speakers, each with enough of that speaker's clips
    concatenated together to clear 10 seconds.

  Both need a normal internet connection - this project's own build
  environment couldn't reach either Microsoft's TTS service or
  Hugging Face/Mozilla's servers to generate these directly.

## Getting more avatars

**2D (AI Video Generator):** extra presets from the
[LiteAvatar Gallery](https://modelscope.cn/models/HumanAIGC-Engineering/LiteAvatarGallery)
can be dropped into `data/Avatars_2D/` as a subfolder containing
`net_encode.pt`, `net_decode.pt`, `bg_video.mp4` and the rest of the preset
files - they'll show up in the sidebar automatically next time the page
loads. Note: that gallery is hosted on modelscope.cn, which wasn't
reachable from the environment this project was built in, so only the one
bundled avatar could be included here - downloading additional ones from
the gallery is a manual step on your end.

If you download the gallery's dated batches (e.g. `20250408`, `20250612` -
each a folder of individually-zipped avatars) into
`data/Avatars_2D/20250408/` and `data/Avatars_2D/20250612/`, click
**Import new avatars** in the right panel of the AI Video Generator page
instead of extracting them by hand - it finds each zip, extracts it,
and renames it to the next `avatar_NN`, leaving the original zip files
untouched. (Same logic is also available as a standalone script - see
`scripts/reorganize_avatars_2d.ps1` - if you'd rather run it outside the
browser.)

The left sidebar's Ethnicity/Gender filters (matching the 3D mode's, minus
Outfit) work from optional tagging, not automatic detection - there's no
way to determine an avatar's gender from a LiteAvatar model folder itself
(it's just neural network weights and a background video). To tag one,
add a `meta.json` next to its folder, e.g. `data/Avatars_2D/avatar_03/
meta.json`:
```json
{"gender": "female", "ethnicity": ""}
```
Leave a field blank to skip it - it just won't show up in that filter.

For tagging many avatars at once (e.g. after importing a batch), hand-
editing individual `meta.json` files doesn't scale - use
`scripts\tag_avatars_2d.bat export` instead. It scans every avatar,
extracts a preview photo from each one, and writes both a visual contact
sheet (`avatars_2d_contact_sheet.html` - open it in a browser to see all
of them at once) and an editable `avatars_2d_tags.csv`. Fill in the CSV
while cross-referencing the contact sheet, then run
`scripts\tag_avatars_2d.bat apply` to write all the `meta.json` files at
once.

**3D (Instant 3D Avatar), including more realistic/photoreal options:**
this mode needs a rigged glTF (`.glb`) model with viseme-style facial
morph targets (blend shapes) to animate - not every 3D model has that.
The 210 bundled avatars are stylized rather than photorealistic; for a more
realistic look you'd need to source or build your own. Some starting
points, each with real trade-offs worth knowing before you commit to one:
- [Ready Player Me](https://readyplayer.me/) - free avatar creator, more
  realistic style than the bundled set, exports `.glb` with ARKit-style
  blend shapes. Check their current terms for your intended use - the
  free tier is aimed at personal/hobby projects.
- [Sketchfab](https://sketchfab.com/) - a marketplace with some free and
  paid realistic head/character models; licenses vary per model, and most
  aren't rigged with viseme blend shapes out of the box, so budget time
  for rigging work (e.g. in Blender) before they'll animate here.
- Reallusion Character Creator / Daz3D - genuinely photoreal, but paid
  tools with their own export pipelines (typically FBX, not glTF) - you'd
  need a conversion step to get a `.glb` with the right morph targets.

Whatever you source, if the exported model's morph target names differ
from this project's viseme naming (see `h_expressions.*` / `h_teeth.t_*`
in `webapp/lipsync.js`), that mapping needs updating to match - drop the
`.glb` in `data/Avatars_3D/avatars/<new-id>/model.glb`, add an entry to
`data/Avatars_3D/manifest.json`, and adjust the mapping in `lipsync.js`
from there.

## Manual / command-line use
If you'd rather drive the pipeline yourself (e.g. on Linux, or without the
web UI):
```shell
pip install -r requirements.txt
```
```shell
# for windows
download_model.bat

# for linux
bash download_model.sh
```
```shell
python lite_avatar.py --data_dir /path/to/sample_data --audio_file /path/to/audio.wav --result_dir /path/to/result
```
The mp4 video result will be saved in the result_dir.

## Interactive demo
The realtime interactive video chat demo powered by our LiteAvatar algorithm is available at [OpenAvatarChat](https://github.com/HumanAIGC-Engineering/OpenAvatarChat)
## Acknowledgement
We are grateful for the following open-source projects that we used in this project:
- [Paraformer](https://modelscope.cn/models/iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch)
 and [FunASR](https://github.com/modelscope/FunASR) for audio feature extraction.
- The 210 avatars used in the Instant 3D Avatar mode (`data/Avatars_3D/`) are
  from the [VALID avatar library](https://github.com/xrtlab/Validated-Avatar-Library-for-Inclusion-and-Diversity---VALID)
  (Tiffany Do, MIT License), via its [glTF conversion](https://github.com/c-frame/valid-avatars-glb),
  including its studio lighting/camera-framing/T-pose-correction approach,
  adapted here from that project's own viewer.html.
- [three.js](https://threejs.org/) (MIT License) for rendering the 3D avatars, vendored locally in `webapp/vendor/`.
- The 10 bundled English sample audio clips (`data/Audio/`) were synthesized
  locally with [espeak-ng](https://github.com/espeak-ng/espeak-ng) (GPL-3.0).
  Run `scripts\generate_sample_audio.bat` to regenerate them with
  [edge-tts](https://github.com/rany2/edge-tts) (LGPL-3.0) instead, using
  Microsoft's free neural voices for more natural-sounding speech.
## Citation
If you find this project useful, please ⭐️ star the repository and cite our related paper:
```
@inproceedings{ZhuangQZZT22,
  author       = {Wenlin Zhuang and Jinwei Qi and Peng Zhang and Bang Zhang and Ping Tan},
  title        = {Text/Speech-Driven Full-Body Animation},
  booktitle    = {Proceedings of the Thirty-First International Joint Conference on Artificial Intelligence, {IJCAI}},
  pages        = {5956--5959},
  year         = {2022}
}
```
