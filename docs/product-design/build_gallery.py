"""Rebuild the offline reference gallery from manifest.json and local artwork.

Run: python3 docs/product-design/build_gallery.py
This builds a design reference browser, not the production shopping app.
"""

import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
manifest = json.loads((ROOT / "manifest.json").read_text())
tokens = json.loads((ROOT / "tokens.json").read_text())
esc = html.escape

cards = []
for board in manifest["boards"]:
    names = " ".join(frame["name"] for frame in board["frames"])
    cards.append(
        f'<article class="board" data-search="{esc((board["title"]+" "+names).lower())}">'
        f'<a href="{esc(board["file"])}" target="_blank" rel="noopener">'
        f'<img loading="lazy" src="{esc(board["file"])}" alt="{esc(board["title"]+": "+names)}" width="1448" height="1086"></a>'
        f'<div class="board-meta"><span>{board["number"]:02d}</span><h2>{esc(board["title"])}</h2></div>'
        f'<p>{esc(names.replace(" ", " "))}</p></article>'
    )

frames = []
for board in manifest["boards"]:
    for frame in board["frames"]:
        x, y, w, h = frame["crop"]
        style = f"width:{1448/w*100:.5f}%;left:{-x/w*100:.5f}%;top:{-y/h*100:.5f}%"
        frames.append(
            f'<article class="frame" data-search="{esc((frame["name"]+" "+board["title"]).lower())}">'
            f'<a class="frame-window" style="aspect-ratio:{w}/{h}" href="{esc(board["file"])}" target="_blank" rel="noopener" aria-label="Open board for {esc(frame["name"])}">'
            f'<img loading="lazy" style="{style}" src="{esc(board["file"])}" alt="{esc(frame["name"])}"></a>'
            f'<div class="frame-meta"><span>{frame["number"]:02d}</span><h2>{esc(frame["name"])}</h2></div>'
            f'<p>PDF page {frame["pdf_page"]} · {esc(board["title"])}</p></article>'
        )

directions = "".join(
    f'<figure><a href="{esc(d["file"])}" target="_blank" rel="noopener"><img src="{esc(d["file"])}" alt="{esc(d["name"])}" loading="lazy"></a><figcaption>{esc(d["name"])}</figcaption></figure>'
    for d in manifest["directions"]
)
swatches = "".join(
    f'<div class="swatch"><i style="background:{value}"></i><strong>{esc(name)}</strong><code>{value}</code></div>'
    for name, value in tokens["colors"].items()
)

document = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Drip — The complete product experience</title>
<style>
:root{color-scheme:light;--cream:#fff9f2;--ink:#201a17;--muted:#6e6259;--coral:#ff4b2e}
*{box-sizing:border-box}body{margin:0;background:var(--cream);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
a{color:inherit;text-underline-offset:4px}button,input{font:inherit}button,a,input{-webkit-tap-highlight-color:transparent}
:focus-visible{outline:3px solid #c2410c;outline-offset:4px}header,main,footer{max-width:1480px;margin:auto;padding:32px}
header{padding-top:48px}.wordmark{font-size:60px;font-weight:850;letter-spacing:-5px;line-height:1}.wordmark b{color:var(--coral)}
.eyebrow{font-size:13px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin:28px 0 12px}
h1{font:normal clamp(40px,5vw,76px)/1.04 Georgia,serif;letter-spacing:-.035em;max-width:900px;margin:0 0 24px}
.intro{max-width:820px;color:var(--muted);font-size:18px}.links{display:flex;gap:24px;flex-wrap:wrap;margin-top:24px}
.toolbar{position:sticky;top:0;z-index:3;background:var(--cream);border-block:1px solid #ded5ca;display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:16px 0;margin:16px 0 28px}
.switch{display:flex;padding:4px;border-radius:30px;background:#eee6dc}.switch button{border:0;border-radius:24px;padding:10px 20px;background:transparent;cursor:pointer;min-height:44px;color:var(--ink)}
.switch button[aria-pressed=true]{background:var(--ink);color:var(--cream)}input{flex:1;min-width:200px;border:1px solid #b8ac9f;border-radius:14px;min-height:48px;padding:10px 16px;background:transparent;color:var(--ink)}
.count{color:var(--muted);font-size:14px;min-width:110px}.boards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:40px 24px}.board img{display:block;width:100%;height:auto;border-radius:12px;border:1px solid #e7ddd2}
.board-meta,.frame-meta{display:flex;gap:12px;align-items:baseline;margin-top:14px}.board-meta span,.frame-meta span{color:#c2410c;font:600 14px system-ui}.board h2,.frame h2{font-size:20px;margin:0}.board p,.frame p{margin:4px 0;color:var(--muted);font-size:14px}
.frames{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:36px 24px}.frame-window{display:block;overflow:hidden;position:relative;border-radius:14px;background:#fff9f2;border:1px solid #e7ddd2}.frame-window img{position:absolute;max-width:none;height:auto}
[hidden]{display:none!important}.empty{padding:60px 0;text-align:center;color:var(--muted)}.section-title{font:normal 36px Georgia,serif;margin:64px 0 24px}.directions{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.directions figure{margin:0}.directions img{display:block;width:100%;max-height:660px;object-fit:contain;object-position:top;background:#f5eee5}.directions figcaption{font-weight:650;margin-top:12px}
.swatches{display:grid;grid-template-columns:repeat(6,1fr);gap:16px}.swatch i{display:block;height:70px;border-radius:12px;border:1px solid #d0c4b7}.swatch strong,.swatch code{display:block;font-size:13px;margin-top:6px}.swatch code{color:var(--muted);margin-top:0}.note{max-width:850px;color:var(--muted)}footer{border-top:1px solid #ded5ca;color:var(--muted);font-size:14px;margin-top:64px}
@media(min-width:1500px){.frames{grid-template-columns:repeat(5,minmax(0,1fr))}}@media(max-width:950px){.frames{grid-template-columns:repeat(3,minmax(0,1fr))}.boards{grid-template-columns:1fr}.swatches{grid-template-columns:repeat(4,1fr)}}
@media(max-width:640px){header,main,footer{padding:24px 16px}.frames{grid-template-columns:repeat(2,minmax(0,1fr));gap:28px 12px}.frame h2{font-size:16px}.frame p{font-size:12px}.directions{grid-template-columns:1fr}.directions img{max-height:720px}.swatches{grid-template-columns:repeat(3,1fr)}.toolbar{gap:10px}.count{font-size:12px;min-width:auto}.switch button{padding:8px 14px}.links{gap:16px}.wordmark{font-size:50px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style></head><body>
<header><div class="wordmark" aria-label="Drip">drip<b>.</b></div><p class="eyebrow">The complete product experience · September 2026</p><h1>The feed is the store.<br>The people make it Drip.</h1><p class="intro">39 app frames, 14 design boards and three visual directions. A complete reference for the moments between watching, discovering, collecting and buying.</p><div class="links"><a href="SPECIFICATION.md">Product & interaction specification</a><a href="tokens.json">Design tokens</a><a href="#directions">Initial directions</a><a href="#system">Final design language</a></div></header>
<main><div class="toolbar"><div class="switch" aria-label="Reference view"><button type="button" id="frames-button" aria-pressed="true">39 frames</button><button type="button" id="boards-button" aria-pressed="false">14 boards</button></div><input type="search" id="search" aria-label="Search design frames" placeholder="Find a screen: checkout, comments, shop…"><output class="count" id="count" aria-live="polite">39 frames</output></div>
<section class="frames" id="frames" aria-label="Individual app frames">{{FRAMES}}</section><section class="boards" id="boards" aria-label="Design boards" hidden>{{BOARDS}}</section><p id="empty" class="empty" hidden>No matching frames. Try another screen or clear your search.</p>
<h2 class="section-title" id="directions">Three starting points.</h2><p class="note">The final direction combines editorial photography, tactile creator commerce and contextual product sheets. These are exploration references, not extra app themes.</p><section class="directions" aria-label="Initial visual directions">{{DIRECTIONS}}</section>
<h2 class="section-title" id="system">Warm. Tactile. Precise.</h2><section class="swatches" aria-label="Exact design colors">{{SWATCHES}}</section><p class="note">Use ink text on coral controls. See the specification for measured contrast, typography, spacing, navigation, motion, responsive behavior and exact corrections to illustrative artwork.</p>
</main><footer>Static implementation references. All products, people, social counts and commerce details are illustrative. Click a frame to open its complete source board. The accompanying 59-page PDF shows each app frame on its own page.</footer>
<script>
let active='frames';const search=document.getElementById('search');
function refresh(){let shown=0;const q=search.value.trim().toLowerCase();for(const mode of ['frames','boards']){const container=document.getElementById(mode);container.hidden=mode!==active;document.getElementById(mode+'-button').setAttribute('aria-pressed',String(mode===active));for(const card of container.children){card.hidden=!card.dataset.search.includes(q);if(mode===active&&!card.hidden)shown++}}document.getElementById('count').textContent=shown+' '+active;document.getElementById('empty').hidden=shown>0}
for(const mode of ['frames','boards'])document.getElementById(mode+'-button').addEventListener('click',()=>{active=mode;refresh()});search.addEventListener('input',refresh);refresh();
</script></body></html>
"""
for key, value in {"FRAMES": "".join(frames), "BOARDS": "".join(cards), "DIRECTIONS": directions, "SWATCHES": swatches}.items():
    document = document.replace("{{" + key + "}}", value)
(ROOT / "index.html").write_text(document)
print(f"Built {ROOT / 'index.html'} with {len(frames)} frames and {len(cards)} boards")
