// Pixel dimensions read straight from image headers — no decode, no dependencies.

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
		// SOF0-SOF15, excluding DHT (c4), JPG (c8) and DAC (cc).
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
		const segment = buf.readUInt16BE(offset + 2);
		if (segment < 2) return null; // Malformed; refuse to loop forever.
		offset += 2 + segment;
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
	const head = buf.toString('utf8', 0, 4096);
	const viewBox = head.match(
		/viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/,
	);
	if (viewBox) {
		return {width: Math.round(+viewBox[1]), height: Math.round(+viewBox[2])};
	}
	const w = head.match(/\bwidth\s*=\s*["']\s*([\d.]+)/);
	const h = head.match(/\bheight\s*=\s*["']\s*([\d.]+)/);
	return w && h ? {width: Math.round(+w[1]), height: Math.round(+h[1])} : null;
};

const READERS = {
	'.png': readPng,
	'.gif': readGif,
	'.bmp': readBmp,
	'.jpg': readJpeg,
	'.jpeg': readJpeg,
	'.webp': readWebp,
	'.svg': readSvg,
};

/** Returns {width, height} for a supported image buffer, else null. */
export const imageSize = (buffer, ext) => {
	const reader = READERS[ext];
	if (!reader) return null;
	try {
		const size = reader(buffer);
		return size && size.width > 0 && size.height > 0 ? size : null;
	} catch {
		return null;
	}
};

export const SUPPORTED_IMAGE_EXTENSIONS = Object.keys(READERS);
