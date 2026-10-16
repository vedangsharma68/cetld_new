// Visibility hints only. The authenticated API independently enforces this scope.
const scope={workspaceId:'9a83b58d-6b02-4b17-8de5-c67136f26434',ownerId:'40ff343c-4334-4aec-b49a-ca772f0cf8ad',
  invoiceId:'f86e28bd-16a8-4c83-a03d-05302f7f3ff6',recipient:'+919871367051'};
const receiptLabel=result=>result?.status==='existing'?({delivered:'Already delivered',read:'Already read',sent:'Already sent',
  accepted:'Already accepted by Meta',failed:'Previous dispatch failed',blocked:'Previous dispatch blocked'}[result.deliveryStatus]||'Previous dispatch unconfirmed'):null;

export function zohoDiscoveryView(value,escape){
  if(!value||!['available','empty','error'].includes(value.status))return '';
  const label={available:'Organizations available',empty:'No organizations returned',error:'Organization check failed'}[value.status];
  const count=Number.isSafeInteger(value.organizationCount)&&value.organizationCount>=0?value.organizationCount:'Not available';
  return `<details data-zoho-discovery><summary>Organization check</summary><p>${label}</p><dl class="detail-facts"><div><dt>Organizations</dt><dd>${count}</dd></div><div><dt>Provider code</dt><dd>${escape(value.providerCode??'Not returned')}</dd></div><div><dt>HTTP status</dt><dd>${escape(value.httpStatus??'Not returned')}</dd></div></dl></details>`;
}

export function createOwnerTemplateTestUI({state,request,openDialog,dialog,escape,button,toast,showError}){
  let pending=null,reviewed=null;
  const label=(control,text)=>{control.textContent=text;control.setAttribute('aria-label',text);};
  const canReview=invoice=>!state.demo&&state.user?.id===scope.ownerId&&state.workspace?.id===scope.workspaceId
    &&state.workspace?.owner_id===scope.ownerId&&invoice?.id===scope.invoiceId;
  const current=context=>state.user?.id===context.userId&&state.workspace?.id===context.workspaceId
    &&canReview(state.invoices.find(invoice=>invoice.id===context.invoiceId));
  async function review(control,invoiceId){
    if(pending)return;
    if(!canReview(state.invoices.find(invoice=>invoice.id===invoiceId)))throw Error('Open the approved synthetic invoice as its owner.');
    reviewed=null;
    const context={userId:state.user.id,workspaceId:state.workspace.id,invoiceId,controller:new AbortController()};
    pending=context;control.disabled=true;
    openDialog('Review owner test',`<div class="dialog-body" aria-busy="true"><p role="status">Preparing owner test preview…</p><p class="error hidden" data-error role="alert"></p></div><div class="dialog-foot">${button('close','Cancel')}</div>`);
    const head=dialog()?.querySelector('.dialog-head');
    const visible=()=>pending===context&&current(context)&&dialog()?.open&&dialog()?.querySelector('.dialog-head')===head;
    let timer;
    try{
      const aborted=new Promise((_,reject)=>{context.controller.signal.addEventListener('abort',()=>reject(Error('Preview timed out. No message was sent.')),{once:true});timer=setTimeout(()=>context.controller.abort(),30000);});
      const preview=await Promise.race([request(invoiceId,{signal:context.controller.signal}),aborted]);
      if(!visible())return;
      if(preview?.workspaceId!==scope.workspaceId||preview.ownerId!==scope.ownerId||preview.invoiceId!==scope.invoiceId
        ||preview.recipient!==scope.recipient||preview.audience!=='owner'||preview.test!==true)
        throw Error('The owner test preview could not be verified. No message was sent.');
      const existing=receiptLabel(preview);
      if(existing){
        openDialog('Review owner test',`<div class="dialog-body"><p role="status">${escape(existing)}</p><p>No new message was sent. This owner test will not be sent again. Check Conversations for its delivery history.</p></div><div class="dialog-foot">${button('close','Close')}</div>`);
        return;
      }
      if(preview.template?.name!=='cetld_invoice_update_v2'||preview.template?.language?.code!=='en'
        ||typeof preview.text!=='string'||!preview.text.includes('TEST ONLY - INV-2026-6771')||!preview.previewToken)
        throw Error('The owner test preview could not be verified. No message was sent.');
      reviewed={...context,preview};
      openDialog('Review owner test',`<div class="dialog-body"><span class="tag">Owner test · one message</span><dl class="detail-facts"><div><dt>Actual recipient</dt><dd>${escape(preview.recipient)}</dd></div><div><dt>Sending bot</dt><dd>+917303338959</dd></div><div><dt>Synthetic invoice</dt><dd>INV-2026-6771</dd></div><div><dt>Template</dt><dd>${escape(preview.template.name)} · English</dd></div></dl><div class="detail-note"><span class="eyebrow">Exact message</span><p>${escape(preview.text)}</p>${preview.footer?`<small>${escape(preview.footer)}</small>`:''}</div><p>This sends one test to the verified owner. Invoice and payment records stay unchanged.</p><p class="error hidden" data-error role="alert"></p></div><div class="dialog-foot">${button('close','Cancel')}${button('owner-template-test-send','Send one owner test','primary')}</div>`);
    }catch(error){
      if(visible()){
        openDialog('Review owner test',`<div class="dialog-body"><p role="status">Preview unavailable</p><p>No message was sent. You can try the preview again after resolving the error.</p><p class="error hidden" data-error role="alert"></p></div><div class="dialog-foot">${button('close','Cancel')}${button('owner-template-test-review','Try preview again','',invoiceId)}</div>`);
        showError(dialog(),error);
      }
    }finally{clearTimeout(timer);if(pending===context)pending=null;context.controller.abort();control.disabled=false;}
  }
  async function send(control){
    const context=reviewed;
    if(!context||!current(context)||!dialog()?.open)throw Error('Open a fresh owner test preview first.');
    reviewed=null;control.disabled=true;control.dataset.keepDisabled='true';label(control,'Sending once…');
    try{
      const result=await request(context.invoiceId,{method:'POST',previewToken:context.preview.previewToken});
      const existing=receiptLabel(result);
      label(control,existing||(result.status==='accepted'?'Accepted by Meta':'Result unconfirmed'));
      toast(existing?`${existing}. No new message was sent. This owner test will not be sent again.`
        :result.status==='accepted'?'Owner test accepted. Check Conversations for delivery status.':'Owner test result is unconfirmed. It will not be retried.');
    }catch(error){label(control,'Result unconfirmed');showError(dialog(),Error(`${error?.message||'The result could not be confirmed.'} Check Conversations before taking further action.`));}
  }
  return {canReview,review,send};
}
