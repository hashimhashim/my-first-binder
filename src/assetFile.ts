import {staticFile} from 'remotion';
import {assetTable, type AssetId} from './assets';

/**
 * Resolves a scanned asset to a URL Remotion can load.
 * Unlike a bare staticFile() call, a typo in the id is a compile error.
 */
export const assetFile = (id: AssetId) => staticFile(assetTable[id].path);
