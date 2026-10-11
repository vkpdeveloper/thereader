# Review dispositions

CodeRabbit CLI 0.7.6 was verified against its official release archive before
use. It reviewed both libraries twice and the reader integration once.

Fixed and regression-tested:

- TypeScript image assets now own their buffers; structured-document transfers
  deduplicate transferables. A real Chrome worker returned all 35 requested-paper
  assets successfully, with no detached shared PDF buffer.
- Both engines resolve named inline image color spaces before computing raw
  byte length. RGB and ICCBased tests assert red pixels and the following text.

The reader integration review reported no findings. The second library review
identified two **inherited Go algorithm limitations**, confirmed against
`packages/pdf_go/content.go`, which remain explicitly deferred in this port:

- Painted SVG path coordinates include the CTM, but stroke width does not include
  its scale. A zero-width PDF hairline can disappear. This affects some vector
  figure appearances; full graphics fidelity is not established by score parity.
- Table ruling candidates are recorded before painting. A discarded, clipping,
  or artifact path can influence table detection even though it is not visible.
  Fixing this changes the shared layout algorithm and may change block/table
  decisions. The port preserves the current Go layout behavior for measured
  score parity; it does not claim these existing limitations are fixed.

These are valid follow-up work, not false positives or a clean review. Correcting
them should update Go and both ports together with new graphics/layout fixtures
and a fresh benchmark. The current report keeps exact reference-score parity
separate from universal visual or semantic correctness.
