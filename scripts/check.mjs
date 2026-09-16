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
check("fast", "install", "S13usb_ethernet silences the retries and lets the last rename speak", () => {
  const lines = readFileSync(join(installDir, "S13usb_ethernet"), "utf8").split("\n")
    .map((raw, i) => ({ n: i + 1, raw, code: raw.replace(/\s#.*$/, "") }));
  const renames = lines.filter((l) => /ip link set usb0 name eth0/.test(l.code));
  if (!renames.length) throw new Error("nothing renames usb0 to eth0, so a printer whose udev rule did not fire has no fallback");

  // Counting silenced attempts is not enough: loud-in-the-loop and quiet-after
  // passes any count test while printing the error on every iteration. What
  // matters is which one speaks - the last, after the retries have given up.
  const quiet = (l) => /2>\/dev\/null/.test(l.code);
  const last = renames[renames.length - 1];
  if (quiet(last))
    throw new Error(`every rename discards stderr (last at line ${last.n}), so a rename that genuinely cannot happen gives the user nothing to go on`);
  for (const l of renames.slice(0, -1))
    if (!quiet(l))
      throw new Error(`the rename at line ${l.n} runs before the last one and does not discard stderr; losing the race with udev prints 'Cannot find device "usb0"' on every attempt`);

  // ...and the one that speaks has to be guarded, or it fires on every boot
  // with no dongle attached, where there is no usb0 to rename and nothing wrong.
  const guard = lines.slice(Math.max(0, last.n - 4), last.n - 1)
    .some((l) => /\/sys\/class\/net\/usb0/.test(l.code));
  if (!guard)
    throw new Error(`the rename at line ${last.n} is not guarded by a /sys/class/net/usb0 test in the 3 lines above it, so it would complain on every dongle-less boot`);
});

check("fast", "install", "udev rule renames a cdc_ncm net device to eth0", () => {
  const s = readFileSync(join(installDir, "70-usb-ethernet.rules"), "utf8");
  const rule = s.split("\n").find((l) => l.trim() && !l.startsWith("#"));
  if (!rule) throw new Error("no rule line");
  for (const tok of ['SUBSYSTEM=="net"', 'ACTION=="add"', 'DRIVERS=="cdc_ncm"', 'NAME="eth0"']) if (!rule.includes(tok)) throw new Error(`rule lacks ${tok}`);
});

// install.sh is the entry point a stranger runs on their own printer after
// cloning: it must be busybox-safe, must refuse a kernel it was not built for,
// and must not unload the modules its caller may be reaching the printer over.
const installer = () => readFileSync(join(ROOT, "install.sh"), "utf8");
const DESTS = ["/usr/data/k1se-eth", "/etc/init.d/S13usb_ethernet", "/etc/udev/rules.d/70-usb-ethernet.rules"];

check("fast", "installer", "install.sh is a busybox-safe /bin/sh script", () => {
  const s = installer();
  if (!s.startsWith("#!/bin/sh\n")) throw new Error("must start with #!/bin/sh");
  if (s.includes("\r")) throw new Error("contains CR; the printer's /bin/sh chokes on CRLF");
  const bashisms = [["[[", "[[ ]] test"], ["function ", "function keyword"], ["source ", "source builtin"],
                    ["<<<", "here-string"], ["+=(", "array append"], ["${!", "indirect expansion"]];
  for (const [tok, what] of bashisms)
    for (const [i, line] of s.split("\n").entries()) {
      if (line.trim().startsWith("#")) continue;
      if (line.includes(tok)) throw new Error(`line ${i + 1} uses ${what}, which busybox ash does not have`);
    }
});

// Comment lines prove nothing: a header that says "refuses a kernel it was not
// built for" satisfies any search for the words. These read code lines only.
const codeOf = (s) => s.split("\n")
  .map((l, i) => ({ n: i + 1, text: l }))
  .filter((l) => !l.text.trim().startsWith("#"));

check("fast", "installer", "install.sh's kernel gate is code, and refuses next to the comparison", () => {
  const lines = codeOf(installer());
  const find = (re) => lines.findIndex((l) => re.test(l.text));

  if (find(/vermagic/) < 0) throw new Error("no code reads vermagic out of the shipped modules; a comment saying so is not a gate");
  const cmp = find(/uname -r/);
  if (cmp < 0) throw new Error("no code compares against `uname -r`, so nothing can tell this kernel from another");

  // within the gate: it must be able to say no, and to be overridden
  const window = lines.slice(cmp, cmp + 20).map((l) => l.text).join("\n");
  if (!/\bdie\b|exit 1/.test(window))
    throw new Error(`the \`uname -r\` comparison at line ${lines[cmp].n} is not followed by any refusal within 20 lines - it compares and carries on`);
  if (!/FORCE/.test(window))
    throw new Error(`nothing near the comparison at line ${lines[cmp].n} consults an override flag`);
  if (!lines.some((l) => l.text.trim() === "--force)"))
    throw new Error("no `--force)` branch in the argument parsing, so the refusal documented in the README cannot be overridden");

  const md5 = find(/md5sum -c/);
  if (md5 < 0) throw new Error("nothing runs `md5sum -c`, so the copied modules are never verified against modules/MANIFEST.md5");
  // the failure path has to hang off the command itself - a `die` further down
  // the function belongs to some other step
  if (!/\|\||^\s*if /.test(lines[md5].text))
    throw new Error(`the md5sum -c at line ${lines[md5].n} ignores its own exit status - a mismatched module would be installed anyway`);
});

check("fast", "installer", "install.sh handles install, uninstall and status, and never rmmods", () => {
  const s = installer();
  for (const verb of ["install", "uninstall", "status"])
    if (!s.split("\n").some((l) => l.trim() === verb + ")"))
      throw new Error(`no \`${verb})\` branch`);
  for (const [i, line] of s.split("\n").entries()) {
    if (line.trim().startsWith("#")) continue;
    for (const bad of ["rmmod", "modprobe -r", "modprobe --remove"])
      if (line.includes(bad)) throw new Error(`line ${i + 1} uses ${bad}: unloading cdc_ncm drops an SSH session that came in over eth0`);
  }
});

check("fast", "installer", "install.sh installs to the paths the README documents", () => {
  const s = installer();
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  for (const d of DESTS) {
    if (!s.includes(d)) throw new Error(`install.sh never mentions ${d}`);
    if (!readme.includes(d)) throw new Error(`README does not document ${d}, which install.sh writes`);
  }
  if (!readme.includes("install.sh")) throw new Error("README does not tell anyone to run install.sh");
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
