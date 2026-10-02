import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeletedAtCompatibility,isDeletedInvoice,isMissingDeletedAtColumn} from '../invoice/deleted-at-compat.mjs';

const missing={code:'42703',message:'column invoices.deleted_at does not exist'};

test('only explicit missing deleted_at schema errors permit a legacy read',()=>{
  assert.equal(isMissingDeletedAtColumn(missing),true);
  assert.equal(isMissingDeletedAtColumn({code:'PGRST204',details:'column public.invoices.deleted_at was not found in the schema cache'}),true);
  for(const error of [
    {code:'42703',message:'column invoices.updated_at does not exist'},
    {code:'PGRST204',message:'column invoices.updated_at does not exist'},
    {code:'42501',message:'permission denied for deleted_at'},
    {code:'XX000',message:'column invoices.deleted_at does not exist'},
  ])assert.equal(isMissingDeletedAtColumn(error),false);
});

test('legacy fallback filters any deleted rows returned by the old query',async()=>{
  const guard=createDeletedAtCompatibility(),calls=[];
  const rows=await guard.read({
    withDeletedAt:async()=>{calls.push('new');throw missing;},
    legacy:async()=>{calls.push('legacy');return [{id:'active'},{id:'deleted',deleted_at:'2026-10-01T00:00:00Z'}];},
  });
  assert.deepEqual(calls,['new','legacy']);
  assert.deepEqual(rows,[{id:'active'}]);
  assert.equal(isDeletedInvoice({deleted_at:'2026-10-01T00:00:00Z'}),true);
});

test('a negative schema probe is not cached across later reads',async()=>{
  const guard=createDeletedAtCompatibility();let migrated=false,legacyReads=0;
  const read=()=>guard.read({
    withDeletedAt:async()=>{
      if(!migrated)throw missing;
      return [{id:'active'},{id:'deleted',deleted_at:'2026-10-01T00:00:00Z'}];
    },
    legacy:async()=>{legacyReads++;return [{id:'legacy-active'}];},
  });
  assert.deepEqual(await read(),[{id:'legacy-active'}]);
  migrated=true;
  assert.deepEqual(await read(),[{id:'active'}]);
  assert.equal(legacyReads,1);
});

test('after deleted_at succeeds once, a later schema error fails closed',async()=>{
  const guard=createDeletedAtCompatibility();let fail=false,legacyReads=0;
  const read=()=>guard.read({
    withDeletedAt:async()=>{if(fail)throw missing;return [{id:'active'}];},
    legacy:async()=>{legacyReads++;return [{id:'unsafe'}];},
  });
  assert.deepEqual(await read(),[{id:'active'}]);
  fail=true;
  await assert.rejects(read(),error=>error===missing);
  assert.equal(legacyReads,0);
});

test('ordinary read failures never trigger a broader legacy query',async()=>{
  const guard=createDeletedAtCompatibility(),failure={code:'42501',message:'permission denied'};let legacyReads=0;
  await assert.rejects(guard.read({withDeletedAt:async()=>{throw failure;},legacy:async()=>{legacyReads++;return []}}),error=>error===failure);
  assert.equal(legacyReads,0);
});
