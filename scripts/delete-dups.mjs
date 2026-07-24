// One-shot: delete the confirmed duplicate font files the user chose to
// drop (keeping Sopokik__y5k7j3, 28__rz0y9z, eyes everywhere). Removes
// each font blob AND its .preview.svg sidecar. Hardcoded allow-list so
// it can only ever touch these four. --apply to execute; dry by default.
import { list, del } from "@vercel/blob";

const PREFIX = "fonts/";
const SUFFIX = ".preview.svg";

// Confirmed same-drawing duplicates to remove (complement of the user's
// keep-list across the three groups):
const DELETE = [
  "Sopokik__xftiqh.otf", // same drawing as Sopokik__y5k7j3 (kept) — IoU 0.95
  "სოფო__კიკნაველიძე__f8k631.otf", // same drawing as Sopokik__y5k7j3 (kept) — IoU 0.93
  "28__gxlu2h.otf", // same drawing as 28__rz0y9z (kept) — IoU 0.74
  "eldritch letters__kawanoko__cgrdoi.otf", // same as eyes everywhere (kept) — IoU 0.80
];

const apply = process.argv.includes("--apply");
const { blobs } = await list({ prefix: PREFIX });
const byPath = new Map(blobs.map((b) => [b.pathname, b.url]));

let n = 0;
for (const name of DELETE) {
  for (const target of [`${PREFIX}${name}`, `${PREFIX}${name}${SUFFIX}`]) {
    const url = byPath.get(target);
    const kind = target.endsWith(SUFFIX) ? "sidecar" : "font   ";
    if (!url) {
      console.log(`  ${kind}  MISSING  ${target}`);
      continue;
    }
    if (apply) {
      await del(url);
      console.log(`  ${kind}  DELETED  ${target}`);
    } else {
      console.log(`  ${kind}  would delete  ${target}`);
    }
    n++;
  }
}
console.log(`\n${apply ? "deleted" : "would delete"} ${n} blob(s) across ${DELETE.length} fonts`);
if (!apply) console.log("re-run with --apply to execute");
