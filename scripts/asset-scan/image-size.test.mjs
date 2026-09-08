import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {imageSize} from './image-size.mjs';

const crc32 = (buf) => {
	const table = [];
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	let crc = 0xffffffff;
	for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typed));
	return Buffer.concat([length, typed, crc]);
};

export const png = (width, height) => {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.concat(
		Array.from({length: height}, () =>
			Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 128)]),
		),
	);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', deflateSync(raw)),
		pngChunk('IEND', Buffer.alloc(0)),
	]);
};

const jpeg = (width, height) => {
	const len = (n) => {
		const b = Buffer.alloc(2);
		b.writeUInt16BE(n);
		return b;
	};
	const sof = Buffer.alloc(4);
	sof.writeUInt16BE(height, 0);
	sof.writeUInt16BE(width, 2);
	return Buffer.concat([
		Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
		len(16),
		Buffer.alloc(14),
		Buffer.from([0xff, 0xc0]),
		len(17),
		Buffer.from([8]),
		sof,
		Buffer.alloc(10),
		Buffer.from([0xff, 0xd9]),
	]);
};

const gif = (width, height) => {
	const buf = Buffer.alloc(14);
	buf.write('GIF89a', 0, 'ascii');
	buf.writeUInt16LE(width, 6);
	buf.writeUInt16LE(height, 8);
	return buf;
};

const webpVp8x = (width, height) => {
	const buf = Buffer.alloc(40);
	buf.write('RIFF', 0, 'ascii');
	buf.write('WEBP', 8, 'ascii');
	buf.write('VP8X', 12, 'ascii');
	buf.writeUIntLE(width - 1, 24, 3);
	buf.writeUIntLE(height - 1, 27, 3);
	return buf;
};

const bmp = (width, height) => {
	const buf = Buffer.alloc(30);
	buf.write('BM', 0, 'ascii');
	buf.writeInt32LE(width, 18);
	buf.writeInt32LE(-height, 22); // Negative height = top-down bitmap.
	return buf;
};

test('reads PNG dimensions', () => {
	assert.deepEqual(imageSize(png(40, 30), '.png'), {width: 40, height: 30});
});

test('reads JPEG dimensions from the SOF0 marker', () => {
	assert.deepEqual(imageSize(jpeg(640, 480), '.jpg'), {width: 640, height: 480});
});

test('reads GIF dimensions', () => {
	assert.deepEqual(imageSize(gif(12, 8), '.gif'), {width: 12, height: 8});
});

test('reads extended WebP dimensions', () => {
	assert.deepEqual(imageSize(webpVp8x(1920, 1080), '.webp'), {
		width: 1920,
		height: 1080,
	});
});

test('reads BMP dimensions, normalising top-down height', () => {
	assert.deepEqual(imageSize(bmp(100, 50), '.bmp'), {width: 100, height: 50});
});

test('prefers the SVG viewBox over width/height attributes', () => {
	const svg = Buffer.from(
		'<svg width="99pt" height="99pt" viewBox="0 0 24 48"><path d="M0 0"/></svg>',
	);
	assert.deepEqual(imageSize(svg, '.svg'), {width: 24, height: 48});
});

test('falls back to SVG width/height when there is no viewBox', () => {
	const svg = Buffer.from('<svg width="120" height="60"></svg>');
	assert.deepEqual(imageSize(svg, '.svg'), {width: 120, height: 60});
});

test('returns null for an unsupported extension', () => {
	assert.equal(imageSize(png(10, 10), '.avif'), null);
});

test('returns null for a truncated or corrupt file', () => {
	assert.equal(imageSize(Buffer.alloc(4), '.png'), null);
	assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), '.jpg'), null);
});

test('does not hang on a JPEG with a zero-length segment', () => {
	const evil = Buffer.concat([
		Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]),
		Buffer.alloc(64),
	]);
	assert.equal(imageSize(evil, '.jpg'), null);
});
