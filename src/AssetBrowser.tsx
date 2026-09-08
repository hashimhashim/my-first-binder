import {AbsoluteFill, Img, OffthreadVideo, staticFile} from 'remotion';
import {allAssets, assets, type Asset, type AssetKind} from './assets';

const KIND_COLOR: Record<AssetKind, string> = {
	image: '#7c6cff',
	video: '#2ea3ff',
	audio: '#22c39a',
	font: '#f0a23c',
	data: '#8c94a8',
	other: '#6b7280',
};

const formatBytes = (bytes: number) => {
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

const facts = (asset: Asset) => {
	const out: string[] = [];
	if (asset.width && asset.height) out.push(`${asset.width}×${asset.height}`);
	if (asset.durationInSeconds !== undefined) {
		out.push(`${asset.durationInSeconds.toFixed(2)}s`);
	}
	if (asset.fps !== undefined) out.push(`${asset.fps} fps`);
	if (asset.channels !== undefined) {
		out.push(asset.channels === 1 ? 'mono' : `${asset.channels}ch`);
	}
	if (asset.sampleRate !== undefined) {
		out.push(`${(asset.sampleRate / 1000).toFixed(1)} kHz`);
	}
	if (asset.codec) out.push(asset.codec);
	return out;
};

const Waveform: React.FC<{color: string}> = ({color}) => (
	<div
		style={{
			display: 'flex',
			alignItems: 'center',
			gap: 5,
			height: '100%',
			padding: '54px 28px 28px',
		}}
	>
		{Array.from({length: 28}, (_, i) => {
			// Deterministic pseudo-random so the still is reproducible.
			const h = 20 + Math.abs(Math.sin(i * 1.7) * 78);
			return (
				<div
					key={i}
					style={{
						flex: 1,
						height: `${h}%`,
						borderRadius: 3,
						background: color,
						opacity: 0.35 + (h / 100) * 0.55,
					}}
				/>
			);
		})}
	</div>
);

const Glyph: React.FC<{label: string; color: string}> = ({label, color}) => (
	<div
		style={{
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			height: '100%',
			fontSize: 34,
			fontWeight: 700,
			letterSpacing: 2,
			color,
			opacity: 0.85,
		}}
	>
		{label}
	</div>
);

const Preview: React.FC<{asset: Asset}> = ({asset}) => {
	const color = KIND_COLOR[asset.kind];
	if (asset.kind === 'image') {
		return (
			<Img
				src={staticFile(asset.path)}
				style={{width: '100%', height: '100%', objectFit: 'cover'}}
			/>
		);
	}
	if (asset.kind === 'video') {
		return (
			<OffthreadVideo
				src={staticFile(asset.path)}
				style={{width: '100%', height: '100%', objectFit: 'cover'}}
			/>
		);
	}
	if (asset.kind === 'audio') return <Waveform color={color} />;
	return <Glyph label={asset.extension.replace('.', '').toUpperCase()} color={color} />;
};

const Card: React.FC<{asset: Asset & {id: string}}> = ({asset}) => {
	const color = KIND_COLOR[asset.kind];
	return (
		<div
			style={{
				background: '#161a24',
				border: '1px solid #262c3a',
				borderRadius: 16,
				overflow: 'hidden',
				display: 'flex',
				flexDirection: 'column',
			}}
		>
			<div
				style={{
					height: 232,
					background: '#0e121a',
					borderBottom: '1px solid #262c3a',
					position: 'relative',
				}}
			>
				<Preview asset={asset} />
				<div
					style={{
						position: 'absolute',
						top: 12,
						left: 12,
						padding: '4px 12px',
						borderRadius: 999,
						background: color,
						color: '#0b0e14',
						fontSize: 15,
						fontWeight: 700,
						letterSpacing: 0.4,
					}}
				>
					{asset.kind}
				</div>
			</div>

			<div style={{padding: '16px 18px 18px', flex: 1}}>
				<div
					style={{
						fontSize: 21,
						fontWeight: 600,
						color: '#f2f4f8',
						marginBottom: 3,
					}}
				>
					{asset.id}
				</div>
				<div
					style={{
						fontSize: 16,
						color: '#7d879b',
						fontFamily: 'monospace',
						marginBottom: 12,
					}}
				>
					{asset.path}
				</div>

				<div style={{display: 'flex', flexWrap: 'wrap', gap: 7}}>
					{facts(asset).map((fact) => (
						<span
							key={fact}
							style={{
								fontSize: 15,
								padding: '3px 10px',
								borderRadius: 7,
								background: '#1f2534',
								color: '#c3cadb',
								fontFamily: 'monospace',
							}}
						>
							{fact}
						</span>
					))}
					<span
						style={{
							fontSize: 15,
							padding: '3px 10px',
							borderRadius: 7,
							background: '#1f2534',
							color: '#c3cadb',
							fontFamily: 'monospace',
						}}
					>
						{formatBytes(asset.bytes)}
					</span>
				</div>
			</div>
		</div>
	);
};

export const AssetBrowser = () => {
	const total = allAssets.reduce((sum, asset) => sum + asset.bytes, 0);
	const counts = allAssets.reduce<Record<string, number>>((acc, asset) => {
		acc[asset.kind] = (acc[asset.kind] ?? 0) + 1;
		return acc;
	}, {});

	return (
		<AbsoluteFill
			style={{
				background: '#0b0e14',
				fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
				padding: 48,
			}}
		>
			<div
				style={{
					display: 'flex',
					alignItems: 'baseline',
					justifyContent: 'space-between',
					marginBottom: 26,
				}}
			>
				<div style={{display: 'flex', alignItems: 'baseline', gap: 18}}>
					<div style={{fontSize: 44, fontWeight: 700, color: '#f2f4f8'}}>
						public/
					</div>
					<div style={{fontSize: 20, color: '#7d879b'}}>
						scanned into src/assets.ts
					</div>
				</div>
				<div style={{display: 'flex', gap: 10}}>
					{Object.entries(counts).map(([kind, n]) => (
						<span
							key={kind}
							style={{
								fontSize: 17,
								padding: '6px 14px',
								borderRadius: 999,
								background: '#161a24',
								border: '1px solid #262c3a',
								color: KIND_COLOR[kind as AssetKind],
								fontWeight: 600,
							}}
						>
							{n} {kind}
						</span>
					))}
					<span
						style={{
							fontSize: 17,
							padding: '6px 14px',
							borderRadius: 999,
							background: '#161a24',
							border: '1px solid #262c3a',
							color: '#c3cadb',
							fontWeight: 600,
						}}
					>
						{formatBytes(total)} total
					</span>
				</div>
			</div>

			{allAssets.length === 0 ? (
				<div
					style={{
						flex: 1,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						color: '#5d6679',
						fontSize: 26,
					}}
				>
					No assets yet — drop files into public/ and run `npm run scan`.
				</div>
			) : (
				<div
					style={{
						display: 'grid',
						// Adapts to the frame rather than assuming a column count.
						gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))',
						gap: 20,
						alignContent: 'start',
					}}
				>
					{allAssets.map((asset) => (
						<Card key={asset.id} asset={asset} />
					))}
				</div>
			)}
		</AbsoluteFill>
	);
};

// Keeps the manifest import honest even when public/ is empty.
export const assetCount = Object.keys(assets).length;
