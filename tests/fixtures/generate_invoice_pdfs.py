"""Generate small, valid invoice PDFs for local extraction contract tests."""

from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


ROOT = Path(__file__).parent
CASES = {
    "receivable_missing_due.pdf": [
        "TAX INVOICE INV-R-1048", "From: Cedar Studio", "Bill To: Northlake Foods",
        "Invoice Date: 2026-09-01", "Subtotal: INR 100.00", "GST: INR 18.00",
        "Total Due: INR 118.00", "Pay Cedar Studio: INR 118.00",
    ],
    "payable.pdf": [
        "SUPPLIER INVOICE INV-P-2048", "From: Paper Works Ltd", "Bill To: Cedar Studio",
        "Invoice Date: 2026-09-01", "Due Date: 2026-10-01",
        "Subtotal: INR 100.00", "GST: INR 18.00", "Amount Cedar Studio Owes: INR 118.00",
    ],
    "uncertain_direction.pdf": [
        "INVOICE INV-U-3048", "From: Unknown Supplier", "To: Unknown Buyer",
        "Invoice Date: 2026-09-01", "Due Date: 2026-10-01",
        "Total: INR 118.00", "Account ownership is not identified on this document.",
    ],
    "zero_total.pdf": [
        "TAX INVOICE INV-Z-4048", "From: Cedar Studio", "Bill To: Northlake Foods",
        "Invoice Date: 2026-09-01", "Due Date: 2026-10-01",
        "Subtotal: INR 0.00", "GST: INR 0.00", "Total Due: INR 0.00",
    ],
    "rounding_adjustment.pdf": [
        "TAX INVOICE INV-A-5048", "From: Cedar Studio", "Bill To: Northlake Foods",
        "Invoice Date: 2026-09-01", "Due Date: 2026-10-01",
        "Subtotal: INR 100.00", "GST: INR 17.99", "Rounding adjustment: INR 0.01",
        "Total Due: INR 118.00", "Pay Cedar Studio: INR 118.00",
    ],
}


for name, lines in CASES.items():
    pdf = canvas.Canvas(str(ROOT / name), pagesize=A4, pageCompression=0)
    pdf.setTitle(name.removesuffix(".pdf"))
    text = pdf.beginText(72, 770)
    text.setFont("Helvetica", 12)
    for line in lines:
        text.textLine(line)
    pdf.drawText(text)
    pdf.showPage()
    pdf.save()
