"""Parametric hand-pose glyphs, drawn as solid silhouettes."""

INK = "#1b1b1b"
ACC = "#f59a23"
MUT = "#c9c9c9"

PALM = '<rect x="24" y="54" width="52" height="46" rx="17" fill="{ink}"/>'
FX   = [33.5, 46, 58.5, 70]
TOP  = [18, 9, 16, 29]      # extended fingertip y
CURL = [48, 46, 48, 51]     # curled fingertip y

def finger(i, extended, color=INK):
    y = TOP[i] if extended else CURL[i]
    return (f'<line x1="{FX[i]}" y1="62" x2="{FX[i]}" y2="{y}" stroke="{color}" '
            f'stroke-width="11" stroke-linecap="round"/>')

def thumb(mode, color=INK):
    if mode == "out":      # open palm — thumb alongside
        return f'<line x1="29" y1="78" x2="9" y2="55" stroke="{color}" stroke-width="11" stroke-linecap="round"/>'
    if mode == "up":
        return f'<line x1="28" y1="74" x2="19" y2="30" stroke="{color}" stroke-width="11" stroke-linecap="round"/>'
    if mode == "down":
        return f'<line x1="28" y1="80" x2="19" y2="118" stroke="{color}" stroke-width="11" stroke-linecap="round"/>'
    return ''              # tucked — hidden inside the silhouette

def hand(fingers, th="tuck", extra="", rot=0, color=INK):
    g = PALM.format(ink=color)
    for i in range(4):
        g += finger(i, fingers[i], color)
    g += thumb(th, color)
    if rot:
        g = f'<g transform="rotate({rot} 50 86)">{g}</g>'
    return g + extra

def svg(body, w=100, h=136, vb="-4 0 108 136"):
    return (f'<svg class="hand" viewBox="{vb}" width="{w}" height="{h}" '
            f'xmlns="http://www.w3.org/2000/svg" role="img">{body}</svg>')

# rotation arc, drawn below the wrist so it never crosses the fingers
def turn(direction):
    body = hand([1,1,1,1], "out", rot=(20 if direction == "r" else -20))
    if direction == "r":
        arc = (f'<path d="M12 126 A74 74 0 0 1 92 120" fill="none" stroke="{ACC}" '
               f'stroke-width="6.5" stroke-linecap="round"/>'
               f'<path d="M84 110 L94 120 L82 127" fill="none" stroke="{ACC}" '
               f'stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>')
    else:
        arc = (f'<path d="M88 126 A74 74 0 0 0 8 120" fill="none" stroke="{ACC}" '
               f'stroke-width="6.5" stroke-linecap="round"/>'
               f'<path d="M16 110 L6 120 L18 127" fill="none" stroke="{ACC}" '
               f'stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>')
    return body + arc

def pinch(ring=True):
    g = PALM.format(ink=INK)
    for i in (1, 2, 3):
        g += finger(i, True)
    # index curls left, thumb rises to meet it
    g += (f'<path d="M46 62 Q46 34 33 31" fill="none" stroke="{INK}" stroke-width="11" stroke-linecap="round"/>'
          f'<path d="M29 78 Q16 52 27 33" fill="none" stroke="{INK}" stroke-width="11" stroke-linecap="round"/>')
    if ring:
        g += f'<circle cx="30" cy="30" r="13" fill="none" stroke="{ACC}" stroke-width="4"/>'
    return g

POSES = {
    "palm":   hand([1,1,1,1], "out"),
    "fist":   hand([0,0,0,0], "tuck"),
    "turn_r": turn("r"),
    "turn_l": turn("l"),
    "pinch":  pinch(True),
    "pinch2": pinch(True) + f'<circle cx="30" cy="30" r="20" fill="none" stroke="{ACC}" stroke-width="3" opacity=".5"/>',
    "one":    hand([1,0,0,0]),
    "two":    hand([1,1,0,0]),
    "three":  hand([1,1,1,0]),
    "four":   hand([1,1,1,1]),
    "thumb_up":   hand([0,0,0,0], "up"),
    "thumb_down": hand([0,0,0,0], "down"),
}

def get(name, w=40):
    return svg(POSES[name], w=w, h=round(w*1.26))

if __name__ == "__main__":
    cells = "".join(
        f'<div class="c">{svg(v, w=96, h=121)}<b>{k}</b></div>' for k, v in POSES.items())
    open("fig/_preview.html", "w").write(
        '<html><head><meta charset="utf-8"><style>'
        'body{font:12px -apple-system,sans-serif;background:#fff;padding:24px;margin:0}'
        '.g{display:grid;grid-template-columns:repeat(6,1fr);gap:18px}'
        '.c{text-align:center;border:1px solid #eee;padding:10px}'
        '.c b{display:block;margin-top:6px;font-family:monospace;color:#888;font-size:10px}'
        '</style></head><body><div class="g">' + cells + '</div></body></html>')
    print("wrote fig/_preview.html")
