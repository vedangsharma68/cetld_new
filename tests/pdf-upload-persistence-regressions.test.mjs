import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {AIProvider,DEFAULT_EXTRACTION_FALLBACK_MODEL,DEFAULT_EXTRACTION_MODEL,DEFAULT_FALLBACK_MODEL,DEFAULT_MODEL} from '../ai/provider.mjs';
import {extractInvoice} from '../ai/extraction.mjs';
import {createAIHandler} from '../ai/routes.mjs';

const WORKSPACE_ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SAMPLE_PDF=Buffer.from('%PDF-1.7\n1 0 obj <<>> endobj\n%%EOF\n');
const GROUND_TRUTH_LINE_ITEMS=[
  {description:'Dextromethorphan polistirex',quantity:10,unitPrice:12.45,amount:124.50},
  {description:'Venlafaxine Hydrochloride',quantity:25,unitPrice:16,amount:400},
  {description:'Metoclopramide Hydrochloride',quantity:25,unitPrice:9.99,amount:249.75},
  {description:'Avobenzone, octinoxate',quantity:10,unitPrice:4.45,amount:44.50},
  {description:'Verapamil hydrochloride',quantity:10,unitPrice:7.89,amount:78.90},
  {description:'Tiagabine hydrochloride',quantity:15,unitPrice:10.25,amount:153.75},
  {description:'Ziprasidone hydrochloride',quantity:10,unitPrice:34.99,amount:349.90},
  {description:'Risperidone',quantity:10,unitPrice:34.99,amount:349.90},
  {description:'Metoprolol succinate',quantity:10,unitPrice:34.99,amount:349.90},
  {description:'Acetaminophen',quantity:10,unitPrice:34.99,amount:349.90},
  {description:'Sorafenib',quantity:15,unitPrice:16,amount:240},
  {description:'Telmisartan',quantity:15,unitPrice:9.99,amount:149.85},
  {description:'Famotidine',quantity:15,unitPrice:4.45,amount:66.75},
  {description:'Methylphenidate Hydrochloride',quantity:15,unitPrice:7.89,amount:118.35},
  {description:'Ibuprofen',quantity:100,unitPrice:0.99,amount:99},
  {description:'Metformin Hydrochloride',quantity:15,unitPrice:2.15,amount:32.25},
  {description:'Avobenzone, Octisalate and Octocrylene',quantity:15,unitPrice:16.99,amount:254.85},
  {description:'Carisoprodol',quantity:10,unitPrice:34.99,amount:349.90},
  {description:'Losartan Potassium',quantity:10,unitPrice:34.99,amount:349.90},
  {description:'Pentazocine Hydrochloride and Naloxone Hydrochloride',quantity:10,unitPrice:34.99,amount:349.90},
  {description:'Omeprazole',quantity:25,unitPrice:9.99,amount:249.75},
  {description:'Losartan Potassium',quantity:25,unitPrice:4.45,amount:111.25},
  {description:'Saline',quantity:10,unitPrice:7.89,amount:78.90},
  {description:'Titanium dioxide',quantity:25,unitPrice:10.25,amount:256.25},
  {description:'Bicalutamide',quantity:25,unitPrice:2.15,amount:53.75},
  {description:'Ampicillin sodium',quantity:15,unitPrice:16.99,amount:254.85},
  {description:'Octinoxate, Titanium Dioxide, Octisalate',quantity:15,unitPrice:12.45,amount:186.75},
  {description:'Cavia porcellus hair and cavia porcellus skin',quantity:25,unitPrice:12.45,amount:311.25},
];
const extractionLineItems=GROUND_TRUTH_LINE_ITEMS.map(item=>({...item,confidence:0.98}));
const SAMPLE_INVOICE={
  direction:{value:'uncertain',confidence:0.4},
  invoiceNumber:{value:'BPXINV-00550',confidence:0.98},
  customerName:{value:'Roger Bigot',confidence:0.97},
  invoiceDate:{value:'2021-05-23',confidence:0.96},
  dueDate:{value:null,confidence:0},
  subtotal:{value:5964.50,confidence:0.97},
  tax:{value:596.45,confidence:0.97},
  total:{value:6610.95,confidence:0.99},
  outstandingAmount:{value:6610.95,confidence:0.92},
  currency:{value:null,confidence:0},
  clientPhone:{value:'+33140260294',confidence:0.9},
  clientEmail:{value:null,confidence:0},
  notes:{value:'Due after 30 days',confidence:0.86},
  lineItems:{value:extractionLineItems,confidence:0.96},
};

function jsonResponse(value,status=200){
  return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
}

function makeExtractionProvider({bytes=SAMPLE_PDF,primaryContent,primaryFinishReason='STOP',fallbackContent=JSON.stringify(SAMPLE_INVOICE),fallbackFinishReason='stop'}={}){
  const requests=[];
  const provider=new AIProvider({
    primaryModel:DEFAULT_EXTRACTION_MODEL,
    fallbackModel:DEFAULT_EXTRACTION_FALLBACK_MODEL,
    geminiApiKey:'test-gemini-key',
    openRouterApiKey:'test-openrouter-key',
    maxAttempts:1,
    fetchImpl:async(url,init)=>{
      const payload=JSON.parse(init.body);
      requests.push({url:String(url),payload});
      if(String(url).includes('generativelanguage.googleapis.com')){
        return jsonResponse({candidates:[{content:{parts:[{text:primaryContent}]},finishReason:primaryFinishReason}]});
      }
      return jsonResponse({choices:[{message:{content:fallbackContent},finish_reason:fallbackFinishReason}]});
    },
  });
  return {provider,requests,bytes};
}

function assertPdfBytesReachedBothProviders(requests,bytes){
  const encoded=bytes.toString('base64');
  const geminiPart=requests[0]?.payload.contents?.[0]?.parts?.find(part=>part.inlineData);
  assert.deepEqual(geminiPart?.inlineData,{mimeType:'application/pdf',data:encoded});
  const openRouterPart=requests[1]?.payload.messages?.[0]?.content?.find(part=>part.type==='file');
  assert.equal(openRouterPart?.file?.file_data,`data:application/pdf;base64,${encoded}`);
}

function assertPdfTextReachedBothProviders(requests){
  const geminiText=requests[0]?.payload.contents?.[0]?.parts?.[0]?.text;
  const fallbackText=requests[1]?.payload.messages?.[0]?.content;
  assert.equal(typeof geminiText,'string');
  assert.equal(typeof fallbackText,'string');
  for(const text of [geminiText,fallbackText]){
    assert.match(text,/BPXINV-00550/);
    assert.match(text,/Page 2 of 2/);
    assert.equal((text.match(/BPXPN\s*-\s*\d{5}/g)||[]).length,28);
  }
}

async function extractWithPrimaryOutput(primaryContent,primaryFinishReason='STOP',fallbackContent=JSON.stringify(SAMPLE_INVOICE),bytes=SAMPLE_PDF){
  const scenario=makeExtractionProvider({bytes,primaryContent,primaryFinishReason,fallbackContent});
  const result=await extractInvoice({provider:scenario.provider,bytes,mimeType:'application/pdf',fileName:'invoice-0-4.pdf',businessName:'Cetld'});
  return {...scenario,result};
}

test('malformed or truncated PDF JSON falls back once to the configured free model with original bytes',async()=>{
  const {requests,result,bytes}=await extractWithPrimaryOutput('{"invoiceNumber":"BPXINV-00550"','MAX_TOKENS');

  assert.equal(requests.length,2);
  assert.match(requests[0].url,/gemini-3\.5-flash-lite:generateContent/);
  assert.match(requests[1].url,/openrouter\.ai\/api\/v1\/chat\/completions/);
  assert.equal(requests[0].payload.generationConfig.maxOutputTokens,8192);
  assert.equal(result.model,DEFAULT_EXTRACTION_FALLBACK_MODEL);
  assert.equal(result.usedFallback,true);
  assert.equal(result.invoiceNumber.value,'BPXINV-00550');
  assert.equal(result.lineItems.value.length,28);
  assert.deepEqual(result.lineItems.value.map(({description,quantity,unitPrice,amount})=>({description,quantity,unitPrice,amount})),GROUND_TRUTH_LINE_ITEMS);
  assert.equal(result.lineItems.value.reduce((sum,item)=>sum+Math.round(item.amount*100),0),596450);
  assertPdfBytesReachedBothProviders(requests,bytes);
});

test('schema-invalid PDF extraction output falls back once and returns validated invoice fields',async()=>{
  const invalid={...SAMPLE_INVOICE};
  delete invalid.lineItems;
  const {requests,result,bytes}=await extractWithPrimaryOutput(JSON.stringify(invalid));

  assert.equal(requests.length,2);
  assert.equal(result.invoiceNumber.value,'BPXINV-00550');
  assert.equal(result.dueDate.value,null,'missing due dates must remain uncertain instead of being guessed');
  assert.ok(result.uncertainFields.includes('dueDate'));
  assertPdfBytesReachedBothProviders(requests,bytes);
});

test('a malformed fallback remains a bounded, sanitized INVALID_OUTPUT failure',async()=>{
  const scenario=makeExtractionProvider({primaryContent:'{truncated',primaryFinishReason:'MAX_TOKENS',fallbackContent:'{also truncated'});
  await assert.rejects(
    extractInvoice({provider:scenario.provider,bytes:SAMPLE_PDF,mimeType:'application/pdf',fileName:'invoice.pdf'}),
    error=>error.code==='INVALID_OUTPUT',
  );
  assert.equal(scenario.requests.length,2,'structured extraction must stop after one configured fallback');
});

test('Gemini image capability errors fail over once to OpenRouter with the exact original image',async()=>{
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3,4]);
  for(const status of [415,422]){
    const requests=[];
    const provider=new AIProvider({
      primaryModel:DEFAULT_EXTRACTION_MODEL,
      fallbackModel:DEFAULT_EXTRACTION_FALLBACK_MODEL,
      geminiApiKey:'test-gemini-key',
      openRouterApiKey:'test-openrouter-key',
      maxAttempts:1,
      fetchImpl:async(url,init)=>{
        const payload=JSON.parse(init.body);
        requests.push({url:String(url),payload});
        if(String(url).includes('generativelanguage.googleapis.com')){
          return jsonResponse({error:{message:'private image capability detail'}},status);
        }
        return jsonResponse({choices:[{message:{content:JSON.stringify(SAMPLE_INVOICE)},finish_reason:'stop'}]});
      },
    });
    const result=await extractInvoice({provider,bytes,mimeType:'image/png',fileName:'invoice.png'});

    assert.equal(requests.length,2,`Gemini ${status} must go directly to the one configured fallback`);
    assert.match(requests[0].url,/gemini-3\.5-flash-lite:generateContent/);
    assert.match(requests[1].url,/openrouter\.ai\/api\/v1\/chat\/completions/);
    assert.deepEqual(requests[0].payload.contents[0].parts.find(part=>part.inlineData)?.inlineData,{
      mimeType:'image/png',data:bytes.toString('base64'),
    });
    const imagePart=requests[1].payload.messages[0].content.find(part=>part.type==='image_url');
    assert.equal(imagePart?.image_url?.url,`data:image/png;base64,${bytes.toString('base64')}`);
    assert.equal(result.model,DEFAULT_EXTRACTION_FALLBACK_MODEL);
    assert.equal(result.usedFallback,true);
  }
});

function responseCapture(){
  return {code:0,data:null,setHeader(){},status(code){this.code=code;return this;},json(data){this.data=data;return data;}};
}

function createExtractionHandler(){
  const requests=[];
  const store={
    getSettings:async()=>({primary_model:DEFAULT_MODEL,fallback_model:DEFAULT_FALLBACK_MODEL}),
    getBusinessName:async()=>'Cetld',
  };
  const env={GEMINI_API_KEY:'test-gemini-key',OPENROUTER_API_KEY:'test-openrouter-key'};
  const fetchImpl=async(url,init)=>{
    const payload=JSON.parse(init.body);
    requests.push({url:String(url),payload});
    if(String(url).includes('generativelanguage.googleapis.com'))return jsonResponse({candidates:[{content:{parts:[{text:'{"truncated":'}]},finishReason:'MAX_TOKENS'}]});
    return jsonResponse({choices:[{message:{content:JSON.stringify(SAMPLE_INVOICE)},finish_reason:'stop'}]});
  };
  const providerFactory=options=>new AIProvider({...options,...env,fetchImpl,maxAttempts:1});
  return {requests,handler:createAIHandler({env,fetchImpl,authorize:async()=>store,providerFactory})};
}

async function uploadThroughExtractRoute(bytes){
  const {handler,requests}=createExtractionHandler();
  const response=responseCapture();
  await handler({
    method:'POST',query:{action:'extract'},headers:{},
    body:{workspaceId:WORKSPACE_ID,file:{base64:bytes.toString('base64'),mimeType:'application/pdf',fileName:'invoice-0-4.pdf'}},
  },response);
  return {response,requests};
}

test('extract API carries the attached PDF unchanged through the structured-output fallback',async()=>{
  const {response,requests}=await uploadThroughExtractRoute(SAMPLE_PDF);

  assert.equal(response.code,200);
  assert.equal(response.data.invoiceNumber.value,'BPXINV-00550');
  assert.equal(response.data.lineItems.value.length,28);
  assert.deepEqual(response.data.lineItems.value.map(({description,quantity,unitPrice,amount})=>({description,quantity,unitPrice,amount})),GROUND_TRUTH_LINE_ITEMS);
  assert.equal(response.data.warnings.some(warning=>/line-item amounts do not match the printed subtotal/i.test(warning)),false);
  assert.equal(requests.length,2);
  assertPdfBytesReachedBothProviders(requests,SAMPLE_PDF);
});

function appFunction(startMarker,endMarker,sandbox){
  const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  const start=app.indexOf(startMarker),end=app.indexOf(endMarker,start);
  assert.notEqual(start,-1,`missing app handler ${startMarker}`);
  assert.notEqual(end,-1,`missing end marker ${endMarker}`);
  const name=startMarker.match(/function\s+(\w+)/)?.[1];
  assert.ok(name,`could not read function name from ${startMarker}`);
  return vm.runInNewContext(`${app.slice(start,end)}; ${name}`,sandbox);
}

test('Assistant review carries all extracted PDF line items through invoice validation into persisted metadata',async()=>{
  const fields={
    direction:'receivable',invoiceNumber:'BPXINV-00550',clientName:'Roger Bigot',clientEmail:'',clientPhone:'',
    invoiceDate:'2021-05-23',dueDate:'2021-06-22',subtotal:'',tax:'',total:'6610.95',outstanding:'6610.95',
    currency:'EUR',notes:'Due after 30 days',alreadyPaid:false,saveLineItems:true,
  };
  const form={dataset:{lineItems:JSON.stringify(extractionLineItems)},elements:{dueDate:{focus(){}}},querySelector(){return {disabled:false}}};
  class FormValues{get(key){return fields[key]??'';}has(key){return (key==='alreadyPaid'||key==='saveLineItems')&&fields[key]===true;}}
  let saveRequest;
  const assistantState={workspace:{id:WORKSPACE_ID},assistantInvoiceFile:null,assistantMessages:[]};
  const saveFromUI=appFunction('async function saveAssistantInvoice(event){','async function retryAssistantSync',{
    state:assistantState,FormData:FormValues,crypto:{randomUUID:()=> 'assistant-test-key-1234'},
    aiRequest:async(action,request)=>{saveRequest={action,request};return {saved:true,invoice:{id:'30000000-0000-4000-8000-000000000001'},sync:{status:'not_configured'}};},
    $:()=>({close(){}}),loadData:async()=>{},render(){},scrollAssistant(){},showError(){},
  });
  await saveFromUI({preventDefault(){},currentTarget:form});

  assert.equal(saveRequest.action,'save-invoice');
  assert.deepEqual(JSON.parse(JSON.stringify(saveRequest.request.body.invoice.lineItems)),extractionLineItems);

  const userId='20000000-0000-4000-8000-000000000001';
  const customerId='20000000-0000-4000-8000-000000000002';
  const invoiceId='30000000-0000-4000-8000-000000000001';
  let persistedInvoice=null;
  const env={SUPABASE_URL:'https://supabase.test',SUPABASE_PUBLISHABLE_KEY:'test-publishable-key',NODE_ENV:'test'};
  const fetchImpl=async(rawUrl,init={})=>{
    const url=new URL(rawUrl),method=init.method||'GET';
    if(url.pathname==='/auth/v1/user')return jsonResponse({id:userId,email:'qa@example.test'});
    if(url.pathname==='/rest/v1/workspace_members')return jsonResponse([{workspace_id:WORKSPACE_ID,user_id:userId,role:'owner'}]);
    if(url.pathname==='/rest/v1/invoices'&&method==='GET')return jsonResponse([]);
    if(url.pathname==='/rest/v1/customers'&&method==='GET')return jsonResponse([]);
    if(url.pathname==='/rest/v1/customers'&&method==='POST'){
      const customer=JSON.parse(init.body);
      return jsonResponse([{...customer,id:customerId,workspace_id:WORKSPACE_ID}]);
    }
    if(url.pathname==='/rest/v1/invoices'&&method==='POST'){
      const invoice=JSON.parse(init.body);
      persistedInvoice={...invoice,id:invoiceId,workspace_id:WORKSPACE_ID,customer_id:customerId,total_amount:'6610.95',amount_paid:'0.00',status:'draft'};
      return jsonResponse([persistedInvoice]);
    }
    if(url.pathname==='/rest/v1/invoices'&&method==='PATCH'){
      persistedInvoice={...persistedInvoice,...JSON.parse(init.body)};
      return jsonResponse([persistedInvoice]);
    }
    throw new Error(`Unexpected Supabase request ${method} ${url.pathname}`);
  };
  const handler=createAIHandler({env,fetchImpl});
  const response=responseCapture();
  await handler({
    method:'POST',query:{action:'save-invoice'},headers:{authorization:'Bearer test-workspace-owner-token'},
    body:{...saveRequest.request.body,invoice:saveRequest.request.body.invoice},
  },response);

  assert.equal(response.code,200,JSON.stringify(response.data));
  assert.deepEqual(persistedInvoice.metadata.line_items,extractionLineItems);
  assert.deepEqual(response.data.invoice.metadata.line_items,extractionLineItems);
  assert.equal(persistedInvoice.metadata.line_items.length,28);
  assert.equal(persistedInvoice.metadata.line_items.reduce((sum,item)=>sum+Math.round(item.amount*100),0),596450);
});

test('Assistant invoice review omits read-only itemization unless the opt-in is checked',async()=>{
  const fields={direction:'receivable',invoiceNumber:'INV-1',clientName:'Client',invoiceDate:'2026-09-01',dueDate:'2026-10-01',total:'100',currency:'INR',saveLineItems:false};
  const form={dataset:{lineItems:JSON.stringify(extractionLineItems)},elements:{dueDate:{focus(){}}},querySelector(){return {disabled:false}}};
  class FormValues{get(key){return fields[key]??'';}has(key){return key==='saveLineItems'&&fields.saveLineItems===true;}}
  let request;
  const save=appFunction('async function saveAssistantInvoice(event){','async function retryAssistantSync',{
    state:{workspace:{id:WORKSPACE_ID},assistantInvoiceFile:null,assistantMessages:[]},FormData:FormValues,crypto:{randomUUID:()=> 'assistant-no-items-key'},
    aiRequest:async(action,options)=>{request={action,options};return {saved:false};},showError(){},
  });
  await save({preventDefault(){},currentTarget:form});
  assert.equal(request.action,'save-invoice');
  assert.deepEqual(JSON.parse(JSON.stringify(request.options.body.invoice.lineItems)),[]);
});

test('New Invoice upload failure keeps the original attached and restores manual Save',async()=>{
  const button={disabled:false};
  const ingestionState={textContent:'',dataset:{},classList:{remove(){}}};
  const manualNumber={disabled:false,value:'MANUAL-1'};
  const handlers={};
  const state={demo:false,workspace:{id:WORKSPACE_ID},invoices:[],settings:{default_currency:'INR'},pendingFile:null};
  let extractionTimeout=0;
  const form={
    dataset:{},
    querySelector(selector){
      if(selector==='[type=submit]')return button;
      if(selector==='[data-ingestion-state]')return ingestionState;
      if(selector==='[name=number]')return manualNumber;
      return null;
    },
    addEventListener(type,handler){handlers[type]=handler;},
  };
  const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  const helpersStart=source.indexOf('function setIngestionState(');
  const helpersEnd=source.indexOf('function invoiceForm(',helpersStart);
  assert.notEqual(helpersStart,-1);
  assert.notEqual(helpersEnd,-1);
  const [setIngestionState,ingestFile]=vm.runInNewContext(`${source.slice(helpersStart,helpersEnd)}; [setIngestionState,ingestFile]`,{
    state,
    AbortController,
    FileReader:class{readAsDataURL(){this.result='data:image/png;base64,AQID';this.onload();}},
    aiRequest:async(_action,options)=>{extractionTimeout=options.timeoutMs;throw Error('provider timeout');},
  });
  const renderForm=appFunction('function invoiceForm(id){','async function saveInvoice(e,x){',{
    state,ingestFile,setIngestionState,escape:String,remaining:()=>0,button:()=>'<button></button>',currencyOptions:()=>'',
    openDialog(){},saveInvoice(){},showError(){},
    $:selector=>selector==='#invoice-form'?form:null,
  });
  renderForm();
  const file={name:'workshop-invoice.png',type:'image/png',size:128};
  handlers.change({target:{name:'source_file',files:[file]}});
  await new Promise(resolve=>setTimeout(resolve,0));

  assert.equal(state.pendingFile,file,'the failed extraction must retain the original for the normal Save flow');
  assert.equal(extractionTimeout,150000,'invoice extraction must have a bounded 150-second timeout for provider failover');
  assert.equal(button.disabled,false,'manual Save must be enabled after the provider failure');
  assert.equal(manualNumber.disabled,false,'manually entered invoice details remain editable');
  assert.equal(ingestionState.dataset.kind,'failed');
  assert.match(ingestionState.textContent,/original.*attached/i);
});

const suppliedPdfPath=process.env.CETLD_TEST_PDF_PATH;
test('the supplied two-page invoice PDF reaches both providers as complete selectable text',{
  skip:suppliedPdfPath?false:'Set CETLD_TEST_PDF_PATH to run this private local-PDF integration check.',
},async()=>{
  const bytes=readFileSync(suppliedPdfPath);
  assert.equal(bytes.subarray(0,5).toString('ascii'),'%PDF-');
  const {response,requests}=await uploadThroughExtractRoute(bytes);

  assert.equal(response.code,200,JSON.stringify(response.data));
  assert.equal(response.data.invoiceNumber.value,'BPXINV-00550');
  assert.equal(response.data.customerName.value,'Roger Bigot');
  assert.equal(response.data.total.value,6610.95);
  assert.deepEqual(response.data.lineItems.value.map(({description,quantity,unitPrice,amount})=>({description,quantity,unitPrice,amount})),GROUND_TRUTH_LINE_ITEMS);
  assert.equal(requests.length,2);
  assertPdfTextReachedBothProviders(requests);
});
