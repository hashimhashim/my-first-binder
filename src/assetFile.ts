import {staticFile} from 'remotion';
import {assetTable, type Asset, type AssetId} from './assets';

/**
 * Resolves a scanned asset to a URL Remotion can load.
 * Unlike a bare staticFile() call, a typo in the id is a compile error.
 */
export const assetFile = (id: AssetId) => staticFile(assetTable[id].path);

/** The full manifest entry for an asset. */
export const asset = (id: AssetId): Asset => assetTable[id];

/**
 * The asset's URL with a content-hash query string, so a CDN or browser cache
 * can be told to hold it forever and still pick up a replaced file.
 */
export const assetFileCacheBusted = (id: AssetId) =>
	`${assetFile(id)}?v=${assetTable[id].hash}`;

/**
 * Duration of a video or audio asset in frames, for `durationInFrames` on a
 * <Composition> or the length of a <Sequence>.
 *
 * Rounds up so the final partial frame is not clipped. Throws when the asset
 * has no known duration — an image, or a file scanned without ffprobe — since
 * silently returning 0 would render an empty composition.
 */
export const assetDurationInFrames = (id: AssetId, fps: number): number => {
	const {durationInSeconds, path} = assetTable[id];
	if (durationInSeconds === undefined) {
		throw new Error(
			`Asset '${String(id)}' (${path}) has no known duration. Run \`npm run scan\` with ffprobe available, or set the duration by hand.`,
		);
	}
	return Math.ceil(durationInSeconds * fps);
};

/** Aspect ratio of an asset with known dimensions, else null. */
export const assetAspectRatio = (id: AssetId): number | null => {
	const {width, height} = assetTable[id];
	return width && height ? width / height : null;
};
