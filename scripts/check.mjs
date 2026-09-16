#!/usr/bin/env node
// Project checks. Usage: node scripts/check.mjs --tier fast|merge|heavy [component ...]
// Each check declares its tier and component. fast runs the checks of the named
// components (all if none given); merge and heavy run every check.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERMAGIC = "vermagic=4.4.94 SMP preempt mod_unload MIPS32_R2 32BIT ";
const THIS_MODULE_SIZE = 352; // struct module on the printer kernel, measured from /module_driver/soc_gpio.ko

const checks = [];
const check = (tier, component, name, fn) => checks.push({ tier, component, name, fn });

function elfSections(buf) {
  if (buf.readUInt32BE(0) !== 0x7f454c46) throw new Error("not ELF");
  if (buf[4] !== 1 || buf[5] !== 1) throw new Error("not 32-bit little-endian ELF");
  if (buf.readUInt16LE(18) !== 8) throw new Error("e_machine is not MIPS");
  const shoff = buf.readUInt32LE(32), shentsize = buf.readUInt16LE(46), shnum = buf.readUInt16LE(48), shstrndx = buf.readUInt16LE(50);
  const raw = [];
  for (let i = 0; i < shnum; i++) { const o = shoff + i * shentsize; raw.push({ nameOff: buf.readUInt32LE(o), off: buf.readUInt32LE(o + 16), size: buf.readUInt32LE(o + 20) }); }
  const str = raw[shstrndx];
  const name = (n) => { let e = str.off + n; while (buf[e]) e++; return buf.toString("latin1", str.off + n, e); };
  return Object.fromEntries(raw.map((s) => [name(s.nameOff), s]));
}

const moduleDir = join(ROOT, "modules");
const kos = existsSync(moduleDir) ? readdirSync(moduleDir).filter((f) => f.endsWith(".ko")) : [];

check("fast", "modules", "at least one .ko present", () => { if (!kos.length) throw new Error("modules/ has no .ko files"); });

for (const ko of kos) {
  check("fast", "modules", `${ko}: MIPS ELF, vermagic, struct module size`, () => {
    const buf = readFileSync(join(moduleDir, ko));
    const sec = elfSections(buf);
    if (!buf.includes(VERMAGIC, 0, "latin1")) throw new Error(`vermagic mismatch (want "${VERMAGIC.trim()}")`);
    const tm = sec[".gnu.linkonce.this_module"];
    if (!tm) throw new Error("no .gnu.linkonce.this_module section");
    if (tm.size !== THIS_MODULE_SIZE) throw new Error(`struct module is ${tm.size} bytes, printer kernel has ${THIS_MODULE_SIZE}`);
    if (sec["__versions"]) throw new Error("has __versions but the printer kernel has MODVERSIONS off");
  });
}

check("fast", "modules", "MANIFEST.md5 matches every .ko", () => {
  const mf = join(moduleDir, "MANIFEST.md5");
  if (!existsSync(mf)) throw new Error("modules/MANIFEST.md5 missing (run: node scripts/check.mjs --write-manifest)");
  const want = Object.fromEntries(readFileSync(mf, "utf8").trim().split(/\r?\n/).map((l) => l.trim().split(/\s+\*?/).reverse()));
  for (const ko of kos) {
    const got = createHash("md5").update(readFileSync(join(moduleDir, ko))).digest("hex");
    if (!want[ko]) throw new Error(`${ko} not in MANIFEST.md5`);
    if (want[ko] !== got) throw new Error(`${ko} md5 ${got} != manifest ${want[ko]} (stale module or stale manifest)`);
  }
  for (const k of Object.keys(want)) if (!kos.includes(k)) throw new Error(`manifest lists ${k} which is not in modules/`);
});

const installDir = join(ROOT, "install");
check("fast", "install", "install files are LF-only, no trailing CR", () => {
  for (const f of readdirSync(installDir)) if (readFileSync(join(installDir, f), "latin1").includes("\r")) throw new Error(`${f} contains CR; the printer's /bin/sh chokes on CRLF`);
});
check("fast", "install", "S13usb_ethernet is a /bin/sh script that loads mii, usbnet, cdc_ncm", () => {
  const s = readFileSync(join(installDir, "S13usb_ethernet"), "utf8");
  if (!s.startsWith("#!/bin/sh\n")) throw new Error("must start with #!/bin/sh");
  for (const m of ["mii", "usbnet", "cdc_ncm"]) if (!s.includes(m)) throw new Error(`does not mention ${m}`);
  if (!/case "\$1" in/.test(s) || !/start\)/.test(s)) throw new Error("needs a case \"$1\" in ... start) block like the other S?? scripts");
});
check("fast", "install", "udev rule renames a cdc_ncm net device to eth0", () => {
  const s = readFileSync(join(installDir, "70-usb-ethernet.rules"), "utf8");
  const rule = s.split("\n").find((l) => l.trim() && !l.startsWith("#"));
  if (!rule) throw new Error("no rule line");
  for (const tok of ['SUBSYSTEM=="net"', 'ACTION=="add"', 'DRIVERS=="cdc_ncm"', 'NAME="eth0"']) if (!rule.includes(tok)) throw new Error(`rule lacks ${tok}`);
});

const patchDir = join(ROOT, "patches");
check("fast", "patches", "patches are unified diffs against drivers/net/usb", () => {
  if (!existsSync(patchDir)) return;
  for (const f of readdirSync(patchDir)) {
    const s = readFileSync(join(patchDir, f), "utf8");
    if (!/^diff --git a\/drivers\/net\//m.test(s) || !/^@@ /m.test(s)) throw new Error(`${f} is not a git diff touching drivers/net`);
  }
});

check("merge", "modules", "every .ko named in README exists", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  for (const m of readme.matchAll(/`([a-z0-9_]+\.ko)`/g)) if (!kos.includes(m[1])) throw new Error(`README names ${m[1]} which is not in modules/`);
});

// ---- runner
const args = process.argv.slice(2);
if (args.includes("--write-manifest")) {
  const lines = kos.map((ko) => `${createHash("md5").update(readFileSync(join(moduleDir, ko))).digest("hex")}  ${ko}`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(moduleDir, "MANIFEST.md5"), lines.join("\n") + "\n");
  console.log(`wrote modules/MANIFEST.md5 (${lines.length} entries)`); process.exit(0);
}
const ti = args.indexOf("--tier"); const tier = ti >= 0 ? args[ti + 1] : "merge";
const comps = args.filter((a, i) => !a.startsWith("--") && i !== ti + 1);
const order = { fast: 0, merge: 1, heavy: 2 };
if (!(tier in order)) { console.log(`unknown tier "${tier}"; use fast, merge or heavy`); process.exit(2); }
const known = [...new Set(checks.map((c) => c.component))];
const unknown = comps.filter((c) => !known.includes(c));
if (unknown.length) { console.log(`unknown component(s) ${unknown.join(", ")}; known: ${known.join(", ")}`); process.exit(2); }
const selected = checks.filter((c) => order[c.tier] <= order[tier] && (tier !== "fast" || !comps.length || comps.includes(c.component)));
if (!selected.length) { console.log(`${tier}_tier: no checks selected — refusing to pass on nothing`); process.exit(2); }
let failed = 0; const t0 = performance.now();
for (const c of selected) {
  try { c.fn(); console.log(`ok    [${c.tier}/${c.component}] ${c.name}`); }
  catch (e) { failed++; console.log(`FAIL  [${c.tier}/${c.component}] ${c.name}: ${e.message}`); }
}
console.log(`${tier}_tier: ${failed} of ${selected.length} checks failed (${(performance.now() - t0).toFixed(0)} ms)`);
process.exit(failed ? 1 : 0);
