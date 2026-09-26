import type { OpenPublication } from '../engine';
import { EpubEngine } from './epub-engine';
import { readPackage } from './package';
import { ZipArchive } from './zip';

export { EpubFormatError } from './package';

/** Opens an EPUB 2/3 from a Blob and renders it into `options.container`. */
export const openPublication: OpenPublication = async (options) => {
  const zip = await ZipArchive.open(options.data);
  const pkg = await readPackage(zip);
  const engine = new EpubEngine(zip, pkg, options.container, options);
  try {
    await engine.start(options.initial);
  } catch (e) {
    engine.destroy();
    throw e;
  }
  return engine;
};
