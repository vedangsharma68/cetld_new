// Declarative grammar shared by the JS matcher and SQL generation.
export const PRIVATE_DATE_YEAR_PIVOT=69; // 00..69 => 2000..2069; 70..99 => 1970..1999.
export const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
export const monthPattern='(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
export const ordinals='first,second,third,fourth,fifth,sixth,seventh,eighth,ninth,tenth,eleventh,twelfth,thirteenth,fourteenth,fifteenth,sixteenth,seventeenth,eighteenth,nineteenth,twentieth,twenty first,twenty second,twenty third,twenty fourth,twenty fifth,twenty sixth,twenty seventh,twenty eighth,twenty ninth,thirtieth,thirty first'.split(',');
export const units='(?:inr|usd|eur|gbp|aed|sgd|aud|cad|chf|rs|rupees?|dollars?|euros?|pounds?)';
export const small=Object.fromEntries('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ').map((word,i)=>[word,BigInt(i)]));
for(const [i,word] of ['twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'].entries())small[word]=BigInt((i+2)*10);
export const scales={thousand:1000n,lakh:100000n,lac:100000n,million:1000000n,crore:10000000n,billion:1000000000n,trillion:1000000000000n,quadrillion:1000000000000000n,quintillion:1000000000000000000n};
export const fractions={half:2n,halves:2n,quarter:4n,quarters:4n,third:3n,fifth:5n,sixth:6n,seventh:7n,eighth:8n,ninth:9n,tenth:10n};
// Private printed evidence keeps a field label separate from its value. This
// grammar applies only to explicitly tagged evidence, not arbitrary names.
export const evidenceLabel='^[a-z_][a-z0-9_ .#%()/-]{0,80}[:=] *';
export const evidenceNumericLabel='^[a-z_][a-z_ .#%()/-]{0,80} +(?=[0-9+−\\p{Sc}-])';
export const evidenceDateLabel='^(?:invoice +date|due(?: +date)?|date)(?![a-z])';
// Shared canonical grammar: SQL is generated from these same expressions.
export const currencyUnitPattern=units.replace('|rs|','|rs\\.?|');
// Currency belongs to its numeric field span, including abbreviation punctuation.
export const numericCurrencyBefore=`(?:\\p{Sc}|(?<![a-z0-9_])${currencyUnitPattern}) *$`;
export const numericCurrencyAfter=`^ *(?:\\p{Sc}|${currencyUnitPattern}(?![a-z0-9_]))`;
export const namedDayPattern=`(?:[0-9]{1,2}(?:st|nd|rd|th)?|${ordinals.map(day=>day.replaceAll(' ','[ -]+')).join('|')})`;
export const dateSeparator='[ ./-]*';
export const namedYearTail=`(?:[ ,./-]*['’ʼ]? *([0-9]{4}|[0-9]{2}|[0-9]{1,3}))?`;
export const namedDatePatterns=[
 `(?:the +)?(${namedDayPattern})${dateSeparator}(?:of +)?(${monthPattern})${namedYearTail}`,
 `(${monthPattern})${dateSeparator}(?:the +)?(${namedDayPattern})${namedYearTail}`,
];
export const privateDocumentKeyPattern='invoice|payment|receipt|customer|client|total|subtotal|tax|amount|currency|notes?|balance|printedevidence|ownerprovidedfacts';
// One data-bearing declaration grammar owns routing, durable origin capture,
// history screening and write guards. Domain questions alone are not origins.
export const privateDataDeclaration=`(?<![a-z0-9_])(?:(?:new|नया) +invoice(?![a-z0-9_])|(?:set|change|correct|update|edit|modify|fix|create|log|save|record|mark)(?![a-z0-9_])(?:(?!(?<![a-z0-9_])(?:invoices?|receipts?|payments?|paid|unpaid|total|subtotal|tax|notes?|currency|due date|invoice date|amount|customer|client|balance)(?![a-z0-9_]))[^;.!?]){0,60}(?<![a-z0-9_])(?:invoices?|receipts?|payments?|paid|unpaid|total|subtotal|tax|notes?|currency|due date|invoice date|amount|customer|client|balance)(?![a-z0-9_])|(?:invoice(?: number| no| date)?|due date|total|subtotal|tax|amount|currency|notes?|customer(?: name)?|client(?: name)?)(?: +(?:is|was|are|were)(?![a-z0-9_]) *| *[:=] *))`;
const financialQuoteHint='(?:invoices?|bills?(?! +gates)|receipts?|[0-9][0-9,.]* *, *due +[0-9])';
const documentAttribution='(?:(?:this|the|our|my|that|an?) +)?(?:invoices?|bills?|receipts?) +(?:(?:is|was|are|were) +)?(?:from|for|to|of|belongs? +to|issued +by|sent +by) +';
// Record identity and relational prose are declarative source forms. All
// downstream sinks consume this same grammar before ordinary-clause separation.
const originDocumentIntro='(?:(?:here|below|following|attached) +(?:is|are) +)?(?:(?:the|an?|my|our|this|that) +)?(?:invoices?|bills?|receipts?)';
const explicitRecordMarker='(?: +(?:number(?![a-z0-9_])|no\\.?) *(?:[:#=] *|(?=[a-z0-9._/-]*[0-9]))| *[#№] *)';
const bareRecordMarker=' +(?=[a-z0-9._/-]*[0-9])';
export const privateOriginRecordHeader='^'+originDocumentIntro+'(?:'+explicitRecordMarker+'|'+bareRecordMarker+')';
const explicitRecordHeader=originDocumentIntro+explicitRecordMarker;
const originClauseStart='(?:^|(?<=[;!?:]) *|(?<=[.]) *)';
const bareRecordHeader=originClauseStart+originDocumentIntro+bareRecordMarker;
export const privateOriginClauseBoundary='[;!?]|[.](?=[ ,]|$)';
export const privateNameAbbreviations=['mr','mrs','ms','mx','dr','prof','sr','jr','st','rev','hon','fr','capt','sgt','lt','col','gen','inc','ltd','co','corp'];
export const grammarAuxiliaries=['am','is','was','are','were','be','been','being','has','had','have','will','shall','can','could','would','did','does','do','may','might','must','should'];
const financialSubject="(?:i|we|you|he|she|it|they)(?:['’ʼ](?:m|re|ve|ll|d|s))?";
const financialPredicate='(?:invoic(?:es?|ing)|bill(?:s|ing)?)';
const questionHeads='who|what|which|when|where|why|how';
const requestHeads='explain|describe|discuss|define|show|tell|teach|help|compare';
const nominalActorToken='(?!(?:'+questionHeads+'|'+financialPredicate+')(?![a-z0-9_]))[^ ,:;.!?]+';
const nominalActor='(?!(?:'+questionHeads+'|'+requestHeads+')(?![a-z0-9_]))'+nominalActorToken+'(?: +'+nominalActorToken+'){0,5}';
const actorPredicate=originClauseStart+nominalActor+' +(?:(?:(?:'+grammarAuxiliaries.join('|')+') +)+)'+financialPredicate;
const actorThirdPerson=originClauseStart+nominalActor+' +(?:invoices|bills|invoiced|billed)(?![a-z0-9_])';
// Finite subject/auxiliary/predicate roles accept tense and aspect without
// treating the nominal topics "billing" and "invoicing" as declarations.
export const privateOriginEvent=`(?:${actorPredicate}|${actorThirdPerson})(?![a-z0-9_])|(?<![a-z0-9_])(?:(?:invoiced|billed)|${financialSubject} +(?:(?:${grammarAuxiliaries.join('|')}) +)*${financialPredicate})(?![a-z0-9_])`;
export const privateOriginCopulas=['am','is','are','was','were'];
export const privateOriginGenericPartyStart='^(?:(?:(?:a|an|the|our|my|your|some|any|all) +)+(?:customers?|clients?|companies|company|business(?:es)?|studios?|teams?|organizations?|organisations?|suppliers?|vendors?|debtors?|creditors?|people)|(?:customers|clients|companies|businesses|studios|teams|organizations|organisations|suppliers|vendors|debtors|creditors|people))(?![a-z0-9_])';
export const privateOriginNoun='(?<![a-z0-9_])(?:invoices?|bills?|receipts?)(?![a-z0-9_])';
export const privateOriginCarrier='(?<![a-z0-9_])(?:issu(?:es?|ed|ing)|send(?:s|ing)?|sent|receiv(?:es?|ed|ing)|generat(?:es?|ed|ing)|creat(?:es?|ed|ing))(?![a-z0-9_])';
export const privateOriginDocumentPrefix='^(?:(?:the|an?|my|our|this|that) +)?(?:invoices?|bills?|receipts?)(?![a-z0-9_])';
export const privateOriginPartyLabel='(?<![a-z0-9_])(?:customer|client|party|company|supplier|vendor|debtor|creditor)(?: +name)? *(?:(?:is|was|to) +|[:=] *)';
export const privateOriginMonetaryBefore=`(?<![a-z0-9_])(?:total|subtotal|tax|amount|balance|price|rate|quantity)(?![a-z0-9_]) *(?:(?:is|was|are|were|to)(?![a-z0-9_]) *)?[:=]? *(?:(?:${currencyUnitPattern}|\\p{Sc}) *)?[+−-]? *$`;
export const privateOriginDateBefore='(?<![a-z0-9_])(?:due(?: +date)?|invoice +date|date)(?![a-z0-9_]) *(?:(?:is|was|to)(?![a-z0-9_]) *)?[:=]? *$';
export const privateOriginLiteralLabel='(?<![a-z0-9_])(?:notes?|currency)(?![a-z0-9_]) *(?:(?:is|was|to)(?![a-z0-9_]) *|[:=] *)';
export const privateOriginRelationStart='^(?:(?:is|was|are|were) +)?(?:to|from|for|of|belongs? +to|issued +by|sent +by)(?![a-z0-9_]) *';
export const privateOriginRelationEnd=' +(?:to|from|for|of|and) *$';
export const privateOriginPronouns=['i','me','my','mine','myself','we','us','our','ours','ourselves','you','your','yours','yourself','yourselves','he','him','his','himself','she','her','hers','herself','it','its','itself','they','them','their','theirs','themselves'];
export const privateOriginNameEdge='^[ ,:;>]+|[ ,:;>]+$';
const linkedRecordHeader=privateOriginCarrier+'(?:(?!'+privateOriginClauseBoundary+').)*?'+originDocumentIntro+bareRecordMarker;
export const privateOriginActorTail=' +(?:(?:'+grammarAuxiliaries.join('|')+') +)*(?:'+financialPredicate+'|invoiced|billed)$';
export const privateOriginPersonalSubject='^'+financialSubject+'$';
// Necessary lexical terminals of the declaration grammar. This cheap superset
// rejects ordinary/numeric fields before evaluating role and provenance rules.
export const privateOriginLexicalHint='invoic|bill|receipt|payment|paid|total|subtotal|tax|note|currency|due|amount|customer|client|balance';
export const privateOriginHeader=`${bareRecordHeader}|${linkedRecordHeader}|(?<![a-z0-9_])(?:(?:here|below|following|attached) +(?:is|are) +(?:(?:the|an?|my|our|this) +)?(?:invoices?|bills?(?! +gates)|receipts?)(?![a-z0-9_])|(?:forwarded|quoted|copied|pasted)(?: +(?:invoice|bill|receipt|message|text))* *[:>](?=.*${financialQuoteHint})|${explicitRecordHeader}|${documentAttribution}|(?:invoice|bill|receipt) *(?=[:,]))|${privateDataDeclaration}|${privateOriginEvent}`;

// Lexical translations preserve offsets and do not alter names/Unicode keys.
// Hindi cardinal atoms (0..99) feed the same scale/group grammar as English.
export const nativeCardinals='शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उनासी अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे पंचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे'.split(' ');
export const lexicalAliases=Object.fromEntries(nativeCardinals.map((word,i)=>[word,String(i)]));
Object.assign(lexicalAliases,{'पांच':'5','पन्द्रह':'15','सौ':'hundred','हजार':'thousand','हज़ार':'thousand','लाख':'lakh','करोड़':'crore','और':'and','दशमलव':'point','रुपये':'rupees','रुपया':'rupee','जनवरी':'jan','फ़रवरी':'feb','फरवरी':'feb','मार्च':'mar','अप्रैल':'apr','मई':'may','जून':'jun','जुलाई':'jul','अगस्त':'aug','सितंबर':'sep','सितम्बर':'sep','अक्टूबर':'oct','अक्तूबर':'oct','नवंबर':'nov','नवम्बर':'nov','दिसंबर':'dec','दिसम्बर':'dec'});

const originMonths='(?:'+monthPattern+'|'+Object.entries(lexicalAliases).filter(([,value])=>months.includes(value)).map(([key])=>key).join('|')+')';
const originDays='(?:'+namedDayPattern+'|'+nativeCardinals.slice(1,32).join('|')+')';
const namedBareDates=[`(?:the +)?${originDays}${dateSeparator}(?:of +)?${originMonths}`,`${originMonths}${dateSeparator}(?:the +)?${originDays}`];
export const originDateCommaPattern=`(${namedBareDates.join('|')})[ ./-]*,[ ./-]*(['’ʼ]?[0-9]{4}|['’ʼ]?[0-9]{2})(?![0-9])`;

// Transliteration is an additional party-reference key, never the Unicode
// field key. Distinct inherent/vowel signs remain distinct (kiran != karan).
export const partyTransliteration=Object.fromEntries(Object.entries({'अ':'a','आ':'aa','इ':'i','ई':'ii','उ':'u','ऊ':'uu','ऋ':'ri','ए':'e','ऐ':'ai','ओ':'o','औ':'au','क':'ka','ख':'kha','ग':'ga','घ':'gha','ङ':'nga','च':'cha','छ':'chha','ज':'ja','झ':'jha','ञ':'nya','ट':'ta','ठ':'tha','ड':'da','ढ':'dha','ण':'na','त':'ta','थ':'tha','द':'da','ध':'dha','न':'na','प':'pa','फ':'pha','ब':'ba','भ':'bha','म':'ma','य':'ya','र':'ra','ल':'la','व':'va','श':'sha','ष':'sha','स':'sa','ह':'ha','ळ':'la','ा':'aa','ि':'i','ी':'ii','ु':'u','ू':'uu','ृ':'ri','े':'e','ै':'ai','ो':'o','ौ':'au','्':'','ं':'n','ँ':'n','ः':'h','़':''}));
export const partyReference='(?:ask|contact|call|pay|send(?: +to)?|tell +me +about|advice +from|talk +to|message|email|फोन|पूछो|पूछें|भेजो)';

// Formal components that also serve as grammar remain reference-scoped keys.
// They are protected as personal targets, not as articles in unrelated prose.
export const partyGrammarWords=['a','an','the','and','or','of','for','to','in','on','at','by','with','from',...grammarAuxiliaries];
export const partyFunctionWords=[...partyGrammarWords,'de','del','la','le','van','von','da','di'];
// Enumeration is a syntactic frame before the candidate, never a noun found
// elsewhere in a message (e.g. a singular decimal on a shopping list).
// Lexical classes for a syntactic list, independent of its punctuation or noun.
export const numericSelectionWords=['choose','select','pick','compare','between','among'];
export const numericCollectiveWords=['pair','couple'];
// Only transport padding is removed before JSON decoding. String values are
// decoded first, then canonically screened; normalization must not change JSON.
export const privateJSONPadding=/[\p{White_Space}\p{Cf}]/u;
export const PRIVATE_NUMBER_LIST_MAX_GROUPS=32; // Switch to a compact graph, never reject a longer run.
