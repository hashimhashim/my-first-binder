/**
 * End-to-end test of the actual page in a real browser.
 *
 * Drives vm-converter.html in Chromium: loads a disk image through the file
 * picker, clicks Convert, captures the downloaded file, and verifies it with
 * qemu-img. Skips (exit 0) if Playwright or qemu-img isn't installed.
 *
 *   npm install playwright && node tests/test_web_e2e.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const page_url = "file://" + join(here, "..", "web", "vm-converter.html");

let chromium;
try {
  ({ chromium } = await import("playwright"));
  execFileSync("qemu-img", ["--version"], { stdio: "ignore" });
} catch {
  console.log("skipped: needs `npm install playwright` and qemu-img on PATH");
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "vmconv-e2e-"));
const src = join(tmp, "source.img");
const size = 8 * 1024 * 1024;
const buf = Buffer.alloc(size);
for (let i = 0; i < 256 * 1024; i++) buf[i] = (i * 7 + 3) & 0xff;
for (let i = size - 128 * 1024; i < size; i++) buf[i] = (i * 13 + 91) & 0xff;
writeFileSync(src, buf);

// Playwright normally finds its own browser; fall back to a system Chromium
// when the installed build doesn't match (CI images often pin one).
async function launch() {
  try {
    return await chromium.launch();
  } catch (e) {
    const fallback = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
    if (!existsSync(fallback)) throw e;
    return chromium.launch({ executablePath: fallback });
  }
}

const browser = await launch();
const page = await browser.newPage({ acceptDownloads: true });

const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
// Force the download fallback so the run needs no native save dialog.
await page.addInitScript(() => { delete window.showSaveFilePicker; });

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (e) { failures++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
}

console.log("vm-converter.html in Chromium");

await page.goto(page_url);

await check("page loads with no script errors", async () => {
  assert.equal(await page.title(), "Image → VM Disk Converter");
  assert.deepEqual(consoleErrors, []);
});

await check("picking a file detects the format and virtual size", async () => {
  await page.setInputFiles("#file", src);
  await page.waitForFunction(() => document.getElementById("f-fmt").textContent !== "reading…");
  assert.equal(await page.textContent("#f-fmt"), "raw");
  assert.match(await page.textContent("#f-size"), /8\.0 MiB/);
  assert.equal(await page.isDisabled("#go"), false);
});

await check("choosing a qemu-only format shows a copyable command instead of converting", async () => {
  await page.selectOption("#target", "qcow2");
  assert.match(await page.textContent("#cmd"), /qemu-img convert -p -O qcow2/);
  assert.equal(await page.isDisabled("#go"), true);
});

await check("converting to VMDK produces a file qemu-img accepts", async () => {
  await page.selectOption("#target", "vmdk");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120000 }),
    page.click("#go"),
  ]);
  const out = join(tmp, "downloaded.vmdk");
  await download.saveAs(out);

  assert.equal(download.suggestedFilename(), "source.vmdk");
  const info = JSON.parse(execFileSync("qemu-img", ["info", "--output=json", out], { encoding: "utf8" }));
  assert.equal(info.format, "vmdk");
  assert.equal(info["virtual-size"], size);
  execFileSync("qemu-img", ["compare", "-f", "raw", src, out]);   // byte-for-byte
  assert.ok(statSync(out).size < size * 0.75, "holes should not be written out");
  assert.match(await page.textContent("#done"), /Wrote source\.vmdk/);
});

await check("an Acronis .tib is refused in the UI with instructions", async () => {
  const tib = join(tmp, "backup.tib");
  writeFileSync(tib, Buffer.alloc(4096));
  await page.setInputFiles("#file", tib);
  await page.waitForSelector("#src-err:not(.hidden)");
  assert.match(await page.textContent("#src-err"), /Mount Image/);
  assert.equal(await page.isDisabled("#go"), true);
});

await browser.close();
rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
