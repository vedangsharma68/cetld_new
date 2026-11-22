import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWhatsAppDispatch} from '../automation/whatsapp/private-dispatch.mjs';

// Reviewer round 17 (independent), bare-VB completion of the agreement class.
//
// Same class as the R2 pronounRole repair, same occurrence-side evidence:
// a SUBJECT-case pronoun immediately followed by a base-form verb (VB)
// cannot be ordinary syntax - a singular subject requires a singular or
// neutral finite form. 'he' and 'she' are unambiguously subject case, so
// 'He pay' / 'She pay' are always name-position citations. 'it' is
// case-ambiguous: sentence-initial 'It pay' is a subject citation, while a
// licensing verb before it gives the ordinary object + bare-infinitive
// reading ('Make it pay off.') and must keep passing.
//
// Expected status on R2: the three block cases currently PASS (leak) and
// FAIL this test. This is not a new scope: it is the singular side of the
// same subject-verb agreement evidence R2 already consults (A1 repaired the
// plural-subject + singular-verb direction).
const phone='+12025550901';
const terms=['party:he','party:she','party:it','party:him','party:them','party:you'];
const supabase={rpc:async()=>({data:{terms,identifiers:[],values:[],files:[]}})};
const frame=body=>({to:phone.slice(1),type:'text',text:{body}});

test('a singular subject pronoun cannot take a base-form verb in an ordinary role',async t=>{
 const admission=await prepareWhatsAppDispatch({supabase,phone});
 const blocks=[
  'He pay on time.',
  'She pay her invoices late.',
  'It pay on time.',          // sentence-initial: subject position
 ];
 for(const body of blocks)await t.test('blocks '+body,()=>assert.throws(()=>admission(frame(body)),{code:'PRIVATE_PAYLOAD_BLOCKED'}));
 const passes=[
  'He pays on time.',         // agreement-valid singular: absorbs
  'It pays to be careful.',
  'I saw him pay.',           // object pronoun + bare infinitive: ordinary
  'Let them pay when ready.',
  'Make it pay off.',         // licensing verb: object reading of it + VB
  'You pay on time.',         // non-singular subjects agree with base form
  'I pay on time.',
  'We pay on time.',
  'He paid on time.',         // neutral finite forms absorb
  'She did pay.',
  'It may pay off.',
 ];
 for(const body of passes)await t.test('passes '+body,()=>assert.doesNotThrow(()=>admission(frame(body))));
});
