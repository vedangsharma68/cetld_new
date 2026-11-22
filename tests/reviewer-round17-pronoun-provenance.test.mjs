import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWhatsAppDispatch} from '../automation/whatsapp/private-dispatch.mjs';

// Reviewer round 17 (independent): pronoun-provenance classes for candidate R1.
//
// The R1 exemption (ai/private-value-matcher.mjs, ordinaryCased PRP/PRP$ rule)
// grants an ordinary role to any known pronoun in ordinary casing without
// checking that the occurrence can actually form ordinary pronoun syntax.
// The matcher already computes the needed evidence BELOW the exemption
// (auxiliaries/nextPOS/predicate, determiner position): a pronoun subject
// requires agreement-compatible verb forms, and a possessive pronoun requires
// a nominal continuation. The exemption short-circuits before consulting it.
//
// Expected status on R1: the eight BLOCK cases in class A1/A2 currently PASS
// (they leak an attested party value in name position) and FAIL this test.
// That is the repair scope. Everything else documents behavior to preserve:
//  - determiner/apposition/quoted citations already block (A3);
//  - valid ordinary syntax stays absorbed (A4), exactly as modals/articles
//    already are: 'You will receive it shortly.' passes with party:will
//    attested and 'You can pay when you are ready.' passes with
//    identifier:can attested. Pronouns must meet the same contract, no
//    blanket blocking;
//  - agreement-valid homographs ('It owes 500.', 'His has been paid.') stay
//    ordinary even under the tightened rule.
const phone='+12025550901';
const terms=['party:you','party:him','party:her','party:them','party:us','party:it','party:your','party:his','party:my','party:will','identifier:can'];
const supabase={rpc:async()=>({data:{terms,identifiers:[],values:[],files:[]}})};
const frame=body=>({to:phone.slice(1),type:'text',text:{body}});

test('pronoun exemption requires syntax compatible with the pronoun role',async t=>{
 const admission=await prepareWhatsAppDispatch({supabase,phone});
 const blocks=[
  // A1: subject pronoun with agreement-incompatible finite verb: name citation
  'You has been billed','You owes 500.','You is a valued customer.',
  'Him owes 500.','Her has paid.','Them owes 500.',
  // A2: possessive pronoun followed by a finite verb, no nominal continuation
  'Your owes 500.','My owes 500.',
  // A3: determiner/apposition/quoted citation (already blocked on R1)
  'The You on file owes 500.','Customer You owes 500.','"You" owes 500.','The Him on our list owes 500.',
 ];
 for(const body of blocks)await t.test('blocks '+body,()=>assert.throws(()=>admission(frame(body)),{code:'PRIVATE_PAYLOAD_BLOCKED'}));
 const passes=[
  // Agreement-valid homographs stay ordinary
  'It owes 500.','His has been paid.',
  // A4: valid ordinary syntax absorbs, consistent with modal absorption
  'I billed you yesterday','Please ask him to confirm','We told them about it',
  'You will receive it shortly.','You can pay when you are ready.',
  // Ordinary controls
  'Your invoice is ready.','You can review your invoice.','It is ready for pickup.','His has been paid already.',
 ];
 for(const body of passes)await t.test('passes '+body,()=>assert.doesNotThrow(()=>admission(frame(body))));
});
