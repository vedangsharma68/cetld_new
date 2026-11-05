import {PRIVATE_UNICODE_FOLD} from './private-value-unicode.mjs';
import {PRIVATE_DATE_YEAR_PIVOT,months,monthPattern,ordinals,units,small,scales,fractions,evidenceLabel,evidenceNumericLabel,evidenceDateLabel,currencyUnitPattern,namedDatePatterns,privateDocumentKeyPattern,privateOriginHeader,privateOriginRecordHeader,privateOriginClauseBoundary,originDateCommaPattern,lexicalAliases,partyTransliteration,partyReference,partyGrammarWords,grammarAuxiliaries,partyFunctionWords,numericSelectionWords,numericCollectiveWords,privateOriginEvent,privateOriginNoun,privateOriginCarrier,privateOriginDocumentPrefix,privateOriginPartyLabel,privateOriginMonetaryBefore,privateOriginDateBefore,privateOriginLiteralLabel,privateOriginRelationStart,privateOriginRelationEnd,privateOriginPronouns,privateOriginNameEdge,privateJSONPadding,PRIVATE_NUMBER_LIST_MAX_GROUPS} from './private-value-language.mjs';
// One code-point fold, shared verbatim with SQL, independent of DB/OS locale.
export const normalizePrivateValue=value=>Array.from(String(value??''),ch=>PRIVATE_UNICODE_FOLD[ch]??ch).join('').replace(/ +/g,' ').trim();
const clean=normalizePrivateValue;
function lexicalText(input){const origins=[],chunks=[];for(const m of input.matchAll(/[\p{L}\p{M}]+|[^\p{L}\p{M}]+/gu)){const part=lexicalAliases[m[0]]??m[0];chunks.push(part);for(let i=0;i<part.length;i++)origins.push(Object.hasOwn(lexicalAliases,m[0])?{start:m.index,end:m.index+m[0].length,translated:true}:{start:m.index+i,end:m.index+i+1});}return {text:chunks.join(''),origins};}
const stripCurrency=value=>value.replace(/\/[-−]$/u,'').replace(new RegExp(`^(?:\\p{Sc}|${currencyUnitPattern}) *| *(?:\\p{Sc}|${currencyUnitPattern})$`,'gu'),'').trim();
export function normalizePrivateText(value){
  const text=String(value??''),chars=[],origins=[];let index=0;
  for(const ch of text){
    const end=index+ch.length;
    for(const part of (PRIVATE_UNICODE_FOLD[ch]??ch).split('')){
      if(part===' '&&(!chars.length||chars.at(-1)===' ')){if(chars.length)origins.at(-1).end=end;continue;}
      chars.push(part);origins.push({start:index,end});
    }
    index=end;
  }
  if(chars.at(-1)===' '){chars.pop();origins.pop();}return {text:chars.join(''),origins};
}
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const separateUnits=text=>text.replace(new RegExp(`\\b${currencyUnitPattern} *(?=[0-9])|(?<=[0-9])${currencyUnitPattern}\\b`,'gu'),match=>' '.repeat(match.length));
const exact=(integer,fraction='')=>{const tail=fraction.replace(/0+$/,'');return BigInt(integer).toString()+(tail?'.'+tail:'');};
const shift=(value,places)=>{const [integer,fraction='']=value.split('.');return exact(integer+fraction.padEnd(places,'0').slice(0,places),fraction.slice(places));};
function groupedInteger(value){
  const groups=value.split(/[.,' ]/u);
  if(!groups.every(group=>/^\d+$/.test(group)))return null;
  if(groups.length===1||groups[0].length<=3&&groups.slice(1).every(group=>group.length===3)
    ||groups[0].length<=2&&groups.at(-1).length===3&&groups.slice(1,-1).every(group=>group.length===2))return groups.join('');
  return null;
}
function scalar(value){
  value=value.replace(/\/[-−]$/u,'');
  value=value.replace(/^[\p{Quotation_Mark}ʼ]+|[\p{Quotation_Mark}ʼ]+$/gu,'').replace(/^\((.*)\)$/u,'$1').replace(/[\p{Quotation_Mark}ʼ]/gu,"'");
  const adornment=new RegExp(`^(?:[+−-]|\\p{Sc}|${currencyUnitPattern}) *| *(?:\\p{Sc}|${currencyUnitPattern})$`,'gu');
  for(let prior;prior!==value;){prior=value;value=value.replace(adornment,'').trim();}
  return value.replace(/[.,]+$/u,'').replace(/ *([.,']) */gu,'$1');
}
// Both valid grouping/decimal interpretations are compared only to retained keys.
function numeric(input){
  let value=scalar(input),places=0;
  const suffix=/([kmb])$/.exec(value);if(suffix){places={k:3,m:6,b:9}[suffix[1]];value=value.slice(0,-1).trim();}
  const values=new Set(),integer=groupedInteger(value);
  if(integer!==null)values.add(exact(integer));
  const last=value.search(/[.,][0-9]+$/u);
  if(last>=0){const whole=groupedInteger(value.slice(0,last));if(whole!==null)values.add(exact(whole,value.slice(last+1)));}
  return new Set([...values].map(n=>places?shift(n,places):n));
}
// Numeric ambiguity is a compact run, never all overlapping subwindows.
// Retention keeps the whole-value interpretations and a compact graph;
// screening checks its paths against actual supplied numeric candidates.
function numericList(value,enumeration=false){
  const prepared=scalar(value),direct=numeric(value);
  if(!/^[0-9][0-9.,' ]*(?:[kmb])?$/u.test(prepared))return direct;
  const parts=prepared.split(/, */u),result=new Set(direct);
  if(runGroups(prepared)<=PRIVATE_NUMBER_LIST_MAX_GROUPS&&direct.size&&!enumeration&&!/, +/u.test(value))return direct;
  if(parts.length>1){for(let i=0;i<parts.length;i++){numericList(parts[i]).forEach(n=>result.add(n));if(i+1<parts.length)numeric(parts[i]+','+parts[i+1]).forEach(n=>result.add(n));}return result;}
  const groups=prepared.split(/ +/u);
  if(groups.length>PRIVATE_NUMBER_LIST_MAX_GROUPS){for(let i=0;i<groups.length;i++){numeric(groups[i]).forEach(n=>result.add(n));if(i+1<groups.length)numeric(groups[i]+' '+groups[i+1]).forEach(n=>result.add(n));}return result;}
  if(direct.size)return direct;
  for(let i=0;i<groups.length;){let end=groups.length,keys=new Set();
    for(;end>i;end--){keys=numeric(groups.slice(i,end).join(' '));if(keys.size)break;}
    if(end===i){i++;continue;}keys.forEach(n=>result.add(n));i=end;
  }
  return result;
}
const runGroups=value=>value.split(/[, ]+/u).length;
const numericRun=value=>{const prepared=scalar(value);return /^[0-9][0-9.,' ]*(?:[kmb])?$/u.test(prepared)&&(prepared.includes(',')||runGroups(prepared)>PRIVATE_NUMBER_LIST_MAX_GROUPS)?prepared:null;};
export const privateNumberKeys=(value,enumeration=false)=>{
 const term=clean(value),run=numericRun(term);
 // Long runs keep their entire parse graph in one key. No atomic member or
 // grouping is lost: membership is resolved against the supplied restatement.
 if(run&&runGroups(run)>PRIVATE_NUMBER_LIST_MAX_GROUPS)return [...numeric(term)].map(number=>'number:'+number).concat('number-run:'+run);
 const keys=[...numericList(term,enumeration)].map(number=>'number:'+number);
 if(run&&(enumeration||!numeric(term).size||/, +/u.test(term)||runGroups(run)>PRIVATE_NUMBER_LIST_MAX_GROUPS))keys.push('number-run:'+run);
 return keys;
};
function enumerationContext(prefix){
 const clause=prefix.split(/[;.!?\n]/u).at(-1),tokens=clause.match(/[\p{L}\p{M}]+/gu)||[];
 if(tokens.some(word=>numericSelectionWords.includes(word)||numericCollectiveWords.includes(word)))return true;
 const predicate=tokens.findIndex(word=>['are','were','include','contain','equal'].includes(word));
 const nominal=predicate>=0?tokens.slice(0,predicate):tokens,head=nominal.at(-1);
 if(predicate>=0&&nominal.some(word=>['these','those','they'].includes(word)))return true;
 // A plural nominal head licenses a list through punctuation, wrappers and
 // adverbs. A singular pronominal subject plus an -s verb does not.
 return /s$/u.test(head||'')&&!['is','was','has','this'].includes(head)&&!['it','he','she','this','that'].includes(nominal[0]);
}
// A run is a sequence of digit groups and boundaries. Search the supplied key's
// digits, then validate only its boundary-aligned spellings with the scalar
// grammar. No O(n * window) alias materialization on invoice writes.
function compileNumericRun(value){
 const text=scalar(value),parts=[...text.matchAll(/[^, ]+/gu)],starts=new Map(),ends=new Map();let digits='';
 for(let i=0;i<parts.length;i++){starts.set(digits.length,i);digits+=parts[i][0].replace(/[^0-9]/gu,'');ends.set(digits.length,i+1);}
 return {text,parts,digits,starts,ends,cache:new Map()};
}
function runHas(run,key){
 if(run.cache.has(key))return run.cache.get(key);
 const probes=[key],suffix=/[kmb]$/u.exec(run.text);
 if(suffix){const places={k:3,m:6,b:9}[suffix[0]], [whole,fraction='']=key.split('.'), padded=whole.padStart(places+1,'0');probes.push(exact(padded.slice(0,-places),padded.slice(-places)+fraction));}
 let found=false;
 for(const probe of probes){const digits=probe.replace('.','');let index=run.digits.indexOf(digits);
  while(index>=0&&!found){let left=index,right=index+digits.length;
   while(left>0&&run.digits[left-1]==='0')left--;
   while(right<run.digits.length&&run.digits[right]==='0')right++;
   for(let a=left;a<=index&&!found;a++)if(run.starts.has(a))for(let b=index+digits.length;b<=right;b++)if(run.ends.has(b)&&numeric(run.text.slice(run.parts[run.starts.get(a)].index,run.parts[run.ends.get(b)-1].index+run.parts[run.ends.get(b)-1][0].length)).has(key)){found=true;break;}
   index=run.digits.indexOf(digits,index+1);
  }
 }
 run.cache.set(key,found);return found;
}
const dayPattern=`(?:[0-9]{1,2}(?:st|nd|rd|th)?|${ordinals.map(day=>day.replaceAll(' ','[ -]+')).join('|')})`;
const dayValue=value=>/^\d/.test(value)?parseInt(value,10):ordinals.indexOf(value.replace(/[ -]+/g,' '))+1;
const yearValue=value=>value==null?null:value.length===2?Number(value)+(Number(value)<=PRIVATE_DATE_YEAR_PIVOT?2000:1900):Number(value);
function dateValue(year,month,day){
  const actual=year??2000,d=new Date(0);d.setUTCHours(0,0,0,0);d.setUTCFullYear(actual,month-1,day);
  return actual>=1&&d.getUTCFullYear()===actual&&d.getUTCMonth()===month-1&&d.getUTCDate()===day?{year,month,day}:null;
}
function dates(original){
  const lexical=lexicalText(original),text=lexical.text;
  const values=[],spans=[],candidates=[];
  const add=(y,m,d,match)=>candidates.push({value:dateValue(y,Number(m),Number(d)),start:lexical.origins[match.index]?.start??match.index,end:lexical.origins[match.index+match[0].length-1]?.end??match.index+match[0].length});
  for(const match of text.matchAll(/(?<![\p{L}\p{N}_])([0-9]{1,4}) *[./-] *([0-9]{1,2})(?: *[./-] *([0-9]{2}|[0-9]{4}|[0-9]{1}))?(?![\p{L}\p{N}_]| *[./-] *[0-9])/gu)){
    if(match[1].length===4&&match[3]!=null)add(Number(match[1]),match[2],match[3],match);
    else if(match[1].length<=2&&(match[3]==null||[2,4].includes(match[3].length))){
      const y=yearValue(match[3]);add(y,match[2],match[1],match);add(y,match[1],match[2],match);
    }
  }
  const boundary='(?![\\p{L}\\p{N}_]|[ ,./\\-\'’ʼ]*[0-9])';
  for(const [index,pattern] of namedDatePatterns.entries())for(const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}${boundary}`,'gu'))){
    const day=match[index===0?1:2],month=match[index===0?2:1];
    add(yearValue(match[3]),months.indexOf(month.slice(0,3))+1,dayValue(day),match);
  }
  // A suffix inside a complete date cannot become a second yearless date.
  // Keep lexical spans even when invalid so invalid full dates cannot promote
  // an otherwise valid month/day suffix. Equal spans retain DD/MM ambiguity.
  for(const c of candidates)if(c.value&&!candidates.some(other=>other.start<=c.start&&other.end>=c.end&&(other.start<c.start||other.end>c.end))){values.push(c.value);spans.push([c.start,c.end]);}
  return {values,spans};
}
const numberWords=new Set([...Object.keys(small),...Object.keys(scales),...Object.keys(fractions),'hundred','and','a','point']);
function wordNumber(words){
  if(!words.length||words.every(word=>['and','a'].includes(word)))return [];
  if(words.length===1){const direct=numeric(words[0]);if(direct.size)return [...direct];}
  const factor=scales[words.at(-1)]||(words.at(-1)==='hundred'?100n:1n);
  if(factor!==1n&&words.some(word=>word==='point'||fractions[word]||/^[0-9]+[.,][0-9]+$/.test(word)))return wordNumber(words.slice(0,-1)).map(value=>shift(value,factor.toString().length-1));
  if(fractions[words.at(-1)]){
    const end=words.length-1,and=words.lastIndexOf('and'),head=and>=0?words.slice(0,and):[],tail=words.slice(and+1,end).filter(word=>word!=='a');
    const numerator=tail.length?wordNumber(tail):['1'],base=head.length?wordNumber(head):['0'];
    return base.flatMap(a=>numerator.filter(n=>/^\d+$/.test(n)).map(n=>{
      const [integer,fraction='']=a.split('.'),digits=Math.max(fraction.length,20),scale=10n**BigInt(digits);
      const value=BigInt(integer)*scale+BigInt(fraction.padEnd(digits,'0'))+BigInt(n)*scale/fractions[words.at(-1)];
      return exact((value/scale).toString(),(value%scale).toString().padStart(digits,'0'));
    }));
  }
  const point=words.indexOf('point');
  if(point>=0){const tail=words.slice(point+1);if(!tail.length||tail.some(w=>!/^\d+$/.test(w)&&(small[w]===undefined||small[w]>9n)))return [];
    return wordNumber(words.slice(0,point)).map(value=>exact(value,tail.map(w=>/^\d+$/.test(w)?w:String(small[w])).join('')));}
  const actual=words.filter(w=>!['and','a',',','&'].includes(w));
  const atom=word=>{const integer=[...numeric(word)].find(value=>/^\d+$/.test(value));return small[word]??(integer!==undefined?BigInt(integer):null);};
  const underHundred=parts=>{
    if(!parts.length)return 0n;
    if(parts.length===1)return atom(parts[0]);
    if(parts.length!==2)return null;
    const first=atom(parts[0]),last=atom(parts[1]);
    return first!==null&&last!==null&&first>=20n&&first<=90n&&first%10n===0n&&last>0n&&last<10n?first+last:null;
  };
  const group=parts=>{
    const hundred=parts.indexOf('hundred');if(hundred<0)return underHundred(parts);
    if(parts.lastIndexOf('hundred')!==hundred)return null;
    const first=hundred?underHundred(parts.slice(0,hundred)):1n,last=underHundred(parts.slice(hundred+1));
    return first!==null&&first>0n&&first<100n&&last!==null&&last<100n?first*100n+last:null;
  };
  if(actual.length>=2&&actual.every(word=>small[word]!==undefined&&small[word]<=9n)&&!words.includes('and'))return [exact(actual.map(word=>String(small[word])).join(''))];
  if(actual.length>=2&&actual.length<=3&&actual.every(word=>atom(word)!==null)){
    const first=atom(actual[0]),tail=underHundred(actual.slice(1));
    if(first>0n&&first<100n&&tail!==null&&tail>=10n&&tail<100n)return [String(first*100n+tail)];
  }
  // Consecutive magnitude words form one multiplier, independent of their
  // relative sizes: lakh crore, million million, or billion million. Explicit
  // coefficients separate additive groups (one crore one lakh).
  let magnitude=0n,index=-1,end=-1,repeated=false;
  for(let i=0;i<actual.length;){
    if(!scales[actual[i]]){i++;continue;}
    const start=i;let cluster=1n;
    while(i<actual.length&&scales[actual[i]])cluster*=scales[actual[i++]];
    if(cluster>magnitude){magnitude=cluster;index=start;end=i;repeated=false;}
    else if(cluster===magnitude)repeated=true;
  }
  if(!magnitude){const value=group(actual);return value===null?[]:[String(value)];}
  if(repeated)return [];
  const heads=index?wordNumber(actual.slice(0,index)):['1'];
  const tails=end===actual.length?['0']:wordNumber(actual.slice(end));
  return heads.flatMap(head=>tails.filter(tail=>/^\d+$/.test(tail)&&BigInt(tail)<magnitude).flatMap(tail=>{const value=shift(head,magnitude.toString().length-1);return /^\d+$/.test(value)?[String(BigInt(value)+BigInt(tail))]:[];}));
}
// A valid complete numeral is atomic. Otherwise take longest valid members;
// punctuation may connect a cardinal phrase or separate a list, never add the
// next independent tens group to an already complete one.
function wordRuns(original,onSpan){
  const lexical=lexicalText(original),text=lexical.text;
  const values=new Set();let run=[];
  const flush=()=>{
    if(!run.some(token=>numberWords.has(token.word)&&!['and','a'].includes(token.word)||lexical.origins[token.start]?.translated)){run=[];return;}
    // Delimiters after a numeral do not belong to its value/span. In a typed
    // projection the following date may already be masked with spaces.
    while(run.length&&['and','a'].includes(run.at(-1).word))run.pop();
    for(let start=0;start<run.length;){
      let end=run.length,found=[];
      for(;end>start;end--){found=wordNumber(run.slice(start,end).map(token=>token.word));if(found.length)break;}
      if(end===start){start++;continue;}
      found.forEach(n=>values.add(n));onSpan?.(found,lexical.origins[run[start].start]?.start??run[start].start,lexical.origins[run[end-1].end-1]?.end??run[end-1].end);start=end;
    }
    run=[];
  };
  for(const token of text.matchAll(/[0-9]+(?:[.,' ]+[0-9]+)*|[a-z]+|[, &-]+|[^\s]/g)){
    const word=token[0];if(/^[, &-]+$/.test(word)){if(word.includes(',')||word.includes('&'))run.push({word:'and',start:token.index,end:token.index+word.length});continue;}
    if(numberWords.has(word)||numeric(word).size>0)run.push({word,start:token.index,end:token.index+word.length});else flush();
  }
  flush();return values;
}

function numbers(text,onSpan,targets=new Set()){
  text=separateUnits(text);const masked=text.split(''),keys=wordRuns(text,(values,start,end)=>{onSpan?.(values,start,end);for(let i=start;i<end;i++)masked[i]=' ';});text=masked.join('');
  for(const match of text.matchAll(/[0-9]+(?:[., \p{Quotation_Mark}ʼ]+[0-9]+)*(?:[kmb])?/gu)){
    if(/[\p{L}\p{N}_]$/u.test(text.slice(0,match.index))||/^[\p{L}\p{N}_]/u.test(text.slice(match.index+match[0].length)))continue;
    const enumeration=enumerationContext(text.slice(0,match.index)),found=[...numericList(match[0],enumeration)];
    const run=numericRun(match[0]);
    if(run&&(enumeration||!numeric(match[0]).size||/, +/u.test(match[0])||runGroups(run)>PRIVATE_NUMBER_LIST_MAX_GROUPS)){
      const graph=compileNumericRun(run);for(const key of targets)if(!found.includes(key)&&runHas(graph,key))found.push(key);
    }
    found.forEach(value=>keys.add(value));
    if(found.length)onSpan?.(found,match.index,match.index+match[0].length);
  }
  return keys;
}
const identifier=value=>/[\p{L}]/u.test(value)&&/^[\p{L}\p{N}\p{M}\p{P} ]+$/u.test(value)?value.replaceAll('&','and').replace(/[^\p{L}\p{N}\p{M}]/gu,''):null;
const identifierPattern=key=>{
  const separator='[\\p{P} ]*',and=Array.from('and',escape).join(separator);
  const pattern=key.replaceAll('&','and').split('and').map(part=>Array.from(part,escape).join(separator)).join(separator+'(?:'+and+'|&)'+separator);
  return new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`,'u');
};
export function partyKey(value){return clean(value).replace(/[\p{L}\p{M}]+/gu,term=>{
 const native=/[\u0900-\u097f]/u.test(term);let out='';
 for(const ch of term){if(Object.hasOwn(partyTransliteration,ch)){if(/[\u093e-\u094d]/u.test(ch)&&out.endsWith('a'))out=out.slice(0,-1);out+=partyTransliteration[ch];}else out+=ch;}
 if(native)out=out.replace(/a$/u,'').replace(/aa/g,'a').replace(/ii/g,'i').replace(/uu/g,'u');return out;
});}
const partyComponent=part=>/\p{L}/u.test(part)&&(Array.from(part).length>=2||!/\p{Script=Latin}/u.test(part));
export const privatePartyKeys=value=>clean(value).split(/[^\p{L}\p{M}\p{N}]+/u).filter(partyComponent).flatMap(part=>/[\u0900-\u097f]/u.test(part)?['party-native:'+part,'party-latin:'+partyKey(part)]:[(partyFunctionWords.includes(part)?'party-ref:':'party:')+partyKey(part)]);

export function privateEvidenceValues(value){
  const values=[clean(value)];
  const amount='[0-9]+(?:[., \\p{Quotation_Mark}ʼ]+[0-9]+)*(?:[kmb])?';
  const currency=new RegExp(`(?:(?:${currencyUnitPattern}|\\p{Sc}) *[+−-]? *${amount}|${amount} *(?:${currencyUnitPattern}|\\p{Sc}))`,'gu');
  for(const raw of String(value??'').split(/[\r\n]+/u)){
    const line=clean(raw),payload=line.replace(new RegExp(evidenceLabel,'u'),'').replace(new RegExp(evidenceNumericLabel,'u'),'');
    if(payload){const amounts=numeric(payload);if(amounts.size&&!new RegExp(evidenceDateLabel,'u').test(line))values.push(...[...amounts].map(value=>'number:'+value));else values.push(payload);}
    for(const match of line.matchAll(currency))values.push(match[0]);
  }
  return [...new Set(values.filter(Boolean))];
}
// This decoder owns structured input at routing, retention and every screening
// boundary. SQL generates the identical padding set and bounded traversal.
export function decodePrivateJSON(value){
 if(typeof value!=='string')return undefined;
 const chars=Array.from(value);let start=0,end=chars.length;
 while(start<end&&privateJSONPadding.test(chars[start]))start++;
 while(end>start&&privateJSONPadding.test(chars[end-1]))end--;
 const source=chars.slice(start,end).join('');if(!/^[\[{"]/.test(source))return undefined;
 try{return JSON.parse(source);}catch{return undefined;}
}
export function* privateOriginDocuments(value,depth=0){
 if(depth>32)throw Object.assign(new Error('PRIVATE_ORIGIN_DEPTH_EXCEEDED'),{code:'PRIVATE_ORIGIN_DEPTH_EXCEEDED'});
 if(typeof value==='string'){
  const decoded=decodePrivateJSON(value);
  if(decoded!==undefined&&decoded!==value){yield* privateOriginDocuments(decoded,depth+1);return;}
  const normalized=clean(value);if(/[a-z]/u.test(normalized)&&new RegExp(privateOriginHeader,'u').test(normalized))yield value;
 }else if(Array.isArray(value)){for(const item of value)yield* privateOriginDocuments(item,depth+1);}
 else if(value&&typeof value==='object'){
  if(Object.keys(value).some(key=>new RegExp(privateDocumentKeyPattern,'u').test(clean(key)))){yield value;return;}
  for(const item of Object.values(value))yield* privateOriginDocuments(item,depth+1);
 }
}
function structuredPrivateOrigin(value){
 try{return !privateOriginDocuments(value).next().done;}catch{return true;}
}
function originPosition(text){
 const match=new RegExp(privateOriginHeader,'u').exec(text);if(!match)return null;
 // Only a carrier linked to this document can precede its noun. An ordinary
 // independent prefix must not become a supplied party/name field.
 if(new RegExp(privateOriginDocumentPrefix,'u').test(text.slice(match.index))){
  const prefix=text.slice(0,match.index),boundary=originClauseBoundary(prefix),carriers=[...prefix.slice(boundary).matchAll(new RegExp(privateOriginCarrier,'gu'))];
  if(carriers.length)return boundary+carriers.at(-1).index;
 }
 return match.index;
}
export function privateOriginStart(value){
 if(decodePrivateJSON(value)!==undefined&&structuredPrivateOrigin(value))return 0;
 const normalized=normalizePrivateText(value);if(!/[a-z]/u.test(normalized.text))return null;
 const start=originPosition(normalized.text);return start===null?null:normalized.origins[start]?.start??0;
}
function originClauseBoundary(prefix){let boundary=0;for(const match of prefix.matchAll(new RegExp(privateOriginClauseBoundary,'gu')))boundary=match.index+match[0].length;return boundary;}
const nameValue=value=>value.trim().replace(new RegExp(privateOriginNameEdge,'gu'),'').replace(/^[\p{Quotation_Mark}ʼ]+|[\p{Quotation_Mark}ʼ]+$/gu,'').trim();
function privateOriginFields(value){
 if(decodePrivateJSON(String(value))!==undefined)return null;
 const text=clean(String(value??'').replace(/[\r\n]+/g,',')).replace(new RegExp(originDateCommaPattern,'gu'),'$1 $2'),start=originPosition(text);
 if(start===null)return null;
 const source=text.slice(start),working=lexicalText(source).text,fields=[],numberRanges=[],masked=working.split(''),mask=(a,b)=>{for(let i=a;i<b;i++)masked[i]=' ';};
 let recordEnd=0;const record=new RegExp(privateOriginRecordHeader.slice(1),'u').exec(working);
 if(record){const a=record.index+record[0].length;recordEnd=a;const identity=/^[\p{L}\p{N}][\p{L}\p{N}._/-]*/u.exec(working.slice(a));if(identity){fields.push({value:identity[0],number:false,party:false});recordEnd=a+identity[0].length;}mask(record.index,recordEnd);}
 // A field's type precedes its interpretation: Total 31.10 is money, while
 // Due 31.10 is a date. Named/full dates remain date-bearing without a label.
 numbers(masked.join(''),(keys,a,b)=>{const label=new RegExp(privateOriginMonetaryBefore,'u').exec(working.slice(0,a));if(label){fields.push({value:working.slice(a,b),number:true,party:false});numberRanges.push([a,b]);mask(label.index,b);}});
 const parsed=dates(masked.join(''));
 for(const [i,[a,b]] of parsed.spans.entries()){
  const label=new RegExp(privateOriginDateBefore,'u').exec(working.slice(0,a));
  if(parsed.values[i].year===null&&/^[0-9][0-9 ./-]*$/u.test(working.slice(a,b))&&!label)continue;
  fields.push({value:working.slice(a,b),number:false,party:false});mask(label?.index??a,b);
 }
 numbers(masked.join(''),(keys,a,b)=>{fields.push({value:working.slice(a,b),number:true,party:false});numberRanges.push([a,b]);mask(a,b);});
 const remaining=masked.join(''),stop=remaining.search(/[.!?]/u),limit=stop<0?remaining.length:stop,partyText=remaining.slice(0,limit);
 const addParty=(value,strong=false)=>{value=nameValue(value);if(!value||!/[\p{L}]/u.test(value))return;const words=value.match(/[\p{L}\p{M}]+/gu)||[];if(!strong&&words.length&&words.every(w=>privateOriginPronouns.includes(w)))return;fields.push({value,number:false,party:true});};
 const label=new RegExp(privateOriginPartyLabel,'u').exec(partyText);
 if(label)addParty(partyText.slice(label.index+label[0].length),true);
  const doc=new RegExp(privateOriginNoun,'u').exec(working),event=new RegExp(privateOriginEvent,'u').exec(working),carrier=doc?[...working.slice(0,doc.index).matchAll(new RegExp(privateOriginCarrier,'gu'))].at(-1):null;
  if(carrier){let before=partyText.slice(carrier.index+carrier[0].length,doc.index).trim().replace(/(?:^| +)(?:a|an|the|my|our|this|that)$/u,'');before=before.replace(new RegExp(privateOriginRelationStart,'u'),'');addParty(before);}
 if(record){
  for(const part of partyText.slice(recordEnd).split(/[,;]/u)){
   const candidate=nameValue(part);if(!candidate||/^(?:notes?|currency|date|due|total|subtotal|tax|amount|balance|rate|quantity)\b/u.test(candidate))continue;
   if(new RegExp(privateOriginPartyLabel,'u').test(candidate))continue;
   addParty(candidate);
  }
 }else{
  const head=event??doc;
  if(head){
   const begin=head.index+head[0].length,rawTail=working.slice(begin),relation=new RegExp(privateOriginRelationStart,'u').test(rawTail.trim()),intro=/\b(?:here|below|following|attached) +(?:is|are)\b/u.test(working.slice(0,head.index));
   if(event||carrier||relation||intro||/^[ ,:]/u.test(rawTail)&&/^[,:]/u.test(rawTail.trim())){
    const amount=numberRanges.filter(([a])=>a>=begin&&a<limit).sort((a,b)=>a[0]-b[0])[0];
    let before=nameValue(partyText.slice(begin,amount?.[0]??limit)).replace(new RegExp(privateOriginRelationStart,'u'),'').replace(new RegExp(privateOriginRelationEnd,'u'),'');before=nameValue(before);addParty(before);
    if(amount){const after=partyText.slice(amount[1]).trim();if(new RegExp(privateOriginRelationStart,'u').test(after))addParty(after.replace(new RegExp(privateOriginRelationStart,'u'),''));}
   }
  }
 }
 const literal=new RegExp(privateOriginLiteralLabel,'u').exec(working);if(literal){const payload=working.slice(literal.index+literal[0].length).trim();if(payload)fields.push({value:payload,number:false,party:false});}
 return {source,fields};
}
export const privateOriginValues=value=>{const parsed=privateOriginFields(value);return parsed?[parsed.source,...parsed.fields.map(field=>field.value)]:[];};
export function privateOriginKeys(value){
  const parsed=privateOriginFields(value);if(!parsed)return [];
  return [...new Set([...(Array.from(parsed.source).length<=3993?['origin:'+parsed.source]:[]),...privateFieldKeys(parsed.source),...parsed.fields.flatMap(field=>{const keys=field.party&&partyFunctionWords.includes(clean(field.value))?[]:privateFieldKeys(field.value),numeric=keys.filter(key=>/^number(?:-run)?:/.test(key));return [...(field.number&&numeric.length?numeric:keys),...(field.party?privatePartyKeys(field.value):[])];})])];
}
// Canonical keys for a retained atomic field. SQL term_aliases is generated
// from the same grammar; parity tests compare these exact key sets.
export function privateFieldKeys(value){
  const raw=clean(value);if(!raw||Array.from(raw).length>4000)return [];
  const term=raw.replace(/^[\p{Quotation_Mark}ʼ]+|[\p{Quotation_Mark}ʼ]+$/gu,''),keys=new Set([raw]),parsed=dates(term),date=parsed.values.filter((value,index)=>{const [a,b]=parsed.spans[index];return ['','the'].includes(term.slice(0,a).trim())&&/^[., ]*$/.test(term.slice(b));});
  for(const key of privateNumberKeys(term))keys.add(key);
  const spoken=stripCurrency(lexicalText(stripCurrency(term)).text),words=spoken.match(/[a-z]+/g)||[];
  if(words.every(word=>numberWords.has(word))){for(const n of numeric(spoken))keys.add('number:'+n);for(const n of wordRuns(lexicalText(term).text===term?spoken:term))keys.add('number:'+n);}
  for(const {year,month,day} of date)keys.add('date:'+(year==null?'*':String(year).padStart(4,'0'))+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0'));
  if(keys.size===1){const key=identifier(term);if(key)keys.add('identifier:'+key);}
  return [...keys];
}
export function createPrivateValueMatcher(terms=[]){
  const retainedRuns=[],retainedNumbers=new Set(),retainedDates=[],literals=[],parties=new Set(),nativeParties=new Set(),latinParties=new Set(),referenceParties=new Set();
  const expanded=terms.flatMap(raw=>String(raw??'').startsWith('evidence:')?privateEvidenceValues(String(raw).slice(9)):String(raw??'').startsWith('origin:')?privateOriginKeys(String(raw).slice(7)).filter(key=>!key.startsWith('origin:')):[raw]);
  const compile=term=>{
    if(term.startsWith('number-run:')){retainedRuns.push(compileNumericRun(term.slice(11)));return true;}
    if(/^number:[0-9]+(?:\.[0-9]+)?$/.test(term)){const [a,b]=term.slice(7).split('.');retainedNumbers.add(exact(a,b));return true;}
    const tagged=/^date:(\*|[0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(term);
    if(tagged){const value=dateValue(tagged[1]==='*'?null:Number(tagged[1]),Number(tagged[2]),Number(tagged[3]));if(value)retainedDates.push(value);return true;}
    if(term.startsWith('party-native:')){nativeParties.add(term.slice(13));return true;}
    if(term.startsWith('party-latin:')){latinParties.add(term.slice(12));return true;}
    if(term.startsWith('party-ref:')){referenceParties.add(term.slice(10));return true;}
    if(term.startsWith('party:')){parties.add(term.slice(6));return true;}
    if(term.startsWith('identifier:')){literals.push(identifierPattern(term.slice(11)));return true;}return false;
  };
  for(const raw of expanded){
    const term=clean(raw);if(!term||compile(term))continue;
    const keys=privateFieldKeys(term);if(keys.length>1){keys.slice(1).forEach(compile);continue;}
    literals.push(new RegExp(`(?<![\\p{L}\\p{N}_])${escape(term)}(?![\\p{L}\\p{N}_])`,'u'));
  }
  // Closed grammatical classes describe roles, not permitted sentences. A
  // formal component can be a subject, object, possessive or question target.
  // Determiner-led noun phrases, bare lowercase instrumental nouns and a
  // different compound proper name remain ordinary uses of a homograph.
  const determiners=new Set(['a','an','the','some','this','that','my','our','your','his','her','their']);
  const relations=new Set(['to','from','with','about','by','for','of','in','on','at']);
  const complements=new Set([...relations,'if','whether','when','where','why','how','who','that','now','today','tomorrow','yesterday','recently','please','again','soon','later']);
  const auxiliaries=new Set(grammarAuxiliaries);
  const finitePast=new Set('arose awoke bore beat became began bent bet bid bit bled blew broke bred brought broadcast built burnt bought caught chose came cost crept cut dealt dug did drew dreamt drank drove ate fell fed felt fought found fled flew forbade forgot forgave froze got gave went grew hung had heard hid hit held hurt kept knew laid led leant leapt learnt left lent let lay lit lost made meant met paid put quit read rode rang rose ran said saw sought sold sent set sewed shook shone shot showed shrank shut sang sank sat slept slid smelt spoke spelt spent spilt spun spat split spread sprang stood stole stuck stung stank struck swore swept swam swung took taught tore told thought threw understood woke wore wept won wound wrote'.split(' '));
  const verbs=new Set(['ask','contact','call','pay','send','tell','talk','message','email','thank','meet','met','spoke','speak','came','comes','went','said','says']);
  const upper=value=>/\p{Lu}/u.test(value?.[0]||'');
  const partyMatches=(content,ordinary=false,original=content)=>{
    const normalized=normalizePrivateText(original),occurrences=[...content.matchAll(/[\p{L}\p{M}\p{N}]+/gu)];
    // Han words do not use Latin-style whitespace boundaries. Match the exact
    // stored spelling inside a Han run; no translated or reordered alias.
    for(const key of parties)if(/^\p{Script=Han}+$/u.test(key))for(const run of content.matchAll(/\p{Script=Han}+/gu)){
      if(run[0]===key)continue;
      for(let i=run[0].indexOf(key);i>=0;i=run[0].indexOf(key,i+key.length))occurrences.push(Object.assign([key],{index:run.index+i}));
    }
    return occurrences.filter(m=>{
      const term=m[0],matched=/[\u0900-\u097f]/u.test(term)?nativeParties.has(term)||parties.has(partyKey(term)):parties.has(partyKey(term))||latinParties.has(partyKey(term));
      const referenceKey=referenceParties.has(partyKey(term));if(!matched&&!referenceKey)return false;
      const before=content.slice(0,m.index).split(/[;.!?\n]/u).at(-1),after=content.slice(m.index+term.length).split(/[;.!?\n]/u)[0];
      const beforeWords=before.match(/[\p{L}\p{M}]+/gu)||[],afterWords=after.match(/[\p{L}\p{M}]+/gu)||[],next=afterWords[0],last=beforeWords.at(-1);
      const offset=normalized.origins[m.index]?.start??m.index,end=normalized.origins[m.index+term.length-1]?.end??m.index+term.length;
      const raw=String(original).slice(offset,end),nextRaw=String(original).slice(end).match(/[\p{L}\p{M}]+/u)?.[0];
      const det=beforeWords.findLastIndex(word=>determiners.has(word));
      const nounPhrase=det>=0&&beforeWords.length-det<=5&&beforeWords.slice(det+1).every(word=>!relations.has(word)&&!auxiliaries.has(word)&&!verbs.has(word)&&!word.endsWith('ed'));
      const possessive=/^[’'ʼ]s(?:[^\p{L}\p{N}]|$)/u.test(after);
      const continuation=afterWords[1],finiteTail=!continuation||determiners.has(continuation)||complements.has(continuation)||['me','you','him','her','us','them','it'].includes(continuation)||upper(String(original).slice(end).match(/[\p{L}\p{M}]+/gu)?.[1]);
      const objectPronoun=['me','you','him','her','us','them','it'].includes(continuation),subjectSlot=!before.trim()||auxiliaries.has(last)||['that','when','if','whether','because','while'].includes(last);
      const regularS=/s$/u.test(next||'')&&!/(?:ss|us|is)$/u.test(next||'')&&(term!=='the'||objectPronoun);
      const predicate=(subjectSlot||objectPronoun||upper(raw)&&beforeWords.length>0)&&(auxiliaries.has(next)||(finitePast.has(next)||/ed$/u.test(next||'')||regularS)&&finiteTail);
      const target=beforeWords.length>0&&(complements.has(next)||!next||/^[ ,;.!?]/u.test(after)&&!after.trim()||possessive);
      const differentName=upper(raw)&&upper(nextRaw)&&!parties.has(partyKey(next))&&!auxiliaries.has(next)&&!complements.has(next);
      const particle=!partyGrammarWords.includes(term);
      const reference=referenceKey&&(content===term||!nounPhrase&&!differentName&&(possessive||predicate||target||auxiliaries.has(last)&&upper(raw)||particle&&upper(raw))&&!(last==='by'&&!upper(raw)));
      if((!matched&&!reference)||!partyComponent(term))return false;
      if(!ordinary)return true;
      // A linguistic exemption applies only to this occurrence's own clause.
      const clause=before+term+after;
      if(new RegExp(partyReference,'u').test(clause))return true;
      return !(/(?:surname|given name|word|name) +$/u.test(before)&&!after.trim()||/^ +is +(?:a +)?common +(?:surname|given name|word|name) *$/u.test(after)&&!before.trim());
    });
  };
  const hasNumber=key=>retainedNumbers.has(key)||retainedRuns.some(run=>runHas(run,key));
  const matchText=(text,ordinary=false)=>{
    const content=clean(text);if(privateOriginStart(text)!==null)return true;if(literals.some(pattern=>pattern.test(content)))return true;
    if(partyMatches(content,ordinary,text).length)return true;
    const found=dates(content);
    if(found.values.some(current=>retainedDates.some(saved=>saved.month===current.month&&saved.day===current.day&&(saved.year==null||current.year==null||saved.year===current.year))))return true;
    // A two-part dotted rendering can also be an amount. Compare that whole
    // interpretation before masking date parts; never compare its subvalues.
    if(found.spans.some(([start,end])=>[...numeric(content.slice(start,end))].some(n=>hasNumber(n))))return true;
    // Do not reinterpret the parts of an explicit non-matching date as amounts.
    const masked=content.split('');for(const [start,end] of found.spans)for(let i=start;i<end;i++)masked[i]=' ';
    return (retainedNumbers.size>0||retainedRuns.length>0)&&[...numbers(masked.join(''),undefined,retainedNumbers)].some(n=>hasNumber(n));
  };
  // Decode protocol JSON before checking its values. Keys are data too. The
  // same traversal owns current text, history, tools, responses and writes.
  const contains=(value,depth=0,ordinary=false)=>{
    if(depth>32)return true;
    if(typeof value==='string'){
      const decoded=decodePrivateJSON(value);if(decoded!==undefined&&decoded!==value&&contains(decoded,depth+1,ordinary))return true;
      return matchText(value,ordinary);
    }
    if(typeof value==='number'||typeof value==='bigint')return matchText(String(value),ordinary);
    if(value&&typeof value==='object'&&structuredPrivateOrigin(value))return true;
    if(Array.isArray(value))return value.some(item=>contains(item,depth+1,ordinary));
    return value!=null&&typeof value==='object'&&Object.entries(value).some(([key,item])=>matchText(key,ordinary)||contains(item,depth+1,ordinary));
  };
  contains.ordinary=value=>contains(value,0,true);
  contains.spans=(value,{ordinary=false}={})=>{
    const normalized=normalizePrivateText(value),content=normalized.text,ranges=[];
    const origin=privateOriginStart(value);if(origin!==null)ranges.push([origin,String(value??'').length]);
    const add=(start,end)=>{if(end>start&&normalized.origins[start]&&normalized.origins[end-1])ranges.push([normalized.origins[start].start,normalized.origins[end-1].end]);};
    for(const match of partyMatches(content,ordinary,value))add(match.index,match.index+match[0].length);
    for(const pattern of literals)for(const match of content.matchAll(new RegExp(pattern.source,'gu')))add(match.index,match.index+match[0].length);
    const found=dates(content),masked=content.split('');
    for(const [i,current] of found.values.entries()){
      const [start,end]=found.spans[i];
      if(retainedDates.some(saved=>saved.month===current.month&&saved.day===current.day&&(saved.year==null||current.year==null||saved.year===current.year))
        ||[...numeric(content.slice(start,end))].some(n=>hasNumber(n)))add(start,end);
      for(let j=start;j<end;j++)masked[j]=' ';
    }
    numbers(masked.join(''),(keys,start,end)=>{if(keys.some(key=>hasNumber(key)))add(start,end);},retainedNumbers);
    return ranges;
  };
  return contains;
}

// Preserve any syntactically independent ordinary clause, with a dependency
// veto rather than an intent allowlist. Never redact fields inside a sentence.
export function ordinaryPart(message,isPrivate,privateSpans=()=>[]){
  const text=String(message||'');if(!isPrivate(text))return {text,mixed:false};
  // Protocol JSON and punctuation inside values are not ordinary clauses.
  if(decodePrivateJSON(text)!==undefined)return {text:'',mixed:true};
  const valuePart=word=>/^[0-9]+$/.test(word)||numberWords.has(word)||ordinals.includes(word)||new RegExp(`^${monthPattern}$`,'u').test(word);
  const protectedRanges=privateSpans(text),clauses=[];let start=0;
  const retain=(start,end)=>{if(!protectedRanges.some(([a,b])=>start<b&&end>a))clauses.push(text.slice(start,end).trim());};
  for(const boundary of text.matchAll(/[;!?]+|\n+|\.(?=\s|$)|,\s+(?:also\s+)?|\s+(?:and also|also|and)\s+/giu)){
    const left=clean(text.slice(0,boundary.index)).match(/([\p{L}\p{N}]+)[,\p{Quotation_Mark}]*$/u)?.[1];
    const right=clean(text.slice(boundary.index+boundary[0].length)).match(/^[,\p{Quotation_Mark}]*([\p{L}\p{N}]+)/u)?.[1];
    if(/[\n.]/.test(boundary[0])&&valuePart(left||'')&&valuePart(right||''))continue;
    retain(start,boundary.index);start=boundary.index+boundary[0].length;
  }
  retain(start,text.length);
  const dependent=/\b(?:it|this|that|these|those|above|below|instead|same|them|their|its|former|latter)\b|^(?:and|but|or|because|so|then|today|tomorrow|yesterday|later|due|do not|don't|never|no changes|no writes)\b/i;
  return {text:clauses.filter(clause=>clause&&!isPrivate(clause)&&!dependent.test(clean(clause))&&/[\p{L}]/u.test(clause)
    &&!clean(clause).split(/[ ,&-]+/u).every(word=>numberWords.has(word))).join('. '),mixed:true};
}
