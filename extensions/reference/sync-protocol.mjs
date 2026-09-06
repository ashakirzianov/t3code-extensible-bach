// Re-vendors the protocol artifacts from the host repository.
//
// An extension in a repository of its own copies these two files in by hand,
// once per protocol version it moves to. This one lives inside the host repo,
// so it scripts the same copy against `packages/contracts/generated/` and a
// test fails when the copy falls behind. That is the only difference: the
// files, and what they mean, are identical.
//
// Not part of the scaffold — the relative path below only resolves in-tree.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const generated = NodePath.join(
  here,
  "..",
  "..",
  "packages",
  "contracts",
  "generated",
  "extensions",
);
const vendored = NodePath.join(here, "protocol");

NodeFS.mkdirSync(vendored, { recursive: true });
for (const fileName of ["protocol.schema.json", "protocol.d.ts"]) {
  NodeFS.copyFileSync(NodePath.join(generated, fileName), NodePath.join(vendored, fileName));
  console.log(`vendored ${fileName}`);
}
