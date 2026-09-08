// Walks public/ and builds the in-memory asset list the manifest is rendered
// from. Pure I/O + metadata extraction; no formatting, no validation.

import {createHash} from 'node:crypto';
import {readdir, readFile, stat} from 'node:fs/promises';
import {extname, join, relative} from 'node:path';
import {IGNORED_NAMES, isTimeBased, kindOf} from './kinds.mjs';
import {imageSize} from './image-size.mjs';
import {probeMedia} from './ffprobe.mjs';

/** Files big enough to be worth a second look before shipping. */
export const DEFAULT_SIZE_WARNING_BYTES = 25 * 1024 * 1024;

const walk = async (dir) => {
	const found = [];
	for (const entry of await readdir(dir, {withFileTypes: true})) {
		if (entry.name.startsWith('.')) continue;
		if (IGNORED_NAMES.has(entry.name.toLowerCase())) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await walk(full)));
		else if (entry.isFile()) found.push(full);
	}
	return found;
};

/**
 * Turns a path relative to public/ into a JS identifier.
 * 'nested/spin-loop.gif' -> 'nestedSpinLoop'
 */
export const toIdentifier = (relPath) => {
	const words = relPath
		.replace(/\.[^./]+$/, '')
		.replace(/[^a-zA-Z0-9]+/g, ' ')
		.trim()
		.split(' ')
		.filter(Boolean);

	if (words.length === 0) return 'asset';

	const camel = words
		.map((word, i) =>
			i === 0
				? word.toLowerCase()
				: word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
		)
		.join('');

	// Identifiers cannot start with a digit.
	return /^[a-z]/.test(camel)
		? camel
		: `asset${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
};

/** Assigns a unique id per path, keeping the first claimant's plain name. */
export const uniqueIds = (relPaths) => {
	const taken = new Set();
	const ids = new Map();
	for (const relPath of relPaths) {
		const base = toIdentifier(relPath);
		let id = base;
		let n = 2;
		while (taken.has(id)) id = `${base}${n++}`;
		taken.add(id);
		ids.set(relPath, id);
	}
	return ids;
};

const posix = (path) => path.split(/[/\\]/).join('/');

/**
 * Scans a public directory. Returns assets sorted by path, so the generated
 * manifest is byte-identical across machines and runs.
 */
export const scanAssets = async (publicDir, {probe = true} = {}) => {
	const files = (await walk(publicDir)).sort();
	const relPaths = files.map((file) => posix(relative(publicDir, file)));
	const ids = uniqueIds(relPaths);

	return Promise.all(
		files.map(async (file, index) => {
			const relPath = relPaths[index];
			const ext = extname(file).toLowerCase();
			const kind = kindOf(ext);
			const [{size}, buffer] = await Promise.all([stat(file), readFile(file)]);

			const asset = {
				id: ids.get(relPath),
				path: relPath,
				kind,
				extension: ext,
				bytes: size,
				// Short content hash: dedupe detection, and a cache-busting token
				// for anyone serving these from a CDN.
				hash: createHash('sha256').update(buffer).digest('hex').slice(0, 12),
			};

			if (kind === 'image') {
				const dimensions = imageSize(buffer, ext);
				if (dimensions) Object.assign(asset, dimensions);
			} else if (probe && isTimeBased(kind)) {
				const media = await probeMedia(file);
				if (media) Object.assign(asset, media);
			}

			return asset;
		}),
	);
};
