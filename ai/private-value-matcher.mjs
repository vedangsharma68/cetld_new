import {PRIVATE_UNICODE_FOLD} from './private-value-unicode.mjs';
import {PRIVATE_DATE_YEAR_PIVOT,months,monthPattern,ordinals,units,small,scales,fractions,evidenceLabel,evidenceNumericLabel,evidenceDateLabel,currencyUnitPattern,namedDatePatterns,privateOriginHeader,privateOriginFieldLabel,originDateCommaPattern,lexicalAliases,partyTransliteration,partyReference} from './private-value-language.mjs';
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
  let total=0n,start=0,lastScale=null;
  for(let i=0;i<actual.length;i++)if(scales[actual[i]]){
    const scale=scales[actual[i]],part=i===start?1n:group(actual.slice(start,i));
    if(part===null||lastScale!==null&&(scale>=lastScale||part>=lastScale))return [];
    total+=part*scale;lastScale=scale;start=i+1;
  }
  const tail=group(actual.slice(start));
  return tail===null||lastScale!==null&&tail>=lastScale?[]:[String(total+tail)];
}
// A valid complete numeral is atomic. Otherwise take longest valid members;
// punctuation may connect a cardinal phrase or separate a list, never add the
// next independent tens group to an already complete one.
function wordRuns(original,onSpan){
  const lexical=lexicalText(original),text=lexical.text;
  const values=new Set();let run=[];
  const flush=()=>{
    if(!run.some(token=>numberWords.has(token.word)&&!['and','a'].includes(token.word)||lexical.origins[token.start]?.translated)){run=[];return;}
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

function numbers(text,onSpan){
  if(/\b(?:amounts|numbers|values|totals|pair|list)\b/u.test(text))text=text.replace(/(?<=[0-9]),(?=[0-9])/gu,' ');
  text=separateUnits(text);const masked=text.split(''),keys=wordRuns(text,(values,start,end)=>{onSpan?.(values,start,end);for(let i=start;i<end;i++)masked[i]=' ';});text=masked.join('');
  for(const match of text.matchAll(/[0-9]+(?:[., \p{Quotation_Mark}ʼ]+[0-9]+)*(?:[kmb])?/gu)){
    if(/[\p{L}\p{N}_]$/u.test(text.slice(0,match.index))||/^[\p{L}\p{N}_]/u.test(text.slice(match.index+match[0].length)))continue;
    const found=[...numericList(match[0])];found.forEach(value=>keys.add(value));if(found.length)onSpan?.(found,match.index,match.index+match[0].length);
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
 if(native)out=out.replace(/a$/u,'');return out.replace(/aa/g,'a').replace(/ii/g,'i').replace(/uu/g,'u');
});}
export const privatePartyKeys=value=>clean(value).split(/[^\p{L}\p{M}\p{N}]+/u).filter(part=>part.length>=2).flatMap(part=>/[\u0900-\u097f]/u.test(part)?['party-native:'+part,'party-latin:'+partyKey(part)]:['party:'+partyKey(part)]);

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
export function privateOriginStart(value){
  const normalized=normalizePrivateText(value),match=new RegExp(privateOriginHeader,'u').exec(normalized.text);
  return match?normalized.origins[match.index]?.start??0:null;
}
export function privateOriginValues(value){
  let text=clean(String(value??'').replace(/[\r\n]+/g,',')).replace(new RegExp(originDateCommaPattern,'gu'),'$1 $2');
  const match=new RegExp(privateOriginHeader,'u').exec(text);if(!match)return [];
  text=text.slice(match.index);const protectedDates=dates(text).spans,parts=[];let start=0;
  for(const sep of text.matchAll(/[,;]/g)){
    if(protectedDates.some(([a,b])=>a<=sep.index&&b>sep.index)||sep[0]===','&&/[0-9]/.test(text[sep.index-1]||'')&&/[0-9]/.test(text[sep.index+1]||''))continue;
    parts.push(text.slice(start,sep.index));start=sep.index+1;
  }
  parts.push(text.slice(start));
  return [text,...parts.map((part,index)=>{let field=part.trim();if(index===0&&field.startsWith(match[0]))field=field.slice(match[0].length);return field.replace(/^[:> ]+/u,'').replace(/^[\p{Quotation_Mark}ʼ]+|[\p{Quotation_Mark}ʼ]+$/gu,'').replace(/^(?:from|to|for) +/u,'').replace(new RegExp(privateOriginFieldLabel,'u'),'').replace(/^[\p{Quotation_Mark}ʼ]+|[\p{Quotation_Mark}ʼ]+$/gu,'');})].filter(Boolean);
}
// Canonical keys for a retained atomic field. SQL term_aliases is generated
// from the same grammar; parity tests compare these exact key sets.
export function privateFieldKeys(value){
  const raw=clean(value);if(!raw||raw.length>4000)return [];
  const term=raw.replace(/^[\p{Quotation_Mark}ʼ]+|[\p{Quotation_Mark}ʼ]+$/gu,''),keys=new Set([raw]),parsed=dates(term),date=parsed.values.filter((value,index)=>{const [a,b]=parsed.spans[index];return ['','the'].includes(term.slice(0,a).trim())&&/^[., ]*$/.test(term.slice(b));});
  for(const n of numeric(term))keys.add('number:'+n);
  const spoken=stripCurrency(lexicalText(stripCurrency(term)).text),words=spoken.match(/[a-z]+/g)||[];
  if(words.every(word=>numberWords.has(word))){for(const n of numeric(spoken))keys.add('number:'+n);for(const n of wordRuns(lexicalText(term).text===term?spoken:term))keys.add('number:'+n);}
  for(const {year,month,day} of date)keys.add('date:'+(year==null?'*':String(year).padStart(4,'0'))+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0'));
  if(keys.size===1){const key=identifier(term);if(key)keys.add('identifier:'+key);}
  return [...keys];
}
export function createPrivateValueMatcher(terms=[]){
  const retainedNumbers=new Set(),retainedDates=[],literals=[],parties=new Set(),nativeParties=new Set(),latinParties=new Set();
  const expanded=terms.flatMap(raw=>String(raw??'').startsWith('evidence:')?privateEvidenceValues(String(raw).slice(9)):String(raw??'').startsWith('origin:')?privateOriginValues(String(raw).slice(7)):[raw]);
  const compile=term=>{
    if(/^number:[0-9]+(?:\.[0-9]+)?$/.test(term)){const [a,b]=term.slice(7).split('.');retainedNumbers.add(exact(a,b));return true;}
    const tagged=/^date:(\*|[0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(term);
    if(tagged){const value=dateValue(tagged[1]==='*'?null:Number(tagged[1]),Number(tagged[2]),Number(tagged[3]));if(value)retainedDates.push(value);return true;}
    if(term.startsWith('party-native:')){nativeParties.add(term.slice(13));return true;}
    if(term.startsWith('party-latin:')){latinParties.add(term.slice(12));return true;}
    if(term.startsWith('party:')){parties.add(term.slice(6));return true;}
    if(term.startsWith('identifier:')){literals.push(identifierPattern(term.slice(11)));return true;}return false;
  };
  for(const raw of expanded){
    const term=clean(raw);if(!term||compile(term))continue;
    const keys=privateFieldKeys(term);if(keys.length>1){keys.slice(1).forEach(compile);continue;}
    literals.push(new RegExp(`(?<![\\p{L}\\p{N}_])${escape(term)}(?![\\p{L}\\p{N}_])`,'u'));
  }
  const partyMatches=(content,ordinary=false)=>{
    // Generic linguistic discussion is distinguishable from a reference to a
    // linked party. Ambiguous mentions otherwise stay local, at every boundary.
    if(ordinary&&/\b(?:surname|given name|word meaning|etymology|name origin)\b/u.test(content)&&!new RegExp(partyReference,'u').test(content))return [];
    return [...content.matchAll(/[\p{L}\p{M}]+/gu)].filter(m=>/[\u0900-\u097f]/u.test(m[0])?nativeParties.has(m[0])||parties.has(partyKey(m[0])):parties.has(partyKey(m[0]))||latinParties.has(partyKey(m[0])));
  };
  const matchText=(text,ordinary=false)=>{
    const content=clean(text);if(privateOriginStart(text)!==null)return true;if(literals.some(pattern=>pattern.test(content)))return true;
    if(partyMatches(content,ordinary).length)return true;
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
  const contains=(value,depth=0,ordinary=false)=>{
    if(depth>32)return true;
    if(typeof value==='string'){
      if(/^[\s]*[\[{\"]/.test(value)){try{const decoded=JSON.parse(value);if(decoded!==value&&contains(decoded,depth+1,ordinary))return true;}catch{}}
      return matchText(value,ordinary);
    }
    if(typeof value==='number'||typeof value==='bigint')return matchText(String(value),ordinary);
    if(Array.isArray(value))return value.some(item=>contains(item,depth+1,ordinary));
    return value!=null&&typeof value==='object'&&Object.entries(value).some(([key,item])=>matchText(key,ordinary)||contains(item,depth+1,ordinary));
  };
  contains.ordinary=value=>contains(value,0,true);
  contains.spans=(value,{ordinary=false}={})=>{
    const normalized=normalizePrivateText(value),content=normalized.text,ranges=[];
    const origin=privateOriginStart(value);if(origin!==null)ranges.push([origin,String(value??'').length]);
    const add=(start,end)=>{if(end>start&&normalized.origins[start]&&normalized.origins[end-1])ranges.push([normalized.origins[start].start,normalized.origins[end-1].end]);};
    for(const match of partyMatches(content,ordinary))add(match.index,match.index+match[0].length);
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
