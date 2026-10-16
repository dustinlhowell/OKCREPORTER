// Renders the App Store icon, launch images and sample screenshots from the game's own drawing code.
// Usage: node tools/render-assets.mjs   (needs Playwright + Chromium)
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const www = path.join(root, "www");
const src = fs.readFileSync(path.join(www, "index.html"), "utf8");

// Expose a hook inside the game's closure instead of starting the loop.
const hook = `
  window.removeEventListener("resize", resize);
  window.__scene = (mode) => {
    resize();
    reset();
    if (mode === "play") {
      state = "play"; score = 23; t = 1;
      arms = [{ x: 175, top: CY - 120, passed: false, tone: 1 }, { x: 390, top: CY - 40, passed: false, tone: 0 }];
      player.y = CY - 30; player.vy = -200; flapAnim = 0.7; crowdX = 40;
    } else if (mode === "over") {
      state = "over"; score = 23; best = 41; t = 1.571;
      arms = [{ x: 60, top: CY - 150, passed: true, tone: 0 }];
      player.y = FLOOR - player.r; player.vy = 0;
    }
    draw();
  };
  window.__icon = () => {
    const S = 1024, k = S / 360;
    canvas.width = S; canvas.height = S; canvas.style.width = S + "px"; canvas.style.height = S + "px";
    H = 360; FLOOR = 318; CY = 170;
    reset();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawArena();
    drawArm(250, 108, 1, 1);
    drawArm(250, 108 + GAP, -1, 0);
    drawFloor();
    ctx.save();
    ctx.translate(120, 172); ctx.scale(2.6, 2.6); ctx.translate(-100, -CY);
    player.y = CY; player.vy = -260; state = "play"; flapAnim = 0.8;
    drawPlayer();
    ctx.restore();
  };
  window.__splash = () => {
    const S = 2732, k = S / 360;
    canvas.width = S; canvas.height = S; canvas.style.width = S + "px"; canvas.style.height = S + "px";
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = C.night; ctx.fillRect(0, 0, 360, 360);
    outlinedText("FLOATER", 180, 180, 40, C.gold);
  };
`;
const marker = "  requestAnimationFrame(frame);\n})();";
if (!src.includes(marker)) throw new Error("render hook marker not found in index.html");
const patched = src.replace(marker, hook + "})();");
const tmp = path.join(www, "__render.html");
fs.writeFileSync(tmp, patched);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.goto("file://" + tmp);
  await page.evaluate(() => document.fonts.ready);

  const iconDir = path.join(root, "ios/App/App/Assets.xcassets/AppIcon.appiconset");
  await page.evaluate(() => window.__icon());
  // App Store icons must be opaque; a page screenshot has no alpha channel.
  const iconPng = await page.locator("#game").screenshot();
  fs.writeFileSync(path.join(iconDir, "AppIcon-512@2x.png"), iconPng);
  fs.mkdirSync(path.join(root, "resources"), { recursive: true });
  fs.copyFileSync(path.join(iconDir, "AppIcon-512@2x.png"), path.join(root, "resources/icon-1024.png"));

  await page.setViewportSize({ width: 2732, height: 2732 });
  await page.evaluate(() => window.__splash());
  const splash = await page.locator("#game").screenshot();
  const splashDir = path.join(root, "ios/App/App/Assets.xcassets/Splash.imageset");
  for (const f of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
    fs.writeFileSync(path.join(splashDir, f), splash);
  }

  // App Store screenshots at 6.9" iPhone size (1320 x 2868).
  const shots = path.join(root, "resources/screenshots");
  fs.mkdirSync(shots, { recursive: true });
  const phone = await browser.newPage({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 3 });
  await phone.goto("file://" + tmp);
  await phone.evaluate(() => document.fonts.ready);
  for (const mode of ["ready", "play", "over"]) {
    await phone.evaluate(m => window.__scene(m), mode);
    await phone.screenshot({ path: path.join(shots, `iphone-6.9-${mode}.png`) });
  }
} finally {
  await browser.close();
  fs.rmSync(tmp, { force: true });
}
console.log("Rendered icon, splash and screenshots.");
