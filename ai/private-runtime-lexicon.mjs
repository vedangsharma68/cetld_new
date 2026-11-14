import {asciiPOS,unicodePOS} from './private-runtime-lexicon-data.mjs';
// One offset per full lexical row. Lookup and a bounded hot-token cache replace
// duplicate entry arrays, tag strings, lemma maps and per-word Set objects.
export function privateWordIndex(text){
 const starts=[0];for(let i=0;i<text.length;i++)if(text.charCodeAt(i)===10)starts.push(i+1);const offsets=Uint32Array.from(starts),count=text?offsets.length:0;
 return value=>{let lo=0,hi=count-1;while(lo<=hi){const mid=(lo+hi)>>>1,end=mid+1<count?offsets[mid+1]-1:text.length,word=text.slice(offsets[mid],end);if(word===value)return true;if(word<value)lo=mid+1;else hi=mid-1;}return false;};
}
function table(text){
 const starts=[0];for(let i=0;i<text.length;i++)if(text.charCodeAt(i)===10)starts.push(i+1);const offsets=Uint32Array.from(starts),count=text?offsets.length:0;
 const read=i=>{const a=offsets[i],end=i+1<count?offsets[i+1]-1:text.length,split=text.indexOf('\t',a);return [text.slice(a,split),text.slice(split+1,end)];};
 return {find(word){let lo=0,hi=count-1;while(lo<=hi){const mid=(lo+hi)>>>1,[value,tags]=read(mid);if(value===word)return tags;if(value<word)lo=mid+1;else hi=mid-1;}},*entries(){for(let i=0;i<count;i++)yield read(i);}};
}
const ascii=table(asciiPOS),unicode=table(unicodePOS),hot=new Map(),empty=[];
export function privateLexicalTags(word){
 if(hot.has(word))return hot.get(word);const raw=(/^[\x00-\x7f]*$/.test(word)?ascii:unicode).find(word),tags=raw===undefined?empty:raw.split('|');if(hot.size>=512)hot.delete(hot.keys().next().value);hot.set(word,tags);return tags;
}
export function* privateLexicalEntries(){yield* ascii.entries();yield* unicode.entries();}
const primary=/^(?:NN|NNS|NNP|NNPS|PRP|PRP\$|DT|VB|VBD|VBP|VBZ|VBG|VBN|MD|IN|TO|CD|RB|RBR|RBS|UH|EX|JJ|JJR|JJS)$/;
const numericTag=word=>{if(typeof word!=='string'||!/^[a-z]+$/.test(word))return;const tags=privateLexicalTags(word);return primary.test(tags[0]||'')?tags.join('|'):undefined;};
// Build tools may serialize the entire dictionary. Chat matching pays only
// for queried tokens; the complete original vocabulary remains available.
export const privateNumericGrammarTags=new Proxy(Object.create(null),{
 get(_,word){if(word==='toJSON')return ()=>Object.fromEntries([...privateLexicalEntries()].filter(([w])=>numericTag(w)!==undefined).map(([w])=>[w,numericTag(w)]));return numericTag(word);},
 ownKeys(){return [...privateLexicalEntries()].map(([w])=>w).filter(w=>numericTag(w)!==undefined);},
 getOwnPropertyDescriptor(_,word){const value=numericTag(word);return value===undefined?undefined:{enumerable:true,configurable:true,value};}
});
