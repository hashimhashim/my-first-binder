import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validate, formatBytes} from './validate.mjs';

const srcWith = async (code) => {
	const dir = await mkdtemp(join(tmpdir(), 'src-'));
	await mkdir(join(dir, 'nested'), {recursive: true});
	await writeFile(join(dir, 'nested', 'Comp.tsx'), code);
	return dir;
};

const asset = (over) => ({
	id: 'logo',
	path: 'logo.png',
	kind: 'image',
	extension: '.png',
	bytes: 100,
	hash: 'aaaaaaaaaaaa',
	...over,
});

const run = (assets, srcDir) =>
	validate(assets, {srcDir, sizeWarningBytes: 25 * 1024 * 1024});

test('flags assetFile ids with no file behind them', async () => {
	const srcDir = await srcWith(`assetFile('ghost');`);
	const {problems} = await run([asset()], srcDir);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /assetFile\('ghost'\) has no matching file/);
});

test('flags staticFile paths with no file behind them', async () => {
	const srcDir = await srcWith(`staticFile('missing/frame.png');`);
	const {problems} = await run([asset()], srcDir);
	assert.match(problems[0], /staticFile\('missing\/frame\.png'\)/);
});

test('accepts a staticFile path written with a leading slash', async () => {
	const srcDir = await srcWith(`staticFile('/logo.png');`);
	const {problems, notes} = await run([asset()], srcDir);
	assert.deepEqual(problems, []);
	assert.equal(notes.filter((n) => n.includes('not referenced')).length, 0);
});

test('reports assets nothing references', async () => {
	const srcDir = await srcWith(`const nothing = true;`);
	const {problems, notes} = await run([asset()], srcDir);
	assert.deepEqual(problems, []);
	assert.match(notes.join('\n'), /1 asset\(s\) not referenced.*logo\.png/);
});

test('does not report an asset referenced by id', async () => {
	const srcDir = await srcWith(`<Img src={assetFile('logo')} />`);
	const {notes} = await run([asset()], srcDir);
	assert.equal(notes.filter((n) => n.includes('not referenced')).length, 0);
});

test('reports byte-identical duplicates', async () => {
	const srcDir = await srcWith('');
	const {notes} = await run(
		[asset(), asset({id: 'logoCopy', path: 'copy.png'})],
		srcDir,
	);
	assert.match(notes.join('\n'), /duplicate content: logo\.png = copy\.png/);
});

test('reports files over the size budget', async () => {
	const srcDir = await srcWith('');
	const {notes} = await run(
		[asset({bytes: 40 * 1024 * 1024, path: 'huge.mp4'})],
		srcDir,
	);
	assert.match(notes.join('\n'), /huge\.mp4 is 40 MB/);
});

test('ignores non-source files and node_modules', async () => {
	const srcDir = await srcWith('');
	await mkdir(join(srcDir, 'node_modules'), {recursive: true});
	await writeFile(
		join(srcDir, 'node_modules', 'lib.js'),
		`assetFile('fromDependency');`,
	);
	await writeFile(join(srcDir, 'notes.md'), `assetFile('fromMarkdown');`);
	const {problems} = await run([asset()], srcDir);
	assert.deepEqual(problems, []);
});

test('formats byte counts readably', () => {
	assert.equal(formatBytes(512), '512 B');
	assert.equal(formatBytes(2048), '2.0 KB');
	assert.equal(formatBytes(25 * 1024 * 1024), '25 MB');
});
