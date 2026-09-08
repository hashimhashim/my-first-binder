# public/

Static assets go here. Anything in this folder is served by Remotion and can be
referenced with `staticFile('<path>')`.

## The manifest

`npm run scan` walks this folder and regenerates `src/assets.ts`, a typed
manifest of everything in it:

| Field | Applies to | Source |
| --- | --- | --- |
| `path`, `kind`, `extension`, `bytes` | all | the filesystem |
| `hash` | all | first 12 hex chars of the file's sha256 |
| `width`, `height` | images, video | image headers / ffprobe |
| `durationInSeconds` | video, audio | ffprobe |
| `fps`, `codec` | video | ffprobe |
| `channels`, `sampleRate` | audio | ffprobe |

`npm start` and `npm run build` run the scan first, so the manifest cannot go
stale during normal use.

## Using assets

Reference assets through the helpers in `src/assetFile.ts` rather than raw
strings, so a typo fails at compile time instead of 404ing mid-render:

```tsx
import {Audio, Img} from 'remotion';
import {assetFile, assetDurationInFrames} from './assetFile';
import {assets} from './assets';

<Img src={assetFile('logo')} style={{width: assets.logo.width}} />
<Audio src={assetFile('themeSong')} />

// Size a composition to the media it plays:
<Composition
  id="Intro"
  durationInFrames={assetDurationInFrames('introClip', 30)}
  fps={30}
  {...}
/>
```

`assetFileCacheBusted(id)` appends the content hash as a query string, for
serving these from a CDN with a long cache lifetime.

## Commands

| Command | What it does |
| --- | --- |
| `npm run scan` | Regenerate `src/assets.ts` |
| `npm run scan:check` | Fail if the manifest is stale or a reference is broken (CI) |
| `npm run scan:watch` | Regenerate on every change to this folder |
| `npm run scan -- --json` | Also write `src/assets.json` for external tooling |

## Previewing what is here

The `AssetBrowser` composition renders the whole manifest as a contact sheet —
thumbnails for images, a frame for video, a waveform for audio, and the scanned
metadata under each. Open it in `npm start`, or render a still:

```
npx remotion still AssetBrowser assets.png
```

It reads `src/assets.ts` only, so it always shows exactly what the last scan
found — including an empty state when `public/` has nothing in it.

## What the scan reports

**Problems** (these fail `scan:check`):

- an `assetFile('id')` or `staticFile('path')` call with no file behind it

**Notes** (informational):

- assets not referenced anywhere in `src/`
- byte-identical duplicates
- files over 25 MB

## ffprobe

Duration, fps, and codec come from ffprobe, which ships inside Remotion's
compositor package — normally there is nothing to install. If it cannot be
found, the scan falls back to an `ffprobe` on `PATH`, and failing that simply
omits those fields rather than failing.
