// Video/audio metadata via ffprobe.
//
// Remotion ships ffprobe inside its platform-specific compositor package, so
// there is normally nothing to install. We mirror Remotion's own platform
// resolution, then fall back to an ffprobe on PATH, then to nothing at all —
// a missing ffprobe degrades the manifest, it does not fail the scan.

import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

const compositorPackages = () => {
	const {platform, arch} = process;
	if (platform === 'win32') return ['@remotion/compositor-win32-x64-msvc'];
	if (platform === 'darwin') {
		return arch === 'arm64'
			? ['@remotion/compositor-darwin-arm64']
			: ['@remotion/compositor-darwin-x64'];
	}
	if (platform === 'linux') {
		// Try both libc flavours rather than sniffing; only one is installed.
		return arch === 'arm64'
			? [
					'@remotion/compositor-linux-arm64-gnu',
					'@remotion/compositor-linux-arm64-musl',
				]
			: [
					'@remotion/compositor-linux-x64-gnu',
					'@remotion/compositor-linux-x64-musl',
				];
	}
	return [];
};

let cached;

/** Absolute path to an ffprobe binary, or null when none is available. */
export const findFfprobe = () => {
	if (cached !== undefined) return cached;

	const binary = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
	for (const pkg of compositorPackages()) {
		try {
			const {dir} = require(pkg);
			const candidate = join(dir, binary);
			if (existsSync(candidate)) {
				cached = candidate;
				return cached;
			}
		} catch {
			// Package not installed for this platform; try the next.
		}
	}

	cached = 'ffprobe'; // Fall back to PATH; probeMedia handles it being absent.
	return cached;
};

const firstStream = (streams, type) =>
	streams.find((stream) => stream.codec_type === type);

const number = (value) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const parseFrameRate = (value) => {
	if (typeof value !== 'string') return undefined;
	const [num, den] = value.split('/').map(Number);
	if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
		return undefined;
	}
	// Round to 3dp so 30000/1001 reads as 29.97 rather than a long tail.
	return Math.round((num / den) * 1000) / 1000;
};

/**
 * Probes a media file. Returns null when ffprobe is unavailable or the file
 * cannot be read — callers treat that as "no media metadata", not an error.
 */
export const probeMedia = async (path) => {
	const ffprobe = findFfprobe();
	if (!ffprobe) return null;

	let stdout;
	try {
		({stdout} = await run(
			ffprobe,
			[
				'-v',
				'quiet',
				'-print_format',
				'json',
				'-show_format',
				'-show_streams',
				path,
			],
			{maxBuffer: 8 * 1024 * 1024},
		));
	} catch {
		return null;
	}

	let probed;
	try {
		probed = JSON.parse(stdout);
	} catch {
		return null;
	}

	const streams = Array.isArray(probed.streams) ? probed.streams : [];
	const video = firstStream(streams, 'video');
	const audio = firstStream(streams, 'audio');
	if (!video && !audio) return null;

	const durationInSeconds =
		number(probed.format?.duration) ??
		number(video?.duration) ??
		number(audio?.duration);

	const result = {};
	if (durationInSeconds !== undefined) {
		// 3dp is well below one frame at any sane fps.
		result.durationInSeconds = Math.round(durationInSeconds * 1000) / 1000;
	}
	if (video) {
		if (number(video.width)) result.width = video.width;
		if (number(video.height)) result.height = video.height;
		const fps = parseFrameRate(video.r_frame_rate);
		if (fps !== undefined) result.fps = fps;
		if (video.codec_name) result.codec = video.codec_name;
	} else if (audio) {
		if (audio.codec_name) result.codec = audio.codec_name;
	}
	if (audio) {
		if (number(audio.channels)) result.channels = audio.channels;
		if (number(audio.sample_rate)) result.sampleRate = Number(audio.sample_rate);
	}

	return Object.keys(result).length > 0 ? result : null;
};
