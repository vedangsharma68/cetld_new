import {numericSelectionWords,numericCollectiveWords,numericQuantifiers,numericDistributionWords,numericCollectionPredicates,numericGrammarTags,numericPredicativeRelations,numericCollectiveHeads,privateOriginMonetaryBefore,privateOriginDateBefore} from './private-value-language.mjs';
// Cardinality is attached to a source span, never inferred from its digits.
// Both scanning and durable projection consume this role; SQL renders the
// same closed operators and pinned lexical categories.
export function privateNumberRole(text,start,end){
 const prefix=text.slice(0,start).split(/[;.!?\n]/u).at(-1),suffix=text.slice(end).split(/[;.!?\n]/u)[0];
 const left=prefix.match(/[\p{L}\p{M}]+|[0-9]+/gu)||[],right=suffix.match(/[\p{L}\p{M}]+|[0-9]+/gu)||[];
 if(new RegExp(privateOriginMonetaryBefore,'u').test(prefix))return 'scalar';
 if(['is','was'].includes(right[0]))return 'scalar';
 if(['are','were'].includes(right[0]))return 'collection';
 const plural=words=>words.some(w=>/^(?:NNS|NNPS)(?:\||$)/.test(numericGrammarTags[w]||''));
 const countedComplement=plural(right)&&right.some(w=>/^[0-9]+$/.test(w)||/^(?:CD)(?:\||$)/.test(numericGrammarTags[w]||'')||numericQuantifiers.includes(w));
 let nominalHead='';
 if(/^(?:IN|TO)(?:\||$)/.test(numericGrammarTags[right[0]]||''))for(const w of right.slice(1)){
  const tags=numericGrammarTags[w]||'';
  if(numericCollectiveHeads.includes(w)){nominalHead=w;continue;}
  if(/(?:^|\|)(?:DT|RB|RBR|RBS)(?:\||$)/.test(tags)||/^(?:JJ|JJR|JJS|VBG|VBN)(?:\||$)/.test(tags))continue;
  if(/^(?:NN|NNS|NNP|NNPS)(?:\||$)/.test(tags)){nominalHead=w;continue;}
  if(/^(?:IN|TO|CC|VB|VBD|VBP|VBZ|MD)(?:\||$)/.test(tags))break;
 }
 // A destination complement does not distribute the scalar placed there.
 const orderedComplement=['in','by'].includes(right[0])&&numericCollectiveHeads.includes(nominalHead);
 if(countedComplement||orderedComplement)return 'collection';
 const partitive=left.at(-1)==='of'&&(/^(?:CD|DT)(?:\||$)/.test(numericGrammarTags[left.at(-2)]||'')||/^[0-9]+$/.test(left.at(-2)||'')||numericCollectiveHeads.includes(left.at(-2)));
 const predicative=plural(right)&&(numericPredicativeRelations.includes(right[0])||/^(?:VB|VBP)(?:\||$)/.test(numericGrammarTags[right[0]]||''));
 if(partitive||predicative)return 'collection';
 if(numericPredicativeRelations.includes(right[0])&&right.some(w=>/^(?:NN|NNP)(?:\||$)/.test(numericGrammarTags[w]||'')))return 'scalar';
 const operation=(words,i)=>numericSelectionWords.includes(words[i])&&(/^(?:IN|TO|VB|VBD|VBP|VBZ|VBG|VBN)(?:\||$)/.test(numericGrammarTags[words[i]]||'')||/(?:^|\|)VB(?:P)?(?:\||$)/.test(numericGrammarTags[words[i]]||'')&&(i===0||/^(?:PRP|NNP|MD)(?:\||$)/.test(numericGrammarTags[words[i-1]]||'')));
 if(right.some((w,i)=>operation(right,i)||numericDistributionWords.includes(w))||left.some((w,i)=>operation(left,i)||[...numericCollectiveWords,...numericQuantifiers,...numericDistributionWords].includes(w)))return 'collection';
 let finite=-1;for(let i=0;i<left.length;i++)if((/^(?:VB|VBD|VBP|VBZ|MD)(?:\||$)/.test(numericGrammarTags[left[i]]||'')||/(?:^|\|)(?:VBD|VBP|VBZ)(?:\||$)/.test(numericGrammarTags[left[i]]||'')&&/^(?:NN|NNS|NNP|NNPS|PRP)(?:\||$)/.test(numericGrammarTags[left[i-1]]||'')))finite=i;
 const spine=finite>=0&&!numericCollectionPredicates.includes(left[finite])?left.slice(finite+1):left;
 const relation=spine.findIndex(w=>/^(?:IN|TO)(?:\||$)/.test(numericGrammarTags[w]||''));
 const phrase=relation>=0?spine.slice(0,relation):spine;
 return phrase.some(w=>/^(?:NNS|NNPS)(?:\||$)/.test(numericGrammarTags[w]||''))?'collection':'unknown';
}

// An ambiguous collection keeps calendar and member interpretations.
export function privateCalendarExclusive(text,start,end){return !(/^[0-9 ./-]+$/u.test(text.slice(start,end))&&!new RegExp(privateOriginDateBefore,'u').test(text.slice(0,start))&&privateNumberRole(text,start,end)==='collection');}
