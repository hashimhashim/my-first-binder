/**
 * Verifies the browser converter against qemu-img.
 *
 * Loads the conversion core straight out of vm-converter.html (between the
 * CORE-START/CORE-END markers), converts a synthetic raw disk to each output
 * format, then checks the result with `qemu-img info` and byte-compares it to
 * the original with `qemu-img compare`.
 *
 *   node tests/test_web_core.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, readSync, writeFileSync, rmSync, statSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "web", "vm-converter.html"), "utf8");
const core = html.split("/* CORE-START")[1].split("/* CORE-END */")[0].replace(/^[^\n]*\n/, "");
const mod = await import(
  "data:text/javascript;base64," +
  Buffer.from(core + "\nexport { openImage, convertImage, humanSize, UnsupportedImage };").toString("base64")
);

const tmp = mkdtempSync(join(tmpdir(), "vmconv-"));
let failures = 0;

function test(name, fn) {
  return fn().then(
    () => console.log(`  ok    ${name}`),
    (e) => { failures++; console.error(`  FAIL  ${name}\n        ${e.message}`); },
  );
}

/** A raw disk with data at the start, a large hole, and data at the end. */
function makeRawDisk(path, sizeMiB = 12) {
  const size = sizeMiB * 1024 * 1024;
  const buf = Buffer.alloc(size);
  for (let i = 0; i < 512 * 1024; i++) buf[i] = (i * 7 + 3) & 0xff;          // head: patterned
  for (let i = size - 256 * 1024; i < size; i++) buf[i] = (i * 13 + 91) & 0xff; // tail: patterned
  buf.write("BOOTSECTOR-MARKER", 0);
  writeFileSync(path, buf);
  return { path, size };
}

function fileSource(path) {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  return {
    size,
    async read(offset, length) {
      const b = Buffer.alloc(length);
      const n = readSync(fd, b, 0, length, offset);
      return new Uint8Array(b.subarray(0, n));
    },
    close: () => closeSync(fd),
  };
}

function fileSink(path) {
  const chunks = [];
  return {
    async write(c) { chunks.push(Buffer.from(c)); },
    async close() { writeFileSync(path, Buffer.concat(chunks)); },
  };
}

const qemu = (...args) => execFileSync("qemu-img", args, { encoding: "utf8" });

async function convertTo(srcPath, target, outPath) {
  const src = fileSource(srcPath);
  const image = await mod.openImage(src, srcPath);
  const sink = fileSink(outPath);
  await mod.convertImage(image, sink, target, { name: outPath.split("/").pop() });
  await sink.close();
  src.close();
  return image;
}

const raw = makeRawDisk(join(tmp, "source.img"));

const cases = [
  { target: "vmdk", out: "out.vmdk", fmt: "vmdk" },
  { target: "vhd-dynamic", out: "out-dyn.vhd", fmt: "vpc" },
  // A fixed VHD has no header at offset 0, so qemu's probe sees raw — as it
  // does for its own fixed VHDs. Read it with an explicit format instead.
  { target: "vhd-fixed", out: "out-fixed.vhd", fmt: "vpc", explicitFormat: true },
  { target: "raw", out: "out.img", fmt: "raw" },
];

console.log("browser converter vs qemu-img");

for (const c of cases) {
  await test(`raw -> ${c.target}: qemu-img reads it and content matches`, async () => {
    const outPath = join(tmp, c.out);
    await convertTo(raw.path, c.target, outPath);

    const infoArgs = c.explicitFormat ? ["info", "-f", c.fmt, "--output=json", outPath]
                                      : ["info", "--output=json", outPath];
    const info = JSON.parse(qemu(...infoArgs));
    assert.equal(info.format, c.fmt, `qemu-img detected ${info.format}, expected ${c.fmt}`);
    // VHD geometry may force padding; it must never shrink the disk.
    assert.ok(info["virtual-size"] >= raw.size,
      `virtual size ${info["virtual-size"]} is smaller than the source ${raw.size}`);
    assert.ok(info["virtual-size"] - raw.size < 1024 * 1024, "padding should be tiny");

    // Byte-for-byte identical guest data — this is the check that matters.
    // qemu-img compare tolerates a longer image only if the extra tail is zeros.
    const cmpArgs = ["compare", "-f", "raw", raw.path];
    if (c.explicitFormat) cmpArgs.push("-F", c.fmt);
    qemu(...cmpArgs, outPath);
  });
}

await test("sparse output stays small (holes are not written out)", async () => {
  const dyn = statSync(join(tmp, "out-dyn.vhd")).size;
  const vmdk = statSync(join(tmp, "out.vmdk")).size;
  assert.ok(dyn < raw.size * 0.75, `dynamic VHD is ${dyn} bytes, expected well under ${raw.size}`);
  assert.ok(vmdk < raw.size * 0.75, `sparse VMDK is ${vmdk} bytes, expected well under ${raw.size}`);
});

await test("round-trip: our VMDK reads back to the original bytes", async () => {
  const back = join(tmp, "roundtrip-from-vmdk.img");
  await convertTo(join(tmp, "out.vmdk"), "raw", back);
  qemu("compare", "-f", "raw", "-F", "raw", raw.path, back);
});

await test("round-trip: our dynamic VHD reads back to the original bytes", async () => {
  const back = join(tmp, "roundtrip-from-vhd.img");
  await convertTo(join(tmp, "out-dyn.vhd"), "raw", back);
  qemu("compare", "-f", "raw", "-F", "raw", raw.path, back);
});

await test("reads a dynamic VHD produced by qemu-img", async () => {
  const qemuVhd = join(tmp, "qemu-dyn.vhd");
  qemu("convert", "-O", "vpc", "-o", "subformat=dynamic", raw.path, qemuVhd);
  const back = join(tmp, "from-qemu-vhd.img");
  await convertTo(qemuVhd, "raw", back);
  qemu("compare", "-f", "raw", "-F", "raw", raw.path, back);
});

await test("reads a sparse VMDK produced by qemu-img", async () => {
  const qemuVmdk = join(tmp, "qemu.vmdk");
  qemu("convert", "-O", "vmdk", "-o", "subformat=monolithicSparse", raw.path, qemuVmdk);
  const back = join(tmp, "from-qemu-vmdk.img");
  await convertTo(qemuVmdk, "raw", back);
  qemu("compare", "-f", "raw", "-F", "raw", raw.path, back);
});

await test("VMware can chain-convert our VMDK (qemu-img re-reads it to qcow2)", async () => {
  const q = join(tmp, "chain.qcow2");
  qemu("convert", "-O", "qcow2", join(tmp, "out.vmdk"), q);
  qemu("compare", "-f", "raw", raw.path, q);
});

// 40 MiB crosses a VMDK grain-table boundary (32 MiB) and many 2 MiB VHD blocks.
for (const target of ["vmdk", "vhd-dynamic"]) {
  await test(`${target}: a disk spanning multiple grain tables / blocks converts correctly`, async () => {
    const big = makeRawDisk(join(tmp, "big.img"), 40);
    const out = join(tmp, `big-${target}.${target === "vmdk" ? "vmdk" : "vhd"}`);
    await convertTo(big.path, target, out);
    qemu("compare", "-f", "raw", big.path, out);
  });
}

await test("Acronis .tib is refused with the two-step instructions", async () => {
  writeFileSync(join(tmp, "backup.tib"), Buffer.alloc(1024));
  await assert.rejects(
    () => mod.openImage(fileSource(join(tmp, "backup.tib")), "backup.tib"),
    /Mount Image/,
  );
});

await test("a qcow2 input is refused rather than silently mangled", async () => {
  const q = join(tmp, "input.qcow2");
  qemu("convert", "-O", "qcow2", raw.path, q);
  await assert.rejects(() => mod.openImage(fileSource(q), "input.qcow2"), /qemu-img/);
});

await test("non-512-multiple images are padded up, not truncated", async () => {
  const odd = join(tmp, "odd.img");
  const size = 1024 * 1024 + 300;
  const buf = Buffer.alloc(size, 0xab);
  writeFileSync(odd, buf);
  const out = join(tmp, "odd.vhd");
  await convertTo(odd, "vhd-fixed", out);
  const info = JSON.parse(qemu("info", "--output=json", out));
  assert.equal(info["virtual-size"] % 512, 0);
  assert.ok(info["virtual-size"] >= size, "padded size must not lose the tail bytes");
  const written = readFileSync(out);
  assert.ok(written.subarray(size - 300, size).every((b) => b === 0xab), "tail bytes were lost");
});

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
