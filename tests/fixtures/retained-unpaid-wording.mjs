// Shared JS and native SQL contract cases for complete retained-review facts.
export const originalRetainedUnpaidInstruction='My business issued this invoice. The currency is USD. The PAID stamp is incorrect: no payment has been received, and the full USD 93.50 is still due. Save it as an unpaid draft with no customer messages or reminders.';
export const equivalentRetainedUnpaidInstruction='That paid stamp is wrong; I issued it, it is USD93.50 and nothing has been paid; keep reminders off';
export const retainedUnpaidWordingCases=[
 {name:'original',message:originalRetainedUnpaidInstruction,currency:'USD',total:93.5},
 {name:'contiguous currency and amount',message:equivalentRetainedUnpaidInstruction,currency:'USD',total:93.5},
 {name:'reordered separate currency and balance',message:'Nothing has been paid. The full balance of 93.50 is still due; the currency is USD; I have issued the invoice: the PAID watermark is false',currency:'USD',total:93.5},
 {name:'conjunctions without a save clause',message:'I issued it and it is unpaid and that PAID marking is wrong and the total is USD 93.50',currency:'USD',total:93.5},
 {name:'full balance with contiguous currency',message:'I issued this invoice; the PAID stamp is wrong; it is unpaid; the full USD93.5 still due; save this invoice as an unpaid draft',currency:'USD',total:93.5},
 {name:'ASCII whitespace and mixed case',message:'  I\tissued it.\r\nThe PAID STAMP is false: nothing has been paid; IT IS usd93.50.  ',currency:'USD',total:93.5},
 {name:'different total and currency',message:'The currency is EUR. We have issued it. The full balance of 118.25 is still due; nothing has been paid; this PAID stamp is false; keep reminders off',currency:'EUR',total:118.25},
 {name:'integer total and another currency',message:'Our business issued this invoice; the PAID marking is incorrect; this invoice is unpaid; the amount is CHF42',currency:'CHF',total:42}
];
const equivalent=equivalentRetainedUnpaidInstruction;
export const retainedUnpaidWordingNegatives=[
 ...['I did not issue it','I never issued it',"I didn't issue it",'Maybe I issued it','I probably issued it','I might have issued it','If I issued it','Someone issued it','The supplier issued it'].map(issuer=>equivalent.replace('I issued it',issuer)),
 ...['nothing has not been paid','something has been paid','payment has been received','nothing might have been paid','it is not unpaid','it is paid','it is already paid'].map(unpaid=>equivalent.replace('nothing has been paid',unpaid)),
 ...['That paid stamp is not wrong','That paid stamp is correct','Maybe that paid stamp is wrong','That paid stamp was wrong'].map(stamp=>equivalent.replace('That paid stamp is wrong',stamp)),
 ...['it is not USD93.50','it might be USD93.50','it is USD92.50','it is XYZ93.50','it is USD93.500','it is USD93.50.00','it is USD93,50','it is USD-93.50','it is USD93.50 or EUR93.50','it is USD93.50 plus USD10'].map(amount=>equivalent.replace('it is USD93.50',amount)),
 ...['We received USD 10.','We got a payment yesterday.','A deposit was collected.','I paid USD 10.','The customer sent USD 10.','We collected a deposit.','USD 10 was paid.','Payment has been received.','This invoice is paid.','Reverse the payment.','Refund the deposit.','Change the customer to Elsewhere.','The currency is EUR.','It is USD93.50.','I issued it.','The PAID stamp is wrong.','It is unpaid.','Save it now.','Keep reminders on.','Yes.'].map(extra=>equivalent+'. '+extra),
 equivalent.replace('I issued it, ',''),equivalent.replace('That paid stamp is wrong; ',''),equivalent.replace(' and nothing has been paid',''),
 equivalent.replace('it is USD93.50 and ',''),
 'I issued it; the PAID stamp is wrong; nothing has been paid; the full balance of 93.50 is still due',
 equivalent+'?',`"${equivalent}"`,`'${equivalent}'`,`The document says ${equivalent}`,
 equivalent.replace('USD93.50','ＵＳＤ９３.５０'),equivalent.replace('USD93.50','USD９３.５０'),
 '\u00a0'+equivalent,equivalent.replace('I issued it','I\u00a0issued it'),
 equivalent.replace('I issued it','I issued it tomorrow'),equivalent.replace('it is USD93.50','perhaps it is USD93.50'),
 Array.from({length:13},()=> 'keep reminders off').concat(equivalent).join('; ')
];
