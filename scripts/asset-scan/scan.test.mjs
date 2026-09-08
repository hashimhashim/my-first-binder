import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanAssets, toIdentifier, uniqueIds} from './scan.mjs';
import {png} from './image-size.test.mjs';

const fixture = async (files) => {
	const dir = await mkdtemp(join(tmpdir(), 'assets-'));
	for (const [path, contents] of Object.entries(files)) {
		const full = join(dir, path);
		await mkdir(join(full, '..'), {recursive: true});
		await writeFile(full, contents);
	}
	return dir;
};

test('camelCases paths into identifiers', () => {
	assert.equal(toIdentifier('logo.png'), 'logo');
	assert.equal(toIdentifier('nested/spin-loop.gif'), 'nestedSpinLoop');
	assert.equal(toIdentifier('theme song.mp3'), 'themeSong');
	assert.equal(toIdentifier('UPPER_CASE.png'), 'upperCase');
});

test('prefixes identifiers that would start with a digit', () => {
	assert.equal(toIdentifier('2captions.srt'), 'asset2captions');
});

test('falls back to a usable name when nothing survives sanitising', () => {
	assert.equal(toIdentifier('---.png'), 'asset');
});

test('disambiguates colliding identifiers deterministically', () => {
	const ids = uniqueIds(['a/logo.png', 'b/logo.png', 'c/logo.png']);
	assert.deepEqual(
		[...ids.values()],
		['aLogo', 'bLogo', 'cLogo'],
	);
	const collides = uniqueIds(['logo.png', 'logo-.png', 'logo_.png']);
	assert.equal(new Set(collides.values()).size, 3);
});

test('scans a directory tree, sorted and hashed', async () => {
	const dir = await fixture({
		'logo.png': png(40, 30),
		'nested/notes.txt': 'hello',
		'README.md': '# docs',
		'.hidden': 'ignored',
	});

	const assets = await scanAssets(dir, {probe: false});

	assert.deepEqual(
		assets.map((asset) => asset.path),
		['logo.png', 'nested/notes.txt'],
		'README, dotfiles excluded; results sorted by path',
	);

	const [logo, notes] = assets;
	assert.equal(logo.kind, 'image');
	assert.equal(logo.width, 40);
	assert.equal(logo.height, 30);
	assert.equal(logo.extension, '.png');
	assert.match(logo.hash, /^[0-9a-f]{12}$/);

	assert.equal(notes.kind, 'data');
	assert.equal(notes.id, 'nestedNotes');
	assert.equal(notes.bytes, 5);
	assert.equal(notes.width, undefined);
});

test('gives identical content the same hash', async () => {
	const dir = await fixture({'a.png': png(10, 10), 'b.png': png(10, 10)});
	const [a, b] = await scanAssets(dir, {probe: false});
	assert.equal(a.hash, b.hash);
});

test('produces byte-identical results across runs', async () => {
	const dir = await fixture({
		'b.png': png(10, 10),
		'a/deep/c.txt': 'x',
		'a.txt': 'y',
	});
	const first = await scanAssets(dir, {probe: false});
	const second = await scanAssets(dir, {probe: false});
	assert.deepEqual(first, second);
});
