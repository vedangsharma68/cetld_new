import test from 'node:test';
import assert from 'node:assert/strict';
import {extractInvoice} from '../ai/extraction.mjs';

const extracted={
  invoiceNumber:{value:'INV-1048',confidence:.98},customerName:{value:'Arbor & Finch',confidence:.97},
  invoiceDate:{value:'2026-09-01',confidence:.96},dueDate:{value:null,confidence:0},
  subtotal:{value:100,confidence:.9},tax:{value:18,confidence:.9},total:{value:118,confidence:.99},
  outstandingAmount:{value:118,confidence:.9},currency:{value:'INR',confidence:.99},
  clientPhone:{value:null,confidence:0},clientEmail:{value:null,confidence:0},notes:{value:null,confidence:0},
  lineItems:{value:[],confidence:0},
};

async function inspectUpload(bytes,mimeType,fileName){let request;const provider={async generateStructured(options){request=options;return{data:options.validate(extracted),model:'test-model',usedFallback:false}}};const result=await extractInvoice({provider,bytes,mimeType,fileName});return{request,result}}

test('Assistant image upload reaches one structured multimodal extraction pass',async()=>{
  const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  const {request,result}=await inspectUpload(png,'image/png','invoice.png');
  assert.equal(request.messages[0].content[1].type,'image_url');
  assert.equal(result.invoiceNumber.value,'INV-1048');assert.equal(result.currency.value,'INR');
});

test('Assistant PDF upload uses Gemini native document content and preserves missing due date',async()=>{
  const {request,result}=await inspectUpload(Buffer.from('%PDF-1.7\ninvoice'),'application/pdf','invoice.pdf');
  assert.equal(request.messages[0].content[1].type,'file');
  assert.match(request.messages[0].content[1].file.file_data,/^data:application\/pdf;base64,/);
  assert.equal(result.dueDate.value,null);assert.ok(result.uncertainFields.includes('dueDate'));
});

