"""Build "RazorCAD User Manual.pdf" from manual_source.md.

The source uses a small Markdown subset:
    # Chapter            (starts a new page, level 0 in the contents)
    ## Section           (level 1 in the contents)
    ### Subsection       (level 2 in the contents)
    paragraphs, **bold**, *italic*, `code`
    - bullet / "  - " nested bullet,  1. numbered item
    | table | rows |     (first row is the header; a |---| line follows it)
    > Tip: ...           (shaded note box; "> Note:" and "> Warning:" also work)
    {idx:term}           (adds "term" to the alphabetical index at that spot; not printed)
    Front matter between --- lines at the top: title, subtitle, version.

The Contents and the Index are generated with ReportLab's multi-pass build, so every page
number is correct and clickable. PDF bookmarks (the sidebar outline) are added too.

Usage:  python build_manual.py
"""
import datetime
import html
import os
import re
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, KeepTogether, NextPageTemplate, PageBreak,
                                PageTemplate, Paragraph, Preformatted, Spacer, Table, TableStyle)
from reportlab.platypus.flowables import Flowable
from reportlab.platypus.tableofcontents import SimpleIndex, TableOfContents

HERE = Path(__file__).resolve().parent
SRC = HERE / "manual_source.md"
OUT = HERE / "RazorCAD User Manual.pdf"
PROJECT = HERE.parent

ACCENT = colors.HexColor("#1f5fa8")
DARK = colors.HexColor("#1d2733")
MUTED = colors.HexColor("#5b6773")
RULE = colors.HexColor("#c9d3de")
SHADE = colors.HexColor("#eef3f9")
TIP = {"tip": ("#e8f4ea", "#2e7d3a"), "note": ("#eef3f9", "#1f5fa8"), "warning": ("#fdf0e6", "#b35c00")}

# ------------------------------------------------------------------ fonts
# Segoe UI (with Segoe UI Symbol for arrows, ticks and the like) and Consolas from Windows; the
# built-in PDF fonts are the fallback, with symbols they lack replaced by plain characters.
FONT_DIR = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
F = {"sans": "Helvetica", "bold": "Helvetica-Bold", "mono": "Courier", "monob": "Courier-Bold", "sym": None}
MAIN_CMAP = set()
SYM_CMAP = set()
try:
    for name, file in [("PSans", "segoeui.ttf"), ("PSans-Bold", "segoeuib.ttf"), ("PSans-Italic", "segoeuii.ttf"),
                       ("PSans-BoldItalic", "segoeuiz.ttf"), ("PMono", "consola.ttf"), ("PMono-Bold", "consolab.ttf"),
                       ("PSym", "seguisym.ttf")]:
        pdfmetrics.registerFont(TTFont(name, str(FONT_DIR / file)))
    pdfmetrics.registerFontFamily("PSans", normal="PSans", bold="PSans-Bold", italic="PSans-Italic", boldItalic="PSans-BoldItalic")
    pdfmetrics.registerFontFamily("PMono", normal="PMono", bold="PMono-Bold", italic="PMono", boldItalic="PMono-Bold")
    F = {"sans": "PSans", "bold": "PSans-Bold", "mono": "PMono", "monob": "PMono-Bold", "sym": "PSym"}
    MAIN_CMAP = set(pdfmetrics.getFont("PSans").face.charToGlyph)
    SYM_CMAP = set(pdfmetrics.getFont("PSym").face.charToGlyph)
except Exception as e:  # fonts missing: fall back to the standard PDF fonts
    print(f"Note: Windows fonts not available ({e}); using built-in PDF fonts.")

ASCII_FALLBACK = {"▸": ">", "✔": "OK", "✕": "x", "⇉": "=>", "⇲": "->", "←": "<-", "→": "->", "−": "-", "Δ": "d", "✓": "OK"}


def symbols(text):
    """Draw characters the main font lacks with the symbol font (or a plain stand-in)."""
    out = []
    for ch in text:
        if ord(ch) < 128 or ord(ch) in MAIN_CMAP:
            out.append(ch)
        elif F["sym"] and ord(ch) in SYM_CMAP:
            out.append(f'<font name="{F["sym"]}">{ch}</font>')
        elif not MAIN_CMAP:
            out.append(ASCII_FALLBACK.get(ch, ch))
        else:
            out.append(ch)
    return "".join(out)


# ------------------------------------------------------------------ styles
BASE = dict(fontName=F["sans"], fontSize=10, leading=14, textColor=DARK)
S = {
    "body": ParagraphStyle("body", **BASE, spaceAfter=6),
    "bullet": ParagraphStyle("bullet", **BASE, leftIndent=14, bulletIndent=4, spaceAfter=3),
    "bullet2": ParagraphStyle("bullet2", **BASE, leftIndent=28, bulletIndent=18, spaceAfter=2),
    "cell": ParagraphStyle("cell", fontName=F["sans"], fontSize=9, leading=12, textColor=DARK),
    "cellh": ParagraphStyle("cellh", fontName=F["bold"], fontSize=9, leading=12, textColor=colors.white),
    "h1": ParagraphStyle("h1", fontName=F["bold"], fontSize=22, leading=27, textColor=ACCENT, spaceAfter=14),
    "h2": ParagraphStyle("h2", fontName=F["bold"], fontSize=14, leading=18, textColor=DARK, spaceBefore=12, spaceAfter=6),
    "h3": ParagraphStyle("h3", fontName=F["bold"], fontSize=11.5, leading=15, textColor=ACCENT, spaceBefore=8, spaceAfter=4),
    "title": ParagraphStyle("title", fontName=F["bold"], fontSize=34, leading=40, textColor=ACCENT, alignment=TA_CENTER),
    "subtitle": ParagraphStyle("subtitle", fontName=F["sans"], fontSize=15, leading=20, textColor=MUTED, alignment=TA_CENTER),
    "center": ParagraphStyle("center", **{**BASE, "textColor": MUTED}, alignment=TA_CENTER),
    "code": ParagraphStyle("code", fontName=F["mono"], fontSize=8.5, leading=11, textColor=DARK),
    "marker": ParagraphStyle("marker", fontName=F["sans"], fontSize=1, leading=0.1, spaceAfter=0, spaceBefore=0),
    "tochead": ParagraphStyle("tochead", fontName=F["bold"], fontSize=22, leading=27, textColor=ACCENT, spaceAfter=14),
}
TOC_LEVELS = [
    ParagraphStyle("toc0", fontName=F["bold"], fontSize=11, leading=15, leftIndent=0, firstLineIndent=0, spaceBefore=6, textColor=DARK),
    ParagraphStyle("toc1", fontName=F["sans"], fontSize=9.5, leading=12.5, leftIndent=16, firstLineIndent=0, textColor=DARK),
    ParagraphStyle("toc2", fontName=F["sans"], fontSize=8.5, leading=11, leftIndent=32, firstLineIndent=0, textColor=MUTED),
]


# ------------------------------------------------------------------ inline markup
def inline(text):
    """Markdown inline -> ReportLab paragraph markup. {idx:term} -> index tags."""
    idx_terms = re.findall(r"\{idx:([^}]+)\}", text)
    text = re.sub(r"\{idx:[^}]+\}", "", text)
    text = html.escape(text, quote=False)
    text = re.sub(r"`([^`]+)`", rf'<font name="{F["mono"]}" color="#8a2b06">\1</font>', text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<i>\1</i>", text)
    text = re.sub(r"\[\[([^\]]+)\]\]", rf'<font name="{F["monob"]}" color="#1d2733">\1</font>', text)
    text = symbols(text)
    for t in idx_terms:
        t = t.strip()
        if "." not in t:  # "sweep" and "Sweep" are one entry; file names keep their case
            t = t[:1].upper() + t[1:]
        text = f'<index item="{html.escape(t, quote=True)}"/>' + text
    return text


class Anchor(Flowable):
    """Zero-size flowable that registers a heading for the contents, bookmarks and index."""

    def __init__(self, level, title, key):
        super().__init__()
        self.level, self.title, self.key = level, title, key
        self.width = self.height = 0

    def wrap(self, *_):
        return 0, 0

    def draw(self):
        c = self.canv
        c.bookmarkPage(self.key)
        c.addOutlineEntry(self.title, self.key, level=self.level, closed=self.level > 0)
        self._doctemplateAttr("notify")("TOCEntry", (self.level, self.title, c.getPageNumber(), self.key))


class ManualDoc(BaseDocTemplate):
    def __init__(self, path, meta, **kw):
        super().__init__(str(path), pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm,
                         topMargin=22 * mm, bottomMargin=20 * mm, title=meta.get("title", "RazorCAD User Manual"),
                         author="RazorCAD", subject="User manual", **kw)
        self.meta = meta
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="f")
        self.addPageTemplates([
            PageTemplate(id="cover", frames=[frame], onPage=self._cover),
            PageTemplate(id="body", frames=[frame], onPageEnd=self._decorate),
            PageTemplate(id="index", onPageEnd=self._decorate, frames=[
                Frame(self.leftMargin, self.bottomMargin, self.width / 2 - 5 * mm, self.height, id="c1"),
                Frame(self.leftMargin + self.width / 2 + 5 * mm, self.bottomMargin, self.width / 2 - 5 * mm, self.height, id="c2")]),
        ])
        self.chapter = ""

    def beforeDocument(self):
        self.chapter = ""

    def afterFlowable(self, f):
        if isinstance(f, Anchor) and f.level == 0:
            self.chapter = f.title
        elif isinstance(f, TocAnchor):
            self.chapter = "Contents"

    def _cover(self, c, d):
        c.saveState()
        c.setFillColor(ACCENT)
        c.rect(0, A4[1] - 18 * mm, A4[0], 18 * mm, stroke=0, fill=1)
        c.rect(0, 0, A4[0], 10 * mm, stroke=0, fill=1)
        c.restoreState()

    def _decorate(self, c, d):
        c.saveState()
        w, h = A4
        c.setStrokeColor(RULE)
        c.setLineWidth(0.6)
        c.line(self.leftMargin, h - 15 * mm, w - self.rightMargin, h - 15 * mm)
        c.line(self.leftMargin, 13 * mm, w - self.rightMargin, 13 * mm)
        c.setFont(F["sans"], 8)
        c.setFillColor(MUTED)
        c.drawString(self.leftMargin, h - 13 * mm, f"RazorCAD User Manual  ·  v{self.meta.get('version', '')}")
        c.drawRightString(w - self.rightMargin, h - 13 * mm, self.chapter)
        c.drawString(self.leftMargin, 9 * mm, f"Manual revision {self.meta.get('revision', '')}")
        c.linkRect("", "contents", (w / 2 - 25 * mm, 6 * mm, w / 2 + 25 * mm, 12 * mm), relative=0, thickness=0)
        c.drawCentredString(w / 2, 9 * mm, "Back to Contents")
        c.setFont(F["bold"], 9)
        c.setFillColor(DARK)
        c.drawRightString(w - self.rightMargin, 9 * mm, f"Page {c.getPageNumber()}")
        c.restoreState()


class TocAnchor(Flowable):
    def wrap(self, *_):
        return 0, 0

    def draw(self):
        self.canv.bookmarkPage("contents")
        self.canv.addOutlineEntry("Contents", "contents", level=0)


# ------------------------------------------------------------------ parser
def parse_front_matter(lines):
    meta = {}
    if lines and lines[0].strip() == "---":
        end = lines.index("---", 1) if "---" in lines[1:] else -1
        for ln in lines[1:end]:
            if ":" in ln:
                k, v = ln.split(":", 1)
                meta[k.strip()] = v.strip()
        lines = lines[end + 1:]
    return meta, lines


def make_table(rows):
    data = [[Paragraph(inline(c), S["cellh"] if i == 0 else S["cell"]) for c in r] for i, r in enumerate(rows)]
    ncol = max(len(r) for r in rows)
    for r in data:
        r += [""] * (ncol - len(r))
    avail = A4[0] - 40 * mm
    # width by content length, within limits
    lens = [max(len(rows[i][j]) if j < len(rows[i]) else 0 for i in range(len(rows))) for j in range(ncol)]
    lens = [min(max(l, 8), 70) for l in lens]
    tot = sum(lens)
    widths = [avail * l / tot for l in lens]
    t = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), ACCENT),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, SHADE]),
        ("GRID", (0, 0), (-1, -1), 0.4, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


def make_code(lines):
    t = Table([[Preformatted("\n".join(lines), S["code"])]], colWidths=[A4[0] - 40 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f4f6f8")),
        ("BOX", (0, 0), (-1, -1), 0.4, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return KeepTogether([t, Spacer(1, 8)])


def make_callout(kind, text):
    bg, fg = TIP[kind]
    label = {"tip": "Tip", "note": "Note", "warning": "Warning"}[kind]
    p = Paragraph(f'<font color="{fg}"><b>{label}:</b></font> ' + inline(text), S["body"])
    t = Table([[p]], colWidths=[A4[0] - 40 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(bg)),
        ("LINEBEFORE", (0, 0), (0, -1), 3, colors.HexColor(fg)),
        ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ]))
    return [t, Spacer(1, 6)]


def parse_body(lines):
    story, para, rows, n_head = [], [], [], [0, 0, 0]
    num = chapter_no = 0
    appendix = False

    def flush_para():
        if para:
            story.append(Paragraph(inline(" ".join(para)), S["body"]))
            para.clear()

    def flush_table():
        if rows:
            story.append(make_table(rows))
            story.append(Spacer(1, 8))
            rows.clear()

    code = None
    for raw in lines:
        line = raw.rstrip()
        s = line.strip()
        if s.startswith("```"):
            flush_para(); flush_table()
            if code is None:
                code = []
            else:
                story.append(make_code(code))
                code = None
            continue
        if code is not None:
            code.append(line)
            continue
        if re.fullmatch(r"(\{idx:[^}]+\}\s*)+", s):
            # index markers on their own line: register them without taking up space
            flush_para(); flush_table()
            story.append(Paragraph(inline(s) or " ", S["marker"]))
            continue
        if s.startswith("|"):
            flush_para()
            cells = [c.strip() for c in s.strip("|").split("|")]
            if all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                continue
            rows.append(cells)
            continue
        flush_table()
        if not s:
            flush_para(); num = 0
            continue
        m = re.match(r"^(#{1,3})\s+(.*)$", s)
        if m:
            flush_para()
            level = len(m.group(1)) - 1
            title = m.group(2).strip()
            n_head[level] += 1
            for k in range(level + 1, 3):
                n_head[k] = 0
            if level == 0:
                appendix = title.lower().startswith("appendix")
                if not appendix:
                    chapter_no += 1
            if appendix:
                number = ""
            elif level == 0:
                number = str(chapter_no)
            else:
                number = ".".join([str(chapter_no)] + [str(n) for n in n_head[1: level + 1]])
            label = f"{number}  {title}" if number else title
            key = "h" + "-".join(str(n) for n in n_head[: level + 1])
            style = S[f"h{level + 1}"]
            if level == 0:
                story.append(PageBreak())
            flow = [Anchor(level, label, key), Paragraph(inline(label), style)]
            story.append(KeepTogether(flow) if level else flow[0])
            if level == 0:
                story.append(flow[1])
            continue
        m = re.match(r"^>\s*(Tip|Note|Warning):\s*(.*)$", s, re.I)
        if m:
            flush_para()
            story += make_callout(m.group(1).lower(), m.group(2))
            continue
        m = re.match(r"^(\s*)[-*]\s+(.*)$", line)
        if m:
            flush_para()
            st = S["bullet2"] if len(m.group(1)) >= 2 else S["bullet"]
            story.append(Paragraph(inline(m.group(2)), st, bulletText="•" if st is S["bullet"] else "–"))
            continue
        m = re.match(r"^\s*(\d+)[.)]\s+(.*)$", line)
        if m:
            flush_para()
            num += 1
            story.append(Paragraph(inline(m.group(2)), S["bullet"], bulletText=f"{num}."))
            continue
        para.append(s)
    flush_para(); flush_table()
    return story


def build():
    lines = SRC.read_text(encoding="utf-8").splitlines()
    meta, body = parse_front_matter(lines)
    version_file = PROJECT / "version.txt"
    if version_file.exists():
        meta["version"] = version_file.read_text(encoding="utf-8").strip()
    meta.setdefault("revision", datetime.date.today().isoformat())

    doc = ManualDoc(OUT, meta)
    story = [
        Spacer(1, 70 * mm),
        Paragraph(meta.get("title", "RazorCAD User Manual"), S["title"]),
        Spacer(1, 8 * mm),
        Paragraph(meta.get("subtitle", ""), S["subtitle"]),
        Spacer(1, 30 * mm),
        Paragraph(f"Software version {meta.get('version', '')}", S["center"]),
        Paragraph(f"Manual revision {meta['revision']}", S["center"]),
        Spacer(1, 8 * mm),
        Paragraph("Click any entry in the Contents or the Index to jump to it. "
                  "Every page has a <b>Back to Contents</b> link in its footer.", S["center"]),
        NextPageTemplate("body"),
        PageBreak(),
        TocAnchor(),
        Paragraph("Contents", S["tochead"]),
    ]
    toc = TableOfContents(levelStyles=TOC_LEVELS, dotsMinLevel=0)
    story.append(toc)
    story += parse_body(body)

    index = SimpleIndex(dot=" . ", headers=True, name="index")
    index_style = ParagraphStyle("idx", fontName=F["sans"], fontSize=8.5, leading=11, textColor=DARK)
    index.setup(style=index_style, dot=" . ", headers=True)
    story += [NextPageTemplate("index"), PageBreak(), Anchor(0, "Index", "index-page"), Paragraph("Index", S["h1"]),
              Paragraph("Page numbers are links: click one to go to that page.", S["body"]), index]

    doc.multiBuild(story, canvasmaker=index.getCanvasMaker())
    print(f"Wrote {OUT} ({doc.page} pages)")


if __name__ == "__main__":
    try:
        build()
    except PermissionError:
        sys.exit(f"Could not write {OUT.name}: close it in your PDF viewer and run again.")
