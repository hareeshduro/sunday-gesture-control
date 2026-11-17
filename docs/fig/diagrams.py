"""Explanatory diagrams for the guide, as inline SVG."""
import math

INK, ACC, MUT, LINE, BG = "#1b1b1b", "#f59a23", "#8a8a8a", "#d8d8d8", "#f7f7f5"
MONO = 'ui-monospace, "SF Mono", Menlo, monospace'
SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif'

def txt(x, y, s, size=9, fill=INK, anchor="start", weight="400", font=SANS, ls=0):
    return (f'<text x="{x}" y="{y}" font-family=\'{font}\' font-size="{size}" fill="{fill}" '
            f'text-anchor="{anchor}" font-weight="{weight}" letter-spacing="{ls}">{s}</text>')

# ---------------------------------------------------------------- 1. the chain
def chain():
    w, h = 760, 150
    boxes = [
        ("01", "Your webcam", "30 pictures\na second"),
        ("02", "Hand tracker", "21 points\nper picture"),
        ("03", "Gesture brain", "is that a fist?\nhow far turned?"),
        ("04", "Home Assistant", "switches the\nreal bulb"),
    ]
    bw, gap = 160, 40
    s = [f'<svg viewBox="0 0 {w} {h}" width="100%" xmlns="http://www.w3.org/2000/svg">']
    for i, (n, title, sub) in enumerate(boxes):
        x = i * (bw + gap)
        fill = "#fff8ee" if i == 2 else BG
        stroke = ACC if i == 2 else LINE
        s.append(f'<rect x="{x}" y="26" width="{bw}" height="84" rx="3" fill="{fill}" stroke="{stroke}" stroke-width="1"/>')
        s.append(txt(x + 12, 46, n, 8, ACC if i == 2 else MUT, font=MONO, ls=1.6))
        s.append(txt(x + 12, 66, title, 12, INK, weight="600"))
        for j, line in enumerate(sub.split("\n")):
            s.append(txt(x + 12, 84 + j * 13, line, 9.5, MUT))
        if i < 3:
            ax = x + bw + 8
            s.append(f'<line x1="{ax}" y1="68" x2="{ax+gap-16}" y2="68" stroke="{MUT}" stroke-width="1.4"/>')
            s.append(f'<path d="M{ax+gap-22} 63 L{ax+gap-16} 68 L{ax+gap-22} 73" fill="none" stroke="{MUT}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>')
    s.append(txt(0, 136, "Everything left of Home Assistant happens inside your browser tab. Nothing is uploaded.", 9, MUT))
    s.append('</svg>')
    return "".join(s)

# ------------------------------------------------------- 2. the 21 landmarks
LM = {
 0:(50,122), 1:(33,110), 2:(23,96), 3:(16,84), 4:(10,73),
 5:(38,78), 6:(34,60), 7:(32,48), 8:(30,37),
 9:(50,74), 10:(50,54), 11:(50,41), 12:(50,28),
 13:(62,77), 14:(64,58), 15:(65,46), 16:(66,34),
 17:(73,84), 18:(78,69), 19:(80,59), 20:(82,48),
}
BONES = [[0,1,2,3,4],[0,5,6,7,8],[5,9,10,11,12],[9,13,14,15,16],[13,17,18,19,20],[0,17]]

def landmarks():
    S, OX, OY = 1.75, 34, 22
    def P(i):
        x, y = LM[i]; return (OX + x * S, OY + (y - 24) * S)
    s = [f'<svg viewBox="0 0 620 220" width="100%" xmlns="http://www.w3.org/2000/svg">']
    for ch in BONES:
        pts = " ".join(f"{P(i)[0]:.1f},{P(i)[1]:.1f}" for i in ch)
        s.append(f'<polyline points="{pts}" fill="none" stroke="{LINE}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>')
    for i in LM:
        x, y = P(i); tip = i in (4, 8, 12, 16, 20)
        s.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{6 if tip else 4.6}" fill="{ACC if tip else INK}"/>')
        s.append(txt(x + 9, y - 6, str(i), 9, MUT, font=MONO))
    bx = 300
    s.append(txt(bx, 36, "What the tracker gives us", 13, INK, weight="600"))
    s.append(f'<line x1="{bx}" y1="44" x2="604" y2="44" stroke="{INK}" stroke-width="1"/>')
    rows = [("21 points, every frame", "wrist, knuckles, joints and fingertips —\nabout thirty times a second"),
            ("Fingertips in orange", "landmarks 4, 8, 12, 16 and 20"),
            ("Angles, not positions", "the project measures joint angles and\ndistances, so a rotated or mirrored\nhand reads exactly the same")]
    y = 66
    for a, b in rows:
        s.append(txt(bx, y, a, 10.5, INK, weight="600"))
        for j, line in enumerate(b.split("\n")):
            s.append(txt(bx, y + 15 + j * 13, line, 9.5, MUT))
        y += 26 + 13 * len(b.split("\n"))
    s.append('</svg>')
    return "".join(s)

# ------------------------------------------------------ 3. the brightness dial
def dial():
    cx, cy, r = 152, 176, 104
    def pt(deg, rad):
        a = math.radians(deg - 90)
        return cx + rad * math.cos(a), cy + rad * math.sin(a)
    s = [f'<svg viewBox="0 0 620 220" width="100%" xmlns="http://www.w3.org/2000/svg">']
    x0, y0 = pt(-62, r); x1, y1 = pt(62, r)
    s.append(f'<path d="M{x0:.1f} {y0:.1f} A{r} {r} 0 0 1 {x1:.1f} {y1:.1f}" fill="none" stroke="{LINE}" stroke-width="13" stroke-linecap="round"/>')
    xa, ya = pt(5, r); xb, yb = pt(62, r)
    s.append(f'<path d="M{xa:.1f} {ya:.1f} A{r} {r} 0 0 1 {xb:.1f} {yb:.1f}" fill="none" stroke="{ACC}" stroke-width="13" stroke-linecap="round"/>')
    for d in (-5, 5):
        xi, yi = pt(d, r - 11); xo, yo = pt(d, r + 11)
        s.append(f'<line x1="{xi:.1f}" y1="{yi:.1f}" x2="{xo:.1f}" y2="{yo:.1f}" stroke="{INK}" stroke-width="2"/>')
    nx, ny = pt(38, r - 26)
    s.append(f'<line x1="{cx}" y1="{cy}" x2="{nx:.1f}" y2="{ny:.1f}" stroke="{INK}" stroke-width="4" stroke-linecap="round"/>')
    s.append(f'<circle cx="{cx}" cy="{cy}" r="7" fill="{INK}"/>')
    s.append(txt(cx, 48, "5\u00b0 of slack", 9.5, INK, anchor="middle", font=MONO))
    s.append(txt(cx, 62, "a steady hand holds its level", 9, MUT, anchor="middle"))
    s.append(txt(30, 150, "turn left", 10, INK, weight="600"))
    s.append(txt(30, 164, "dimmer", 9.5, MUT))
    s.append(txt(274, 150, "turn right", 10, INK, weight="600", anchor="end"))
    s.append(txt(274, 164, "brighter", 9.5, MUT, anchor="end"))
    s.append(txt(cx, 212, "The palm is the knob. Nothing moves until you turn it.", 9, MUT, anchor="middle"))
    bx, bw = 330, 274
    s.append(txt(bx, 36, "Turn past the slack", 10.5, INK, weight="600"))
    s.append(txt(bx + bw, 36, "Brightness moves", 10.5, INK, weight="600", anchor="end"))
    s.append(f'<line x1="{bx}" y1="44" x2="{bx+bw}" y2="44" stroke="{INK}" stroke-width="1"/>')
    for j, (a, b) in enumerate([("10\u00b0", "9%"), ("20\u00b0", "23%"), ("30\u00b0", "39%"), ("45\u00b0", "68%"), ("60\u00b0", "100%")]):
        y = 66 + j * 25
        s.append(txt(bx, y, a, 10.5, INK, font=MONO))
        s.append(txt(bx + bw, y, b, 10.5, ACC if j == 4 else INK, anchor="end", font=MONO))
        s.append(f'<line x1="{bx}" y1="{y+8}" x2="{bx+bw}" y2="{y+8}" stroke="#ececec" stroke-width="1"/>')
    s.append(txt(bx, 208, "Gentle at first, stronger the further you go.", 9, MUT))
    s.append('</svg>')
    return "".join(s)

# ------------------------------------------------------- 4. the four layers
def layers():
    rows = [("1", "See the hand", "camera on screen, skeleton drawn over it"),
            ("2", "Understand the hand", "fingers up? fist? how far has the wrist turned?"),
            ("3", "Make it steady", "4 of 5 frames must agree, pose must be held still"),
            ("4", "Connect real lights", "local server holds the token, talks to Home Assistant")]
    h = 34 * len(rows) + 10
    s = [f'<svg viewBox="0 0 600 {h}" width="100%" xmlns="http://www.w3.org/2000/svg">']
    for i, (n, a, b) in enumerate(rows):
        y = i * 34
        s.append(f'<rect x="0" y="{y}" width="600" height="28" rx="2" fill="{BG}"/>')
        s.append(f'<rect x="0" y="{y}" width="3" height="28" fill="{ACC}"/>')
        s.append(txt(14, y + 18.5, n, 9, ACC, font=MONO, weight="600"))
        s.append(txt(32, y + 18.5, a, 10, INK, weight="600"))
        s.append(txt(170, y + 18.5, b, 9.5, MUT))
        if i < len(rows) - 1:
            s.append(f'<path d="M8 {y+28} L8 {y+34}" stroke="{LINE}" stroke-width="1.2"/>')
    s.append('</svg>')
    return "".join(s)

# ------------------------------------------------------------ 5. the safe path
def tokenpath():
    s = [f'<svg viewBox="0 0 620 132" width="100%" xmlns="http://www.w3.org/2000/svg">']
    boxes = [(0, "Browser tab", "gestures only\nnever sees the token", BG, LINE),
             (218, "Local server", "holds the token\nin memory only", "#fff8ee", ACC),
             (436, "Home Assistant", "your bulbs", BG, LINE)]
    for x, title, sub, fill, stroke in boxes:
        s.append(f'<rect x="{x}" y="22" width="184" height="72" rx="3" fill="{fill}" stroke="{stroke}"/>')
        s.append(txt(x + 14, 44, title, 11, INK, weight="600"))
        for j, line in enumerate(sub.split("\n")):
            s.append(txt(x + 14, 62 + j * 13, line, 9, MUT))
    for x in (184, 402):
        s.append(f'<line x1="{x+4}" y1="58" x2="{x+28}" y2="58" stroke="{MUT}" stroke-width="1.4"/>')
        s.append(f'<path d="M{x+22} 53 L{x+28} 58 L{x+22} 63" fill="none" stroke="{MUT}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>')
    s.append(txt(188, 110, "only  turn_on · turn_off · toggle", 8.5, ACC, font=MONO))
    s.append(txt(188, 122, "and only on the lights you ticked", 8.5, MUT))
    s.append('</svg>')
    return "".join(s)

FIGS = {"chain": chain, "landmarks": landmarks, "dial": dial, "layers": layers, "tokenpath": tokenpath}

if __name__ == "__main__":
    body = "".join(f'<div class="f"><b>{k}</b>{v()}</div>' for k, v in FIGS.items())
    open("fig/_diag.html", "w").write(
        '<html><head><meta charset="utf-8"><style>body{font:12px sans-serif;padding:20px;background:#fff;margin:0}'
        '.f{margin-bottom:26px;max-width:720px}.f b{display:block;font-family:monospace;color:#aaa;font-size:10px;margin-bottom:6px}'
        '</style></head><body>' + body + '</body></html>')
    print("wrote fig/_diag.html")
