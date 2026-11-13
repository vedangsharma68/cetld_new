import {sharedCalendarComponents} from './private-calendar-components.mjs';
import {personalObjectVerbs,personalNounHeads,recipientVerbs,countNouns} from './private-reference-frames.mjs';
import {privateWordIndex} from './private-runtime-lexicon.mjs';
const personalHeads={has:privateWordIndex(personalNounHeads)};
const personObjectPredicates={has:privateWordIndex(personalObjectVerbs)};
const recipientPredicates=privateWordIndex(recipientVerbs),countNoun=privateWordIndex(countNouns);
import {PRIVATE_UNICODE_FOLD} from './private-value-unicode.mjs';
import {createHash} from 'node:crypto';
import {canonicalNumberRole as numericRole,privateCalendarExclusive} from './private-number-role.mjs';
import {privateLanguageSyntax,privateLanguageTags} from './private-language-syntax.mjs';
import {magnitudeAliases,fractionModifiers,numeralContentWords,privateNumeralSpanPattern,numericQuantifiers,grammarDeterminers,mixedFractionPattern,numeralTokenPattern,privateOriginTupleStart,privatePersonalPrefixes,privatePersonalHonorifics,privatePersonalCases,calendarRelations,privateQuantitySeparator,privateCalendarWitnessPattern,privatePersonalMorphologyPattern,privateNativeStemForms,privateTamilDependentMorphologyPattern,privateNativeAttachment,privateDateScanPatterns} from './private-value-language.mjs';
import {PRIVATE_DATE_YEAR_PIVOT,months,monthPattern,ordinals,units,small,scales,fractions,evidenceLabel,evidenceNumericLabel,evidenceDateLabel,currencyUnitPattern,numericCurrencyBefore,numericCurrencyAfter,namedDatePatterns,privateDocumentKeyPattern,privateOriginHeader,privateOriginLexicalHint,privateOriginRecordHeader,privateOriginClauseBoundary,privateNameAbbreviations,originDateCommaPattern,lexicalAliases,partyTransliteration,partyReference,partyGrammarWords,grammarAuxiliaries,partyFunctionWords,numericSelectionWords,numericCollectiveWords,privateOriginEvent,privateOriginNoun,privateOriginCarrier,privateOriginDocumentPrefix,privateOriginPartyLabel,privateOriginMonetaryBefore,privateOriginDateBefore,privateOriginLiteralLabel,privateOriginRelationStart,privateOriginRelationEnd,privateOriginPronouns,privateOriginCopulas,privateOriginGenericPartyStart,privateOriginActorTail,privateOriginPersonalSubject,privateOriginNameEdge,privateJSONPadding,PRIVATE_NUMBER_LIST_MAX_GROUPS} from './private-value-language.mjs';
// One code-point fold, shared verbatim with SQL, independent of DB/OS locale.
export const normalizePrivateValue=value=>Array.from(String(value??''),ch=>PRIVATE_UNICODE_FOLD[ch]??ch).join('').replace(/ +/g,' ').trim();
const clean=normalizePrivateValue;
let dependentMorphology,personalMorphology;
const affixMatch=(tail,dependent=false)=>{if(!tail)return false;return dependent?(dependentMorphology??=new RegExp(privateTamilDependentMorphologyPattern(clean),'u')).test(tail):(personalMorphology??=new RegExp(privatePersonalMorphologyPattern(clean),'u')).test(tail);};
let wordSegmenter,graphemeSegmenter;
const personalPrefixes=privatePersonalPrefixes.map(clean),personalHonorifics=privatePersonalHonorifics.map(clean),personalCases=privatePersonalCases.map(clean);
function lexicalText(input){const origins=[],chunks=[];for(const m of input.matchAll(/[\p{L}\p{M}]+|[^\p{L}\p{M}]+/gu)){const part=Object.hasOwn(lexicalAliases,m[0])?lexicalAliases[m[0]]:m[0];chunks.push(part);for(let i=0;i<part.length;i++)origins.push(Object.hasOwn(lexicalAliases,m[0])?{start:m.index,end:m.index+m[0].length,translated:true}:{start:m.index+i,end:m.index+i+1});}return {text:chunks.join(''),origins};}
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
  const values=new Set();
  if(value.includes('/')){const f=/^(?:([0-9]+) +)?([0-9]+) *\/ *([0-9]+)$/.exec(value);if(!f||BigInt(f[3])===0n)return values;const unit=10n**20n,n=(BigInt(f[1]||'0')*BigInt(f[3])+BigInt(f[2]))*unit/BigInt(f[3]),v=exact(String(n/unit),String(n%unit).padStart(20,'0'));return new Set([places?shift(v,places):v]);}
  const integer=groupedInteger(value);
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
const numericRun=value=>{const prepared=scalar(value);return /^[0-9][0-9.,' ]*(?:[kmb])?$/u.test(prepared)&&(prepared.includes(',')||prepared.length>3989||runGroups(prepared)>PRIVATE_NUMBER_LIST_MAX_GROUPS)?prepared:null;};
// A storage row is bounded; the input and its parse graph are not. Chunks carry
// a full-run identity and cardinality, so reconstruction cannot bless a prefix.
const boundedRun=run=>{
 if(run.length<=3989)return ['number-run:'+run];
 const id=createHash('sha256').update(run).digest('hex'),parts=Math.ceil(run.length/3800);
 return Array.from({length:parts},(_,i)=>'number-run:['+[id,i,parts,run.slice(i*3800,(i+1)*3800)].map(x=>JSON.stringify(x)).join(', ')+']');
};
function rationalQuantity(term){const bare=stripCurrency(term),magnitude='(?:'+[...Object.keys(scales),...Object.keys(magnitudeAliases),'hundred'].join('|')+')';return bare.includes('/')&&(bare!==term||new RegExp('^'+mixedFractionPattern+'(?: *'+magnitude+')?$','u').test(bare)||new RegExp('(?:[kmb]| +'+magnitude+')$','u').test(bare));}
// Resolve intrinsic mixed operands before applying collection separators.
function collectionRendering(term){
 if(rationalQuantity(term))return term;
 const rational=term.replace(new RegExp(mixedFractionPattern,'gu'),m=>[...numeric(m)][0]||m);
 const spoken=(lexicalText(term).text.match(/[a-z]+/gu)||[]).some(w=>numberWords.has(w)&&!['and','a'].includes(w));
 return rational.replace(new RegExp(privateQuantitySeparator,'gu'),token=>spoken&&token==='and'?token:'|').replace(/ *[|] */gu,'|').replace(/^[|]+|[|]+$/gu,'');
}
export const privateNumberKeys=(value,enumeration=false)=>{
 const term=clean(value),run=numericRun(term);
 if(enumeration){const rendered=collectionRendering(term);if(rendered.includes('|'))return [...new Set(rendered.split('|').flatMap(part=>privateNumberKeys(part,true)))];if(rendered!==term){const keys=new Set((term.includes('/')&&!rationalQuantity(term)?[]:[...numeric(term),...wordRuns(term)]).map(n=>'number:'+n));privateNumberKeys(rendered,true).forEach(k=>keys.add(k));return [...keys];}}
 // Long runs keep their entire parse graph in one key. No atomic member or
 // grouping is lost: membership is resolved against the supplied restatement.
 if(run&&run.length>3989)return boundedRun(run);
 if(run&&runGroups(run)>PRIVATE_NUMBER_LIST_MAX_GROUPS)return [...numeric(term)].filter(n=>n.length<=3993).map(number=>'number:'+number).concat(boundedRun(run));
 const keys=[...numericList(term,enumeration)].map(number=>'number:'+number);
 if(enumeration&&/[a-z]/u.test(term))for(const part of term.split(','))for(const n of new Set([...numeric(part),...wordRuns(part)]))keys.push('number:'+n);
 if(run&&(enumeration||!numeric(term).size||/, +/u.test(term)||runGroups(run)>PRIVATE_NUMBER_LIST_MAX_GROUPS))keys.push(...boundedRun(run));
 return keys;
};
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
  if(!new RegExp(privateCalendarWitnessPattern,'u').test(text))return {values:[],spans:[],maskSpans:[]};
  const mixed=[...text.matchAll(new RegExp(mixedFractionPattern,'gu'))].filter(m=>numeric(m[0]).size);
  const values=[],spans=[],candidates=[],ranges=[];
  const add=(y,m,d,match)=>{
   const dateLabel=new RegExp(privateOriginDateBefore,'u').test(text.slice(0,match.index));
   if(!dateLabel&&(new RegExp(privateOriginMonetaryBefore,'u').test(text.slice(0,match.index))||new RegExp(numericCurrencyBefore,'u').test(text.slice(0,match.index))||new RegExp(numericCurrencyAfter,'u').test(text.slice(match.index+match[0].length))))return;
   if(mixed.some(span=>span.index<=match.index&&span.index+span[0].length>=match.index+match[0].length))return;
   if(/^[0-9 ./-]+$/u.test(match[0])&&new RegExp('^ *(?:'+[...Object.keys(scales),...Object.keys(magnitudeAliases),'hundred'].join('|')+')(?![a-z])','u').test(text.slice(match.index+match[0].length)))return;
   candidates.push({value:dateValue(y,Number(m),Number(d)),start:lexical.origins[match.index]?.start??match.index,end:lexical.origins[match.index+match[0].length-1]?.end??match.index+match[0].length});
  };
  const tokens=[...text.matchAll(/[\p{L}\p{M}]+|[0-9]+/gu)],patterns=privateDateScanPatterns.map(p=>new RegExp('^'+p+'(?![\\p{L}\\p{N}_])','u'));
  for(let i=0;i<tokens.length;i++){
   const a=tokens[i].index;if(/[\p{L}\p{N}_]$/u.test(text.slice(Math.max(0,a-2),a)))continue;
   // Every supported date consumes at most six lexical tokens. One context
   // token keeps the scan linear without inventing a text-length ceiling.
   const last=tokens[Math.min(i+6,tokens.length-1)],chunk=text.slice(a,last.index+last[0].length);
   for(let kind=0;kind<patterns.length;kind++){
    const match=patterns[kind].exec(chunk);if(!match)continue;match.index=a;
    if(/^[\p{L}\p{N}_]/u.test(text.slice(a+match[0].length,a+match[0].length+2)))continue;
    if(kind===0){
     if(match[1].length===4&&match[2].length<=2&&match[3]!=null&&match[3].length<=2)add(Number(match[1]),match[2],match[3],match);
     else if(match[1].length<=2&&match[2].length<=2&&(match[3]==null||[2,4].includes(match[3].length))){const y=yearValue(match[3]);add(y,match[2],match[1],match);add(y,match[1],match[2],match);}
     else add(NaN,NaN,NaN,match);
    }else{
     const day=match[kind===1?1:2],month=match[kind===1?2:1];add(match[3]?.length>4?NaN:yearValue(match[3]),months.indexOf(month.slice(0,3))+1,dayValue(day),match);
    }
   }
  }
  const shared=sharedCalendarComponents(text,monthPattern).map(group=>({...group,start:lexical.origins[group.start]?.start??group.start,end:lexical.origins[group.end-1]?.end??group.end}));
  for(const group of shared){for(const range of group.ranges||[])ranges.push(range);}
  for(const group of shared)for(const v of group.values)candidates.push({value:dateValue(v.year,v.month,v.day),start:group.start,end:group.end,shared:true});
  for(let i=candidates.length-1;i>=0;i--)if(!candidates[i].shared&&shared.some(g=>g.start<=candidates[i].start&&g.end>=candidates[i].end))candidates.splice(i,1);
  // Invalid maximal lexemes suppress their own suffixes. Accepted dates then
  // exclude crossing interpretations made from parts of adjacent endpoints.
  candidates.sort((a,b)=>a.start-b.start||b.end-a.end);
  let coverStart=-1,coverEnd=-1,acceptedStart=-1,acceptedEnd=-1;
  for(const c of candidates){
   const sameAccepted=c.start===acceptedStart&&c.end===acceptedEnd;
   if(c.start<acceptedEnd&&!sameAccepted)continue;
   if(c.end<=coverEnd&&(c.start>coverStart||c.end<coverEnd))continue;
   if(c.end>coverEnd){coverStart=c.start;coverEnd=c.end;}
   if(c.value){values.push(c.value);spans.push([c.start,c.end]);acceptedStart=c.start;acceptedEnd=c.end;}
  }
  const maskSpans=spans.filter(([a,b])=>privateCalendarExclusive(original,a,b));
return {values,spans,maskSpans,ranges};
}
const numberWords=new Set([...numeralContentWords,'and','a']);
function wordNumber(words){
  if(!words.length||words.every(word=>['and','a'].includes(word)))return [];
  if(words.some(w=>magnitudeAliases[w])&&words.every(w=>magnitudeAliases[w]||['and','a'].includes(w)))return [];
  words=words.map(word=>magnitudeAliases[word]||word);
  if(words.length===1){const direct=numeric(words[0]);if(direct.size)return [...direct];}
  const factor=scales[words.at(-1)]||(words.at(-1)==='hundred'?100n:1n);
  if(factor!==1n&&words.some(word=>word==='point'||fractions[word]||fractionModifiers[word]||word.includes('/')||/^[0-9]+[.,][0-9]+$/.test(word)))return wordNumber(words.slice(0,-1)).map(value=>shift(value,factor.toString().length-1));
  if(words.at(-1).includes('/')){
    const tail=[...numeric(words.at(-1))],base=words.length===1?['0']:wordNumber(words.slice(0,-1));
    return base.flatMap(a=>tail.map(b=>{const [ai,af='']=a.split('.'),[bi,bf='']=b.split('.'),places=Math.max(af.length,bf.length),unit=10n**BigInt(places),n=BigInt(ai)*unit+BigInt(af.padEnd(places,'0'))+BigInt(bi)*unit+BigInt(bf.padEnd(places,'0'));return exact(String(n/unit),String(n%unit).padStart(places,'0'));}));
  }
  if(fractionModifiers[words[0]]){
    const modifier=fractionModifiers[words[0]],base=words.length>1?wordNumber(words.slice(1)):[String(modifier.base)];
    return base.flatMap(value=>{const [a,b='']=value.split('.'),places=Math.max(20,b.length),unit=10n**BigInt(places),n=BigInt(a)*unit+BigInt(b.padEnd(places,'0'))+BigInt(modifier.numerator)*unit/BigInt(modifier.denominator);return n<0n?[]:[exact(String(n/unit),String(n%unit).padStart(places,'0'))];});
  }
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
    if(!run.some(token=>numberWords.has(token.word)&&!['and','a'].includes(token.word)||token.word.includes('/')||lexical.origins[token.start]?.translated)){run=[];return;}
    // Delimiters after a numeral do not belong to its value/span. In a typed
    // projection the following date may already be masked with spaces.
    while(run.length&&['and','a'].includes(run.at(-1).word))run.pop();
    for(let start=0;start<run.length;){
      let end=run.length,found=[];
      for(;end>start;end--){found=wordNumber(run.slice(start,end).map(token=>token.word));if(found.length)break;}
      if(end===start){start++;continue;}
      onSpan?.(found,lexical.origins[run[start].start]?.start??run[start].start,lexical.origins[run[end-1].end-1]?.end??run[end-1].end);found.forEach(n=>values.add(n));start=end;
    }
    run=[];
  };
  for(const span of text.matchAll(new RegExp(privateNumeralSpanPattern,'gu'))){
   for(const token of span[0].matchAll(new RegExp(numeralTokenPattern,'gu'))){
    const word=token[0],index=span.index+token.index;if(/^[, &-]+$/.test(word)){if(word.includes(',')||word.includes('&'))run.push({word:'and',start:index,end:index+word.length});continue;}
    if(numberWords.has(word)||numeric(word).size>0)run.push({word,start:index,end:index+word.length});else flush();
   }
   flush();
  }
  flush();return values;
}

function numbers(text,onSpan,targets=new Set()){
  const original=text,emit=(values,start,end,enumeration=false)=>{
    const before=new RegExp(numericCurrencyBefore,'u').exec(original.slice(0,start)),after=new RegExp(numericCurrencyAfter,'u').exec(original.slice(end));
    onSpan?.(values,before?.index??start,end+(after?.[0].length??0),enumeration);
  };
  text=separateUnits(text);const roleSource=text;const masked=text.split(''),keys=wordRuns(text,(values,start,end)=>{const part=original.slice(start,end),rational=part.includes('/')&&(rationalQuantity(part)||new RegExp(numericCurrencyBefore,'u').test(original.slice(0,start))||new RegExp(numericCurrencyAfter,'u').test(original.slice(end))||new RegExp(privateOriginMonetaryBefore,'u').test(original.slice(0,start)));const role=numericRole(roleSource,start,end),enumeration=!rational&&(role==='collection'||part.includes('/')&&role==='unknown');if(enumeration){if(part.includes('/'))values.splice(0);for(const key of privateNumberKeys(part,true))if(/^number:/.test(key)&&!values.includes(key.slice(7)))values.push(key.slice(7));}emit(values,start,end,enumeration);for(let i=start;i<end;i++)masked[i]=' ';});text=masked.join('');
  for(const match of text.matchAll(/[0-9]+(?:[., \p{Quotation_Mark}ʼ]+[0-9]+)*(?:[kmb])?/gu)){
    if(/[\p{L}\p{N}_]$/u.test(text.slice(0,match.index))||/^[\p{L}\p{N}_]/u.test(text.slice(match.index+match[0].length)))continue;
    const enumeration=numericRole(roleSource,match.index,match.index+match[0].length)==='collection',found=[...numericList(match[0],enumeration)];
    const run=numericRun(match[0]);
    if(run&&(enumeration||!numeric(match[0]).size||/, +/u.test(match[0])||runGroups(run)>PRIVATE_NUMBER_LIST_MAX_GROUPS)){
      const graph=compileNumericRun(run,enumeration);for(const key of targets)if(!found.includes(key)&&runHas(graph,key))found.push(key);
    }
    found.forEach(value=>keys.add(value));
    if(found.length)emit(found,match.index,match.index+match[0].length,enumeration);
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
export const privatePartyKeys=value=>{const term=clean(value),parts=term.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);return parts.filter(part=>partyComponent(part)&&!(parts.length>1&&privateNameAbbreviations.includes(part)&&new RegExp('(?<![a-z0-9_])'+part+'[.]','u').test(term))).flatMap(part=>/[\u0900-\u097f]/u.test(part)?['party-native:'+part,'party-latin:'+partyKey(part)]:[(partyFunctionWords.includes(part)?'party-ref:':'party:')+partyKey(part)]);};

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
  const normalized=clean(value.replace(/[\r\n]/g,';'));if(new RegExp(privateOriginLexicalHint,'u').test(normalized)&&new RegExp(privateOriginHeader,'u').test(normalized))yield value;
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
 const normalized=normalizePrivateText(String(value??'').replace(/[\r\n]/g,';'));if(!new RegExp(privateOriginLexicalHint,'u').test(normalized.text))return null;
 const start=originPosition(normalized.text);return start===null?null:normalized.origins[start]?.start??0;
}
function* originBoundaries(text){for(const match of text.matchAll(new RegExp(privateOriginClauseBoundary,'gu'))){if(match[0]==='.'){const word=text.slice(0,match.index).match(/[\p{L}\p{M}]+$/u)?.[0];if(word&&(Array.from(word).length===1||privateNameAbbreviations.includes(word)))continue;}yield match.index;}}
function originClauseBoundary(prefix){let boundary=0;for(const index of originBoundaries(prefix))boundary=index+1;return boundary;}
// Functional bridges introduce another tuple participant; their lexical roles
// are not part of that participant's identity. Source proper-name tokens stop
// traversal, including formal names that overlap a function word.
function tupleParticipant(value,properNames){
 value=value.replace(new RegExp(privateOriginTupleStart,'u'),'');
 for(;;){const words=[...value.matchAll(/[\p{L}\p{M}]+/gu)],first=words[0],next=words[1];if(!first||properNames.has(first[0]))break;
  const tags=privateLanguageTags(first[0]),nextTags=next?privateLanguageTags(next[0]):[];
  if(!tags.some(t=>['IN','TO','CC','RB','RBR','RBS'].includes(t))&&!(tags[0]==='NN'&&nextTags.some(t=>['IN','TO'].includes(t))))break;
  value=value.slice(first.index+first[0].length).trim();
 }
 return value.replace(new RegExp(privateOriginRelationStart,'u'),'').replace(new RegExp(privateOriginRelationEnd,'u'),'');
}
const nameValue=value=>value.trim().replace(new RegExp(privateOriginNameEdge,'gu'),'').replace(/^[\p{Quotation_Mark}ʼ]+|[\p{Quotation_Mark}ʼ]+$/gu,'').trim();
function privateOriginFields(value,sourceNames){
 if(decodePrivateJSON(String(value))!==undefined)return null;
 const start=privateOriginStart(value);if(start===null)return null;
 const properNames=sourceNames||new Set([...String(value??'').matchAll(/[\p{L}\p{M}]+/gu)].filter(m=>/^\p{Lu}/u.test(Array.from(m[0])[0])).map(m=>clean(m[0])));
 const source=clean(String(value??'').slice(start).replace(/[\r\n]+/g,',')).replace(new RegExp(originDateCommaPattern,'gu'),'$1 $2'),working=lexicalText(source).text,fields=[],numberRanges=[],masked=working.split(''),mask=(a,b)=>{for(let i=a;i<b;i++)masked[i]=' ';};
 let recordEnd=0;const record=new RegExp(privateOriginRecordHeader.slice(1),'u').exec(working);
 if(record){const a=record.index+record[0].length;recordEnd=a;const identity=/^[\p{L}\p{N}][\p{L}\p{N}._/-]*/u.exec(working.slice(a));if(identity){fields.push({value:identity[0],number:false,party:false});recordEnd=a+identity[0].length;}mask(record.index,recordEnd);}
 // A field's type precedes its interpretation: Total 31.10 is money, while
 // Due 31.10 is a date. Named/full dates remain date-bearing without a label.
 numbers(masked.join(''),(keys,a,b,enumeration)=>{const label=new RegExp(privateOriginMonetaryBefore,'u').exec(working.slice(0,a));if(label||new RegExp(mixedFractionPattern,'u').test(working.slice(a,b))){fields.push({value:working.slice(a,b),number:true,party:false,keys,enumeration});numberRanges.push([a,b]);mask(label?.index??a,b);}});
 const parsed=dates(masked.join(''));
 for(const [a,b] of parsed.maskSpans){if(!parsed.spans.some(([x,y])=>x===a&&y===b)&&working.slice(a,b).includes('/')){const label=new RegExp(privateOriginDateBefore,'u').exec(working.slice(0,a));fields.push({value:working.slice(a,b),number:false,party:false});if(label||parsed.maskSpans.some(([x,y])=>x===a&&y===b))mask(label?.index??a,b);}}
 for(const [i,[a,b]] of parsed.spans.entries()){
  const label=new RegExp(privateOriginDateBefore,'u').exec(working.slice(0,a));
  if(parsed.values[i].year===null&&/^[0-9][0-9 ./-]*$/u.test(working.slice(a,b))&&!label&&privateCalendarExclusive(working,a,b))continue;
  fields.push({value:working.slice(a,b),number:false,party:false});if(label||parsed.maskSpans.some(([x,y])=>x===a&&y===b))mask(label?.index??a,b);
 }
 numbers(masked.join(''),(keys,a,b,enumeration)=>{fields.push({value:working.slice(a,b),number:true,party:false,keys,enumeration});numberRanges.push([a,b]);mask(a,b);});
 const remaining=masked.join(''),stop=[...originBoundaries(remaining)].find(index=>remaining[index]!==';'),limit=stop===undefined?remaining.length:stop,partyText=remaining.slice(0,limit);
 const addParty=(value,strong=false)=>{value=nameValue(value);if(!value||!/[\p{L}]/u.test(value))return;const words=value.match(/[\p{L}\p{M}]+/gu)||[];
  if(strong&&words.some(w=>!properNames.has(w)&&/^(?:VB|VBD|VBP|VBZ)$/.test(privateLanguageTags(w)[0]||'')&&!privateLanguageTags(w).some(t=>['NN','NNS','JJ'].includes(t))))return;
  const properSurface=words.length===1&&properNames.has(words[0]);
  const functionName=(strong||properSurface)&&words.length===1&&(properSurface||!privateOriginPronouns.includes(words[0]))&&partyFunctionWords.includes(words[0]);
  const possessiveName=strong&&words.length>1&&['my','our','your','his','her','their','its'].includes(words[0]);
  if(words.length===1&&!properSurface&&privateLanguageTags(words[0]).some(tag=>['RB','RBR','RBS'].includes(tag)))return;
  if(words.length&&!functionName&&(!possessiveName&&privateOriginPronouns.includes(words[0])||grammarAuxiliaries.includes(words[0])||words.every(w=>privateOriginPronouns.includes(w))))return;
  if(!strong&&words.length&&(words.slice(1).some(w=>privateOriginCopulas.includes(w))||new RegExp(privateOriginGenericPartyStart,'u').test(value)))return;fields.push({value,number:false,party:true,strong});};
 const label=new RegExp(privateOriginPartyLabel,'u').exec(partyText);
 if(label)addParty(partyText.slice(label.index+label[0].length),true);
  const doc=new RegExp(privateOriginNoun,'u').exec(working),event=new RegExp(privateOriginEvent,'u').exec(working),carrier=doc?[...working.slice(0,doc.index).matchAll(new RegExp(privateOriginCarrier,'gu'))].at(-1):null;
 if(event){const actor=event[0].replace(new RegExp(privateOriginActorTail,'u'),'').trim();if(actor!==event[0].trim()&&!new RegExp(privateOriginPersonalSubject,'u').test(actor))addParty(actor);}
  if(carrier){let before=partyText.slice(carrier.index+carrier[0].length,doc.index).trim().replace(/(?:^| +)(?:a|an|the|my|our|this|that)$/u,'');before=before.replace(new RegExp(privateOriginRelationStart,'u'),'');addParty(before,numberRanges.length>0);}
 if(record){
  for(const [index,part] of partyText.slice(recordEnd).split(/[,;]/u).entries()){
   let candidate=nameValue(part);if(index===0&&!new RegExp(privateOriginRelationStart,'u').test(candidate))continue;candidate=candidate.replace(new RegExp(privateOriginRelationStart,'u'),'');if(!candidate||/^(?:notes?|currency|date|due|total|subtotal|tax|amount|balance|rate|quantity)\b/u.test(candidate))continue;
   if(new RegExp(privateOriginPartyLabel,'u').test(candidate))continue;
   addParty(candidate,true);
  }
 }else{
  const head=event??doc;
  if(head){
   const begin=head.index+head[0].length,rawTail=working.slice(begin),relation=new RegExp(privateOriginRelationStart,'u').test(rawTail.trim()),intro=/\b(?:here|below|following|attached) +(?:is|are)\b/u.test(working.slice(0,head.index));
   if(event||carrier||relation||intro||/^[ ,:]/u.test(rawTail)&&/^[,:]/u.test(rawTail.trim())){
    const amount=numberRanges.filter(([a])=>a>=begin&&a<limit).sort((a,b)=>a[0]-b[0])[0];
    let before=nameValue(partyText.slice(begin,amount?.[0]??limit)).replace(new RegExp(privateOriginRelationStart,'u'),'').replace(new RegExp(privateOriginRelationEnd,'u'),'');before=nameValue(before);addParty(before,Boolean(amount));
    if(amount){const after=partyText.slice(amount[1]).trim();if(new RegExp(privateOriginRelationStart,'u').test(after))addParty(after.replace(new RegExp(privateOriginRelationStart,'u'),''),true);}
    // Coordinates inherit the same participant/quantity roles as the first
    // argument; walk all spans rather than taking a first-match party window.
    const argumentsInFrame=numberRanges.filter(([a])=>a>=begin&&a<limit).sort((a,b)=>a[0]-b[0]);
    for(let i=1;i<argumentsInFrame.length;i++){
     const between=partyText.slice(argumentsInFrame[i-1][1],argumentsInFrame[i][0]);
     if(new RegExp(privateOriginTupleStart,'u').test(between))addParty(tupleParticipant(between,properNames),true);
    }
   }
  }
 }
 const literal=new RegExp(privateOriginLiteralLabel,'u').exec(working);if(literal){const payload=working.slice(literal.index+literal[0].length).trim();if(payload)fields.push({value:payload,number:false,party:false});}
 return {source,fields};
}
export const privateOriginValues=value=>{const parsed=privateOriginFields(value);return parsed?[parsed.source,...parsed.fields.map(field=>field.value)]:[];};
function privateOriginSegmentKeys(value,sourceNames){
  const parsed=privateOriginFields(value,sourceNames);if(!parsed)return [];
  return [...new Set([...(Array.from(parsed.source).length<=3993?['origin:'+parsed.source]:[]),...privateFieldKeys(parsed.source),...parsed.fields.flatMap(field=>{
  const words=field.value.match(/[\p{L}\p{M}]+/gu)||[],inferred=field.party&&!field.strong;
  const keys=field.party&&(partyFunctionWords.includes(clean(field.value))||inferred)?[]:privateFieldKeys(field.value),numeric=keys.filter(key=>/^number(?:-run)?:/.test(key));
  const parties=field.party?privatePartyKeys(field.value).map(key=>inferred?key.replace(/^party(?:-ref)?:/u,'party-inferred:'):key):[];
  return [...(field.number?(privateNumberKeys(field.value,field.enumeration).length?privateNumberKeys(field.value,field.enumeration):(field.keys||[]).map(n=>'number:'+n)):keys),...parties];
 })])];
}
// One complete record plus every independent declaration frame. Frames are
// bounded by the next head, so later events never cause suffix re-expansion.
export function privateOriginSegments(value){
 if(decodePrivateJSON(String(value))!==undefined)return [];
 const source=clean(String(value??'').replace(/[\r\n]+/g,',')).replace(new RegExp(originDateCommaPattern,'gu'),'$1 $2');
 const prepared=clean(String(value??'').replace(/[\r\n]+/g,';')).replace(new RegExp(originDateCommaPattern,'gu'),'$1 $2');
 const heads=[...prepared.matchAll(new RegExp(privateOriginHeader,'gu'))];
 return heads.slice(1).map((head,i)=>source.slice(head.index,heads[i+2]?.index??source.length));
}
export function privateOriginKeys(value){
 const names=new Set([...String(value??'').matchAll(/[\p{L}\p{M}]+/gu)].filter(m=>/^\p{Lu}/u.test(Array.from(m[0])[0])).map(m=>clean(m[0])));
 return [...new Set([privateOriginSegmentKeys(value,names),...privateOriginSegments(value).map(segment=>privateOriginSegmentKeys(segment,names))].flat())];
}
// Canonical keys for a retained atomic field. SQL term_aliases is generated
// from the same grammar; parity tests compare these exact key sets.
export function privateFieldKeys(value){
  const raw=clean(value);if(!raw)return [];
  if(Array.from(raw).length>4000){
   const direct=privateNumberKeys(raw);if(direct.length)return direct;
   const keys=new Set(),parsed=dates(raw),masked=raw.split('');
   for(const [i,[a,b]] of parsed.spans.entries()){const {year,month,day}=parsed.values[i];keys.add('date:'+(year==null?'*':String(year).padStart(4,'0'))+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0'));}
   for(const range of parsed.ranges||[])keys.add('date-range:'+range.map(v=>(v.year==null?'*':String(v.year).padStart(4,'0'))+'-'+String(v.month).padStart(2,'0')+'-'+String(v.day).padStart(2,'0')).join('/'));
   for(const [a,b] of parsed.maskSpans)for(let j=a;j<b;j++)masked[j]=' ';
   numbers(masked.join(''),(values,a,b,enumeration)=>{const direct=privateNumberKeys(raw.slice(a,b),enumeration);direct.forEach(k=>keys.add(k));if(!direct.length)values.forEach(n=>{if(n.length<=3993)keys.add('number:'+n);else boundedRun(n).forEach(k=>keys.add(k));});});
   return [...keys];
  }
  const term=raw.replace(/^[\p{Quotation_Mark}ʼ]+|[\p{Quotation_Mark}ʼ]+$/gu,''),keys=new Set([raw]),parsed=dates(term),date=parsed.values.filter((value,index)=>{const [a,b]=parsed.spans[index];return ['','the'].includes(term.slice(0,a).trim())&&/^[., ]*$/.test(term.slice(b));});
  if(!(/^[0-9]{1,2} *\/ *[0-9]{1,2}$/u.test(term)||date.length&&term.includes('/')))for(const key of privateNumberKeys(term))keys.add(key);
  const spoken=stripCurrency(lexicalText(stripCurrency(term)).text),words=spoken.match(/[a-z]+/g)||[];
  if(!(/^[0-9]{1,2} *\/ *[0-9]{1,2}$/u.test(term)||date.length&&term.includes('/'))&&words.every(word=>numberWords.has(word))){for(const n of numeric(spoken))keys.add('number:'+n);for(const n of wordRuns(lexicalText(term).text===term?spoken:term))keys.add('number:'+n);}
  for(const range of date.length?parsed.ranges||[]:[])keys.add('date-range:'+range.map(v=>(v.year==null?'*':String(v.year).padStart(4,'0'))+'-'+String(v.month).padStart(2,'0')+'-'+String(v.day).padStart(2,'0')).join('/'));
  for(const {year,month,day} of date)keys.add('date:'+(year==null?'*':String(year).padStart(4,'0'))+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0'));
  if(keys.size===1){const key=identifier(term);if(key)keys.add('identifier:'+key);}
  return [...keys];
}
export function createPrivateValueMatcher(terms=[],{canonical=false}={}){
  const retainedRuns=[],retainedNumbers=new Set(),retainedDates=[],retainedDateRanges=[],literals=[],parties=new Set(),nativeParties=new Set(),latinParties=new Set(),referenceParties=new Set(),inferredParties=new Set();
  const expanded=terms.flatMap(raw=>String(raw??'').startsWith('evidence:')?privateEvidenceValues(String(raw).slice(9)):String(raw??'').startsWith('origin:')?privateOriginKeys(String(raw).slice(7)).filter(key=>!key.startsWith('origin:')):[raw]);
  const attested=new Set(expanded.filter(t=>/^party(?:-native|-latin|-inferred|-ref)?:/.test(t)).map(t=>t.slice(t.indexOf(':')+1)));
  const chunks=new Map();
  const invalidGraph=()=>{throw Object.assign(new Error('Incomplete private numeric graph'),{code:'CHAT_MEMORY_UNAVAILABLE'});};
  const compile=term=>{
    if(term.startsWith('date-range:')){const pair=term.slice(11).split('/').map(x=>/^(\*|[0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(x));if(pair.length===2&&pair.every(Boolean))retainedDateRanges.push(pair.map(p=>({year:p[1]==='*'?null:Number(p[1]),month:Number(p[2]),day:Number(p[3])})));return true;}
    if(term.startsWith('number-run:')){
     const body=term.slice(11);
     if(body.startsWith('[')){
      let part;try{part=JSON.parse(body);}catch{invalidGraph();}
      if(!Array.isArray(part)||part.length!==4||!/^[a-f0-9]{64}$/.test(part[0])||!Number.isSafeInteger(part[1])||!Number.isSafeInteger(part[2])||part[1]<0||part[2]<1||part[1]>=part[2]||typeof part[3]!=='string'||!/^[0-9.,' kmb]+$/.test(part[3]))invalidGraph();
      const group=chunks.get(part[0])||{count:part[2],pieces:new Map()};if(group.count!==part[2]||group.pieces.has(part[1])&&group.pieces.get(part[1])!==part[3])invalidGraph();group.pieces.set(part[1],part[3]);chunks.set(part[0],group);
     }else retainedRuns.push(compileNumericRun(body));return true;
    }
    if(/^number:[0-9]+(?:\.[0-9]+)?$/.test(term)){const [a,b]=term.slice(7).split('.');retainedNumbers.add(exact(a,b));return true;}
    const tagged=/^date:(\*|[0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(term);
    if(tagged){const value=dateValue(tagged[1]==='*'?null:Number(tagged[1]),Number(tagged[2]),Number(tagged[3]));if(value)retainedDates.push(value);return true;}
    if(term.startsWith('party-native:')){nativeParties.add(term.slice(13));return true;}
    if(term.startsWith('party-latin:')){latinParties.add(term.slice(12));return true;}
    if(term.startsWith('party-inferred:')){inferredParties.add(term.slice(15));return true;}
    if(term.startsWith('party-ref:')){referenceParties.add(term.slice(10));return true;}
    if(term.startsWith('party:')){parties.add(term.slice(6));return true;}
    if(term.startsWith('identifier:')){if(attested.has(term.slice(11))&&privateLanguageTags(term.slice(11)).length)return true;literals.push(identifierPattern(term.slice(11)));return true;}return false;
  };
  for(const raw of expanded){
    const term=clean(raw);if(!term||compile(term)||attested.has(term))continue;
    const keys=privateFieldKeys(term);if(keys.length>1){keys.slice(1).forEach(compile);continue;}
    literals.push(new RegExp(`(?<![\\p{L}\\p{N}_])${escape(term)}(?![\\p{L}\\p{N}_])`,'u'));
  }
  for(const [id,group] of chunks){
   if(group.pieces.size!==group.count)invalidGraph();const run=Array.from({length:group.count},(_,i)=>group.pieces.get(i)??invalidGraph()).join('');
   if(createHash('sha256').update(run).digest('hex')!==id)invalidGraph();retainedRuns.push(compileNumericRun(run));
  }
  // Closed grammatical classes describe roles, not permitted sentences. A
  // formal component can be a subject, object, possessive or question target.
  // Determiner-led noun phrases, bare lowercase instrumental nouns and a
  // different compound proper name remain ordinary uses of a homograph.
  const determiners=new Set([...grammarDeterminers,'a','an','the','some','this','that','my','our','your','his','her','their']);
  const relations=new Set(['to','from','with','about','by','for','of','in','on','at']);
  const complements=new Set([...relations,'if','whether','when','where','why','how','who','that','now','today','tomorrow','yesterday','recently','please','again','soon','later']);
  const auxiliaries=new Set(grammarAuxiliaries);
  const finitePast=new Set('arose awoke bore beat became began bent bet bid bit bled blew broke bred brought broadcast built burnt bought caught chose came cost crept cut dealt dug did drew dreamt drank drove ate fell fed felt fought found fled flew forbade forgot forgave froze got gave went grew hung had heard hid hit held hurt kept knew laid led leant leapt learnt left lent let lay lit lost made meant met paid put quit read rode rang rose ran said saw sought sold sent set sewed shook shone shot showed shrank shut sang sank sat slept slid smelt spoke spelt spent spilt spun spat split spread sprang stood stole stuck stung stank struck swore swept swam swung took taught tore told thought threw understood woke wore wept won wound wrote'.split(' '));
  const verbs=new Set(['ask','contact','call','pay','send','tell','talk','message','email','thank','meet','met','spoke','speak','came','comes','went','said','says']);
  const upper=value=>/\p{Lu}/u.test(Array.from(value||'')[0]||'');
  const partyMatches=(content,ordinary=false,original=content)=>{
    const normalized=normalizePrivateText(original),occurrences=[...content.matchAll(/[\p{L}\p{M}\p{N}]+/gu)];
    const syntax=parties.size||referenceParties.size||inferredParties.size?privateLanguageSyntax(content):[];
    // Registered spellings are matched independently of script. Multi-grapheme
    // uncased names can carry attached morphology; a single grapheme needs a
    // lexical word boundary so it cannot become a substring blacklist.
    if(/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(content)){
    const lexical=content.normalize('NFC'),lexicalMap=normalizePrivateText(lexical).origins;let cursor=0;
    const words=[...(wordSegmenter??=new Intl.Segmenter(undefined,{granularity:'word'})).segment(lexical)].map(w=>{const a=cursor;while(cursor<lexicalMap.length&&lexicalMap[cursor].start<w.index+w.segment.length)cursor++;return {index:a,segment:content.slice(a,cursor),isWordLike:w.isWordLike};});
    const graphemes=graphemeSegmenter??=new Intl.Segmenter(undefined,{granularity:'grapheme'});
    for(const key of new Set([...parties,...referenceParties,...inferredParties,...nativeParties])){
      const uncased=key.toLowerCase()===key.toUpperCase(),multiple=[...graphemes.segment(key)].length>1;
      for(const m of content.matchAll(new RegExp(privateNativeStemForms(key).map(escape).join('|'),'gu'))){
       const begin=m.index,finish=begin+m[0].length,word=words.find(w=>w.isWordLike&&w.index<=begin&&w.index+w.segment.length>begin);if(!word)continue;
       const prefix=content.slice(word.index,begin),tail=content.slice(finish).match(/^[\p{L}\p{M}]+/u)?.[0]||'',clitic=prefix&&personalPrefixes.includes(prefix)&&/\p{Script=Arabic}/u.test(key);
       if(prefix&&!clitic)continue;
       const honorific=personalHonorifics.find(part=>tail.startsWith(part)),suffix=honorific?tail.slice(honorific.length):tail;
       const personalAffix=tail.length>0&&(affixMatch(tail,m[0]!==key)||privateNativeAttachment(key,tail,m[0]!==key,clean));
       const lexicalEnd=words.some(w=>w.index===finish||w.index+w.segment.length===finish);
       if(!(personalAffix||uncased&&(lexicalEnd||clitic&&tail==='')))continue;
       const old=occurrences.find(n=>n.index===begin&&n[0]===key);if(old)old.personalAffix=personalAffix;else occurrences.push(Object.assign([key],{index:begin,personalAffix}));
      }
    }
    }
    return occurrences.filter(m=>{
      const term=m[0],matched=/[\u0900-\u097f]/u.test(term)?nativeParties.has(term)||parties.has(partyKey(term)):parties.has(partyKey(term))||latinParties.has(partyKey(term));
      const referenceKey=referenceParties.has(partyKey(term)),inferredKey=inferredParties.has(partyKey(term)),weakOnly=inferredKey&&!referenceKey&&!matched;if(!matched&&!referenceKey&&!inferredKey)return false;
      const before=content.slice(0,m.index).split(/[;.!?\n]/u).at(-1),after=content.slice(m.index+term.length).split(/[;.!?\n]/u)[0];
      const beforeWords=before.match(/[\p{L}\p{M}]+/gu)||[],afterWords=after.match(/[\p{L}\p{M}]+/gu)||[],next=afterWords[0],last=beforeWords.at(-1);
      const offset=normalized.origins[m.index]?.start??m.index,end=normalized.origins[m.index+term.length-1]?.end??m.index+term.length;
      const raw=String(original).slice(offset,end),nextRaw=String(original).slice(end).match(/[\p{L}\p{M}]+/u)?.[0];
      const det=beforeWords.findLastIndex(word=>determiners.has(word));
      const proper=upper(raw),apposition=proper&&det>=0&&beforeWords.length>det+1;
      const nominalScope=det>=0&&beforeWords.slice(det+1).every(word=>(!canonical||privateLanguageTags(word).length>0&&!privateLanguageTags(word).some(tag=>/^(VB|VBD|VBP|VBZ|MD|IN|TO)$/.test(tag)&&!privateLanguageTags(word).includes('JJ')))&&!relations.has(word)&&!auxiliaries.has(word)&&!verbs.has(word)&&(!/^VB/.test(privateLanguageTags(word)[0]||'')||privateLanguageTags(word).includes('JJ')));
      const possessive=/^[’'ʼ]s(?:[^\p{L}\p{N}]|$)/u.test(after);
      const continuation=afterWords[1],finiteTail=!continuation||determiners.has(continuation)||complements.has(continuation)||['me','you','him','her','us','them','it'].includes(continuation)||upper(String(original).slice(end).match(/[\p{L}\p{M}]+/gu)?.[1]);
      const regularS=/s$/u.test(next||'')&&!/(?:ss|us|is)$/u.test(next||'')&&!auxiliaries.has(continuation)&&(term!=='the'||['me','you','him','her','us','them','it'].includes(continuation));
      const nextToken=syntax.find(token=>token.start>=m.index+term.length&&/^[\p{L}\p{M}]/u.test(token.word)),nextPOS=nextToken?.pos;
      const currentToken=syntax.find(token=>token.start===m.index&&token.word===term),currentPOS=currentToken?.pos;
      const incompatibleFunction=['a','an'].includes(term)||auxiliaries.has(term);
      const finiteAlternative=nextToken?.alternatives.includes('VBZ')&&!auxiliaries.has(continuation)&&currentPOS!=='JJ'&&(!beforeWords.length||apposition||complements.has(last));
      const predicate=auxiliaries.has(next)||/^(?:VBD|VBZ)$/u.test(nextPOS||'')||(nextPOS==='VBN'||finitePast.has(next)||/ed$/u.test(next||''))&&finiteTail||finiteAlternative||regularS&&(nextPOS!=='NNS'||incompatibleFunction);
      const addressed=verbs.has(last),terminal=!next,prepositional=relations.has(last)&&last!=='by';
      const differentName=proper&&upper(nextRaw)&&!parties.has(partyKey(next))&&!auxiliaries.has(next)&&!complements.has(next);
      const previousToken=syntax.filter(t=>t.end<=m.index).at(-1);
      const personalHead=/^(?:NN|NNP)$/.test(previousToken?.pos||'')&&!/^(?:JJ|JJR|JJS)$/.test(previousToken?.alternatives[0]||'')&&personalHeads.has(previousToken?.word.toLowerCase());
      let governorIndex=syntax.findLastIndex(t=>t.end<=m.index);
      while(governorIndex>=0&&(/^(?:JJ|JJR|JJS|RB|RBR|RBS)$/.test(syntax[governorIndex].pos)||/^(?:JJ|JJR|JJS)$/.test(syntax[governorIndex].alternatives[0]||'')))governorIndex--;
      const governor=syntax[governorIndex],argumentVerb=governor&&!auxiliaries.has(governor.word.toLowerCase())&&/^(?:VB|VBD|VBP|VBZ|VBN)$/.test(governor.pos);
      const recipient=argumentVerb&&recipientPredicates(governor.word.toLowerCase())&&/^(?:DT|PRP\$|NNP|NNS)$/.test(nextPOS||'');
      const bareCount=argumentVerb&&currentPOS==='NN'&&countNoun(term);
      const personalObject=!nominalScope&&argumentVerb&&(personObjectPredicates.has(governor.word.toLowerCase())||recipient||bareCount);
      const subjectToken=syntax.filter(t=>t.end<=(previousToken?.start??0)).at(-1);
      const personalCopula=privateOriginCopulas.includes(previousToken?.word.toLowerCase())&&(subjectToken?.pos==='PRP'&&!['it'].includes(subjectToken.word.toLowerCase())||subjectToken?.pos==='NNP'||personalHeads.has(subjectToken?.word.toLowerCase()));
      const structuralPersonal=canonical&&!nominalScope&&(/^(?:IN|TO|RP)$/.test(governor?.pos||'')||currentPOS==='NN'&&countNoun(term));
      const personal=structuralPersonal||personalCopula||personalHead||personalObject||m.personalAffix||possessive||predicate||apposition||addressed||prepositional&&proper||proper&&beforeWords.length>0&&!determiners.has(last)||terminal&&(addressed||prepositional||proper);
      // An article/modal/instrumental noun has a grammatical role. It does
      // not acquire an entity role merely because a registered name overlaps.
      const pronominal=/^(?:any|some|no|every)(?:thing|one|body)$/u.test(next||'');
      const nominalNext=/^(?:NN|NNS|NNP|NNPS|JJ|JJR|JJS|CD|VBN)$/u.test(nextPOS||'')&&!pronominal;
      const nominalTail=syntax.filter(t=>t.start>=m.index+term.length);
      let completeNoun=false;for(const token of nominalTail){if(/^(?:IN|TO|CC|VB|VBD|VBP|VBZ|MD|[.,;!?])$/u.test(token.pos))break;if(/^(?:NN|NNS|NNP|NNPS)$/u.test(token.pos)&&!token.alternatives.some(t=>/^(?:RB|RBR|RBS)$/.test(t))){completeNoun=true;break;}}
      const articleRole=['a','an','the'].includes(term)&&completeNoun&&(!proper||!beforeWords.length);
      const modalRole=auxiliaries.has(term)&&/^(?:PRP|DT|VB|VBP)$/u.test(nextPOS||'')&&!addressed&&!prepositional&&!auxiliaries.has(last);
      const connectiveRole=partyGrammarWords.includes(term)&&!['a','an','the'].includes(term)&&!auxiliaries.has(term)&&!addressed&&!prepositional&&(!proper||!beforeWords.length);
      const functionUse=!m.personalAffix&&!possessive&&!predicate&&!apposition&&!terminal&&(articleRole||modalRole||connectiveRole);
      const incompleteArticle=['a','an','the'].includes(term)&&!completeNoun;
      const nounUse=!personalObject&&!personalHead&&nominalScope&&!apposition&&!incompleteArticle||last==='by'&&!proper&&(!canonical||referenceKey&&currentPOS==='NN');
      const attributeRole=/^(?:JJ|JJR|JJS)$/u.test(currentPOS||'')&&!personal;
      const imperative=!beforeWords.length&&nextPOS==='DT'&&currentToken?.alternatives.includes('VB');
      const verbRole=(/^(?:VB|VBD|VBP|VBZ|VBG|VBN)$/u.test(currentPOS||'')||imperative)&&!personal;
      const compoundRole=currentToken?.known&&!proper&&/^(?:NN|NNS)$/u.test(currentPOS||'')&&/^(?:NN|NNS)$/u.test(nextPOS||'')&&!personal;
      const cased=term.toUpperCase()!==term.toLowerCase();

      const monthRole=new RegExp('^'+monthPattern+'$','u').test(term)&&calendarRelations.includes(last)&&!predicate;
      const lexicalImperative=!possessive&&!predicate&&!nextToken?.alternatives.includes('VBZ')&&currentToken?.alternatives.includes('VB')&&(completeNoun||/^(?:IN|TO)$/u.test(nextPOS||''))&&(!proper||!beforeWords.length)&&(!beforeWords.length||previousToken?.alternatives.some(t=>['UH','RB','MD','PRP','TO'].includes(t)));

      const bareNominal=!personal&&!proper&&currentPOS==='NN'&&!possessive&&!addressed&&!predicate&&(/^(?:VB|VBD|VBP|VBZ)$/u.test(previousToken?.pos||'')||previousToken?.pos==='JJ');
      if(cased&&(monthRole||lexicalImperative||bareNominal))return false;
      if(cased&&!m.personalAffix&&!possessive&&!apposition&&!addressed&&(functionUse||nounUse&&!proper||attributeRole||verbRole||compoundRole))return false;
      const reference=(referenceKey||inferredKey)&&(content===term||!differentName&&!functionUse&&!nounUse&&(!weakOnly||proper||personal));
      if((!matched&&!reference)||!partyComponent(term))return false;
      if(!ordinary)return true;
      // A linguistic exemption applies only to this occurrence's own clause.
      const clause=before+term+after;
      if(new RegExp(partyReference,'u').test(clause))return true;
      return !(/(?:surname|given name|word|name) +$/u.test(before)&&!after.trim()||/^ +is +(?:a +)?common +(?:surname|given name|word|name) *$/u.test(after)&&!before.trim());
    });
  };
  const insideRange=(date,range)=>{const y=date.year??range[0].year??2000,a=range[0].year??y,b=range[1].year??(range[1].month*32+range[1].day<range[0].month*32+range[0].day?a+1:a);const stamp=(v,year)=>year*512+v.month*32+v.day;return stamp(date,y)>=stamp(range[0],a)&&stamp(date,y)<=stamp(range[1],b);};
  const hasNumber=key=>retainedNumbers.has(key)||retainedRuns.some(run=>runHas(run,key));
  const matchText=(text,ordinary=false)=>{
    const content=clean(text);if(!canonical&&privateOriginStart(text)!==null)return true;if(literals.some(pattern=>pattern.test(content)))return true;
    if(partyMatches(content,ordinary,text).length)return true;
    const found=dates(content);
    if(found.ranges?.some(range=>retainedDates.some(d=>insideRange(d,range)))||found.values.some(d=>retainedDateRanges.some(range=>insideRange(d,range))))return true;
    if(found.values.some(current=>retainedDates.some(saved=>saved.month===current.month&&saved.day===current.day&&(saved.year==null||current.year==null||saved.year===current.year))))return true;
    // A two-part dotted rendering can also be an amount. Compare that whole
    // interpretation before masking date parts; never compare its subvalues.
    if(found.maskSpans.some(([start,end])=>(!content.slice(start,end).includes('/')&&[...numeric(content.slice(start,end))].some(n=>hasNumber(n)))))return true;
    // Do not reinterpret the parts of an explicit non-matching date as amounts.
    const masked=content.split('');for(const [start,end] of found.maskSpans)for(let i=start;i<end;i++)masked[i]=' ';
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
    if(!canonical&&value&&typeof value==='object'&&structuredPrivateOrigin(value))return true;
    if(Array.isArray(value))return value.some(item=>contains(item,depth+1,ordinary));
    return value!=null&&typeof value==='object'&&Object.entries(value).some(([key,item])=>matchText(key,ordinary)||contains(item,depth+1,ordinary));
  };
  contains.ordinary=value=>contains(value,0,true);
  contains.entities=value=>typeof value==='string'&&partyMatches(clean(value),true,value).length>0;
  contains.spans=(value,{ordinary=false}={})=>{
    const normalized=normalizePrivateText(value),content=normalized.text,ranges=[];
    const origin=privateOriginStart(value);if(origin!==null)ranges.push([origin,String(value??'').length]);
    const add=(start,end)=>{if(end>start&&normalized.origins[start]&&normalized.origins[end-1])ranges.push([normalized.origins[start].start,normalized.origins[end-1].end]);};
    for(const match of partyMatches(content,ordinary,value))add(match.index,match.index+match[0].length);
    for(const pattern of literals)for(const match of content.matchAll(new RegExp(pattern.source,'gu')))add(match.index,match.index+match[0].length);
    const found=dates(content),masked=content.split('');
    for(const [i,current] of found.values.entries()){
      const [start,end]=found.spans[i];
      if(retainedDateRanges.some(range=>insideRange(current,range))||found.ranges?.some(range=>retainedDates.some(date=>insideRange(date,range)))||retainedDates.some(saved=>saved.month===current.month&&saved.day===current.day&&(saved.year==null||current.year==null||saved.year===current.year))
        ||(!content.slice(start,end).includes('/')&&[...numeric(content.slice(start,end))].some(n=>hasNumber(n))))add(start,end);
      if(found.maskSpans.some(([a,b])=>a===start&&b===end))for(let j=start;j<end;j++)masked[j]=' ';
    }
    for(const [a,b] of found.maskSpans)for(let j=a;j<b;j++)masked[j]=' ';
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
    // A soft coordinator/appositive cannot detach a registered nominal
    // constituent. A predicate outside the private span is evidence that the
    // left side is a clause, rather than a name in a coordinated noun phrase.
    if(!/^[;!?\n.]$/u.test(boundary[0][0])){
      const named=protectedRanges.some(([a,b])=>a<boundary.index&&b>start&&/[\p{L}\p{M}]/u.test(text.slice(Math.max(a,start),Math.min(b,boundary.index))));
      if(named&&!privateLanguageSyntax(text.slice(start,boundary.index)).some(token=>/^(?:VB|VBD|VBP|VBZ)$/u.test(token.pos)&&!protectedRanges.some(([a,b])=>start+token.start<b&&start+token.end>a)))continue;
    }
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
