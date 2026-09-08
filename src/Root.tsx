import {Composition} from 'remotion';
import {MyComposition} from './MyComposition';
import {AssetBrowser} from './AssetBrowser';

export const RemotionRoot = () => {
	return (
		<>
			<Composition
				id="MyComposition"
				component={MyComposition}
				durationInFrames={150}
				fps={30}
				width={1920}
				height={1080}
			/>
			<Composition
				id="AssetBrowser"
				component={AssetBrowser}
				durationInFrames={1}
				fps={30}
				width={1920}
				height={1080}
			/>
		</>
	);
};
