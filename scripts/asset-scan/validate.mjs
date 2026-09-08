// The checks a media tool's project panel gives you for free: broken links,
// unused files, duplicates, and files heavy enough to hurt.

import {readdir, readFile} from 'node:fs/promises';
import {extname, join, relative} from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

const walkSource = async (dir) => {
	const found = [];
	let entries;
	try {
		entries = await readdir(dir, {withFileTypes: true});
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await walkSource(full)));
		else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
			found.push(full);
		}
	}
	return found;
};

// Only literal arguments can be checked; a computed path is invisible to us
// and is deliberately not reported either way.
const ASSET_FILE_CALL = /\bassetFile\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
const STATIC_FILE_CALL = /\bstaticFile\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

/** Collects literal asset references from every source file under srcDir. */
export const collectReferences = async (srcDir) => {
	const byId = new Map();
	const byPath = new Map();

	for (const file of await walkSource(srcDir)) {
		const code = await readFile(file, 'utf8');
		for (const [, id] of code.matchAll(ASSET_FILE_CALL)) {
			if (!byId.has(id)) byId.set(id, []);
			byId.get(id).push(file);
		}
		for (const [, path] of code.matchAll(STATIC_FILE_CALL)) {
			const normalized = path.replace(/^\.?\//, '');
			if (!byPath.has(normalized)) byPath.set(normalized, []);
			byPath.get(normalized).push(file);
		}
	}

	return {byId, byPath};
};

const formatBytes = (bytes) => {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};

/**
 * Produces problems (things that are wrong) and notes (things worth knowing).
 * Only problems can fail a --check run.
 */
export const validate = async (assets, {srcDir, sizeWarningBytes, rootDir}) => {
	// Report source locations the way a developer would type them.
	const display = (file) =>
		rootDir ? relative(rootDir, file).split(/[/\\]/).join('/') : file;
	const problems = [];
	const notes = [];

	const ids = new Set(assets.map((asset) => asset.id));
	const paths = new Set(assets.map((asset) => asset.path));
	const {byId, byPath} = await collectReferences(srcDir);

	// Referenced but missing on disk — the "offline media" case.
	for (const [id, files] of byId) {
		if (!ids.has(id)) {
			problems.push(
				`assetFile('${id}') has no matching file in public/ (${files
					.map(display)
					.join(', ')})`,
			);
		}
	}
	for (const [path, files] of byPath) {
		if (!paths.has(path)) {
			problems.push(
				`staticFile('${path}') has no matching file in public/ (${files
					.map(display)
					.join(', ')})`,
			);
		}
	}

	// Present on disk but referenced nowhere.
	const referenced = new Set([
		...[...byId].map(([id]) => id),
		...assets
			.filter((asset) => byPath.has(asset.path))
			.map((asset) => asset.id),
	]);
	const unused = assets.filter((asset) => !referenced.has(asset.id));
	if (unused.length > 0) {
		notes.push(
			`${unused.length} asset(s) not referenced from src/: ${unused
				.map((asset) => asset.path)
				.join(', ')}`,
		);
	}

	// Byte-identical duplicates.
	const byHash = new Map();
	for (const asset of assets) {
		if (!byHash.has(asset.hash)) byHash.set(asset.hash, []);
		byHash.get(asset.hash).push(asset);
	}
	for (const group of byHash.values()) {
		if (group.length > 1) {
			notes.push(
				`duplicate content: ${group.map((asset) => asset.path).join(' = ')}`,
			);
		}
	}

	// Heavy files.
	for (const asset of assets) {
		if (asset.bytes >= sizeWarningBytes) {
			notes.push(`${asset.path} is ${formatBytes(asset.bytes)}`);
		}
	}

	return {problems, notes};
};

export {formatBytes};
