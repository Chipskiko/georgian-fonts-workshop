// Build a side-by-side visual of the suspected duplicate groups by
// inlining each font's existing preview.svg sidecar. Writes an HTML file
// to the scratchpad for screenshotting. Read-only w.r.t. blob.
import { list } from "@vercel/blob";
import { writeFileSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/dup.html";

const GROUPS = [
  { title: "Group A — IoU 0.93–0.95 · SAME DRAWING (3 copies)", files: [
    "Sopokik__xftiqh.otf", "Sopokik__y5k7j3.otf", "სოფო__კიკნაველიძე__f8k631.otf",
  ]},
  { title: "Group B — IoU 0.74 · two fonts named \"28\"", files: [
    "28__gxlu2h.otf", "28__rz0y9z.otf",
  ]},
  { title: "Group C — IoU 0.80 · same designer \"kawanoko\"", files: [
    "eldritch letters__kawanoko__cgrdoi.otf", "eyes everywhere__kawanoko__f9qde7.otf",
  ]},
];

const { blobs } = await list({ prefix: "fonts/" });
const urlOf = new Map();
for (const b of blobs) urlOf.set(b.pathname.replace("fonts/", ""), b.url);

async function svgFor(file) {
  const u = urlOf.get(`${file}.preview.svg`);
  if (!u) return `<div class="miss">no sidecar for ${file}</div>`;
  const svg = await (await fetch(`${u}?cb=${Date.now()}`)).text();
  return svg.replace("<svg ", '<svg style="width:100%;height:auto;max-height:70px" ');
}

let body = "";
for (const g of GROUPS) {
  body += `<h2>${g.title}</h2>`;
  for (const f of g.files) {
    body += `<div class="row"><div class="name">${f}</div>${await svgFor(f)}</div>`;
  }
}

writeFileSync(
  OUT,
  `<!doctype html><meta charset=utf8><style>
   body{background:#111;color:#eee;font:13px/1.4 monospace;padding:20px}
   h2{color:#ffea00;margin:26px 0 8px;font-size:14px}
   .row{background:#1c1c1c;border:1px solid #333;border-radius:6px;padding:10px 14px;margin:6px 0}
   .name{color:#888;font-size:11px;margin-bottom:6px}
   .miss{color:#f66}
  </style><h1 style="font-size:16px">Duplicate-content check</h1>${body}`,
);
console.log("wrote", OUT);
