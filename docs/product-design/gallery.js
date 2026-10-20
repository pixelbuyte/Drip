'use strict';
const data=JSON.parse(document.getElementById('design-data').textContent);
const {manifest,tokens,review}=data;
const frames=manifest.boards.flatMap(board=>board.frames.map(frame=>({...frame,board,width:board.width||1448,height:board.height||1086,...Object.fromEntries(['group','description','contract'].map((key,i)=>[key,review.notes[frame.number][i]]))})));
const byId=new Map(frames.map(f=>[f.number,f]));
const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
function art(frame,tag='div'){
 const n=el(tag,'frame-window');const [x,y,w,h]=frame.crop;n.style.aspectRatio=w+'/'+h;
 const im=el('img');im.src=frame.board.file;im.alt=frame.name+' — complete app screen';im.loading='lazy';im.style.width=(frame.width/w*100)+'%';im.style.left=(-x/w*100)+'%';im.style.top=(-y/h*100)+'%';n.append(im);return n;
}
$('stats').textContent=manifest.frame_count+' full app frames · '+manifest.board_count+' boards · 3 directions';
let group='All',view='screens',current=40,sequence=frames.map(f=>f.number),position=0,activeFlow=null,returnFocus=null;
const categories=['All','Refinement','Feed','Shop','Social','Discover','Checkout','Account','States'];
for(const name of categories){const b=el('button','',name);b.type='button';b.setAttribute('aria-pressed',String(name===group));b.onclick=()=>{group=name;renderScreens();};document.querySelector('.filters').append(b);}
function renderScreens(){
 const q=$('search').value.trim().toLowerCase();const matches=frames.filter(f=>(group==='All'||f.group===group)&&[f.name,f.board.title,f.description,f.group].join(' ').toLowerCase().includes(q));
 $('screens').replaceChildren();
 // Lead with the newly refined journey, then retain the original reference order.
 const ordered=[...matches].sort((a,b)=>Number(b.number>=40)-Number(a.number>=40)||a.number-b.number);
 for(const f of ordered){const card=el('article','screen-card');const a=art(f,'button');a.type='button';a.setAttribute('aria-label','Inspect '+f.number+': '+f.name);a.onclick=()=>openFrame(f.number,ordered.map(x=>x.number));card.append(a);const label=el('div','frame-label');label.append(el('span','',String(f.number).padStart(2,'0')),el('h2','',f.name));card.append(label,el('p','',f.group+(f.number>=40?' · New refinement':'')));$('screens').append(card);}
 $('count').textContent=matches.length+' / '+frames.length+' screens';$('empty').hidden=matches.length>0;
 for(const b of document.querySelectorAll('.filters button'))b.setAttribute('aria-pressed',String(b.textContent===group));
}
$('search').addEventListener('input',renderScreens);$('clear').onclick=()=>{$('search').value='';group='All';renderScreens();$('search').focus();};
function setView(next){view=next;for(const name of ['screens','flows','directions','system'])$(name+'-view').hidden=name!==view;for(const b of document.querySelectorAll('.modes button'))b.setAttribute('aria-pressed',String(b.dataset.view===view));}
for(const b of document.querySelectorAll('.modes button'))b.onclick=()=>setView(b.dataset.view);
for(const flow of review.flows){const card=el('article','flow-card');const previews=el('div','flow-previews');previews.append(art(byId.get(flow.frames[0])),art(byId.get(flow.frames[1])));card.append(previews,el('p','eyebrow',(flow.frames.length-1)+' TRANSITIONS'),el('h3','',flow.name),el('p','',flow.description));const b=el('button','','Walk this flow');b.setAttribute('aria-label','Walk flow: '+flow.name);b.onclick=()=>openFrame(flow.frames[0],flow.frames,flow);card.append(b);$('flows').append(card);}
const directionNotes=['Photography, whitespace and an elegant serif give discovery the confidence of a fashion edit.','Pastel objects, creator-led hierarchy and tactile product cards add energy without visual noise.','Immersive media, expanding product surfaces and fluid sheets preserve the context of the discovery.'];
manifest.directions.forEach((d,i)=>{const f=el('figure');const a=el('a');a.href=d.file;a.target='_blank';a.rel='noopener';const im=el('img');im.src=d.file;im.alt=d.name;im.loading='lazy';a.append(im);f.append(a,el('h3','',d.name),el('p','',directionNotes[i]));$('directions').append(f);});
for(const [name,color] of Object.entries(tokens.colors)){const s=el('div','swatch');const i=el('i');i.style.background=color;s.append(i,el('strong','',name),el('code','',color));$('swatches').append(s);}
for(const [name,t] of Object.entries(tokens.type)){const r=el('div','type-row');r.append(el('span','',name),el('span','',t.size+' / '+t.lineHeight+' pt'));$('type-scale').append(r);}
const motions=[['Button press','80 / 120ms','Scale to .98, return without overshoot.'],['Like','260ms','Local heart emphasis; one increment.'],['Follow','180ms','Label and check crossfade.'],['Save','200ms','Bookmark fill, small collection confirmation.'],['Product peek','320ms','Shelf grows into contextual sheet.'],['Comment detent','300ms','Follows the finger, settles with high damping.'],['Checkout sheet','300ms','Slide upward with focus transfer.'],['Tab transition','180ms','Shallow crossfade; dock stays anchored.'],['Feed settle','220–320ms','Native inertial snap; no artificial wait.'],['Purchase success','360ms','One restrained check, then return to story.']];
for(const row of motions){const tr=el('tr');for(const c of row)tr.append(el('td','',c));$('motion').append(tr);}
function openFrame(id,ids=frames.map(f=>f.number),flow=null){
 if(!$('inspector').open){returnFocus=document.activeElement;$('inspector').showModal();}
 sequence=ids;position=Math.max(0,ids.indexOf(id));activeFlow=flow;current=id;renderInspector();
}
function go(id){current=id;const i=sequence.indexOf(id);if(i!==-1)position=i;else{sequence=frames.map(f=>f.number);position=sequence.indexOf(id);activeFlow=null;}renderInspector();}
function step(delta){const next=position+delta;if(next<0||next>=sequence.length)return;position=next;current=sequence[position];renderInspector();}
function renderInspector(){
 const f=byId.get(current);if(!f)return;$('download').textContent='Export this frame';const display=$('frame-display'),a=art(f);display.replaceChildren(...a.childNodes);display.style.aspectRatio=a.style.aspectRatio;display.style.setProperty('--frame-ratio',f.crop[2]/f.crop[3]);
 $('frame-counter').textContent='FRAME '+String(f.number).padStart(2,'0')+' / '+frames.length;
 $('frame-kicker').textContent=activeFlow?activeFlow.name:f.group+' / '+f.board.title;
 $('frame-title').textContent=f.name;$('frame-description').textContent=f.description;$('frame-contract').textContent=f.contract;
 $('source').href=f.board.file;$('actions').replaceChildren();
 const opts=review.actions[f.number]||[];
 if(activeFlow&&position<sequence.length-1){const b=el('button','',activeFlow.labels[position]||'Next state');b.onclick=()=>step(1);$('actions').append(b);}
 for(const [id,label] of opts){if(activeFlow&&id===sequence[position+1])continue;const b=el('button','',label);b.onclick=()=>go(id);$('actions').append(b);}
 $('detents').hidden=![4,5,6].includes(current);$('detents').replaceChildren();
 for(const [id,label] of [[4,'25%'],[5,'60%'],[6,'90%']]){const b=el('button','',label);b.setAttribute('aria-pressed',String(id===current));b.onclick=()=>go(id);$('detents').append(b);}
 $('previous').disabled=position===0;$('next').disabled=position===sequence.length-1;$('step-status').textContent=(position+1)+' / '+sequence.length;
 history.replaceState(null,'','#frame='+f.number);$('inspector').scrollTop=0;$('frame-title').focus({preventScroll:true});
}
$('close').onclick=()=>$('inspector').close();$('previous').onclick=()=>step(-1);$('next').onclick=()=>step(1);
$('inspector').addEventListener('close',()=>{history.replaceState(null,'',location.pathname+location.search);if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});});
$('inspector').addEventListener('click',e=>{if(e.target===$('inspector')){const r=$('inspector').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('inspector').close();}});
document.addEventListener('keydown',e=>{if(!$('inspector').open)return;if(e.key==='ArrowRight'){e.preventDefault();step(1);}if(e.key==='ArrowLeft'){e.preventDefault();step(-1);}});
$('download').onclick=async()=>{
 const f=byId.get(current),image=new Image();image.src=f.board.file;const b=$('download');b.disabled=true;b.textContent='Preparing frame…';
 try{await image.decode();const [x,y,w,h]=f.crop;const c=document.createElement('canvas');c.width=Math.round(w);c.height=Math.round(h);c.getContext('2d').drawImage(image,x,y,w,h,0,0,c.width,c.height);const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));if(!blob)throw new Error('Frame could not be exported');const url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download='drip-'+String(f.number).padStart(2,'0')+'-'+f.name.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);b.textContent='Frame exported';}catch{b.textContent='Export unavailable — use source board';}finally{b.disabled=false;}
};
renderScreens();
const initial=Number(new URLSearchParams(location.hash.slice(1)).get('frame'));if(byId.has(initial))openFrame(initial);
