// Scans public/ and generates src/assets.ts, a typed manifest of every static
// asset. Run via `npm run scan`; also runs automatically before start/build.
//
// Image dimensions are read straight from file headers so this stays
// dependency-free. Video/audio duration is not resolvable here without ffprobe
// — use getVideoMetadata/getAudioDurationInSeconds from @remotion/media-utils
// at runtime for that.

import {readdir, readFile, stat, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join, relative, extname, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const outFile = join(root, 'src', 'assets.ts');

const KINDS = {
	image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg'],
	video: ['.mp4', '.webm', '.mov', '.mkv', '.m4v'],
	audio: ['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac'],
	font: ['.woff', '.woff2', '.ttf', '.otf'],
	data: ['.json', '.csv', '.txt', '.srt', '.vtt'],
};

// Documentation living in public/ is not an asset.
const IGNORED_NAMES = new Set(['readme.md', 'license', 'license.md']);

const kindOf = (ext) => {
	for (const [kind, exts] of Object.entries(KINDS)) {
		if (exts.includes(ext)) return kind;
	}
	return 'other';
};

const walk = async (dir) => {
	const out = [];
	for (const entry of await readdir(dir, {withFileTypes: true})) {
		if (entry.name.startsWith('.')) continue;
		if (IGNORED_NAMES.has(entry.name.toLowerCase())) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		else if (entry.isFile()) out.push(full);
	}
	return out;
};

// --- image dimension readers (header parsing, no decode) ---

const readPng = (buf) =>
	buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47
		? {width: buf.readUInt32BE(16), height: buf.readUInt32BE(20)}
		: null;

const readGif = (buf) =>
	buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF'
		? {width: buf.readUInt16LE(6), height: buf.readUInt16LE(8)}
		: null;

const readBmp = (buf) =>
	buf.length >= 26 && buf.toString('ascii', 0, 2) === 'BM'
		? {width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22))}
		: null;

const readJpeg = (buf) => {
	if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
	let offset = 2;
	while (offset + 9 < buf.length) {
		if (buf[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = buf[offset + 1];
		// SOF0-SOF15, excluding DHT (c4), JPG (c8) and DAC (cc)
		if (
			marker >= 0xc0 &&
			marker <= 0xcf &&
			![0xc4, 0xc8, 0xcc].includes(marker)
		) {
			return {
				height: buf.readUInt16BE(offset + 5),
				width: buf.readUInt16BE(offset + 7),
			};
		}
		offset += 2 + buf.readUInt16BE(offset + 2);
	}
	return null;
};

const readWebp = (buf) => {
	if (buf.length < 30 || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
	const format = buf.toString('ascii', 12, 16);
	if (format === 'VP8X') {
		return {
			width: 1 + buf.readUIntLE(24, 3),
			height: 1 + buf.readUIntLE(27, 3),
		};
	}
	if (format === 'VP8 ') {
		return {
			width: buf.readUInt16LE(26) & 0x3fff,
			height: buf.readUInt16LE(28) & 0x3fff,
		};
	}
	if (format === 'VP8L') {
		const bits = buf.readUInt32LE(21);
		return {width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1};
	}
	return null;
};

const readSvg = (buf) => {
	const head = buf.toString('utf8', 0, 2048);
	const viewBox = head.match(/viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/);
	if (viewBox) {
		return {width: Math.round(+viewBox[1]), height: Math.round(+viewBox[2])};
	}
	const w = head.match(/\bwidth\s*=\s*["']\s*([\d.]+)/);
	const h = head.match(/\bheight\s*=\s*["']\s*([\d.]+)/);
	return w && h ? {width: Math.round(+w[1]), height: Math.round(+h[1])} : null;
};

const dimensionsOf = async (path, ext) => {
	const readers = {
		'.png': readPng,
		'.gif': readGif,
		'.bmp': readBmp,
		'.jpg': readJpeg,
		'.jpeg': readJpeg,
		'.webp': readWebp,
		'.svg': readSvg,
	};
	const reader = readers[ext];
	if (!reader) return null;
	try {
		return reader(await readFile(path));
	} catch {
		return null;
	}
};

// --- manifest generation ---

const identifier = (relPath) => {
	const base = relPath
		.replace(/\.[^./]+$/, '')
		.replace(/[^a-zA-Z0-9]+/g, ' ')
		.trim()
		.split(' ')
		.map((word, i) =>
			i === 0
				? word.toLowerCase()
				: word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
		)
		.join('');
	return /^[a-z]/.test(base) ? base : `asset${base.charAt(0).toUpperCase()}${base.slice(1)}`;
};

const main = async () => {
	if (!existsSync(publicDir)) {
		console.error(`scan-assets: no public/ directory at ${publicDir}`);
		process.exit(1);
	}

	const files = (await walk(publicDir)).sort();
	const assets = [];
	const seen = new Map();

	for (const file of files) {
		const relPath = relative(publicDir, file).split(/[/\\]/).join('/');
		const ext = extname(file).toLowerCase();
		const {size} = await stat(file);

		let id = identifier(relPath);
		if (seen.has(id)) {
			const n = seen.get(id) + 1;
			seen.set(id, n);
			id = `${id}${n}`;
		} else {
			seen.set(id, 1);
		}

		assets.push({
			id,
			path: relPath,
			kind: kindOf(ext),
			extension: ext,
			bytes: size,
			dimensions: await dimensionsOf(file, ext),
		});
	}

	const entries = assets
		.map((asset) => {
			const dims = asset.dimensions
				? `\n\t\twidth: ${asset.dimensions.width},\n\t\theight: ${asset.dimensions.height},`
				: '';
			return [
				`\t${asset.id}: {`,
				`\t\tpath: '${asset.path}',`,
				`\t\tkind: '${asset.kind}',`,
				`\t\textension: '${asset.extension}',`,
				`\t\tbytes: ${asset.bytes},${dims}`,
				`\t},`,
			].join('\n');
		})
		.join('\n');

	const contents = `// GENERATED by scripts/scan-assets.mjs — do not edit by hand.
// Run \`npm run scan\` after adding or removing files in public/.

export type AssetKind = ${Object.keys(KINDS)
		.concat('other')
		.map((k) => `'${k}'`)
		.join(' | ')};

export type Asset = {
	/** Path relative to public/, as passed to staticFile(). */
	path: string;
	kind: AssetKind;
	extension: string;
	bytes: number;
	/** Present for images whose header could be parsed. */
	width?: number;
	height?: number;
};

export const assets = {${entries ? `\n${entries}\n` : ''}} as const satisfies Record<string, Asset>;

export type AssetId = keyof typeof assets;

/** Widened view of the manifest, for lookups by a runtime string. */
export const assetTable: Record<string, Asset> = assets;

export const allAssets: readonly (Asset & {id: AssetId})[] = Object.entries(
	assetTable,
).map(([id, asset]) => ({...asset, id: id as AssetId}));

export const assetsByKind = (kind: AssetKind) =>
	allAssets.filter((asset) => asset.kind === kind);
`;

	await writeFile(outFile, contents);
	const counts = assets.reduce((acc, a) => {
		acc[a.kind] = (acc[a.kind] ?? 0) + 1;
		return acc;
	}, {});
	const summary = Object.entries(counts)
		.map(([k, n]) => `${n} ${k}`)
		.join(', ');
	console.log(
		`scan-assets: ${assets.length} asset(s) -> src/assets.ts${
			summary ? ` (${summary})` : ''
		}`,
	);
};

await main();
