"""Export the design book, individual source-resolution frames and offline package.
Requires reportlab and Pillow. Run after build_gallery.py.
"""
import json, re, zipfile, io
from pathlib import Path
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph
ROOT=Path(__file__).resolve().parent
OUT=ROOT/'exports'; OUT.mkdir(exist_ok=True)
FRAMES=OUT/'frames'; FRAMES.mkdir(exist_ok=True)
m=json.loads((ROOT/'manifest.json').read_text()); t=json.loads((ROOT/'tokens.json').read_text()); review=json.loads((ROOT/'review-data.json').read_text())
PDF=OUT/'Drip-Product-Design-v2.pdf'
c=canvas.Canvas(str(PDF));c.setTitle('DRIP / Complete product experience / v2');c.setAuthor('DRIP Product Design')
cream=HexColor('#FFF9F2');ink=HexColor('#201A17');muted=HexColor('#6E6259');coral=HexColor('#FF4B2E')
page=0
style=ParagraphStyle('body',fontName='Helvetica',fontSize=14,leading=21,textColor=ink)
small=ParagraphStyle('small',fontName='Helvetica',fontSize=11,leading=16,textColor=muted)
def para(text,x,top,w,s=style):
 p=Paragraph(text,s);_,h=p.wrap(w,1000);p.drawOn(c,x,top-h);return top-h

def start(title,size=(1200,900)):
 global page
 page+=1;c.setPageSize(size);w,h=size;c.setFillColor(cream);c.rect(0,0,w,h,fill=1,stroke=0);c.setFillColor(ink);c.setFont('Helvetica-Bold',15);c.drawString(36,h-38,title);c.setFillColor(muted);c.setFont('Helvetica',9);c.drawString(36,22,'DRIP / Product design reference / September 2026 / v2');c.drawRightString(w-36,22,str(page));return w,h

def fit(img,x,y,w,h):
 picture=Image.open(img).convert('RGB') if isinstance(img,str) else img.convert('RGB');buffer=io.BytesIO();picture.save(buffer,format='JPEG',quality=94);buffer.seek(0);reader=ImageReader(buffer);iw,ih=reader.getSize();s=min(w/iw,h/ih);c.drawImage(reader,x+(w-iw*s)/2,y+(h-ih*s)/2,iw*s,ih*s,mask='auto')

def finish(): c.showPage()
start('DRIP / THE COMPLETE PRODUCT EXPERIENCE')
c.setFillColor(ink);c.setFont('Helvetica-Bold',110);c.drawString(70,670,'drip');c.setFillColor(coral);c.circle(281,679,9,fill=1,stroke=0)
c.setFillColor(ink);c.setFont('Times-Roman',56);c.drawString(70,560,'The feed is the store.');c.drawString(70,496,'The people make it Drip.')
para('42 full app frames. 15 design boards. Three visual directions.',70,418,850)
para('A complete visual reference for watching, discovering, collecting and buying. Nine guided review flows connect the designs in the accompanying offline gallery.',70,355,840)
para('Version 2 retains the original 39-screen design set and adds the living shelf, refined product peek and clear-total checkout. Every important app state has its own page.',70,270,850)
para('Scope: raster visual references and click-through state review. Illustrative people, products, prices and orders. No live video, social persistence or payment processing.',70,150,960,small);finish()
start('IMPLEMENTATION / ESSENTIAL RULES')
y=800
for title,body in [('Navigation','Home contains For you and Shop. Discover contains search and categories. Drop opens creation. Following prioritizes followed creators. Profile contains orders, saved finds, reviews and preferences. Bag and notifications are top-bar utilities.'),('Product continuity','Feed > living shelf > product peek > checkout > same feed post. Keep the source visible, preserve post ID, playhead and selected variant, and lock background scrolling under sheets.'),('Final reference priority','Prefer frames 40-42 for the primary shopping path. Use the other 39 frames for alternate post formats, Shop, discovery, people, accounts, comments and recovery states.'),('Exact values over image drift','Studio Tote: $78; Chocolate, Sand, Black. Ink labels on coral. Heart means Like; bookmark means Save. Three tagged look products: tote, knit and denim. Coffee is set dressing. The illustrative full order total is $84.24.'),('Gallery versus production','The gallery links states and exports reference images. The production app still needs the specified gestures, native text, accessible controls and backend integration. See REVIEW-GUIDE.md for implementation gaps and SPECIFICATION.md for complete behavior.')]:
 c.setFillColor(ink);c.setFont('Helvetica-Bold',19);c.drawString(50,y,title);y=para(body,50,y-18,1090)-40
finish()
start('DESIGN SYSTEM / EXACT PALETTE')
for i,(name,color) in enumerate(t['colors'].items()):
 x=50+(i%6)*187;y=665-(i//6)*170;c.setFillColor(HexColor(color));c.roundRect(x,y,160,100,12,fill=1,stroke=0);c.setFillColor(ink);c.setFont('Helvetica-Bold',12);c.drawString(x,y-23,name);c.setFont('Helvetica',11);c.drawString(x,y-42,color)
para('Typography: display 48/50; title 32/36; section 24/28; product 18/24; body 16/24; metadata 14/20; navigation 13/16. Editorial serif for stories, sans for buying decisions.',50,430,1080)
para('Spacing: 4, 8, 12, 16, 20, 24, 32, 40, 48. Radius: thumbnail 8, field 12, tile 16, media 24, sheet 28. Touch targets: minimum 44; prefer 48.',50,330,1080)
para('Measured solid-color contrast: ink/cream 16.44:1; muted/cream 5.65:1; ink/coral 5.16:1; coralText/cream 4.95:1; ink/lime 13.06:1. Verify text over actual media separately.',50,230,1080)
para('Motion: press 80ms, release 120ms, like 260ms, follow 180ms, save 200ms, peek 320ms, comments/checkout 300ms, tabs 180ms, success 360ms. Reduced motion: immediate or <=100ms fade.',50,130,1080,small);finish()
for i,d in enumerate(m['directions']):
 start('INITIAL DIRECTION / '+d['name'].replace('·','/'))
 fit(str(ROOT/d['file']),40,55,540,780)
 c.setFont('Times-Roman',36);c.setFillColor(ink);c.drawString(630,650,['Editorial Commerce','Playful Creator Commerce','Future Social Shopping'][i])
 para(['Photographic scale, confident editorial type, generous whitespace and restraint.','Dimensional category objects, tactile products, pastel warmth and creator-first hierarchy.','Contextual sheets, immersive media and a continuous path from video to product to purchase.'][i],630,600,480)
 para('The selected final direction combines the strongest parts of all three. These are exploration references, not additional themes inside the app.',630,430,480)
 finish()
for b in m['boards']:
 assert page+1==b['pdf_page'],(page,b)
 start('BOARD '+str(b['number']).zfill(2)+' / '+b['title'])
 fit(str(ROOT/b['file']),28,42,1144,795);finish()
 source=Image.open(ROOT/b['file']).convert('RGB')
 for f in b['frames']:
  assert page+1==f['pdf_page']
  x,y,w,h=f['crop'];crop=source.crop((round(x),round(y),round(x+w),round(y+h)))
  name='drip-'+str(f['number']).zfill(2)+'-'+re.sub('[^a-z0-9]+','-',f['name'].lower()).strip('-')+'.png'
  crop.save(FRAMES/name,compress_level=6)
  start(str(f['number']).zfill(2)+' / '+f['name'],(600,1120))
  fit(crop,32,125,536,930)
  para(review['notes'][str(f['number'])][1],36,100,528,small)
  finish()
start('REVIEW / BEHAVIOR THAT MAKES IT DRIP')
y=795
for title,body in [('The living shelf','A compact product surface grows into a peek. Social actions form a horizontal row, leaving the creator and product more space. Product scrub previews variants; Shop the frame connects visible objects to tagged products.'),('Comments stay in the story','25%, 60% and 90% detents. Preserve drafts, thread position, focus, keyboard visibility and source playback policy. A state swap in the gallery does not validate drag physics.'),('Eight distinctive interaction contracts','Product scrub, drop stack, hold to peek, creator trust trail, shop the frame, save threads, same-item chorus and return ribbon. See SPECIFICATION.md for triggers, feedback and accessible alternatives.'),('Review at real device sizes','390 x 844 primary, 375 x 667 compact phone, Android safe areas and keyboard, and a contextual side panel on tablet. Raster art is visual direction: real text and controls must support scaling and screen readers.'),('Implementation truth','Existing feed infrastructure is retained on this branch. The actual feed currently suspends playback for sheets; product peek requires a deliberate policy adjustment. Native payment controls, inventory checks and idempotency must be implemented before real purchase flows.')]:
 c.setFillColor(ink);c.setFont('Helvetica-Bold',18);c.drawString(50,y,title);y=para(body,50,y-17,1090)-38
finish();assert page==m['pdf_pages'];c.save()
archive=OUT/'Drip-Design-Package-v2.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for f in sorted(ROOT.rglob('*')):
  if not f.is_file() or 'exports' in f.relative_to(ROOT).parts or '__pycache__' in f.parts or f.name.startswith('.'):continue
  z.write(f,'Drip-Design/'+str(f.relative_to(ROOT)))
 z.write(PDF,'Drip-Design/'+PDF.name)
 for f in sorted(FRAMES.glob('*.png')):z.write(f,'Drip-Design/frames/'+f.name)
print(f'{PDF}: {page} pages; {len(list(FRAMES.glob("*.png")))} frame exports; {archive}')
