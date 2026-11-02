// Shared by all provider-bound surfaces. No locale-dependent Number rounding.
const clean=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const grouped=/^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d+)?$/;
function numeric(value){
  if(!grouped.test(value))return null;
  const [integer,fraction='']=value.replaceAll(',','').split('.');
  const tail=fraction.replace(/0+$/,'');
  return BigInt(integer).toString()+(tail?'.'+tail:'');
}
const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const monthPattern='(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
function dateKeys(year,month,day){
  year=year?Number(year):2000;month=Number(month);day=Number(day);
  const d=new Date(Date.UTC(year,month-1,day));
  if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)return [];
  return [`date:${month}-${day}`]; // Missing-year renderings conservatively match any retained year.
}
function dates(text){
  const keys=new Set();
  const add=(y,m,d)=>dateKeys(y,m,d).forEach(key=>keys.add(key));
  for(const match of text.matchAll(/(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/gu))add(match[1],match[2],match[3]);
  for(const match of text.matchAll(/(?<!\d)(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?!\d)/gu))add(match[3],match[2],match[1]);
  for(const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])([0-9]{1,2})(?:st|nd|rd|th)?[ -]+(${monthPattern})\\.?(?:[ ,]+([0-9]{4}))?(?![\\p{L}\\p{N}])`,'gu')))add(match[3],months.indexOf(match[2].slice(0,3))+1,match[1]);
  for(const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(${monthPattern})\\.?[ -]+([0-9]{1,2})(?:st|nd|rd|th)?(?:[ ,]+([0-9]{4}))?(?![\\p{L}\\p{N}])`,'gu')))add(match[3],months.indexOf(match[1].slice(0,3))+1,match[2]);
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
    return wordNumber(words.slice(0,point)).map(value=>numeric(value+'.'+tail.map(w=>String(small[w])).join(''))).filter(Boolean);}
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
  const keys=new Set();
  for(const match of text.matchAll(/(?<![\p{L}\p{N}_.,])\d+(?:,\d+)*(?:\.\d+)?(?![\p{L}\p{N}_]|[.,]\d)/gu)){
    const value=numeric(match[0]);if(value!==null)keys.add(value);
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
    const amount=numeric(term),date=dates(term);
    if(amount!==null)retainedNumbers.add(amount);
    else if(date.size)date.forEach(key=>retainedDates.add(key));
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
