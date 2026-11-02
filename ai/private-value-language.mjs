// Declarative grammar shared by the JS matcher and SQL generation.
export const PRIVATE_DATE_YEAR_PIVOT=69; // 00..69 => 2000..2069; 70..99 => 1970..1999.
export const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
export const monthPattern='(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
export const ordinals='first,second,third,fourth,fifth,sixth,seventh,eighth,ninth,tenth,eleventh,twelfth,thirteenth,fourteenth,fifteenth,sixteenth,seventeenth,eighteenth,nineteenth,twentieth,twenty first,twenty second,twenty third,twenty fourth,twenty fifth,twenty sixth,twenty seventh,twenty eighth,twenty ninth,thirtieth,thirty first'.split(',');
export const units='(?:inr|usd|eur|gbp|aed|sgd|aud|cad|chf|rs|rupees?|dollars?|euros?|pounds?)';
export const small=Object.fromEntries('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ').map((word,i)=>[word,BigInt(i)]));
for(const [i,word] of ['twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'].entries())small[word]=BigInt((i+2)*10);
export const scales={thousand:1000n,lakh:100000n,lac:100000n,million:1000000n,crore:10000000n,billion:1000000000n};
export const fractions={half:2n,halves:2n,quarter:4n,quarters:4n,third:3n,fifth:5n,sixth:6n,seventh:7n,eighth:8n,ninth:9n,tenth:10n};
// Private printed evidence keeps a field label separate from its value. This
// grammar applies only to explicitly tagged evidence, not arbitrary names.
export const evidenceLabel='^[a-z_][a-z0-9_ .#%()/-]{0,80}[:=] *';
export const evidenceNumericLabel='^[a-z_][a-z_ .#%()/-]{0,80} +(?=[0-9+−\\p{Sc}-])';
export const evidenceDateLabel='^(?:invoice +date|due(?: +date)?|date)(?![a-z])';
// Shared canonical grammar: SQL is generated from these same expressions.
export const currencyUnitPattern=units.replace('|rs|','|rs\\.?|');
export const namedDayPattern=`(?:[0-9]{1,2}(?:st|nd|rd|th)?|${ordinals.map(day=>day.replaceAll(' ','[ -]+')).join('|')})`;
export const dateSeparator='[ ./-]*';
export const namedYearTail=`(?:[ ,./-]*['’ʼ]? *([0-9]{4}|[0-9]{2}|[0-9]{1,3}))?`;
export const namedDatePatterns=[
 `(?:the +)?(${namedDayPattern})${dateSeparator}(?:of +)?(${monthPattern})${namedYearTail}`,
 `(${monthPattern})${dateSeparator}(?:the +)?(${namedDayPattern})${namedYearTail}`,
];
const financialQuoteHint='(?:invoices?|bills?(?! +gates)|receipts?|[0-9][0-9,.]* *, *due +[0-9])';
export const privateOriginHeader=`(?<![a-z0-9_])(?:(?:here|below|following|attached) +(?:is|are) +(?:(?:the|an?|my|our|this) +)?(?:invoices?|bills?(?! +gates)|receipts?)(?![a-z0-9_])|(?:forwarded|quoted|copied|pasted)(?: +(?:invoice|bill|receipt|message|text))* *[:>](?=.*${financialQuoteHint})|(?:this|the|our|my|that) +(?:invoice|bill|receipt) +(?:is +)?(?:from|for|to) +|(?:invoice|bill|receipt) *(?=[:,]))`;
export const privateOriginFieldLabel='^(?:due(?: +date)?|invoice +date|bill +to|customer(?: +name)?|client(?: +name)?|amount|total) *(?::|=|is +)? *';
const namedBareDates=[`(?:the +)?${namedDayPattern}${dateSeparator}(?:of +)?${monthPattern}`,`${monthPattern}${dateSeparator}(?:the +)?${namedDayPattern}`];
export const originDateCommaPattern=`(${namedBareDates.join('|')}) *, *(['’ʼ]?[0-9]{4}|['’ʼ]?[0-9]{2})(?![0-9])`;

// Lexical translations preserve offsets and do not alter names/Unicode keys.
// Hindi cardinal atoms (0..99) feed the same scale/group grammar as English.
export const nativeCardinals='शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उनासी अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे पंचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे'.split(' ');
export const lexicalAliases=Object.fromEntries(nativeCardinals.map((word,i)=>[word,String(i)]));
Object.assign(lexicalAliases,{'पांच':'5','पन्द्रह':'15','सौ':'hundred','हजार':'thousand','हज़ार':'thousand','लाख':'lakh','करोड़':'crore','और':'and','दशमलव':'point','रुपये':'rupees','रुपया':'rupee','जनवरी':'jan','फ़रवरी':'feb','फरवरी':'feb','मार्च':'mar','अप्रैल':'apr','मई':'may','जून':'jun','जुलाई':'jul','अगस्त':'aug','सितंबर':'sep','सितम्बर':'sep','अक्टूबर':'oct','अक्तूबर':'oct','नवंबर':'nov','नवम्बर':'nov','दिसंबर':'dec','दिसम्बर':'dec'});

// Transliteration is an additional party-reference key, never the Unicode
// field key. Distinct inherent/vowel signs remain distinct (kiran != karan).
export const partyTransliteration=Object.fromEntries(Object.entries({'अ':'a','आ':'aa','इ':'i','ई':'ii','उ':'u','ऊ':'uu','ऋ':'ri','ए':'e','ऐ':'ai','ओ':'o','औ':'au','क':'ka','ख':'kha','ग':'ga','घ':'gha','ङ':'nga','च':'cha','छ':'chha','ज':'ja','झ':'jha','ञ':'nya','ट':'ta','ठ':'tha','ड':'da','ढ':'dha','ण':'na','त':'ta','थ':'tha','द':'da','ध':'dha','न':'na','प':'pa','फ':'pha','ब':'ba','भ':'bha','म':'ma','य':'ya','र':'ra','ल':'la','व':'va','श':'sha','ष':'sha','स':'sa','ह':'ha','ळ':'la','ा':'aa','ि':'i','ी':'ii','ु':'u','ू':'uu','ृ':'ri','े':'e','ै':'ai','ो':'o','ौ':'au','्':'','ं':'n','ँ':'n','ः':'h','़':''}));
export const partyReference='(?:ask|contact|call|pay|send(?: +to)?|tell +me +about|advice +from|talk +to|message|email|फोन|पूछो|पूछें|भेजो)';
