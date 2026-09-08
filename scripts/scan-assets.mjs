#!/usr/bin/env node
// Scans public/ and generates src/assets.ts, a typed manifest of every static
// asset, then validates the result.
//
//   npm run scan              regenerate the manifest
//   npm run scan -- --check   fail if the manifest is stale or invalid (CI)
//   npm run scan -- --watch   regenerate on every change to public/
//   npm run scan -- --json    also write src/assets.json
//
// Runs automatically before `npm start` and `npm run build`.

import {watch} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scanAssets, DEFAULT_SIZE_WARNING_BYTES} from './asset-scan/scan.mjs';
import {renderManifest, renderJson} from './asset-scan/manifest.mjs';
import {validate} from './asset-scan/validate.mjs';
import {findFfprobe} from './asset-scan/ffprobe.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const srcDir = join(root, 'src');
const manifestFile = join(srcDir, 'assets.ts');
const jsonFile = join(srcDir, 'assets.json');

const flags = new Set(process.argv.slice(2));
const check = flags.has('--check');
const isWatch = flags.has('--watch');
const emitJson = flags.has('--json');
const quiet = flags.has('--quiet');

const log = (message) => {
	if (!quiet) console.log(message);
};

const readIfExists = async (path) => {
	try {
		return await readFile(path, 'utf8');
	} catch {
		return null;
	}
};

const summarize = (assets) => {
	const counts = {};
	for (const asset of assets) counts[asset.kind] = (counts[asset.kind] ?? 0) + 1;
	return Object.entries(counts)
		.map(([kind, n]) => `${n} ${kind}`)
		.join(', ');
};

const run = async () => {
	if (!existsSync(publicDir)) {
		console.error(`scan-assets: no public/ directory at ${publicDir}`);
		return 1;
	}

	const assets = await scanAssets(publicDir);
	const manifest = renderManifest(assets);
	const json = renderJson(assets);

	const {problems, notes} = await validate(assets, {
		srcDir,
		rootDir: root,
		sizeWarningBytes: DEFAULT_SIZE_WARNING_BYTES,
	});

	if (check) {
		const stale = [];
		if ((await readIfExists(manifestFile)) !== manifest) {
			stale.push('src/assets.ts');
		}
		if (emitJson && (await readIfExists(jsonFile)) !== json) {
			stale.push('src/assets.json');
		}
		if (stale.length > 0) {
			console.error(
				`scan-assets: ${stale.join(' and ')} out of date — run \`npm run scan\` and commit the result`,
			);
		}
		for (const problem of problems) console.error(`scan-assets: ${problem}`);
		for (const note of notes) log(`scan-assets: note: ${note}`);
		if (stale.length > 0 || problems.length > 0) return 1;
		log(`scan-assets: manifest up to date (${assets.length} asset(s))`);
		return 0;
	}

	await writeFile(manifestFile, manifest);
	if (emitJson) await writeFile(jsonFile, json);

	const summary = summarize(assets);
	log(
		`scan-assets: ${assets.length} asset(s) -> src/assets.ts${
			summary ? ` (${summary})` : ''
		}`,
	);
	for (const note of notes) log(`scan-assets: note: ${note}`);
	for (const problem of problems) console.error(`scan-assets: ${problem}`);

	// A broken reference is a real error, but never a reason to leave the
	// manifest unwritten — the fix usually needs the fresh manifest.
	return problems.length > 0 ? 1 : 0;
};

if (isWatch) {
	if (findFfprobe() === 'ffprobe') {
		log('scan-assets: using ffprobe from PATH (Remotion’s copy not found)');
	}
	await run();
	log('scan-assets: watching public/ — ctrl-c to stop');

	let pending;
	let running = false;
	const schedule = () => {
		clearTimeout(pending);
		// Debounce: an editor save or a file copy fires several events.
		pending = setTimeout(async () => {
			if (running) return schedule();
			running = true;
			try {
				await run();
			} catch (err) {
				console.error(`scan-assets: ${err.message}`);
			} finally {
				running = false;
			}
		}, 150);
	};

	watch(publicDir, {recursive: true}, schedule);
} else {
	process.exit(await run());
}
