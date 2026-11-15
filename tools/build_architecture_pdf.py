"""Render docs/architecture.md to a PDF.

Deliberately a small, dependency-light converter rather than a full Markdown
engine: the document uses six constructs (headings, paragraphs, bullets, code
blocks, tables and rules) and the PDF only has to be readable and navigable.

    python tools/build_architecture_pdf.py

Writes docs/internal/architecture.pdf.
"""

from __future__ import annotations

import os
import re
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "docs", "architecture.md")
TARGET = os.path.join(ROOT, "docs", "internal", "architecture.pdf")

ACCENT = colors.HexColor("#5f7d2a")
INK = colors.HexColor("#141a16")
MUTED = colors.HexColor("#4b544d")
RULE = colors.HexColor("#c9d3c6")


def styles():
    base = getSampleStyleSheet()
    body = ParagraphStyle(
        "Body",
        parent=base["BodyText"],
        fontName="Helvetica",
        fontSize=9.4,
        leading=13.6,
        textColor=INK,
        alignment=TA_LEFT,
        spaceAfter=5,
    )
    return {
        "title": ParagraphStyle(
            "Title", parent=body, fontName="Helvetica-Bold", fontSize=22, leading=26,
            textColor=INK, spaceAfter=10,
        ),
        "subtitle": ParagraphStyle("Subtitle", parent=body, textColor=MUTED, fontSize=9.6),
        "h1": ParagraphStyle(
            "H1", parent=body, fontName="Helvetica-Bold", fontSize=15, leading=19,
            textColor=INK, spaceBefore=16, spaceAfter=7,
        ),
        "h2": ParagraphStyle(
            "H2", parent=body, fontName="Helvetica-Bold", fontSize=11.6, leading=15,
            textColor=ACCENT, spaceBefore=12, spaceAfter=5,
        ),
        "h3": ParagraphStyle(
            "H3", parent=body, fontName="Helvetica-Bold", fontSize=10, leading=13,
            textColor=INK, spaceBefore=9, spaceAfter=3,
        ),
        "body": body,
        "bullet": ParagraphStyle("Bullet", parent=body, leftIndent=10, spaceAfter=2),
        "code": ParagraphStyle(
            "Code", parent=body, fontName="Courier", fontSize=7.6, leading=9.6,
            textColor=colors.HexColor("#1d241c"), backColor=colors.HexColor("#f1f4ee"),
            borderPadding=5, spaceBefore=3, spaceAfter=8,
        ),
        "cell": ParagraphStyle("Cell", parent=body, fontSize=7.8, leading=10, spaceAfter=0),
        "cellHead": ParagraphStyle(
            "CellHead", parent=body, fontName="Helvetica-Bold", fontSize=7.8,
            leading=10, textColor=colors.white, spaceAfter=0,
        ),
    }


INLINE = [
    (re.compile(r"`([^`]+)`"), r'<font face="Courier" size="8">\1</font>'),
    (re.compile(r"\*\*([^*]+)\*\*"), r"<b>\1</b>"),
    (re.compile(r"(?<!\*)\*([^*]+)\*(?!\*)"), r"<i>\1</i>"),
    (re.compile(r"\[([^\]]+)\]\(([^)]+)\)"), r"\1"),
]


def inline(text: str) -> str:
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    for pattern, replacement in INLINE:
        text = pattern.sub(replacement, text)
    return text


def split_row(line: str):
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def build_table(rows, style, width):
    head = [Paragraph(inline(cell), style["cellHead"]) for cell in rows[0]]
    body = [[Paragraph(inline(cell), style["cell"]) for cell in row] for row in rows[1:]]
    columns = max(len(row) for row in rows)
    table = Table([head] + body, colWidths=[width / columns] * columns, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), ACCENT),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("GRID", (0, 0), (-1, -1), 0.4, RULE),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7f9f4")]),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    return table


def convert(markdown: str, style, width):
    story = []
    lines = markdown.splitlines()
    index = 0
    first_heading = True

    while index < len(lines):
        line = lines[index]

        if line.startswith("```"):
            index += 1
            block = []
            while index < len(lines) and not lines[index].startswith("```"):
                block.append(lines[index])
                index += 1
            index += 1
            story.append(Preformatted("\n".join(block), style["code"]))
            continue

        if line.startswith("|") and index + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|$", lines[index + 1].strip()):
            rows = [split_row(line)]
            index += 2
            while index < len(lines) and lines[index].startswith("|"):
                rows.append(split_row(lines[index]))
                index += 1
            story.append(Spacer(1, 3))
            story.append(build_table(rows, style, width))
            story.append(Spacer(1, 8))
            continue

        if line.startswith("# "):
            title = inline(line[2:].strip())
            story.append(Paragraph(title, style["title" if first_heading else "h1"]))
            if first_heading:
                story.append(
                    Paragraph(
                        "GREEN ROUTE · architecture and execution plan · generated from docs/architecture.md",
                        style["subtitle"],
                    )
                )
                first_heading = False
            else:
                story.append(PageBreak())
            index += 1
            continue

        if line.startswith("## "):
            story.append(Paragraph(inline(line[3:].strip()), style["h1"]))
            index += 1
            continue

        if line.startswith("### "):
            story.append(Paragraph(inline(line[4:].strip()), style["h2"]))
            index += 1
            continue

        if line.startswith("#### "):
            story.append(Paragraph(inline(line[5:].strip()), style["h3"]))
            index += 1
            continue

        if line.strip() == "---":
            story.append(Spacer(1, 6))
            story.append(
                Table([[""]], colWidths=[width], rowHeights=[0.6],
                      style=TableStyle([("BACKGROUND", (0, 0), (-1, -1), RULE)]))
            )
            story.append(Spacer(1, 8))
            index += 1
            continue

        if re.match(r"^\s*[-*]\s+", line):
            items = []
            while index < len(lines) and re.match(r"^\s*[-*]\s+", lines[index]):
                text = re.sub(r"^\s*[-*]\s+", "", lines[index])
                items.append(ListItem(Paragraph(inline(text), style["bullet"]), leftIndent=10))
                index += 1
            story.append(ListFlowable(items, bulletType="bullet", start="•", leftIndent=12))
            story.append(Spacer(1, 4))
            continue

        if re.match(r"^\s*\d+\.\s+", line):
            items = []
            while index < len(lines) and re.match(r"^\s*\d+\.\s+", lines[index]):
                text = re.sub(r"^\s*\d+\.\s+", "", lines[index])
                items.append(ListItem(Paragraph(inline(text), style["bullet"]), leftIndent=10))
                index += 1
            story.append(ListFlowable(items, bulletType="1", leftIndent=12))
            story.append(Spacer(1, 4))
            continue

        if line.strip():
            story.append(Paragraph(inline(line.strip()), style["body"]))
        index += 1

    return story


def footer(canvas, document):
    canvas.saveState()
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 12 * mm, "GREEN ROUTE — architecture")
    canvas.drawRightString(A4[0] - 18 * mm, 12 * mm, f"{document.page}")
    canvas.restoreState()


def main() -> int:
    if not os.path.exists(SOURCE):
        print(f"missing {SOURCE}", file=sys.stderr)
        return 1

    with open(SOURCE, encoding="utf-8") as handle:
        markdown = handle.read()

    style = styles()
    document = SimpleDocTemplate(
        TARGET,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=16 * mm,
        bottomMargin=18 * mm,
        title="GREEN ROUTE — architecture and execution plan",
        author="GREEN ROUTE",
    )
    width = document.width
    document.build(convert(markdown, style, width), onFirstPage=footer, onLaterPages=footer)
    size = os.path.getsize(TARGET)
    print(f"wrote {TARGET} ({size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
