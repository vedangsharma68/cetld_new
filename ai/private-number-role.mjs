import {numericSelectionWords,numericCollectiveWords,numericQuantifiers,numericDistributionWords,numericCollectionPredicates,numericGrammarTags,numericPredicativeRelations,numericCollectiveHeads,numericOrderingHeads,numericDestinationPredicates,grammarAuxiliaries,privateOriginMonetaryBefore,privateOriginDateBefore} from './private-value-language.mjs';
// Cardinality is evidence about an operand, not a property of a lexical verb.
// SQL renders the same valency, nominal attachment and predicate precedence.
const tags=w=>numericGrammarTags[w]||'';
function predicate(words,i){
 let j=i-1;while(j>=0&&/^(?:RB|RBR|RBS)(?:\||$)/.test(tags(words[j])))j--;
 if(j>=0&&/^(?:DT|PRP\$|JJ|JJR|JJS)(?:\||$)/.test(tags(words[j])))return false;
 return /^(?:VB|VBD|VBP|VBZ)(?:\||$)/.test(tags(words[i]))||/(?:^|\|)(?:VB|VBD|VBP|VBZ|VBG|VBN)(?:\||$)/.test(tags(words[i]))&&(j<0||/^(?:PRP|NNP|NNS|MD|TO|UH)(?:\||$)/.test(tags(words[j]))||/(?:^|\|)UH(?:\||$)/.test(tags(words[j]))||grammarAuxiliaries.includes(words[j]));
}
export function privateNumberRole(text,start,end){
 const prefix=text.slice(0,start).split(/[;.!?\n]/u).at(-1),suffix=text.slice(end).split(/[;.!?\n]/u)[0];
 const left=prefix.match(/[\p{L}\p{M}]+|[0-9]+/gu)||[],right=suffix.match(/[\p{L}\p{M}]+|[0-9]+/gu)||[];
 if(new RegExp(privateOriginMonetaryBefore,'u').test(prefix))return 'scalar';
 if(['is','was'].includes(right[0]))return 'scalar';
 if(['are','were'].includes(right[0]))return 'collection';
 let finite=-1;for(let i=0;i<left.length;i++)if(predicate(left,i)||/^(?:MD)(?:\||$)/.test(tags(left[i])))finite=i;
 const spine=finite>=0&&!numericCollectionPredicates.includes(left[finite])?left.slice(finite+1):left;
 const relation=spine.findIndex(w=>/^(?:IN|TO)(?:\||$)/.test(tags(w)));
 const phrase=relation>=0?spine.slice(0,relation):spine;
 let nominalHead='';
 const prepositional=/^(?:IN|TO)(?:\||$)/.test(tags(right[0]));
 if(prepositional)for(const w of right.slice(1)){
  if(numericCollectiveHeads.includes(w)||numericOrderingHeads.includes(w)){nominalHead=w;continue;}
  if(/(?:^|\|)(?:DT|RB|RBR|RBS)(?:\||$)/.test(tags(w))||/^(?:JJ|JJR|JJS|VBG|VBN)(?:\||$)/.test(tags(w)))continue;
  if(/^(?:NN|NNS|NNP|NNPS)(?:\||$)/.test(tags(w))){nominalHead=w;continue;}
  if(/^(?:IN|TO|CC|VB|VBD|VBP|VBZ|MD)(?:\||$)/.test(tags(w)))break;
 }
 // Required-PP valency binds a destination to the scalar object. An ordering
 // relation instead describes separate elements, independently of preposition.
 const ordering=numericOrderingHeads.includes(nominalHead);
 const destination=prepositional&&right[0]!=='as'&&finite>=0&&numericDestinationPredicates.includes(left[finite])&&!ordering;
 const plural=words=>words.some(w=>/^(?:NNS|NNPS)(?:\||$)/.test(tags(w)));
 const countedComplement=plural(right)&&right.some(w=>/^[0-9]+$/.test(w)||/^(?:CD)(?:\||$)/.test(tags(w))||numericQuantifiers.includes(w));
 if(!destination&&(countedComplement||numericCollectiveHeads.includes(nominalHead)||ordering))return 'collection';
 const partitive=left.at(-1)==='of'&&(/^(?:CD|DT)(?:\||$)/.test(tags(left.at(-2)))||/^[0-9]+$/.test(left.at(-2)||'')||numericCollectiveHeads.includes(left.at(-2)));
 const predicative=!destination&&plural(right)&&(numericPredicativeRelations.includes(right[0])||/^(?:VB|VBP)(?:\||$)/.test(tags(right[0])));
 if(partitive||predicative)return 'collection';
 const operation=(words,i)=>numericSelectionWords.includes(words[i])&&!numericDestinationPredicates.includes(words[i])&&predicate(words,i);
 if(right.some((w,i)=>operation(right,i)||numericDistributionWords.includes(w))||left.some((w,i)=>operation(left,i))||phrase.some(w=>[...numericCollectiveWords,...numericQuantifiers,...numericDistributionWords].includes(w)))return 'collection';
 // An explicit collection predicate outranks a merely singular result noun.
 if(numericPredicativeRelations.includes(right[0])&&right.some(w=>/^(?:NN|NNP)(?:\||$)/.test(tags(w))))return 'scalar';
 return plural(phrase)?'collection':'unknown';
}

// An ambiguous collection keeps calendar and member interpretations.
export function privateCalendarExclusive(text,start,end){return !(/^[0-9 ./-]+$/u.test(text.slice(start,end))&&!new RegExp(privateOriginDateBefore,'u').test(text.slice(0,start))&&privateNumberRole(text,start,end)==='collection');}
