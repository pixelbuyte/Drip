"""Build the offline DRIP design studio with full-screen inspection and guided flows.
Python standard library only; no network or frontend dependencies.
"""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parent
payload = {key: json.loads((ROOT / name).read_text()) for key, name in [('manifest','manifest.json'),('tokens','tokens.json'),('review','review-data.json')]}
manifest=payload['manifest']
frames=[f for b in manifest['boards'] for f in b['frames']]
ids={f['number'] for f in frames}
assert len(ids)==len(frames)==manifest['frame_count']
for board in manifest['boards']:
    assert (ROOT / board['file']).is_file(), board['file']
    for f in board['frames']:
        x,y,w,h=f['crop']
        assert x>=0 and y>=0 and w>0 and h>0 and x+w<=board.get('width',1448) and y+h<=board.get('height',1086)
        assert str(f['number']) in payload['review']['notes']
for flow in payload['review']['flows']:
    assert set(flow['frames'])<=ids
    assert len(flow['labels'])==len(flow['frames'])-1
for actions in payload['review']['actions'].values():
    assert all(a[0] in ids for a in actions)
page=(ROOT/'gallery-template.html').read_text()
page=page.replace('__STYLE__',(ROOT/'gallery.css').read_text()).replace('__SCRIPT__',(ROOT/'gallery.js').read_text()).replace('__DATA__',json.dumps(payload).replace('</','<\\/'))
(ROOT/'index.html').write_text(page)
print(f"Built {len(frames)} full-screen references, {len(manifest['boards'])} boards, {len(payload['review']['flows'])} guided flows.")
