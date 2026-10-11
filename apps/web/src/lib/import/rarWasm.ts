import unrarWasmUrl from 'node-unrar-js/esm/js/unrar.wasm?url';

/**
 * The unrar WebAssembly binary. Vite emits it as a hashed asset (which the
 * service worker precaches); it is fetched the first time a CBR is imported.
 */
let binary: Promise<ArrayBuffer> | null = null;

export function loadUnrarWasm(): Promise<ArrayBuffer> {
  binary ??= fetch(unrarWasmUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    })
    .catch((error: unknown) => {
      binary = null;
      throw error;
    });
  return binary;
}
