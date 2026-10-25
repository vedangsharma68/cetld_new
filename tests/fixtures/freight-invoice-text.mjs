// Transcription of the supplied IPS page for deterministic offline regression.
// The image remains the source of truth; this is not a live OCR/model fixture.
export const freightInvoiceText = `Tax Invoice
INTERNATIONAL PARCEL SERVICES
KHEVAN CONSULTANTS OPC PVT LTD
A/C Code: KHEVAN
Invoice No.: CR-25260643
Invoice Date: 31/03/2026
Date Range: 01/03/2026 TO 31/03/2026
HSN/SAC: 996812
SN AwbNo Date NetworkNo Destination Net Consignee D/S Pcs Weight Amount COVID Fuel G.Total
1 088820 24/03/2026 399927558758 ARGENTINA FEDEX NEUMATICOS DEVOTO NDox 1 2.200 3520.00 0.00 1513.60 5033.60
DEMAND
SURCHARGE 315.00 135.45 450.45
3835.00 0.00 1649.05 5484.05
BANK DETAILS
Non-Taxable: 0.00
Taxable: 5484.05
CGST@9%: 0.00
SGST@9%: 0.00
IGST@18%: 987.13
Rounded off: 0.18
Bill Amount (₹): 6471.00
For INTERNATIONAL PARCEL SERVICES`;

// Selectable PDF built from the transcription, not the original attachment.
// Helvetica lacks ₹, so the equivalent explicit INR code is used here.
export function freightInvoicePdf(text = freightInvoiceText) {
 const lines=text.replaceAll('₹','INR').split('\n');
 const stream='BT /F1 8 Tf 20 800 Td 14 TL\n'+lines.map(line=>'('+line.replace(/[\\()]/g,'\\$&')+') Tj T*').join('\n')+'\nET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets=[0];
 for(const [index,object] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;}
 const xref=Buffer.byteLength(pdf);
 pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('');
 return Buffer.from(pdf+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
