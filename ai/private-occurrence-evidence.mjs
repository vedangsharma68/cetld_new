import {privateLanguageSyntax} from './private-language-syntax.mjs';
import {privateWordIndex} from './private-runtime-lexicon.mjs';
import {words,zeroWords,exceptions} from './private-language-model.mjs';
// Admission-only evidence. The shared capture tokenizer and its pinned
// semantics are unchanged. Model membership is not an ordinary-role grant.
const word=privateWordIndex(words),zero=privateWordIndex(zeroWords),exception=privateWordIndex(exceptions),hot=new Map();
const morphology=[[/s$/,''],[/es$/,''],[/ies$/,'y'],[/ing$/,''],[/ing$/,'e'],[/ed$/,''],[/d$/,''],[/er$/,''],[/r$/,''],[/est$/,''],[/st$/,''],[/xes$/,'x'],[/zes$/,'s'],[/ves$/,'f'],[/ches$/,'ch'],[/shes$/,'sh'],[/men$/,'man']];
function evidence(value){
 if(hot.has(value))return hot.get(value);
 const lexical=word(value)&&!zero(value)||exception(value)||morphology.some(([pattern,replacement])=>pattern.test(value)&&word(value.replace(pattern,replacement)));
 const isolated=privateLanguageSyntax(value)[0],nominalPOS=lexical&&!isolated?.known&&/^(?:NN|NNS)$/u.test(isolated?.pos||'')?isolated.pos:null;
 const result={lexical:lexical||isolated?.known===true,nominalPOS};
 if(hot.size>=512)hot.delete(hot.keys().next().value);hot.set(value,result);return result;
}
export function privateOccurrenceSyntax(text){return privateLanguageSyntax(text).map(token=>({...token,...evidence(token.word)}));}

// This is clause evidence, not an ordinary-role certificate for its words.
// A private name/recipient/field inside the clause is still checked normally.
export function privateCompletedActionClause(text,{subjectPronouns,singularSubjects,auxiliaries}){
 const firstWord=text.match(/^[\p{L}\p{M}]+/u)?.[0];
 const first=firstWord&&privateOccurrenceSyntax(firstWord)[0];
 if(!first?.lexical||!(first.known&&first.pos==='PRP'||first.alternatives.includes('UH')||first.alternatives.includes('VB')||/^RB(?:R|S)?$/u.test(first.pos)&&!first.alternatives.some(p=>/^(?:NN|NNS|NNP|NNPS)$/u.test(p))))return false;
 const tokens=privateOccurrenceSyntax(text);
 const evidenced=(t,re)=>t?.lexical===true&&(re.test(t.pos)||t.nominalPOS&&re.test(t.nominalPOS));
 const modifier=t=>evidenced(t,/^(?:NN|NNS|JJ|JJR|JJS|VBN)$/u);
 const adverb=t=>evidenced(t,/^RB(?:R|S)?$/u)&&!t.alternatives.some(p=>/^(?:NN|NNS|NNP|NNPS)$/u.test(p));
 const objectAt=i=>{
  if(tokens[i]?.known&&tokens[i].pos==='PRP'&&!subjectPronouns.has(tokens[i].word))return true;
  // You/it are also ordinary object pronouns, but a base-form verb cannot
  // turn an arbitrary bare private object head into an ordinary noun.
  if(tokens[i]?.known&&tokens[i].pos==='PRP'&&['you','it'].includes(tokens[i].word))return true;
  if(!evidenced(tokens[i],/^DT$/u))return false;
  for(const token of tokens.slice(i+1)){
   if(!modifier(token))return false;
   if(evidenced(token,/^(?:NN|NNS)$/u))return true;
  }
  return false;
 };
 let i=0;while(tokens[i]?.known&&tokens[i].alternatives.includes('UH')||adverb(tokens[i]))i++;
 const subject=tokens[i];
 if(subject?.known&&subject.pos==='PRP'&&subjectPronouns.has(subject.word)){
  i++;while(adverb(tokens[i]))i++;
  const finite=tokens[i];
  if(!finite?.lexical)return false;
  if(finite.pos==='MD'){
   i++;while(adverb(tokens[i]))i++;
   if(!evidenced(tokens[i],/^VB$/u)||auxiliaries.has(tokens[i].word))return false;
  }else if(!(/^(?:VBD)$/u.test(finite.pos)||finite.pos==='VBZ'&&singularSubjects.has(subject.word)||finite.pos==='VBP'&&!singularSubjects.has(subject.word))||auxiliaries.has(finite.word))return false;
 }else{
  // A structural imperative needs a positively attested base-form verb and
  // a complete object. Unknown POS guesses and fragments are insufficient.
  if(!subject?.lexical||!subject.alternatives.includes('VB')||auxiliaries.has(subject.word))return false;
 }
 i++;while(adverb(tokens[i]))i++;
 return objectAt(i);
}

// The same Unicode Quotation_Mark contract used by direct field witnesses.
// NFKC is applied only to a quote glyph, never to message content. It unifies
// width/presentation forms. The finite pair data also supports low/reversed
// quotation styles; an unrecognized future mark remains open, never ordinary.
const quotationPairs=new Map([
 [0x22,[0x22]],[0x27,[0x27]],[0x60,[0x60]],
 [0xab,[0xbb]],[0xbb,[0xab]],
 [0x2018,[0x2019]],[0x2019,[0x2018]],
 [0x201a,[0x2018,0x2019]],[0x201b,[0x2019]],
 [0x201c,[0x201d]],[0x201d,[0x201c]],
 [0x201e,[0x201c,0x201d]],[0x201f,[0x201d]],
 [0x2039,[0x203a]],[0x203a,[0x2039]],
 [0x2e42,[0x201c,0x201d]],
 [0x300c,[0x300d]],[0x300d,[0x300c]],
 [0x300e,[0x300f]],[0x300f,[0x300e]],
 [0x301d,[0x301e,0x301f]],[0x301e,[0x301d]],[0x301f,[0x301d]],
].map(([open,close])=>[String.fromCodePoint(open),new Set(close.map(cp=>String.fromCodePoint(cp)))]));
const quotation=ch=>/\p{Quotation_Mark}/u.test(ch)||ch==='`';
function fieldLiteralState(text){
 const quotes=[],brackets=[];let offset=0,quotedEnd=0;
 for(const source of text){
  const i=offset;offset+=source.length;
  const ch=quotation(source)?source.normalize('NFKC'):source;
  if(quotation(source)){
   let slashes=0;for(let j=i-1;j>=0&&text[j]==='\\';j--)slashes++;
   if(slashes%2)continue;
   const apostrophe=ch==="'"||ch===String.fromCodePoint(0x2019);
   const wordBefore=/[\p{L}\p{N}]$/u.test(text.slice(0,i));
   // An unseparated word-internal mark is not a completed literal edge.
   if((apostrophe||quotes.at(-1)?.has(ch))&&wordBefore&&/^[\p{L}\p{N}]/u.test(text.slice(offset)))continue;
   if(quotes.at(-1)?.has(ch)){
    quotes.pop();if(!quotes.length&&!quotedEnd&&quotation(text[0]))quotedEnd=offset;
    continue;
   }
   // Apostrophes inside words/possessives are not new quote openers. A
   // matching active closer above still closes its own quoted value.
   if(apostrophe&&wordBefore)continue;
   quotes.push(quotationPairs.get(ch)||new Set());continue;
  }
  if(quotes.length)continue;
  if('([{'.includes(ch))brackets.push(ch);
  else if(')]}'.includes(ch)&&brackets.pop()!=='([{'[')]}'.indexOf(ch)])return {open:true,quotedEnd};
 }
 return {open:quotes.length>0||brackets.length>0,quotedEnd};
}
export function privateFieldLiteralOpen(text){return fieldLiteralState(text).open;}

export function privateFieldValueComplete(text){
 const state=fieldLiteralState(text);
 if(state.open)return false;
 let value=text.trim();
 // A balanced trailing parenthetical can annotate a completed head, but an
 // unfinished article, conjunction or modifier cannot stand in for a value.
 for(;;){
  const match=value.match(/ *(?:\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\}) *[.!?;]*$/u);
  if(!match||!/[\p{L}\p{N}]/u.test(value.slice(0,match.index)))break;
  value=value.slice(0,match.index).trim();
 }
 if(state.quotedEnd>0&&/^[.!?;\s]*$/u.test(value.slice(state.quotedEnd)))return true;
 if(/^[0-9]+(?:[./-][0-9]+)*[.!?;]*$/u.test(value))return true;
 const lastWord=value.match(/[\p{L}\p{M}]+(?=[^\p{L}\p{M}]*$)/u)?.[0];
 const last=lastWord&&privateOccurrenceSyntax(lastWord)[0];
 return !!last?.lexical&&/^(?:NN|NNS|NNP|NNPS)$/u.test(last.nominalPOS||last.pos);
}
