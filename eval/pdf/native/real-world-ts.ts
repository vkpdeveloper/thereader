// Evaluation only; engine code has no filesystem dependency.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extract } from "../../../packages/pdf_ts/src";
mkdirSync("test-corpus/pdf/native/ts", { recursive: true });
for (const name of [
  "harness",
  "axler",
  "hefferon",
  "thinkpython",
  "calculus",
]) {
  const document = extract(
    new Uint8Array(readFileSync(`test-corpus/pdf/real-world/${name}.pdf`)),
  );
  writeFileSync(
    `test-corpus/pdf/native/ts/${name}.json`,
    JSON.stringify(document, (_, value) =>
      value instanceof Uint8Array
        ? Buffer.from(value).toString("base64")
        : value,
    ),
  );
  console.log(name, document.stats);
}
