import sys
fonts=open('/home/claude/st-dyomix/src/fonts.css').read()
def oz(cx, top, h, studio_mode, ids):
    # geometric O (ring with waveform inside) + Z, both h tall; returns svg
    t=h*0.2  # stroke thickness
    r=h/2; zw=h*0.86; g=h*0.14; left=cx-(h+g+zw)/2
    ox=left+r; zx=left+h+g
    cyo=top+r
    bars=[0.25,0.5,0.85,0.55,1.0,0.6,0.35]
    bw=(r-t)*2*0.62/len(bars)
    bstart=ox-(len(bars)*bw)/2
    wave='' if studio_mode=='middle' else ''.join(f'<rect x="{bstart+i*bw+bw*0.2:.1f}" y="{cyo-(r-t)*0.62*b:.1f}" width="{bw*0.6:.1f}" height="{2*(r-t)*0.62*b:.1f}" rx="{bw*0.3:.1f}" fill="url(#{ids}w)"/>' for i,b in enumerate(bars))
    z=f'M{zx},{top} H{zx+zw} V{top+t} L{zx+t*1.25},{top+h-t} H{zx+zw} V{top+h} H{zx} V{top+h-t} L{zx+zw-t*1.25},{top+t} H{zx} Z'
    s=f'''<defs><linearGradient id="{ids}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5fb0ff"/><stop offset="0.55" stop-color="#4c9aff"/><stop offset="1" stop-color="#8f6bff"/></linearGradient>
<linearGradient id="{ids}w" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff" stop-opacity=".95"/><stop offset="1" stop-color="#ff9f43"/></linearGradient></defs>
<circle cx="{ox}" cy="{cyo}" r="{r-t/2}" fill="none" stroke="url(#{ids}g)" stroke-width="{t}"/>{wave}
<path d="{z}" fill="url(#{ids}g)"/>'''
    return s
def icon(mode):
    S=1024
    h=430 if mode=='under' else 420
    top=245 if mode=='under' else 302
    body=oz(S/2, top, h, mode, 'a')
    if mode=='under':
        txt=f'<text x="{S/2}" y="{top+h+150}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="104" letter-spacing="34" fill="#e6e7ea">STUDIO</text>'
    else:
        y=top+h/2
        txt=f'<rect x="0" y="{y-62}" width="{S}" height="124" fill="#1f2026"/><rect x="0" y="{y-62}" width="{S}" height="3" fill="#4c9aff" opacity=".5"/><rect x="0" y="{y+59}" width="{S}" height="3" fill="#8f6bff" opacity=".5"/><text x="{S/2+17}" y="{y+36}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="98" letter-spacing="34" fill="#ffffff">STUDIO</text>'
        body=f'<clipPath id="cl"><rect width="{S}" height="{S}" rx="230"/></clipPath><g clip-path="url(#cl)">'+body
        txt=txt+'</g>'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2c33"/><stop offset="1" stop-color="#141518"/></linearGradient></defs>
<rect width="{S}" height="{S}" rx="230" fill="url(#bg)"/><rect x="3" y="3" width="{S-6}" height="{S-6}" rx="228" fill="none" stroke="#ffffff" stroke-opacity=".06" stroke-width="6"/>
{body}{txt}</svg>'''
def wordmark():
    W,H=1600,520
    mark=icon('under').replace('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">','<svg x="90" y="90" width="340" height="340" viewBox="0 0 1024 1024">')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}"><rect width="{W}" height="{H}" fill="#18191c"/>
{mark}<text x="500" y="300" font-family="Inter" font-weight="700" font-size="250" letter-spacing="6" fill="#e6e7ea">OZMIX</text>
<text x="508" y="420" font-family="Inter" font-weight="500" font-size="92" letter-spacing="58" fill="#4c9aff">STUDIO</text></svg>'''
for name,svg in [('icon-under',icon('under')),('icon-middle',icon('middle')),('wordmark',wordmark())]:
    open(name+'.svg','w').write(svg)
    open(name+'.html','w').write(f'<html><head><style>{fonts} body{{margin:0;background:transparent}}</style></head><body>{svg}</body></html>')
