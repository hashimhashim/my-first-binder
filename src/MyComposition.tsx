import {AbsoluteFill} from 'remotion';

export const MyComposition = () => {
	return (
		<AbsoluteFill
			style={{
				backgroundColor: 'white',
				justifyContent: 'center',
				alignItems: 'center',
			}}
		>
			<div style={{fontSize: 80, fontFamily: 'sans-serif'}}>
				Hello, Remotion!
			</div>
		</AbsoluteFill>
	);
};
