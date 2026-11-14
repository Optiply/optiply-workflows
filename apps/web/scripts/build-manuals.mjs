// Builds the two PDF manuals from docs/manuals/*.md (session 54):
//   Optiply-Workflows-User-Guide.pdf  = user-guide.md
//   Optiply-Workflows-Admin-Guide.pdf = user-guide.md + admin-guide.md
// Markdown → styled HTML (cover, contents with links, a chapter per page) → PDF through Playwright's Chromium, with
// page numbers in the footer. Screenshots come from docs/manuals/images (docs/manuals/SCREENSHOTS.md says how to make
// them). Run from apps/web: `node scripts/build-manuals.mjs` (or `corepack pnpm --filter @ow/web manuals`).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { Marked } from 'marked'

const here = dirname(fileURLToPath(import.meta.url))
const web = resolve(here, '..')
const manuals = process.env.MANUALS_DIR
  ? resolve(process.env.MANUALS_DIR)
  : resolve(web, '../../docs/manuals')
const build = join(manuals, '.build')
mkdirSync(build, { recursive: true })

const font = (pkg) => pathToFileURL(join(web, 'node_modules/@fontsource-variable', pkg, 'index.css')).href
const today = new Date().toISOString().slice(0, 10)

/** A heading's anchor: lower case, words joined by dashes, unique within the document. */
function slugger() {
  const seen = new Map()
  return (text) => {
    const base =
      text
        .toLowerCase()
        .replace(/<[^>]+>/g, '')
        .replace(/&[a-z]+;/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'section'
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n ? `${base}-${n}` : base
  }
}

const missing = new Set()
/** A PNG's width in pixels, from its header. */
function pngWidth(file) {
  return readFileSync(file).readUInt32BE(16)
}
/** Screenshots used, by their path under docs/manuals: each gets a print copy before the PDFs are made. */
const used = new Set()
/** Where a screenshot's print copy goes: a JPEG at print resolution (the PNG originals are 2× screen size). */
function printCopy(href) {
  used.add(href)
  return join(build, 'print', href.replace(/\.png$/i, '.jpg'))
}

/** Markdown → HTML body + the headings for the contents (H2 chapters, H3 sections). */
function render(markdown, slug) {
  const toc = []
  const marked = new Marked({ gfm: true })
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens)
        const id = slug(text)
        if (depth === 2 || depth === 3) toc.push({ depth, id, text })
        return `<h${depth} id="${id}">${text}</h${depth}>\n`
      },
      image({ href, text }) {
        const file = join(manuals, href)
        if (!existsSync(file)) missing.add(href)
        const src = existsSync(file) ? pathToFileURL(printCopy(href)).href : ''
        // A screenshot as wide as the whole screen (2880 px at 2×) fills the column; a dialog or panel keeps its size
        // relative to that, a little larger so its words stay readable.
        const width = existsSync(file) ? Math.min(100, Math.round((pngWidth(file) / 2880) * 100 * 1.3)) : 100
        return `<figure>${src ? `<img src="${src}" alt="${text}" style="width:${width}%">` : `<div class="missing">Screenshot to come: ${href}</div>`}${text ? `<figcaption>${text}</figcaption>` : ''}</figure>`
      },
      blockquote({ tokens }) {
        const body = this.parser.parse(tokens)
        const kind =
          /^<p><strong>(Tip|Note|Important|Warning):?<\/strong>/i.exec(body)?.[1]?.toLowerCase() ?? 'note'
        return `<blockquote class="callout ${kind}">${body}</blockquote>\n`
      },
    },
  })
  // A paragraph holding only an image is a figure, not a paragraph around one.
  const html = marked.parse(markdown).replace(/<p>(<figure>[\s\S]*?<\/figure>)<\/p>/g, '$1')
  return { html, toc }
}

const css = `
@import url("${font('inter')}");
@import url("${font('jetbrains-mono')}");
@page { size: A4; margin: 22mm 18mm 22mm 18mm; }
:root { --ink: #222b36; --muted: #50657f; --blue: #1860c4; --blue-dark: #134d9e; --blue-soft: #dbe7f9;
  --line: #d7dfec; --tint: #f5f8fb; }
* { box-sizing: border-box; }
html { font-family: "Inter Variable", Inter, system-ui, sans-serif; color: var(--ink); font-size: 9.6pt; line-height: 1.5; }
body { margin: 0; }
a { color: var(--blue); text-decoration: none; }
h1, h2, h3, h4 { line-height: 1.25; color: var(--ink); break-after: avoid; }
h1 { font-size: 26pt; margin: 0 0 10mm; letter-spacing: -0.5px; }
h2 { font-size: 18pt; margin: 0 0 6mm; padding-bottom: 3mm; border-bottom: 2px solid var(--blue); break-before: page; }
h3 { font-size: 12pt; margin: 6mm 0 2.5mm; color: var(--blue-dark); }
h4 { font-size: 11pt; margin: 6mm 0 2mm; }
p, ul, ol { margin: 0 0 2.4mm; }
li { margin: 0.4mm 0; }
li > p { margin: 0; }
code { font-family: "JetBrains Mono Variable", "JetBrains Mono", monospace; font-size: 0.88em; background: var(--tint);
  border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; }
pre { background: #1d2733; color: #e8eef6; border-radius: 6px; padding: 4mm; font-size: 8.6pt; line-height: 1.45;
  white-space: pre-wrap; word-break: break-word; break-inside: avoid; margin: 0 0 4mm; }
pre code { background: none; border: 0; padding: 0; color: inherit; font-size: inherit; }
table { width: 100%; border-collapse: collapse; margin: 2mm 0 5mm; font-size: 9.2pt; break-inside: auto; }
th { background: var(--tint); text-align: left; font-weight: 600; }
th, td { border: 1px solid var(--line); padding: 1.6mm 2.4mm; vertical-align: top; }
tr { break-inside: avoid; }
figure { margin: 2mm 0 4mm; break-inside: avoid; text-align: center; }
figure img { max-width: 100%; max-height: 100mm; border: 1px solid var(--line); border-radius: 6px;
  box-shadow: 0 1px 3px rgba(34, 43, 54, 0.08); }
figcaption { font-size: 8.8pt; color: var(--muted); margin-top: 1.5mm; }
.missing { border: 1px dashed var(--line); padding: 10mm; color: var(--muted); font-size: 9pt; }
blockquote.callout { margin: 3mm 0 5mm; padding: 3mm 4mm; border-left: 4px solid var(--blue); background: var(--blue-soft);
  border-radius: 0 6px 6px 0; break-inside: avoid; }
blockquote.callout.tip { border-color: #2e8540; background: #e3f2e6; }
blockquote.callout.important, blockquote.callout.warning { border-color: #c27c0e; background: #fbf0dc; }
blockquote.callout p:last-child { margin-bottom: 0; }
hr { border: 0; border-top: 1px solid var(--line); margin: 6mm 0; }
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: space-between; break-after: page; }
.wordmark { font-weight: 700; font-size: 30pt; letter-spacing: -0.5px; color: #009ee3; }
.wordmark span { font-weight: 500; font-size: 14pt; color: var(--muted); letter-spacing: 0; margin-left: 2mm; }
.cover h1 { font-size: 34pt; margin: 0 0 4mm; }
.cover .subtitle { font-size: 14pt; color: var(--muted); }
.cover .meta { font-size: 9.5pt; color: var(--muted); border-top: 1px solid var(--line); padding-top: 4mm; }
.toc { break-after: page; }
.toc h2 { break-before: auto; }
.toc ol { list-style: none; padding: 0; }
.toc li.d2 { font-weight: 600; margin-top: 2.5mm; }
.toc li.d3 { padding-left: 6mm; font-size: 9.5pt; }
.toc li.part { font-size: 12pt; font-weight: 700; color: var(--blue-dark); margin-top: 5mm; }
.part-title { break-before: page; height: 200mm; display: flex; flex-direction: column; justify-content: center; }
.part-title h1 { font-size: 30pt; color: var(--blue-dark); }
`

function page({ title, audience, parts }) {
  const slug = slugger()
  const rendered = parts.map((p) => ({ ...p, ...render(p.markdown.replace(/^# .*\n/, ''), slug) }))
  const contents = rendered
    .map(
      (p) =>
        (p.label ? `<li class="part">${p.label}</li>` : '') +
        p.toc.map((h) => `<li class="d${h.depth}"><a href="#${h.id}">${h.text}</a></li>`).join(''),
    )
    .join('')
  const body = rendered
    .map((p) => (p.label ? `<section class="part-title"><h1>${p.label}</h1></section>` : '') + p.html)
    .join('\n')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head><body>
<section class="cover">
  <div class="wordmark">optiply.<span>workflows</span></div>
  <div><h1>${title}</h1><div class="subtitle">${audience}</div></div>
  <div class="meta">Version of ${today} · Generated from docs/manuals in the optiply-workflows repository</div>
</section>
<nav class="toc"><h2>Contents</h2><ol>${contents}</ol></nav>
${body}
</body></html>`
}

const user = readFileSync(join(manuals, 'user-guide.md'), 'utf8')
const admin = readFileSync(join(manuals, 'admin-guide.md'), 'utf8')
const docs = [
  {
    file: 'Optiply-Workflows-User-Guide.pdf',
    title: 'User Guide',
    audience: 'Building and using workflows and apps — for everyone at Optiply',
    parts: [{ markdown: user }],
  },
  {
    file: 'Optiply-Workflows-Admin-Guide.pdf',
    title: 'Admin Guide',
    audience: 'Everything in the User Guide, plus running and administering the platform',
    parts: [
      { label: 'Part 1 — Using Optiply Workflows', markdown: user },
      { label: 'Part 2 — Administration', markdown: admin },
    ],
  },
]

// Locally the installed Google Chrome (as the e2e config does); in CI Playwright's own Chromium.
const browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' })
try {
  // Render first so every screenshot is known, then make the print copies in the browser (no image tools needed):
  // at most 1600 px wide, JPEG at 0.8, so a PDF is a few MB instead of tens.
  const pages = docs.map((doc) => ({ doc, html: page(doc) }))
  const shrink = await browser.newPage()
  for (const href of used) {
    const source = join(manuals, href)
    if (!existsSync(source)) continue
    const out = printCopy(href)
    mkdirSync(dirname(out), { recursive: true })
    const dataUrl = `data:image/png;base64,${readFileSync(source).toString('base64')}`
    const jpeg = await shrink.evaluate(async (url) => {
      const img = new Image()
      img.src = url
      await img.decode()
      const scale = Math.min(1, 1600 / img.naturalWidth)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.naturalWidth * scale)
      canvas.height = Math.round(img.naturalHeight * scale)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/jpeg', 0.8).split(',')[1]
    }, dataUrl)
    writeFileSync(out, Buffer.from(jpeg, 'base64'))
  }
  await shrink.close()
  for (const { doc, html } of pages) {
    const htmlFile = join(build, doc.file.replace(/\.pdf$/, '.html'))
    writeFileSync(htmlFile, html)
    const tab = await browser.newPage()
    await tab.goto(pathToFileURL(htmlFile).href, { waitUntil: 'networkidle' })
    await tab.evaluate(() => document.fonts.ready)
    await tab.pdf({
      path: join(manuals, doc.file),
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-size:8px;color:#50657f;padding:0 18mm;display:flex;justify-content:space-between;font-family:Helvetica,Arial,sans-serif"><span>Optiply Workflows · ${doc.title}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    })
    await tab.close()
    console.log(`wrote ${join(manuals, doc.file)}`)
  }
} finally {
  await browser.close()
}
if (missing.size) console.warn(`screenshots missing (placeholders in the PDF): ${[...missing].join(', ')}`)
