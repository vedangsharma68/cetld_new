// POS algorithm derived from wink-pos-tagger, Copyright GRAYPE Systems Private
// Limited (MIT). See docs/private-language-model-LICENSE.txt.
import contextRules from 'wink-pos-tagger/src/rules-engine.js';
import createTokenizer from 'wink-tokenizer';
import helpers from 'wink-helpers';
import lexicon from 'wink-lexicon/src/lexicon.js';
import suffixPOS from 'wink-lexicon/src/unknown-words.js';
import tagPOS from 'wink-lexicon/src/tags.js';
import punctuationPOS from 'wink-lexicon/src/punctuations.js';
import {words,zeroWords,names,exceptions} from './private-language-model.mjs';

// The pinned model's unigram/context algorithm, without unused lemmatization.
// Sorted text + typed offsets preserve every WordNet membership/category used
// by that algorithm while avoiding its large object and sense-array graphs.
function dictionary(text){
 let count=1;for(let i=0;i<text.length;i++)if(text.charCodeAt(i)===10)count++;
 const offsets=new Uint32Array(count+1);let n=1;for(let i=0;i<text.length;i++)if(text.charCodeAt(i)===10)offsets[n++]=i+1;offsets[count]=text.length+1;
 return value=>{let lo=0,hi=count-1;while(lo<=hi){const mid=(lo+hi)>>>1,word=text.slice(offsets[mid],offsets[mid+1]-1);if(word===value)return true;if(word<value)lo=mid+1;else hi=mid-1;}return false;};
}
const knownWord=dictionary(words),zeroWord=dictionary(zeroWords),namedWord=dictionary(names),exceptionWord=dictionary(exceptions),tokenize=createTokenizer().tokenize;
const morphology=[[/s$/,''],[/es$/,''],[/ies$/,'y'],[/ing$/,''],[/ing$/,'e'],[/ed$/,''],[/d$/,''],[/er$/,''],[/r$/,''],[/est$/,''],[/st$/,''],[/xes$/,'x'],[/zes$/,'s'],[/ves$/,'f'],[/ches$/,'ch'],[/shes$/,'sh'],[/men$/,'man']];
export const privateLanguageTags=word=>Object.hasOwn(lexicon,word.toLowerCase())?lexicon[word.toLowerCase()]:[];
function unigram(token){
 if(token.entityType&&token.pos)return [token.pos];
 if(token.tag==='punctuation'){token.pos=punctuationPOS[token.value]||token.value;return [token.pos];}
 if(token.tag==='symbol'&&token.value!=='&'){token.pos='NN';return ['NN'];}
 token.pos=tagPOS[token.tag];if(token.pos!==undefined)return [token.pos];
 const word=token.normal;let poses=Object.hasOwn(lexicon,word)?lexicon[word]:undefined;
 if(!poses){let pos;
  if(knownWord(word)&&!zeroWord(word)||exceptionWord(word)||morphology.some(([pattern,replacement])=>pattern.test(word)&&knownWord(word.replace(pattern,replacement)))){
   if(namedWord(word)&&/^[A-Z][a-z]+/.test(token.value))pos='NNP';
   else{pos=suffixPOS[word.slice(-4)]||suffixPOS[word.slice(-3)]||suffixPOS[word.slice(-2)]||suffixPOS[word.slice(-1)];if(!pos&&word.startsWith('un')&&Object.hasOwn(lexicon,word.slice(2)))pos='JJ';}
  }else pos='NNP';
  poses=pos===undefined?['NN','VBP','VB']:pos==='NNS'?['NNS','VBZ']:pos==='VBN'?['VBD','VBN']:[pos];
 }
 token.pos=poses[0];return poses;
}
const years=new Set('1990s 1980s 1970s 1960s 1950s 1940s 1930s 1910s mid-1990s mid-1980s mid-1970s mid-1960s mid-1950s mid-1940s mid-1930s mid-1920s mid-1910s'.split(' '));
export function privateLanguageSyntax(text){
 if(!/[a-z]/i.test(text))return [];
 const tokens=tokenize(text),poses=tokens.map(token=>{token.normal=helpers.string.normalize(token.value);return unigram(token);});contextRules(tokens,poses);
 let cursor=0;return tokens.flatMap(token=>{
  if(years.has(token.normal))token.pos='CD';else if(/^[A-Z]/.test(token.value)&&/^[JN]/.test(token.pos))token.pos='NNP';
  const index=text.indexOf(token.value,cursor);if(index<0)return [];cursor=index+token.value.length;
  const word=token.value.toLowerCase(),known=Object.hasOwn(lexicon,word);return [{word:token.value,pos:token.pos,alternatives:known?lexicon[word]:[token.pos],known,start:index,end:cursor}];
 });
}
