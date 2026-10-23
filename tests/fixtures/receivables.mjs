export const receivablesLedger=[
  {invoice_number:'ISSUED-INR',status:'sent',currency:'INR',total_amount:'100.00',amount_paid:'99.00'},
  {invoice_number:'PARTIAL-USD',status:'overdue',currency:'USD',total_amount:'300.00',amount_paid:'44.94'},
  ...[['INR','20496.00'],['USD','545.02'],['AUD','4490.00']].map(([currency,total_amount])=>({invoice_number:`DRAFT-${currency}`,status:'draft',currency,total_amount,amount_paid:'0.00'})),
  ...['paid','cancelled','void'].map(status=>({invoice_number:`EXCLUDED-${status}`,status,currency:'INR',total_amount:'999.00',amount_paid:status==='paid'?'999.00':'0.00'})),
  {invoice_number:'DELETED',status:'sent',currency:'AUD',total_amount:'700.00',amount_paid:'0.00',deleted_at:'2026-10-23T00:00:00Z'},
  {invoice_number:'BILL',status:'sent',currency:'USD',total_amount:'800.00',amount_paid:'0.00',metadata:{invoice_direction:'payable'}},
].map((row,i)=>({id:String(i),due_date:'2026-10-01',metadata:{invoice_direction:'receivable'},...row}));
