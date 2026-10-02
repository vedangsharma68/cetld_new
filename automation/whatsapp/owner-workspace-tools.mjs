import {createOwnerSafetyTools} from './owner-agent.mjs';
import {createWorkspaceDataTool} from './workspace-data.mjs';

// These adapters retain atomic invoice/payment/attachment safeguards. They are
// private server operations, never additional functions offered to the model.
export function createOwnerWorkspaceTools(options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if(options.signal?.aborted)abort();
  else options.signal?.addEventListener('abort',abort,{once:true});
  let writeAttempted = false;
  const safety = createOwnerSafetyTools({...options,signal:controller.signal});
  const invoke = (name, args = {}) => safety.execute(name, args);
  const target = params => {
    const filters = Array.isArray(params.filters) ? params.filters : [];
    if(filters.length !== 1 || !['invoice_number','id'].includes(filters[0].column) || filters[0].operator !== 'eq') return undefined;
    return filters[0].value;
  };
  const tool = createWorkspaceDataTool({...options,signal:controller.signal,
    getRuntimeConfig: () => invoke('getAIProviderConfiguration'),
    async executeSafetyOperation(params) {
      if(params.signal?.aborted || (Number.isFinite(params.deadlineAt) && Date.now()>=params.deadlineAt)) throw Object.assign(new Error(),{code:'OWNER_LOOP_TIMEOUT'});
      const {operation, table, values = {}} = params;
      if(['create','update','delete','restore','confirm','cancel','saveAttachment','reviewAttachment'].includes(operation))writeAttempted=true;
      if (operation === 'pending') return invoke('getPendingOwnerAction');
      if (operation === 'confirm') return invoke('confirmPendingOwnerChange');
      if (operation === 'cancel') return invoke('cancelPendingOwnerChange');
      if (operation === 'analyzeAttachment') return invoke('readInvoiceAttachment');
      if (operation === 'saveAttachment') return invoke('ingestInvoiceAttachment');
      if (operation === 'reviewAttachment') {
        const names={invoice_number:'invoiceNumber',customer_name:'customerName',issue_date:'invoiceDate',due_date:'dueDate',total_amount:'total',currency:'currency',invoice_direction:'direction'};
        if(Object.keys(values).some(key=>!names[key]))return {ok:false,code:'INVALID',message:'That field cannot be added to this invoice review.'};
        return invoke('continueInvoiceReview',Object.fromEntries(Object.entries(values).map(([key,value])=>[names[key],value])));
      }
      if (operation === 'sendFile') return invoke('sendInvoiceFile', {target: target(params)});
      if (table === 'workspace_settings' && operation === 'update') {
        if(Object.keys(values).some(key=>!['business_name','follow_up_preferences'].includes(key)))return {ok:false,code:'INVALID',message:'Choose one settings change at a time.'};
        return invoke('proposeWorkspaceSettingsChange',{...(values.business_name!==undefined?{businessName:values.business_name}:{}),patch:values.follow_up_preferences||{}});
      }
      if (table !== 'invoices') return {ok:false, code:'INVALID', message:'This operation is not available for that table.'};
      if (operation === 'delete') return invoke('prepareInvoiceDeletion', {target: target(params)});
      if (operation === 'restore') {
        if(params.filters?.[0]?.column !== 'invoice_number') return {ok:false,code:'INVALID',message:'Use the invoice number to restore a deleted invoice.'};
        return invoke('undoInvoiceDeletion', {invoiceNumber: target(params)});
      }
      if (operation === 'update') {
        if (Object.keys(values).length === 1 && values.status === 'paid') return invoke('proposeInvoicePayment', {target: target(params)});
        const names = {invoice_number:'invoiceNumber', issue_date:'invoiceDate', due_date:'dueDate', total_amount:'total', currency:'currency', notes:'notes'};
        if (Object.keys(values).some(key => !names[key])) return {ok:false, code:'INVALID', message:'That invoice field cannot be changed safely from chat.'};
        return invoke('proposeInvoiceChange', {target:target(params), changes:Object.fromEntries(Object.entries(values).map(([key,value]) => [names[key],value]))});
      }
      if (operation === 'create') {
        const names = {invoice_number:'invoiceNumber', customer_name:'clientName', client_name:'clientName', customer_email:'clientEmail', customer_phone:'clientPhone', issue_date:'invoiceDate', due_date:'dueDate', total_amount:'total', subtotal:'subtotal', tax:'tax', currency:'currency', notes:'notes'};
        if (Object.keys(values).some(key => !names[key])) return {ok:false, code:'INVALID', message:'That invoice field cannot be set safely from chat.'};
        return invoke('proposeInvoiceCreation', Object.fromEntries(Object.entries(values).map(([key,value]) => [names[key],value])));
      }
      return {ok:false, code:'INVALID', message:'Choose a supported workspace operation.'};
    },
  });
  return {
    definitions:[tool.definition],
    async execute(name, args, context) {
      if (name !== 'workspaceData') return {ok:false, code:'UNKNOWN_TOOL', message:'That tool does not exist. Use workspaceData with a description of what you need.'};
      if(context?.signal?.aborted)abort();
      else context?.signal?.addEventListener('abort',abort,{once:true});
      try{return await tool.execute(args,context);}
      finally{context?.signal?.removeEventListener('abort',abort);}
    },
    setServedModel: safety.setServedModel,
    getMedia: safety.getMedia,
    getAttachmentIngested: safety.getAttachmentIngested,
    getWriteAttempted: () => writeAttempted || tool.getWriteAttempted?.() || false,
    getReplyRequirement() {return tool.getReplyRequirement?.() || safety.getReplyRequirement();},
  };
}
