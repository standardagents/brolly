import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const sharp = require("sharp");

const root = dirname(fileURLToPath(import.meta.url));
const publicCardsRoot = join(root, "..", "..", "apps", "docs-site", "public", "x-posts");
const cardsDir = join(publicCardsRoot, "light");
const darkCardsDir = join(publicCardsRoot, "dark");
const posts = JSON.parse(await readFile(join(root, "posts.json"), "utf8"));

await mkdir(cardsDir, { recursive: true });
await mkdir(darkCardsDir, { recursive: true });

const escapeHtml = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const formatText = (value) => {
  return value.split(/\n\n+/).map((paragraph) => {
    const escaped = escapeHtml(paragraph)
      .replace(/(^|\s)(@[A-Za-z0-9_]+)/g, '$1<span class="link">$2</span>')
      .replace(/(^|\s)(#[A-Za-z0-9_]+)/g, '$1<span class="link">$2</span>')
      .replaceAll("\n", "<br>");
    return `<p>${escaped}</p>`;
  }).join("");
};

const avatarDataUrl = async (url) => {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(String(response.status));
    const mime = response.headers.get("content-type") || "image/jpeg";
    const body = Buffer.from(await response.arrayBuffer());
    return `data:${mime};base64,${body.toString("base64")}`;
  } catch {
    return "";
  }
};

const fontSize = (text) => {
  const paragraphs = text.split(/\n\n+/).length;
  const effectiveLength = text.length + (paragraphs - 1) * 35;
  if (effectiveLength > 430) return 25;
  if (effectiveLength > 340) return 27;
  if (effectiveLength > 260) return 29;
  if (effectiveLength > 190) return 33;
  if (effectiveLength > 110) return 38;
  return 46;
};

const lineHeight = (text) => fontSize(text) <= 29 ? 1.18 : 1.25;

const htmlFor = (post, avatar, theme) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1200px; height: 675px; overflow: hidden; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background:
      radial-gradient(circle at 12% 20%, rgba(249, 115, 22, .28), transparent 30%),
      radial-gradient(circle at 88% 82%, rgba(29, 155, 240, .22), transparent 30%),
      linear-gradient(135deg, #111827 0%, #07111f 55%, #030712 100%);
    color: #0f1419;
  }
  body.dark {
    background:
      radial-gradient(circle at 12% 20%, rgba(249, 115, 22, .22), transparent 30%),
      radial-gradient(circle at 88% 82%, rgba(29, 155, 240, .18), transparent 30%),
      linear-gradient(135deg, #020617 0%, #030712 55%, #000 100%);
  }
  .canvas {
    width: 1200px;
    height: 675px;
    padding: 50px 58px;
    position: relative;
  }
  .canvas::before, .canvas::after {
    content: "";
    position: absolute;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 999px;
  }
  .canvas::before { width: 360px; height: 360px; left: -180px; top: -190px; }
  .canvas::after { width: 280px; height: 280px; right: -120px; bottom: -160px; }
  .card {
    width: 1084px;
    height: 575px;
    background: rgba(255,255,255,.985);
    border: 1px solid rgba(255,255,255,.75);
    border-radius: 34px;
    box-shadow: 0 28px 90px rgba(0,0,0,.38), 0 2px 8px rgba(0,0,0,.15);
    padding: 40px 44px 36px;
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
  }
  body.dark .card {
    background: rgba(15,20,25,.985);
    border-color: #2f3336;
    box-shadow: 0 28px 90px rgba(0,0,0,.66), 0 2px 8px rgba(0,0,0,.4);
  }
  .card::before {
    content: "";
    position: absolute;
    left: 0; top: 0; right: 0;
    height: 7px;
    background: linear-gradient(90deg, #f38020 0%, #f9b233 52%, #1d9bf0 100%);
  }
  .header { display: flex; align-items: center; min-height: 76px; }
  .avatar {
    width: 72px; height: 72px; border-radius: 50%; object-fit: cover;
    background: linear-gradient(145deg, #1d9bf0, #f38020);
    border: 3px solid #fff;
    box-shadow: 0 0 0 1px #d8e0e5, 0 5px 18px rgba(15,20,25,.16);
  }
  body.dark .avatar {
    border-color: #0f1419;
    box-shadow: 0 0 0 1px #3a3f44, 0 5px 18px rgba(0,0,0,.5);
  }
  .identity { margin-left: 18px; line-height: 1.15; }
  .name { font-size: 27px; font-weight: 790; letter-spacing: -.3px; }
  .handle { margin-top: 6px; color: #536471; font-size: 20px; }
  .xmark { margin-left: auto; font: 700 43px/1 Georgia, serif; color: #0f1419; transform: translateY(-3px); }
  body.dark .name, body.dark .xmark, body.dark .post { color: #f7f9f9; }
  body.dark .handle { color: #8b98a5; }
  .meta-row { display: flex; align-items: center; gap: 12px; margin: 25px 0 18px; }
  .category {
    color: #9a3412; background: #fff1e8; border: 1px solid #fed7aa;
    border-radius: 999px; padding: 9px 14px 8px; font-size: 14px; font-weight: 800;
    letter-spacing: .8px;
  }
  body.dark .category { color: #ffb86b; background: #2b1b12; border-color: #6b3416; }
  .badge {
    margin-left: auto; color: #fff; background: #0f1419; border-radius: 999px;
    padding: 10px 18px 9px; font-size: 19px; font-weight: 850; letter-spacing: .3px;
    box-shadow: 0 5px 14px rgba(15,20,25,.18);
  }
  body.dark .badge { color: #0f1419; background: #f7f9f9; }
  .post {
    font-size: ${fontSize(post.text)}px;
    line-height: ${lineHeight(post.text)};
    letter-spacing: -.55px;
    font-weight: 440;
    flex: 1;
    overflow: hidden;
  }
  .post p { margin: 0 0 .55em; }
  .post p:last-child { margin-bottom: 0; }
  .link { color: #1d9bf0; }
  .footer {
    border-top: 1px solid #e7e9ea;
    padding-top: 17px;
    display: flex;
    align-items: center;
    color: #536471;
    font-size: 18px;
  }
  body.dark .footer { color: #8b98a5; border-color: #2f3336; }
  .source { margin-left: auto; color: #1d9bf0; font-weight: 650; }
</style>
</head>
<body class="${theme}">
  <main class="canvas">
    <article class="card" id="card">
      <header class="header">
        ${avatar ? `<img class="avatar" src="${avatar}" alt="">` : '<div class="avatar"></div>'}
        <div class="identity">
          <div class="name">${escapeHtml(post.name)}</div>
          <div class="handle">${escapeHtml(post.handle)}</div>
        </div>
        <div class="xmark">𝕏</div>
      </header>
      <div class="meta-row">
        <div class="category">${escapeHtml(post.category)}</div>
        <div class="badge">${escapeHtml(post.badge)}</div>
      </div>
      <div class="post">${formatText(post.text)}</div>
      <footer class="footer">
        <span>${escapeHtml(post.date)}</span>
        <span class="source">View post on X ↗</span>
      </footer>
    </article>
  </main>
</body>
</html>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 675 }, deviceScaleFactor: 1 });
const manifest = [];

for (let index = 0; index < posts.length; index += 1) {
  const post = posts[index];
  const avatar = await avatarDataUrl(post.avatar);
  const baseFilename = `${String(index + 1).padStart(2, "0")}-${post.slug}`;
  const lightFilename = `${baseFilename}.png`;
  const darkFilename = `${baseFilename}-dark.png`;

  await page.setContent(htmlFor(post, avatar, "light"), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(cardsDir, lightFilename), type: "png" });

  await page.setContent(htmlFor(post, avatar, "dark"), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(darkCardsDir, darkFilename), type: "png" });

  manifest.push({
    ...post,
    lightFile: `/x-posts/light/${lightFilename}`,
    darkFile: `/x-posts/dark/${darkFilename}`
  });
}

await browser.close();
await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const createContactSheet = async (fileKey, filename, background) => {
  const thumbWidth = 560;
  const thumbHeight = 315;
  const gap = 30;
  const edge = 45;
  const columns = 3;
  const rows = Math.ceil(manifest.length / columns);
  const sheetWidth = edge * 2 + columns * thumbWidth + (columns - 1) * gap;
  const sheetHeight = edge * 2 + rows * thumbHeight + (rows - 1) * gap;
  const composites = [];

  for (let index = 0; index < manifest.length; index += 1) {
    const resized = await sharp(join(publicCardsRoot, manifest[index][fileKey].replace("/x-posts/", "")))
      .resize(thumbWidth, thumbHeight)
      .png()
      .toBuffer();
    composites.push({
      input: resized,
      left: edge + (index % columns) * (thumbWidth + gap),
      top: edge + Math.floor(index / columns) * (thumbHeight + gap)
    });
  }

  await sharp({
    create: {
      width: sheetWidth,
      height: sheetHeight,
      channels: 4,
      background
    }
  }).composite(composites).png().toFile(join(root, filename));
};

await createContactSheet("lightFile", "contact-sheet-light.png", "#07111f");
await createContactSheet("darkFile", "contact-sheet-dark.png", "#00040a");

console.log(`Rendered ${manifest.length} light cards to ${cardsDir}`);
console.log(`Rendered ${manifest.length} dark cards to ${darkCardsDir}`);
console.log(`Contact sheets: ${join(root, "contact-sheet-light.png")} and ${join(root, "contact-sheet-dark.png")}`);
