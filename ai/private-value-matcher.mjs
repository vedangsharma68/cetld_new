// Shared by all provider-bound surfaces. No locale-dependent Number rounding.
const clean=value=>String(value??'').normalize('NFKC').replace(/\p{Cf}/gu,'').toLowerCase().replace(/\s+/gu,' ').trim();
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const separators=/[.,' ]/u;
const units='(?:inr|usd|eur|gbp|aed|sgd|aud|cad|chf|rs|rupees?|dollars?|euros?|pounds?)';
const separateUnits=text=>text.replace(new RegExp(`\\b${units}(?=[0-9])|(?<=[0-9])${units}\\b`,'gu'),' ');
const exact=(integer,fraction='')=>{
  const tail=fraction.replace(/0+$/,'');
  return BigInt(integer).toString()+(tail?'.'+tail:'');
};
function groupedInteger(value){
  const groups=value.split(separators);
  if(!groups.every(group=>/^\d+$/.test(group)))return null;
  if(groups.length===1||groups[0].length<=3&&groups.slice(1).every(group=>group.length===3)
    ||groups[0].length<=2&&groups.at(-1).length===3&&groups.slice(1,-1).every(group=>group.length===2))return groups.join('');
  return null;
}
// Keep every valid interpretation; ambiguity is private only when a retained
// value matches. Never split a malformed/space-grouped candidate into subvalues.
// Mirrored by app.private_invoice_number_aliases; SQL/JS parity is tested.
function numeric(value){
  value=value.replace(/[\p{Quotation_Mark}ʼ]/gu,"'").replace(/ *([.,']) */gu,'$1');
  const values=new Set(),integer=groupedInteger(value);
  if(integer!==null)values.add(exact(integer));
  const last=value.search(/[.,][0-9]+$/u);
  if(last>=0){
    const whole=groupedInteger(value.slice(0,last)),fraction=value.slice(last+1);
    if(whole!==null)values.add(exact(whole,fraction));
  }
  return values;
}
const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const monthPattern='(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const ordinals='first,second,third,fourth,fifth,sixth,seventh,eighth,ninth,tenth,eleventh,twelfth,thirteenth,fourteenth,fifteenth,sixteenth,seventeenth,eighteenth,nineteenth,twentieth,twenty first,twenty second,twenty third,twenty fourth,twenty fifth,twenty sixth,twenty seventh,twenty eighth,twenty ninth,thirtieth,thirty first'.split(',');
const dayPattern=`(?:[0-9]{1,2}(?:st|nd|rd|th)?|${ordinals.map(day=>day.replaceAll(' ','[ -]+')).join('|')})`;
const dayValue=value=>/^\d/.test(value)?parseInt(value,10):ordinals.indexOf(value.replace(/[ -]+/g,' '))+1;
function dateKeys(year,month,day){
  year=year?Number(year):2000;month=Number(month);day=Number(day);
  if(year<1)return [];
  const d=new Date(0);d.setUTCHours(0,0,0,0);d.setUTCFullYear(year,month-1,day);
  if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)return [];
  return [`date:${month}-${day}`]; // Missing-year renderings conservatively match any retained year.
}
function dates(text){
  const keys=new Set();
  const add=(y,m,d)=>dateKeys(y,m,d).forEach(key=>keys.add(key));
  for(const match of text.matchAll(/(?<![\p{L}\p{N}_])([0-9]{4}) *[./-] *([0-9]{1,2}) *[./-] *([0-9]{1,2})(?![\p{L}\p{N}_])/gu))add(match[1],match[2],match[3]);
  for(const match of text.matchAll(/(?<![\p{L}\p{N}_])([0-9]{1,2}) *[./-] *([0-9]{1,2}) *[./-] *([0-9]{4})(?![\p{L}\p{N}_])/gu)){
    add(match[3],match[2],match[1]);add(match[3],match[1],match[2]);
  }
  for(const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])(${dayPattern})[ -]+(?:of[ -]+)?(${monthPattern})\\.?(?:[ ,]+([0-9]{4}))?(?![\\p{L}\\p{N}_])`,'gu')))add(match[3],months.indexOf(match[2].slice(0,3))+1,dayValue(match[1]));
  for(const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])(${monthPattern})\\.?[ -]+(?:the[ -]+)?(${dayPattern})(?:[ ,]+([0-9]{4}))?(?![\\p{L}\\p{N}_])`,'gu')))add(match[3],months.indexOf(match[1].slice(0,3))+1,dayValue(match[2]));
  return keys;
}
const small=Object.fromEntries('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ').map((word,i)=>[word,BigInt(i)]));
for(const [i,word] of ['twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'].entries())small[word]=BigInt((i+2)*10);
const scales={thousand:1000n,lakh:100000n,lac:100000n,million:1000000n,crore:10000000n,billion:1000000000n};
const numberWords=new Set([...Object.keys(small),...Object.keys(scales),'hundred','and','point']);
function wordNumber(words){
  if(!words.length||words.length>40||words.every(word=>word==='and'))return [];
  const point=words.indexOf('point');
  if(point>=0){const tail=words.slice(point+1);if(!tail.length||tail.some(w=>small[w]===undefined||small[w]>9n))return [];
    return wordNumber(words.slice(0,point)).map(value=>exact(value,tail.map(w=>String(small[w])).join('')));}
  const actual=words.filter(w=>w!=='and');let total=0n,group=0n;
  for(const word of actual){if(small[word]!==undefined)group+=small[word];else if(word==='hundred')group=(group||1n)*100n;else if(scales[word]){total+=(group||1n)*scales[word];group=0n;}else return [];}
  const values=[String(total+group)];
  // Colloquial amounts: twelve fifty, one twenty five, nineteen ninety nine.
  if(actual.length>=2&&actual.length<=3&&actual.every(w=>small[w]!==undefined)&&small[actual[0]]<100n&&small[actual[1]]>=10n){
    const tail=actual.slice(1).reduce((sum,w)=>sum+small[w],0n);
    if(tail<100n)values.push(String(small[actual[0]]*100n+tail));
  }
  return values;
}
function numbers(text){
  // Currency/unit affixes are numeric context, not identifier fragments.
  text=separateUnits(text);
  const keys=new Set();
  for(const match of text.matchAll(/[0-9]+(?:[., \p{Quotation_Mark}ʼ]+[0-9]+)*/gu)){
    if(/[\p{L}\p{N}_]$/u.test(text.slice(0,match.index))||/^[\p{L}\p{N}_]/u.test(text.slice(match.index+match[0].length)))continue;
    numeric(match[0]).forEach(value=>keys.add(value));
  }
  let run=[];
  const flush=()=>{wordNumber(run).forEach(n=>keys.add(n));run=[];};
  for(const token of text.matchAll(/[a-z]+|[^a-z\s-]+/g)){if(numberWords.has(token[0]))run.push(token[0]);else flush();}flush();
  return keys;
}
export function createPrivateValueMatcher(terms=[]){
  const retainedNumbers=new Set(),retainedDates=new Set(),literals=[];
  for(const raw of terms){
    const term=clean(raw);if(!term)continue;
    // SQL aliases are typed so a canonical decimal cannot acquire a new
    // thousands interpretation when loaded again (e.g. 1.125 -> 1125).
    if(/^number:[0-9]+(?:\.[0-9]+)?$/.test(term)){
      const [integer,fraction]=term.slice(7).split('.');retainedNumbers.add(exact(integer,fraction));continue;
    }
    const amount=numeric(separateUnits(term).trim()),date=dates(term);
    if(date.size)date.forEach(key=>retainedDates.add(key));
    else if(amount.size)amount.forEach(value=>retainedNumbers.add(value));
    else {
      // Treat complete English number phrases as values, never arbitrary words
      // inside names. Names/identifiers require complete token/phrase matches.
      const words=term.split(/[ -]+/);
      if(words.every(word=>numberWords.has(word)))wordNumber(words).forEach(n=>retainedNumbers.add(n));
      literals.push(new RegExp(`(?<![\\p{L}\\p{N}_])${escape(term)}(?![\\p{L}\\p{N}_])`,'u'));
    }
  }
  return text=>{
    const content=clean(text);
    if(literals.some(pattern=>pattern.test(content)))return true;
    if(retainedDates.size&&[...dates(content)].some(key=>retainedDates.has(key)))return true;
    return retainedNumbers.size>0&&[...numbers(content)].some(n=>retainedNumbers.has(n));
  };
}

// Split whole clauses, never redact a value out of a private sentence. Only
// independent ordinary speech acts can survive a mixed turn; references cannot.
export function ordinaryPart(message,isPrivate){
  const text=String(message||'');if(!isPrivate(text))return {text,mixed:false};
  const clauses=text.split(/(?:[;!?\n]+|\.(?=\s|$)|,\s+(?:also\s+)?|\s+(?:and also|also)\s+)/iu).map(s=>s.trim()).filter(Boolean);
  const independent=/^(?:good (?:morning|afternoon|evening)|hello|hi|hey|thanks|thank you|tell me (?:a|another) joke|(?:please )?(?:tell|write) (?:me )?(?:a|another) (?:joke|story|poem)|(?:please )?explain\b|i (?:like|enjoy|love)\b)/i;
  const ordinary=clauses.filter(clause=>!isPrivate(clause)&&independent.test(clause)&&! /\b(?:it|this|that|these|those|above|below|instead|same|them|their|its)\b/i.test(clause));
  return {text:ordinary.join('. '),mixed:true};
}
