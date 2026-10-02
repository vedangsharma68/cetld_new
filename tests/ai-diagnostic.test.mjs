import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {classifyDiagnosticError,createGeminiDiagnostic,diagnosticFixture,diagnosticRequests,validDiagnosticFixture,validateDiagnosticPng} from '../ai/diagnostic.mjs';
import {INVOICE_EXTRACTION_MAX_TOKENS, invoiceExtractionPrompt, invoiceExtractionResponseSchema} from '../ai/extraction.mjs';
import {createAIHandler} from '../ai/routes.mjs';

const USER='10000000-0000-4000-8000-000000000001', WORKSPACE='20000000-0000-4000-8000-000000000002';
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const generated=text=>response({candidates:[{content:{parts:[{text}]},finishReason:'STOP'}]});
function invoiceOutput(){return JSON.stringify({invoiceNumber:null,invoiceNumberConfidence:0,customerName:null,customerNameConfidence:0,invoiceDate:null,invoiceDateConfidence:0,dueDate:null,dueDateConfidence:0,subtotal:null,subtotalConfidence:0,tax:null,taxConfidence:0,total:null,totalConfidence:0,outstandingAmount:null,outstandingAmountConfidence:0,currency:null,currencyConfidence:0,clientPhone:null,clientPhoneConfidence:0,clientPhoneRaw:null,clientPhoneRawConfidence:0,clientEmail:null,clientEmailConfidence:0,notes:null,notesConfidence:0,direction:'uncertain',directionConfidence:0,lineItems:[],lineItemsConfidence:0})}
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}return(crc^0xffffffff)>>>0}

test('fixed PNG passes CRC/inflate validation and independently decodes as 192x96 RGB',async()=>{
  assert.equal(validDiagnosticFixture(),true);
  assert.deepEqual(Object.keys(diagnosticFixture()).sort(),['data','mimeType']);
  assert.equal(diagnosticFixture().mimeType,'image/png');
  const bytes=Buffer.from(diagnosticFixture().data,'base64');
  const {data,info}=await sharp(bytes).raw().toBuffer({resolveWithObject:true});
  assert.deepEqual({width:info.width,height:info.height,channels:info.channels},{width:192,height:96,channels:3});
  assert.equal(data.length,192*96*3);
});

test('PNG validation rejects a corrupt IDAT despite a valid signature and IEND',()=>{
  const corrupt=Buffer.from(diagnosticFixture().data,'base64');
  let offset=8;
  while (corrupt.subarray(offset+4,offset+8).toString('ascii')!=='IDAT') offset+=12+corrupt.readUInt32BE(offset);
  corrupt[offset+8]^=1;
  assert.equal(corrupt.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),true);
  assert.equal(corrupt.subarray(-8,-4).toString('ascii'),'IEND');
  assert.equal(validateDiagnosticPng(corrupt),false);

  const badStream=Buffer.from(diagnosticFixture().data,'base64');
  const length=badStream.readUInt32BE(offset);
  badStream[offset+8+length-1]^=1;
  badStream.writeUInt32BE(crc32(badStream.subarray(offset+4,offset+8+length)),offset+8+length);
  assert.equal(validateDiagnosticPng(badStream),false);
});

test('every native Gemini request is bounded, ordered, and immutable in purpose',()=>{
  const requests=diagnosticRequests();
  assert.deepEqual(requests.map(x=>x.name),['text','structured','image','invoice_schema']);
  assert.deepEqual(requests[2].payload.contents[0].parts[1],{inlineData:diagnosticFixture()});
  assert.equal(requests[3].payload.generationConfig.responseJsonSchema,invoiceExtractionResponseSchema);
  assert.equal(requests[3].payload.contents[0].parts[0].text,invoiceExtractionPrompt(''));
  assert.equal(requests[3].payload.generationConfig.maxOutputTokens,INVOICE_EXTRACTION_MAX_TOKENS);
  assert.ok(requests.every(x=>x.payload.generationConfig.maxOutputTokens<=INVOICE_EXTRACTION_MAX_TOKENS));
});

test('sequential probe succeeds without fallback and distinguishes local contract validation',async()=>{
  let active=0,maxActive=0,calls=0;
  const run=createGeminiDiagnostic({fetchImpl:async(url,init)=>{active++;maxActive=Math.max(maxActive,active);calls++;assert.match(url,/gemini-3\.5-flash-lite:generateContent$/);assert.ok(init.headers['x-goog-api-key']);assert.doesNotMatch(url,/key=/);assert.equal(init.redirect,'error');active--;return generated(calls===2?'{"answer":"OK"}':calls===4?invoiceOutput():'OK')}});
  const result=await run({userId:USER,role:'owner',apiKey:'server-secret'});
  assert.equal(maxActive,1);assert.deepEqual(result.stages.map(x=>x.status),['success','success','success','success']);
  const invalid=createGeminiDiagnostic({fetchImpl:async()=>generated('{}')});
  const invalidResult=await invalid({userId:USER,role:'admin',apiKey:'key'});
  assert.equal(invalidResult.stages.at(-1).status,'contract_invalid');
  assert.equal(invalidResult.stages.at(-1).httpStatus,200);
});

test('an image 400 cannot hide a successful simple schema result or prevent the invoice probe',async()=>{
  let calls=0;
  const run=createGeminiDiagnostic({fetchImpl:async()=>{
    calls++;
    if (calls===2) return generated('{"answer":"OK"}');
    if (calls===3) return response({error:{status:'INVALID_ARGUMENT',message:'unclassified image rejection'}},400);
    return generated(calls===4?invoiceOutput():'OK');
  }});
  const result=await run({userId:USER,role:'owner',apiKey:'key'});
  assert.equal(calls,4);
  assert.deepEqual(result.stages.map(x=>[x.stage,x.status,x.httpStatus]),[
    ['text','success',200],['structured','success',200],['image','http_rejected',400],['invoice_schema','success',200],
  ]);
});

test('HTTP failure report is finite-only despite adversarial provider text',async()=>{
  const secret='LEAK_ME_NEVER';
  const body={error:{message:`schema rejected ${secret} https://evil.invalid raw payload`,status:'INVALID_ARGUMENT',details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'API_KEY_SERVICE_BLOCKED',domain:'googleapis.com',metadata:{secret}},{'@type':'type.googleapis.com/google.rpc.BadRequest',fieldViolations:[{field:'generationConfig.responseJsonSchema',description:secret},{field:'private.secret',description:secret}]}]}};
  const run=createGeminiDiagnostic({fetchImpl:async()=>response(body,400)});
  const result=await run({userId:USER,role:'owner',apiKey:'key'}), serialized=JSON.stringify(result);
  assert.equal(result.stages[0].status,'http_rejected');assert.equal(result.stages[0].category,'key_restricted');
  assert.deepEqual(result.stages[0].fieldPaths,['generationConfig.responseJsonSchema']);
  assert.doesNotMatch(serialized,/LEAK|evil|raw payload|description|private\.secret/);
});

test('structured ErrorInfo and bounded transient classifications map to finite categories',()=>{
  assert.equal(classifyDiagnosticError({error:{message:'API key not valid'}},400).category,'invalid_api_key');
  assert.equal(classifyDiagnosticError({error:{message:'maxOutputTokens exceeds output token limit'}},400).category,'output_token_limit');
  assert.equal(classifyDiagnosticError({error:{message:'bad inlineData base64'}},400).category,'malformed_inline_data');
  assert.equal(classifyDiagnosticError({error:{message:'totally novel '+('x'.repeat(5000))}},418).category,'unknown');
});

test('authorization, per-user cooldown, total deadline, and no-write route behavior',async()=>{
  let calls=0;
  const runner=createGeminiDiagnostic({fetchImpl:async()=>{calls++;return generated('OK')}});
  assert.equal((await runner({userId:USER,role:'member',apiKey:'key'})).error,'DIAGNOSTIC_ADMIN_REQUIRED');assert.equal(calls,0);
  await runner({userId:USER,role:'owner',apiKey:'key'});
  assert.equal((await runner({userId:USER,role:'owner',apiKey:'key'})).error,'DIAGNOSTIC_COOLDOWN');

  let tick=0;
  const deadline=createGeminiDiagnostic({now:()=>tick++?46_000:0,fetchImpl:async()=>generated('OK')});
  const expired=await deadline({userId:'other',role:'admin',apiKey:'key'});
  assert.deepEqual(expired.stages.map(x=>x.status),['not_run','not_run','not_run','not_run']);assert.equal(expired.stages[0].category,'timeout');

  let invoked=0;
  const handler=createAIHandler({authorize:async()=>({userId:USER,workspaceId:WORKSPACE,role:'member'}),diagnosticRunner:async()=>{invoked++;return {model:'x',stages:[]}}});
  const res={setHeader(){},status(value){this.statusCode=value;return this},json(value){this.body=value;return this}};
  await handler({method:'POST',query:{action:'diagnostic'},body:{workspaceId:WORKSPACE},headers:{}},res);
  assert.equal(res.statusCode,403);assert.equal(invoked,0);assert.deepEqual(res.body,{error:'DIAGNOSTIC_ADMIN_REQUIRED'});
});
