import {PRIVATE_UNICODE_FOLD} from './private-value-unicode.mjs';
import {PRIVATE_DATE_YEAR_PIVOT,months,monthPattern,ordinals,units,small,scales,fractions,evidenceLabel,evidenceNumericLabel,evidenceDateLabel} from './private-value-language.mjs';
// One code-point fold, shared verbatim with SQL, independent of DB/OS locale.
export const normalizePrivateValue=value=>Array.from(String(value??''),ch=>PRIVATE_UNICODE_FOLD[ch]??ch).join('').replace(/ +/g,' ').trim();
const clean=normalizePrivateValue;
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
const separateUnits=text=>text.replace(new RegExp(`\\b${units}(?=[0-9])|(?<=[0-9])${units}\\b`,'gu'),match=>' '.repeat(match.length));
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
  value=value.replace(/^\((.*)\)$/u,'$1').replace(/[\p{Quotation_Mark}ʼ]/gu,"'");
  const adornment=new RegExp(`^(?:[+−-]|\\p{Sc}|${units}) *| *(?:\\p{Sc}|${units})$`,'gu');
  for(let prior;prior!==value;){prior=value;value=value.replace(adornment,'').trim();}
  return value.replace(/ *([.,']) */gu,'$1');
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
// Grouping wins when the complete candidate has a valid grouping shape. If it
// does not, comma+space separates lists and invalid whitespace chains are
// segmented into longest valid groups. Thus 1 250 != [1,250], but 1250 77 is a list.
function numericList(value){
  const prepared=scalar(value),whole=groupedInteger(prepared);
  if(whole!==null)return numeric(value);
  const list=value.split(/, +/u);
  if(list.length>1)return new Set(list.flatMap(part=>[...numericList(part)]));
  const direct=numeric(value);if(direct.size)return direct;
  const groups=value.split(/ +/u),result=new Set();
  for(let i=0;i<groups.length;){let end=groups.length,keys=new Set();
    for(;end>i;end--){keys=numeric(groups.slice(i,end).join(' '));if(keys.size)break;}
    if(end===i){i++;continue;}keys.forEach(n=>result.add(n));i=end;
  }
  return result;
}
const dayPattern=`(?:[0-9]{1,2}(?:st|nd|rd|th)?|${ordinals.map(day=>day.replaceAll(' ','[ -]+')).join('|')})`;
const dayValue=value=>/^\d/.test(value)?parseInt(value,10):ordinals.indexOf(value.replace(/[ -]+/g,' '))+1;
const yearValue=value=>value==null?null:value.length===2?Number(value)+(Number(value)<=PRIVATE_DATE_YEAR_PIVOT?2000:1900):Number(value);
function dateValue(year,month,day){
  const actual=year??2000,d=new Date(0);d.setUTCHours(0,0,0,0);d.setUTCFullYear(actual,month-1,day);
  return actual>=1&&d.getUTCFullYear()===actual&&d.getUTCMonth()===month-1&&d.getUTCDate()===day?{year,month,day}:null;
}
function dates(text){
  const values=[],spans=[];
  const add=(y,m,d,match)=>{const value=dateValue(y,Number(m),Number(d));if(value){values.push(value);spans.push([match.index,match.index+match[0].length]);}};
  for(const match of text.matchAll(/(?<![\p{L}\p{N}_])([0-9]{1,4}) *[./-] *([0-9]{1,2})(?: *[./-] *([0-9]{2}|[0-9]{4}|[0-9]{1}))?(?![\p{L}\p{N}_]| *[./-] *[0-9])/gu)){
    if(match[1].length===4&&match[3]!=null)add(Number(match[1]),match[2],match[3],match);
    else if(match[1].length<=2&&(match[3]==null||[2,4].includes(match[3].length))){
      const y=yearValue(match[3]);add(y,match[2],match[1],match);add(y,match[1],match[2],match);
    }
  }
  const tail='(?:[ ,]+([0-9]{4}|[0-9]{2}))?(?![\\p{L}\\p{N}_]|[ ,]+[0-9])';
  for(const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])(${dayPattern})[ -]+(?:of[ -]+)?(${monthPattern})\\.?${tail}`,'gu')))add(yearValue(match[3]),months.indexOf(match[2].slice(0,3))+1,dayValue(match[1]),match);
  for(const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])(${monthPattern})\\.?[ -]+(?:the[ -]+)?(${dayPattern})${tail}`,'gu')))add(yearValue(match[3]),months.indexOf(match[1].slice(0,3))+1,dayValue(match[2]),match);
  return {values,spans};
}
const numberWords=new Set([...Object.keys(small),...Object.keys(scales),...Object.keys(fractions),'hundred','and','a','point']);
function wordNumber(words){
  if(!words.length||words.every(word=>['and','a'].includes(word)))return [];
  const factor=scales[words.at(-1)]||(words.at(-1)==='hundred'?100n:1n);
  if(factor!==1n&&words.some(word=>word==='point'||fractions[word]))return wordNumber(words.slice(0,-1)).map(value=>shift(value,factor.toString().length-1));
  if(fractions[words.at(-1)]){
    const end=words.length-1,and=words.lastIndexOf('and'),head=and>=0?words.slice(0,and):[],tail=words.slice(and+1,end).filter(word=>word!=='a');
    const numerator=tail.length?wordNumber(tail):['1'],base=head.length?wordNumber(head):['0'];
    return base.flatMap(a=>numerator.filter(n=>/^\d+$/.test(n)).map(n=>{
      const [integer,fraction='']=a.split('.'),digits=Math.max(fraction.length,2),scale=10n**BigInt(digits);
      const value=BigInt(integer)*scale+BigInt(fraction.padEnd(digits,'0'))+BigInt(n)*scale/fractions[words.at(-1)];
      return exact((value/scale).toString(),(value%scale).toString().padStart(digits,'0'));
    }));
  }
  const point=words.indexOf('point');
  if(point>=0){const tail=words.slice(point+1);if(!tail.length||tail.some(w=>small[w]===undefined||small[w]>9n))return [];
    return wordNumber(words.slice(0,point)).map(value=>exact(value,tail.map(w=>String(small[w])).join('')));}
  const actual=words.filter(w=>!['and','a'].includes(w));let total=0n,group=0n;
  for(const word of actual){if(small[word]!==undefined)group+=small[word];else if(word==='hundred')group=(group||1n)*100n;else if(scales[word]){total+=(group||1n)*scales[word];group=0n;}else return [];}
  if(actual.length>=2&&actual.every(word=>small[word]!==undefined&&small[word]<=9n)&&!words.includes('and'))return [exact(actual.map(word=>String(small[word])).join(''))];
  const values=[];
  if(actual.length>=2&&actual.length<=3&&actual.every(w=>small[w]!==undefined)&&small[actual[0]]<100n&&small[actual[1]]>=10n){
    const tail=actual.slice(1).reduce((sum,w)=>sum+small[w],0n);if(tail<100n)values.push(String(small[actual[0]]*100n+tail));}
  return values.length?values:[String(total+group)];
}
function wordRuns(text,onSpan){
  const values=new Set();let run=[],start=0,end=0;
  const flush=()=>{const found=wordNumber(run);found.forEach(n=>values.add(n));if(found.length)onSpan?.(found,start,end);run=[];};
  for(const token of text.matchAll(/[a-z]+|[^a-z\s, &-]+/g)){if(numberWords.has(token[0])){if(!run.length)start=token.index;run.push(token[0]);end=token.index+token[0].length;}else flush();}flush();return values;
}
function numbers(text,onSpan){
  text=separateUnits(text);const keys=wordRuns(text,onSpan);
  for(const match of text.matchAll(/[0-9]+(?:[., \p{Quotation_Mark}ʼ]+[0-9]+)*(?:[kmb])?/gu)){
    if(/[\p{L}\p{N}_]$/u.test(text.slice(0,match.index))||/^[\p{L}\p{N}_]/u.test(text.slice(match.index+match[0].length)))continue;
    const found=[...numericList(match[0])];found.forEach(value=>keys.add(value));if(found.length)onSpan?.(found,match.index,match.index+match[0].length);
  }
  return keys;
}
const identifier=value=>/[a-z\p{L}]/u.test(value)&&/[0-9]/u.test(value)&&/^[\p{L}\p{N}\p{P} ]+$/u.test(value)?value.replace(/[^\p{L}\p{N}]/gu,''):null;
const identifierPattern=key=>new RegExp(`(?<![\\p{L}\\p{N}_])${Array.from(key,escape).join('[\\p{P} ]*')}(?![\\p{L}\\p{N}_])`,'u');
export function privateEvidenceValues(value){
  const values=[clean(value)];
  const amount='[0-9]+(?:[., \\p{Quotation_Mark}ʼ]+[0-9]+)*(?:[kmb])?';
  const currency=new RegExp(`(?:(?:${units}|\\p{Sc}) *[+−-]? *${amount}|${amount} *(?:${units}|\\p{Sc}))`,'gu');
  for(const raw of String(value??'').split(/[\r\n]+/u)){
    const line=clean(raw),payload=line.replace(new RegExp(evidenceLabel,'u'),'').replace(new RegExp(evidenceNumericLabel,'u'),'');
    if(payload){const amounts=numeric(payload);if(amounts.size&&!new RegExp(evidenceDateLabel,'u').test(line))values.push(...[...amounts].map(value=>'number:'+value));else values.push(payload);}
    for(const match of line.matchAll(currency))values.push(match[0]);
  }
  return [...new Set(values.filter(Boolean))];
}
export function createPrivateValueMatcher(terms=[]){
  const retainedNumbers=new Set(),retainedDates=[],literals=[];
  const expanded=terms.flatMap(raw=>String(raw??'').startsWith('evidence:')?privateEvidenceValues(String(raw).slice(9)):[raw]);
  for(const raw of expanded){
    const term=clean(raw);if(!term)continue;
    if(/^number:[0-9]+(?:\.[0-9]+)?$/.test(term)){const [a,b]=term.slice(7).split('.');retainedNumbers.add(exact(a,b));continue;}
    const tagged=/^date:(\*|[0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(term);
    if(tagged){const value=dateValue(tagged[1]==='*'?null:Number(tagged[1]),Number(tagged[2]),Number(tagged[3]));if(value)retainedDates.push(value);continue;}
    if(term.startsWith('identifier:')){literals.push(identifierPattern(term.slice(11)));continue;}
    const parsedDates=dates(term),date=parsedDates.spans.some(([a,b])=>['','the'].includes(term.slice(0,a).trim())&&/^[., ]*$/.test(term.slice(b)))?parsedDates.values:[],amount=numeric(term);
    if(date.length)retainedDates.push(...date);
    if(amount.size)amount.forEach(value=>retainedNumbers.add(value));
    if(!date.length&&!amount.size){
      const words=term.split(/[ ,&-]+/u),spoken=words.every(word=>numberWords.has(word))?wordNumber(words):[];
      if(spoken.length)spoken.forEach(n=>retainedNumbers.add(n));
      else{const key=identifier(term);literals.push(key?identifierPattern(key):new RegExp(`(?<![\\p{L}\\p{N}_])${escape(term)}(?![\\p{L}\\p{N}_])`,'u'));}
    }
  }
  const matchText=text=>{
    const content=clean(text);if(literals.some(pattern=>pattern.test(content)))return true;
    const found=dates(content);
    if(found.values.some(current=>retainedDates.some(saved=>saved.month===current.month&&saved.day===current.day&&(saved.year==null||current.year==null||saved.year===current.year))))return true;
    // A two-part dotted rendering can also be an amount. Compare that whole
    // interpretation before masking date parts; never compare its subvalues.
    if(found.spans.some(([start,end])=>[...numeric(content.slice(start,end))].some(n=>retainedNumbers.has(n))))return true;
    // Do not reinterpret the parts of an explicit non-matching date as amounts.
    const masked=content.split('');for(const [start,end] of found.spans)for(let i=start;i<end;i++)masked[i]=' ';
    return retainedNumbers.size>0&&[...numbers(masked.join(''))].some(n=>retainedNumbers.has(n));
  };
  // Decode protocol JSON before checking its values. Keys are data too. The
  // same traversal owns current text, history, tools, responses and writes.
  const contains=(value,depth=0)=>{
    if(depth>32)return true;
    if(typeof value==='string'){
      if(/^[\s]*[\[{\"]/.test(value)){try{const decoded=JSON.parse(value);if(decoded!==value&&contains(decoded,depth+1))return true;}catch{}}
      return matchText(value);
    }
    if(typeof value==='number'||typeof value==='bigint')return matchText(String(value));
    if(Array.isArray(value))return value.some(item=>contains(item,depth+1));
    return value!=null&&typeof value==='object'&&Object.entries(value).some(([key,item])=>matchText(key)||contains(item,depth+1));
  };
  contains.spans=value=>{
    const normalized=normalizePrivateText(value),content=normalized.text,ranges=[];
    const add=(start,end)=>{if(end>start&&normalized.origins[start]&&normalized.origins[end-1])ranges.push([normalized.origins[start].start,normalized.origins[end-1].end]);};
    for(const pattern of literals)for(const match of content.matchAll(new RegExp(pattern.source,'gu')))add(match.index,match.index+match[0].length);
    const found=dates(content),masked=content.split('');
    for(const [i,current] of found.values.entries()){
      const [start,end]=found.spans[i];
      if(retainedDates.some(saved=>saved.month===current.month&&saved.day===current.day&&(saved.year==null||current.year==null||saved.year===current.year))
        ||[...numeric(content.slice(start,end))].some(n=>retainedNumbers.has(n)))add(start,end);
      for(let j=start;j<end;j++)masked[j]=' ';
    }
    numbers(masked.join(''),(keys,start,end)=>{if(keys.some(key=>retainedNumbers.has(key)))add(start,end);});
    return ranges;
  };
  return contains;
}

// Preserve any syntactically independent ordinary clause, with a dependency
// veto rather than an intent allowlist. Never redact fields inside a sentence.
export function ordinaryPart(message,isPrivate,privateSpans=()=>[]){
  const text=String(message||'');if(!isPrivate(text))return {text,mixed:false};
  // Protocol JSON and punctuation inside values are not ordinary clauses.
  if(/^\s*[\[{\"]/.test(text)){try{JSON.parse(text);return {text:'',mixed:true};}catch{}}
  const valuePart=word=>/^[0-9]+$/.test(word)||numberWords.has(word)||ordinals.includes(word)||new RegExp(`^${monthPattern}$`,'u').test(word);
  const protectedRanges=privateSpans(text),clauses=[];let start=0;
  const retain=(start,end)=>{if(!protectedRanges.some(([a,b])=>start<b&&end>a))clauses.push(text.slice(start,end).trim());};
  for(const boundary of text.matchAll(/[;!?]+|\n+|\.(?=\s|$)|,\s+(?:also\s+)?|\s+(?:and also|also)\s+/giu)){
    const left=clean(text.slice(0,boundary.index)).match(/([\p{L}\p{N}]+)[,\p{Quotation_Mark}]*$/u)?.[1];
    const right=clean(text.slice(boundary.index+boundary[0].length)).match(/^[,\p{Quotation_Mark}]*([\p{L}\p{N}]+)/u)?.[1];
    if(/[\n.]/.test(boundary[0])&&valuePart(left||'')&&valuePart(right||''))continue;
    retain(start,boundary.index);start=boundary.index+boundary[0].length;
  }
  retain(start,text.length);
  const dependent=/\b(?:it|this|that|these|those|above|below|instead|same|them|their|its|former|latter)\b|^(?:and|but|or|because|so|then|do not|don't|never|no changes|no writes)\b/i;
  return {text:clauses.filter(clause=>clause&&!isPrivate(clause)&&!dependent.test(clean(clause))&&/[\p{L}]/u.test(clause)
    &&!clean(clause).split(/[ ,&-]+/u).every(word=>numberWords.has(word))).join('. '),mixed:true};
}
