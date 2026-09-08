# public/

Static assets go here. Anything in this folder is served by Remotion and can be
referenced with `staticFile('<path>')`.

After adding or removing files, run:

```
npm run scan
```

That regenerates `src/assets.ts`, a typed manifest of everything in this folder
(kind, extension, byte size, and pixel dimensions for images). `npm start` and
`npm run build` run the scan automatically.

Reference assets through the manifest rather than raw strings so a typo fails at
compile time:

```tsx
import {assetFile} from './assetFile';
import {assets} from './assets';

<Img src={assetFile('logo')} style={{width: assets.logo.width}} />;
```

Video and audio durations are not in the manifest — read them at runtime with
`getVideoMetadata` / `getAudioDurationInSeconds` from `@remotion/media-utils`.
