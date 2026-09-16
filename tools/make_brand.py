#!/usr/bin/env python3
"""Generate every Homingvector brand SVG from ONE set of construction constants.

Hand-authored geometry, not traced: the mark is three polygons on a 48-unit grid, the wordmark is
stroked centre-lines on a 24-unit cap height. Nothing is round -- no arcs, round joins or caps
anywhere. See brand/CONSTRUCTION.md for the reasoning behind each number.
"""
import os, sys
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'brand')
FG, RED, BG = '#f2f0ea', '#ff4a2b', '#070707'

# ---------------------------------------------------------------- mark (48 x 48 grid)
# heavy stroke: 10 units wide at the top, driving to the vertex
HEAVY = 'M3 5H13L25 34H19Z'
def hair(w):   # right stroke; w = its horizontal thickness (2.5 display, 4 etch)
    return f'M{45.5-w} 5H45.5L{32+w/2:g} 29H{29.5+w/2-w:g}Z'.replace('H29.5-','H')
def hair_path(w):
    return f'M{45.5-w:g} 5H45.5L{29.5+w:g} 29H29.5Z'
def bracket(w):  # the lock: one corner, closing under the gap the hairline leaves
    return f'M27 {42-w:g}H{39-w:g}V32H39V42H27Z'

def mark_svg(color_heavy=FG, color_lock=RED, w_hair=2.5, w_br=2.5, bg=None, size=48):
    b = f'<rect width="48" height="48" fill="{bg}"/>' if bg else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="{size}" height="{size}">{b}'
            f'<path fill="{color_heavy}" d="{HEAVY}"/><path fill="{color_heavy}" d="{hair_path(w_hair)}"/>'
            f'<path fill="{color_lock}" d="{bracket(w_br)}"/></svg>')

# ---------------------------------------------------------------- wordmark (cap height 24)
S = 3.4            # stroke
A = S / 2
TOP, BOT, MID = A, 24 - A, 11.6
C = 5              # chamfer, the only "curve" this alphabet has
GAP = 3.2          # tight tracking
def g_H(w=15):  return w, f'M{A} {TOP}V{BOT}M{w-A} {TOP}V{BOT}M{A} {MID}H{w-A}'
def g_O(w=17):  return w, f'M{A+C} {TOP}H{w-A-C}L{w-A} {TOP+C}V{BOT-C}L{w-A-C} {BOT}H{A+C}L{A} {BOT-C}V{TOP+C}Z'
def g_M(w=19):  return w, f'M{A} {BOT}V{TOP}L{w/2} {TOP+13}L{w-A} {TOP}V{BOT}'
def g_I(w=S):   return w, f'M{A} {TOP}V{BOT}'
def g_N(w=15):  return w, f'M{A} {BOT}V{TOP}L{w-A} {BOT}V{TOP}'
def g_G(w=17):  return w, f'M{w-A} {TOP}H{A+C}L{A} {TOP+C}V{BOT-C}L{A+C} {BOT}H{w-A}V{MID+1}H{w/2+1}'
def g_E(w=13):  return w, f'M{w} {TOP}H{A}V{BOT}H{w}M{A} {MID}H{w-2}'
def g_C(w=16):  return w, f'M{w} {TOP}H{A+C}L{A} {TOP+C}V{BOT-C}L{A+C} {BOT}H{w}'
def g_T(w=15):  return w, f'M0 {TOP}H{w}M{w/2} {TOP}V{BOT}'
def g_R(w=15):  return w, f'M{A} {BOT}V{TOP}H{w-A-C}L{w-A} {TOP+C}V{MID-C+A}L{w-A-C} {MID}H{A}M{w/2} {MID}L{w-A} {BOT}'
GLYPH = dict(H=g_H, O=g_O, M=g_M, I=g_I, N=g_N, G=g_G, E=g_E, C=g_C, T=g_T, R=g_R)

def wordmark_paths(color=FG, x0=0.0):
    """Returns (svg fragment, advance width). The V is the mark's own broken V, not a font V."""
    x, parts = x0, []
    for ch in 'HOMINGVECTOR':
        if ch == 'V':
            w = 18
            # heavy left stroke (filled, like the mark) and a hairline that stops short of the vertex
            parts.append(f'<path fill="{color}" d="M{x:g} 0H{x+5.2:g}L{x+w/2+1.6:g} 24H{x+w/2-1.6:g}Z"/>')
            parts.append(f'<path fill="{color}" d="M{x+w-1.6:g} 0H{x+w:g}L{x+w/2+4.4:g} 16H{x+w/2+2.8:g}Z"/>')
        else:
            w, d = GLYPH[ch]()
            # M's centre vertex is ~27 deg: a mitre there spikes 7 units through the baseline, so M alone
            # takes a BEVEL join -- a flat cut, still no curve anywhere.
            join = 'bevel' if ch == 'M' else 'miter'
            parts.append(f'<path transform="translate({x:g} 0)" fill="none" stroke="{color}" stroke-width="{S}" '
                         f'stroke-linejoin="{join}" stroke-miterlimit="10" stroke-linecap="butt" d="{d}"/>')
        x += w + GAP
    return ''.join(parts), x - GAP - x0

def wordmark_svg(color=FG):
    frag, w = wordmark_paths(color)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 {w+2:g} 26" width="{(w+2)*2:g}" height="52" role="img" aria-label="HOMINGVECTOR">{frag}</svg>'

def lockup_svg(color=FG, lock=RED):
    # mark sits on the cap height: 48-grid scaled so its 5..45 span equals 24 * 1.5
    k = 36 / 40
    frag, w = wordmark_paths(color, x0=48 * k + 14)
    total = 48 * k + 14 + w
    m = (f'<g transform="translate(0 {-5*k-6:g}) scale({k:g})"><path fill="{color}" d="{HEAVY}"/>'
         f'<path fill="{color}" d="{hair_path(2.5)}"/><path fill="{lock}" d="{bracket(2.5)}"/></g>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -7 {total+2:g} 38" width="{(total+2)*2:g}" height="76" '
            f'role="img" aria-label="HOMINGVECTOR">{m}<g transform="translate(0 0)">{frag}</g></svg>')

files = {
    'logo-mark.svg':        mark_svg(),
    'logo-wordmark.svg':    wordmark_svg(),
    'logo-primary.svg':     lockup_svg(),
    'logo-mono-light.svg':  lockup_svg(FG, FG),        # single colour, for dark grounds
    'logo-mono-dark.svg':   lockup_svg(BG, BG),        # single colour, for light grounds
    'logo-etch.svg':        mark_svg(FG, FG, w_hair=4, w_br=4),
    'favicon.svg':          mark_svg(FG, RED, w_hair=4, w_br=4, bg=BG),
}
os.makedirs(OUT, exist_ok=True)
for n, s in files.items():
    open(os.path.join(OUT, n), 'w').write(s + '\n')
print('wrote', len(files), 'svg to', os.path.abspath(OUT))
