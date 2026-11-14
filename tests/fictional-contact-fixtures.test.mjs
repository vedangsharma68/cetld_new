import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
// Fingerprint of removed fixture contact data, never the contact literal.
const removedFingerprint='41dad8592561942968e44fe05d0bd4c3257226f245be33b69235b6bcd070e608';
test('test source contains no removed personal phone in national or international form',async()=>{
 const walk=async dir=>{for(const entry of await readdir(dir,{withFileTypes:true})){const path=dir+'/'+entry.name;if(entry.isDirectory())await walk(path);else if(/\.(?:mjs|js|ts|sql|source)$/.test(path)){
  const source=await readFile(path,'utf8');
  for(const match of source.matchAll(/\+?[0-9][0-9 ()-]{7,}[0-9]/g)){
   const digits=match[0].replace(/[^0-9]/g,'');
   if(digits.length>=10&&digits.length<=13)assert.notEqual(createHash('sha256').update(digits.slice(-10)).digest('hex'),removedFingerprint,path+' contains removed personal fixture data');
  }
 }}};
 await walk(new URL('.',import.meta.url).pathname);
});
test('general production-chat fixture uses a NANPA-reserved fictional phone',async()=>{
 const source=await readFile(new URL('./fixtures/private-invoice.mjs',import.meta.url),'utf8');
 const phone=source.match(/const phone='([^']+)'/)[1];
 assert.match(phone,/^\+1[2-9][0-9]{2}55501[0-9]{2}$/);
 const ledger=await readFile(new URL('./whatsapp-owner-ledger.test.mjs',import.meta.url),'utf8');
 assert.match(ledger,/phone:'\+1[2-9][0-9]{2}55501[0-9]{2}'/);
});
