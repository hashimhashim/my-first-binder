// Classification of files found in public/ by extension.

export const KINDS = {
	image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg'],
	video: ['.mp4', '.webm', '.mov', '.mkv', '.m4v'],
	audio: ['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac'],
	font: ['.woff', '.woff2', '.ttf', '.otf'],
	data: ['.json', '.csv', '.txt', '.srt', '.vtt'],
};

export const ALL_KINDS = [...Object.keys(KINDS), 'other'];

/** Documentation living in public/ is not an asset. */
export const IGNORED_NAMES = new Set(['readme.md', 'license', 'license.md']);

export const kindOf = (ext) => {
	for (const [kind, exts] of Object.entries(KINDS)) {
		if (exts.includes(ext)) return kind;
	}
	return 'other';
};

/** Kinds ffprobe can tell us something useful about. */
export const isTimeBased = (kind) => kind === 'video' || kind === 'audio';
