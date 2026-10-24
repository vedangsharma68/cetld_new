import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerWriteConfirmation} from '../automation/whatsapp/owner-write-confirmation.mjs';

test('confirmations use only public committed fields, retaining nulls and custom values',()=>{
  const record={name:'Pappa',phone:'+919818685252',email:null,custom_fields:{code:'00123',enabled:false,credit:1234.5},
    id:'private-id',workspace_id:'private-workspace',updated_at:'private-timestamp',metadata:{secret:'private-metadata'}};
  const result={ok:true,completed:true,entityType:'customer',action:'customer.updated',record};
  assert.equal(ownerWriteConfirmation(result),'Updated customer.\nName: Pappa\nPhone: +919818685252\nEmail: none\nCustom fields: {"code":"00123","enabled":false,"credit":1234.5}');
  for(const patch of [{ok:false},{completed:false},{proposal:true},{requiresConfirmation:true},{record:null},{action:'customer.proposed'}])
    assert.equal(ownerWriteConfirmation({...result,...patch}),null);
  assert.equal(ownerWriteConfirmation({ok:true,completed:true,entityType:'invoice',action:'invoice.updated',record}),null);
});

test('adjacent business record and settings receipts render deterministically',()=>{
  for(const action of ['created','updated','deleted','restored']){
    const reply=ownerWriteConfirmation({ok:true,completed:true,entityType:'business_record',action:`business_record.${action}`,record:{name:'Supplier 001',record_type:'supplier',custom_fields:{phone:'+919818685252'}}});
    assert.ok(reply.includes('Name: Supplier 001\nCategory: supplier\nCustom fields: {"phone":"+919818685252"}'));
  }
  assert.equal(ownerWriteConfirmation({ok:true,completed:true,entityType:'settings',action:'settings.updated',record:{business_name:'Shop 001',default_currency:'INR'}}),
    'Updated business settings.\nBusiness name: Shop 001\nDefault currency: INR');
  assert.equal(ownerWriteConfirmation({ok:true,completed:true,entityType:'ai_settings',action:'ai_settings.updated',record:{primary_model:'exact-model',fallback_model:null}}),
    'Updated AI settings.\nPrimary model: exact-model\nFallback model: none');
});
