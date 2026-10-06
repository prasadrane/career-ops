#!/usr/bin/env python3
"""
tex-to-docx.py — Convert tailored LaTeX resume (.tex) to ATS-friendly DOCX.
Usage:
    python scripts/tex-to-docx.py <path_to_tex> [output_docx_path]
"""

import os
import sys
import re
import docx
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn

COLOR_PRIMARY = RGBColor(17, 24, 39)    # #111827 (Near-black)
COLOR_ACCENT = RGBColor(30, 58, 95)     # #1E3A5F (Dark navy)
COLOR_MUTED = RGBColor(55, 65, 81)      # #374151 (Dark gray)
COLOR_LINE = "9CA3AF"                   # Divider

def add_p_border_bottom(p, color_hex="9CA3AF", sz="6"):
    pPr = p._p.get_or_add_pPr()
    pBdr = parse_xml(f'<w:pBdr {nsdecls("w")}><w:bottom w:val="single" w:sz="{sz}" w:space="2" w:color="{color_hex}"/></w:pBdr>')
    pPr.append(pBdr)

def add_hyperlink(paragraph, url, text, color="1E3A5F", underline=True):
    part = paragraph.part
    r_id = part.relate_to(url, docx.opc.constants.RELATIONSHIP_TYPE.HYPERLINK, is_external=True)
    hyperlink = parse_xml(f'<w:hyperlink {nsdecls("w")} r:id="{r_id}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>')
    new_run = parse_xml(f'<w:r {nsdecls("w")}><w:rPr><w:color w:val="{color}"/><w:u w:val="{"single" if underline else "none"}"/></w:rPr><w:t>{text}</w:t></w:r>')
    hyperlink.append(new_run)
    paragraph._p.append(hyperlink)

def extract_braced_args(line):
    """Extracts top-level curly-brace arguments from a LaTeX macro line."""
    args = []
    i = 0
    while i < len(line):
        if line[i] == '{':
            depth = 1
            j = i + 1
            while j < len(line) and depth > 0:
                if line[j] == '{':
                    depth += 1
                elif line[j] == '}':
                    depth -= 1
                j += 1
            args.append(line[i+1:j-1])
            i = j
        else:
            i += 1
    return args

def parse_latex_formatting(text):
    """Parses text containing LaTeX macros like \\textbf{...}, \\#, \\%, --, --- and returns list of (chunk, is_bold)."""
    text = text.replace(r'\#', '#').replace(r'\%', '%').replace(r'\&', '&').replace('---', '—').replace('--', '–')
    tokens = []
    pattern = re.compile(r'\\textbf\{([^}]+)\}')
    last_idx = 0
    for m in pattern.finditer(text):
        if m.start() > last_idx:
            tokens.append((text[last_idx:m.start()], False))
        tokens.append((m.group(1), True))
        last_idx = m.end()
    if last_idx < len(text):
        tokens.append((text[last_idx:], False))
    return tokens


FONT_MAP = {"helvet": "Arial", "mathptmx": "Times New Roman", "lmodern": "Latin Modern Roman"}

def _num(pattern, text, default):
    m = re.search(pattern, text, re.S)
    return float(m.group(1)) if m else default

def parse_layout(content):
    """Read the visual layout from the .tex itself so the DOCX tracks the PDF
    (font family, margins, sizes, hanging skill-label width). Nothing is
    hardcoded to one template: the 2026-10-05 retrospective found the old
    converter pinned Arial/9.5pt while the .tex varied from 8.5 to 10.5pt."""
    parts = content.split(r'\begin{document}')
    pre = re.sub(r'(?m)^\s*%.*$', '', parts[0])  # commented-out packages must not count
    body_start = parts[1]
    pkg = re.search(r'\\usepackage(?:\[[^\]]*\])?\{(helvet|mathptmx|lmodern)\}', pre)
    g = lambda k: _num(k + r'=([\d.]+)in', pre, 0.5)
    return {
        "font": FONT_MAP.get(pkg.group(1), "Arial") if pkg else "Arial",
        "left": g("left"), "right": g("right"), "top": g("top"), "bottom": g("bottom"),
        "body": _num(r'before=\\fontsize\{([\d.]+)pt\}', pre, 10.0),
        "line": _num(r'before=\\fontsize\{[\d.]+pt\}\{([\d.]+)pt\}', pre, 13.0),
        "name": _num(r'fontsize\{([\d.]+)pt\}\{[\d.]+pt\}\\bfseries\\selectfont\s*PRASAD', body_start, 19.5),
        "title": _num(r'PRASAD RANE\}\\par\s*\\vspace\{[^}]*\}\s*\{\\fontsize\{([\d.]+)pt\}', body_start, 10.5),
        "contact": _num(r'\\color\{muted\}\\fontsize\{([\d.]+)pt\}', body_start, 10.0),
        "section": _num(r'newcommand\{\\resumesection\}.*?fontsize\{([\d.]+)pt\}', pre, 11.5),
        "role": _num(r'roleHeaderFontSize\}\{\\fontsize\{([\d.]+)pt\}', pre, 10.5),
        "edu": _num(r'educationHeaderFontSize\}\{\\fontsize\{([\d.]+)pt\}', pre, 10.5),
        "label_w": _num(r'makebox\[([\d.]+)in\]', pre, 1.15),
        "indent": _num(r'leftmargin=([\d.]+)pt', pre, 10.5),
    }

def convert_tex_to_docx(tex_file, docx_file):
    with open(tex_file, 'r', encoding='utf-8') as f:
        content = f.read()

    doc = docx.Document()
    
    L = parse_layout(content)
    for section in doc.sections:
        section.top_margin = Inches(L["top"])
        section.bottom_margin = Inches(L["bottom"])
        section.left_margin = Inches(L["left"])
        section.right_margin = Inches(L["right"])
        section.page_width = Inches(8.5)
        section.page_height = Inches(11.0)
    text_width = 8.5 - L["left"] - L["right"]

    # Base typography follows the .tex font package
    style = doc.styles['Normal']
    font = style.font
    font.name = L['font']
    style.element.rPr.rFonts.set(qn('w:eastAsia'), L['font'])
    font.size = Pt(L['body'])
    font.color.rgb = COLOR_PRIMARY

    # Parse Name & Title
    name_m = re.search(r'\\fontsize\{[\d.]+pt\}\{[\d.]+pt\}\\bfseries\\selectfont\s*(PRASAD[^}]*)\}', content)
    name = name_m.group(1).strip() if name_m else "PRASAD RANE"

    title_m = re.search(r'PRASAD RANE\}\\par\s*\\vspace\{[^}]*\}\s*\{\\fontsize\{[\d.]+pt\}\{[\d.]+pt\}\\bfseries\\selectfont\s*(.*?)\}\\par', content, re.DOTALL)
    raw_title = title_m.group(1).strip() if title_m else ""
    title = raw_title.replace(r'\textbar{}', '|').replace(r'\textbar', '|').replace(r'\&', '&').strip()

    p_name = doc.add_paragraph()
    p_name.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_name.paragraph_format.space_before = Pt(0)
    p_name.paragraph_format.space_after = Pt(1)
    r_name = p_name.add_run(name)
    r_name.font.size = Pt(L['name'])
    r_name.bold = True
    r_name.font.color.rgb = COLOR_PRIMARY

    if title:
        p_title = doc.add_paragraph()
        p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p_title.paragraph_format.space_before = Pt(0)
        p_title.paragraph_format.space_after = Pt(2)
        r_title = p_title.add_run(title)
        r_title.font.size = Pt(L['title'])
        r_title.bold = True
        r_title.font.color.rgb = COLOR_PRIMARY

    # Contact Line
    contact_m = re.search(r'\{\\color\{muted\}\\fontsize\{[\d.]+pt\}\{[\d.]+pt\}\\selectfont\s*(.*?)\\par\}', content, re.DOTALL)
    p_contact = doc.add_paragraph()
    p_contact.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_contact.paragraph_format.space_before = Pt(0)
    p_contact.paragraph_format.space_after = Pt(5)

    if contact_m:
        raw_contact = contact_m.group(1).strip()
        parts = re.split(r'\\sep\s*', raw_contact)
        for i, part in enumerate(parts):
            if i > 0:
                r_sep = p_contact.add_run("  |  ")
                r_sep.font.color.rgb = COLOR_MUTED
                r_sep.font.size = Pt(L['contact'])
            
            href_m = re.search(r'\\href\{([^}]+)\}\{([^}]+)\}', part)
            if href_m:
                url = href_m.group(1)
                label = href_m.group(2)
                add_hyperlink(p_contact, url, label, color="1E3A5F", underline=False)
            else:
                clean_text = part.replace(r'\&', '&').strip()
                r = p_contact.add_run(clean_text)
                r.font.size = Pt(L['contact'])
                r.font.color.rgb = COLOR_MUTED

    def add_section_header(sec_title):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(6)
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.line_spacing = 1.0
        r = p.add_run(sec_title.replace(r'\&', '&'))
        r.font.size = Pt(L['section'])
        r.bold = True
        r.font.color.rgb = COLOR_ACCENT
        add_p_border_bottom(p, color_hex=COLOR_LINE, sz="6")
        return p

    def add_bullet(text_runs):
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Pt(L['indent'])
        p.paragraph_format.first_line_indent = Pt(-L['indent'])
        p.paragraph_format.tab_stops.add_tab_stop(Pt(L['indent']))
        p.paragraph_format.space_before = Pt(1)
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.line_spacing = Pt(L['line'])
        r_b = p.add_run("•	")
        r_b.font.size = Pt(L['body'])
        r_b.font.color.rgb = COLOR_PRIMARY
        for t, b in text_runs:
            r = p.add_run(t)
            r.font.size = Pt(L['body'])
            r.font.color.rgb = COLOR_PRIMARY
            r.bold = b

    # Split into sections based on \resumesection{...}
    sections = re.split(r'\\resumesection\{([^}]+)\}', content)
    for i in range(1, len(sections), 2):
        sec_title = sections[i].strip()
        sec_body = sections[i+1].strip()

        add_section_header(sec_title)

        if "SUMMARY" in sec_title.upper():
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.space_after = Pt(4)
            p.paragraph_format.line_spacing = Pt(L['line'])
            clean_body = re.sub(r'\s+', ' ', sec_body)
            runs = parse_latex_formatting(clean_body)
            for t, b in runs:
                r = p.add_run(t)
                r.font.size = Pt(L['body'])
                r.font.color.rgb = COLOR_PRIMARY
                r.bold = b

        elif "SKILL" in sec_title.upper():
            for sm in re.finditer(r'\\skillrow\{([^}]+)\}\{([^}]+)\}', sec_body):
                lbl = sm.group(1).replace(r'\&', '&').strip()
                val = sm.group(2).replace(r'\#', '#').replace(r'\%', '%').replace(r'\&', '&').strip()
                p_sk = doc.add_paragraph()
                p_sk.paragraph_format.space_before = Pt(1)
                p_sk.paragraph_format.space_after = Pt(1)
                p_sk.paragraph_format.line_spacing = Pt(L['line'])
                p_sk.paragraph_format.left_indent = Inches(L['label_w'])
                p_sk.paragraph_format.first_line_indent = Inches(-L['label_w'])
                p_sk.paragraph_format.tab_stops.add_tab_stop(Inches(L['label_w']))
                r_lbl = p_sk.add_run(f"{lbl}	")
                r_lbl.bold = True
                r_lbl.font.size = Pt(L['body'])
                r_lbl.font.color.rgb = COLOR_PRIMARY
                r_val = p_sk.add_run(val)
                r_val.font.size = Pt(L['body'])
                r_val.font.color.rgb = COLOR_PRIMARY

        elif "EXPERIENCE" in sec_title.upper():
            # Parse lines and blocks
            lines = sec_body.split('\n')
            current_role_items = []
            
            for line in lines:
                line_str = line.strip()
                if line_str.startswith(r'\roleHeader'):
                    args = extract_braced_args(line_str)
                    if len(args) >= 4:
                        job_title = args[0].replace(r'\&', '&').strip()
                        comp = args[1].replace(r'\&', '&').strip()
                        loc = args[2].replace(r'\&', '&').strip()
                        dates = args[3].replace('--', '–').strip()

                        p = doc.add_paragraph()
                        p.paragraph_format.space_before = Pt(4)
                        p.paragraph_format.space_after = Pt(1)
                        r_c = p.add_run(comp)
                        r_c.bold = True
                        r_c.font.size = Pt(L['role'])
                        p.add_run("  |  ").font.color.rgb = COLOR_MUTED
                        r_t = p.add_run(job_title)
                        r_t.font.size = Pt(L['role'])
                        p.add_run("  |  ").font.color.rgb = COLOR_MUTED
                        r_l = p.add_run(loc)
                        r_l.font.size = Pt(L['role'])
                        r_l.font.color.rgb = COLOR_MUTED

                        p.paragraph_format.tab_stops.add_tab_stop(Inches(text_width), docx.enum.text.WD_TAB_ALIGNMENT.RIGHT)
                        p.add_run("\t")
                        r_d = p.add_run(dates)
                        r_d.font.size = Pt(L['role'])
                        r_d.font.color.rgb = COLOR_MUTED
                elif line_str.startswith(r'\item'):
                    raw_item = line_str[5:].strip()
                    # Clean trailing \end{itemize} or comments
                    raw_item = re.sub(r'\\end\{itemize\}.*', '', raw_item).strip()
                    runs = parse_latex_formatting(raw_item)
                    add_bullet(runs)

        elif "PROJECT" in sec_title.upper():
            lines = sec_body.split('\n')
            for line in lines:
                line_str = line.strip()
                if line_str.startswith(r'\projectHeader'):
                    args = extract_braced_args(line_str)
                    if len(args) >= 3:
                        p_name = args[0].replace(r'\&', '&').strip()
                        p_stack = args[1].replace(r'\#', '#').replace(r'\&', '&').strip()
                        p_url = args[2].strip()

                        p = doc.add_paragraph()
                        p.paragraph_format.space_before = Pt(3)
                        p.paragraph_format.space_after = Pt(1)
                        r_p = p.add_run(p_name)
                        r_p.bold = True
                        r_p.font.size = Pt(L['role'])
                        p.add_run("  |  ").font.color.rgb = COLOR_MUTED
                        p.add_run(p_stack).font.color.rgb = COLOR_MUTED

                        p.paragraph_format.tab_stops.add_tab_stop(Inches(text_width), docx.enum.text.WD_TAB_ALIGNMENT.RIGHT)
                        p.add_run("\t")
                        add_hyperlink(p, p_url, "GitHub", color="1E3A5F", underline=True)
                elif line_str.startswith(r'\item'):
                    raw_item = line_str[5:].strip()
                    raw_item = re.sub(r'\\end\{itemize\}.*', '', raw_item).strip()
                    runs = parse_latex_formatting(raw_item)
                    add_bullet(runs)

        elif "EDUCATION" in sec_title.upper():
            lines = sec_body.split('\n')
            for line in lines:
                line_str = line.strip()
                if line_str.startswith(r'\educationHeader'):
                    args = extract_braced_args(line_str)
                    if len(args) >= 4:
                        deg_raw = args[0].replace(r'\&', '&').strip()
                        sch = args[1].replace(r'\&', '&').strip()
                        loc = args[2].replace(r'\&', '&').strip()
                        dates = args[3].replace('--', '–').strip()

                        p = doc.add_paragraph()
                        p.paragraph_format.space_before = Pt(2)
                        p.paragraph_format.space_after = Pt(1)

                        deg_url_m = re.search(r'\\href\{([^}]+)\}\{([^}]+)\}', deg_raw)
                        if deg_url_m:
                            add_hyperlink(p, deg_url_m.group(1), deg_url_m.group(2), color="1E3A5F", underline=True)
                        else:
                            r_deg = p.add_run(deg_raw)
                            r_deg.bold = True
                            r_deg.font.size = Pt(L['edu'])

                        p.add_run("  |  ").font.color.rgb = COLOR_MUTED
                        r_sch = p.add_run(sch)
                        r_sch.bold = True
                        r_sch.font.color.rgb = COLOR_ACCENT
                        r_sch.font.size = Pt(L['edu'])

                        if loc:
                            p.add_run("  |  ").font.color.rgb = COLOR_MUTED
                            r_loc = p.add_run(loc)
                            r_loc.font.size = Pt(L['edu'])
                            r_loc.font.color.rgb = COLOR_MUTED

                        p.paragraph_format.tab_stops.add_tab_stop(Inches(text_width), docx.enum.text.WD_TAB_ALIGNMENT.RIGHT)
                        p.add_run("\t")
                        r_d = p.add_run(dates)
                        r_d.font.size = Pt(L['edu'])
                        r_d.font.color.rgb = COLOR_MUTED

    os.makedirs(os.path.dirname(docx_file) or '.', exist_ok=True)
    doc.save(docx_file)
    print(f"Generated DOCX: {docx_file}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scripts/tex-to-docx.py <tex_path> [docx_path]")
        sys.exit(1)
    tex_path = sys.argv[1]
    docx_path = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(tex_path)[0] + ".docx"
    convert_tex_to_docx(tex_path, docx_path)
