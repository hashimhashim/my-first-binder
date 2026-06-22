import {AbsoluteFill, useCurrentFrame, interpolate} from 'remotion';

export const MyComposition = () => {
	const frame = useCurrentFrame();
	const opacity = interpolate(frame, [0, 30], [0, 1]);
	const translateY = interpolate(frame, [0, 30], [40, 0]);

	return (
		<AbsoluteFill
			style={{
				backgroundColor: 'white',
				justifyContent: 'center',
				alignItems: 'center',
			}}
		>
			<div
				style={{
					fontSize: 80,
					fontFamily: 'sans-serif',
					opacity,
					transform: `translateY(${translateY}px)`,
				}}
			>
				Hello, Remotion!
			</div>
		</AbsoluteFill>
	);
};
