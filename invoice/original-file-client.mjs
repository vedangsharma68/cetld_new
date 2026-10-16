const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES=10*1024*1024;
const EXTENSIONS={'application/pdf':'pdf','image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
const unavailable=()=>new Error('The original attachment is unavailable. Refresh the invoice and try again.');

function downloadName(name,mimeType){
  const clean=String(name||'invoice-original').replace(/[\\/:*?"<>|\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'-')
    .replace(/^\.+/,'').trim().slice(0,180)||'invoice-original';
  const extension=EXTENSIONS[mimeType];
  return new RegExp(`\\.${mimeType==='image/jpeg'?'jpe?g':extension}$`,'i').test(clean)?clean:`${clean}.${extension}`;
}

/** Use the existing signed-in client. RLS protects both metadata and Storage. */
export async function downloadOriginalInvoiceFile(client,{workspaceId,invoiceId}={}){
  if(!UUID.test(workspaceId||'')||!UUID.test(invoiceId||''))throw unavailable();
  const {data:identity,error:authError}=await client.auth.getUser();
  if(authError||!UUID.test(identity?.user?.id||''))throw new Error('Sign in to download the original attachment.');
  const {data:invoice,error:invoiceError}=await client.from('invoices').select('id,workspace_id,deleted_at')
    .eq('workspace_id',workspaceId).eq('id',invoiceId).is('deleted_at',null).maybeSingle();
  if(invoiceError||invoice?.id!==invoiceId||invoice?.workspace_id!==workspaceId||invoice.deleted_at)throw unavailable();
  const {data:files,error:fileError}=await client.from('invoice_files')
    .select('id,workspace_id,invoice_id,storage_path,file_name,mime_type,size_bytes')
    .eq('workspace_id',workspaceId).eq('invoice_id',invoiceId)
    .order('created_at',{ascending:false}).order('id',{ascending:false}).limit(1);
  if(fileError)throw unavailable();
  if(!Array.isArray(files)||!files.length)throw new Error('No original attachment was saved for this invoice.');
  const file=files[0],parts=String(file.storage_path||'').split('/'),size=Number(file.size_bytes);
  let decodedName;try{decodedName=decodeURIComponent(parts[2]||'');}catch{throw unavailable();}
  if(files.length!==1||file.workspace_id!==workspaceId||file.invoice_id!==invoiceId
      ||parts.length!==3||parts[0]!==workspaceId||parts[1]!==invoiceId||!parts[2]
      ||['.','..'].includes(decodedName)||/[\\/?#\x00-\x1f]/.test(decodedName)
      ||!Object.hasOwn(EXTENSIONS,file.mime_type)||file.size_bytes===null
      ||!Number.isSafeInteger(size)||size<1||size>MAX_BYTES)throw unavailable();
  const {data:blob,error:downloadError}=await client.storage.from('invoice-files').download(file.storage_path);
  if(downloadError||!blob||blob.size!==size||typeof blob.arrayBuffer!=='function'
      ||String(blob.type).split(';')[0].toLowerCase()!==file.mime_type)throw unavailable();
  return {blob,fileName:downloadName(file.file_name,file.mime_type),fileId:file.id};
}

export function saveOriginalInvoiceFile({blob,fileName},{documentImpl=globalThis.document,urlImpl=globalThis.URL,schedule=setTimeout}={}){
  const objectUrl=urlImpl.createObjectURL(blob),anchor=documentImpl.createElement('a');
  try{
    anchor.href=objectUrl;anchor.download=fileName;anchor.hidden=true;
    documentImpl.body.append(anchor);anchor.click();
  }finally{
    anchor.remove();schedule(()=>urlImpl.revokeObjectURL(objectUrl),1000);
  }
}
