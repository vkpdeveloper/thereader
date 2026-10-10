/** Vite's `?url` imports resolve to the emitted asset's URL. */
declare module '*.wasm?url' {
  const url: string;
  export default url;
}
