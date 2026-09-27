import type { OpenPublication } from '../engine';
import { EpubEngine } from './epub-engine';
import { readPackage } from './package';
import { ZipArchive } from './zip';

export { EpubFormatError } from './package';

/** Opens an EPUB 2/3 from a Blob and renders it into `options.container`. */
export const openPublication: OpenPublication = async (options) => {
  let zip: ZipArchive;
  let pkg: Awaited<ReturnType<typeof readPackage>>;
  try {
    zip = await ZipArchive.open(options.file);
    pkg = await readPackage(zip);
  } catch (e) {
    options.file.close();
    throw e;
  }
  const engine = new EpubEngine(zip, pkg, options.container, options);
  try {
    await engine.start(options.initial);
  } catch (e) {
    engine.destroy();
    throw e;
  }
  return engine;
};
