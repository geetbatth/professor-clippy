// sherpa-onnx-node ships JavaScript with JSDoc only; the parts `voiceChild.ts` uses.
declare module 'sherpa-onnx-node' {
  const sherpa: {
    OfflineRecognizer: new (config: object) => unknown;
    OfflineTts: new (config: object) => unknown;
  };
  export default sherpa;
}
