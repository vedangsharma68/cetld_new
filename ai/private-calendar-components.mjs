export const privateCalendarComponentTokenPattern='[0-9]{4} *[-/.] *[0-9]{1,2} *[-/.] *[0-9]{1,2}|[0-9]{1,2} *[/.] *[0-9]{1,2}(?: *[/.] *(?:[0-9]{4}|[0-9]{2}))?|[\\p{L}\\p{M}]+|[0-9]+(?:st|nd|rd|th)?|[’\'ʼ][0-9]+';
// Calendar components form coordinated constraints, not sentence frames.
// Month/year anchors bind every connected endpoint, including ellipsis.
export function sharedCalendarComponents(text,monthPattern){
 const lexeme=new RegExp(privateCalendarComponentTokenPattern,'gu');
 const words=[...text.matchAll(lexeme)].flatMap(w=>{if(/^[0-9].*[/.]/.test(w[0])&&w[0].match(/[0-9]+/g).length===2&&(new RegExp(monthPattern+'[ .-]*$','u').test(text.slice(0,w.index))||new RegExp('^[ .-]*'+monthPattern,'u').test(text.slice(w.index+w[0].length))))return [...w[0].matchAll(/[0-9]+/g)].map(x=>Object.assign([x[0]],{index:w.index+x.index}));return [w];}),groups=[];let group=[];
 const monthRE=new RegExp('^'+monthPattern+'$','u'),month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
 const flush=()=>{if(group.length)groups.push(group);group=[];};
 for(const w of words){const value=w[0];
  if(/^[0-9].*[/.\-]/u.test(value)){const rawParts=value.match(/[0-9]+/g),parts=rawParts.map(Number),iso=/^[0-9]{4}/.test(value),m=iso?parts[1]:parts[1],day=iso?parts[2]:parts[0],year=iso?parts[0]:(parts[2]??null);group.push({value:String(day),n:day,month:0,numericMonth:m,ownYear:year!==null&&!iso&&rawParts[2].length===2?year+(year<=69?2000:1900):year,start:w.index,end:w.index+value.length},{value:String(m),month:m,n:null,start:w.index,end:w.index+value.length});if(year!==null)group.push({value:String(!iso&&rawParts[2].length===2?year+(year<=69?2000:1900):year),month:0,n:!iso&&rawParts[2].length===2?year+(year<=69?2000:1900):year,start:w.index,end:w.index+value.length});continue;}
  const m=monthRE.test(value)?month.indexOf(value.slice(0,3))+1:0,n=/^[’'ʼ]?[0-9]+(?:st|nd|rd|th)?$/.test(value)?parseInt(value.replace(/^[’'ʼ]/,''),10):null;
  if(m||n!==null){group.push({value,start:w.index,end:w.index+value.length,month:m,n});}
  else if(['and','or','the','of','to','through','until'].includes(value)&&group.length){group.push({value,start:w.index,end:w.index+value.length,join:true});}else flush();
 }flush();
 const result=[];
 for(const raw of groups){const g=raw.filter(x=>!x.join);if(!g.some(x=>x.month)||g.filter(x=>x.n!==null&&x.n<=31).length<2)continue;
  const explicitYears=new Set();for(let i=1;i+1<g.length;i++)if(g[i].month&&g[i-1].n>=1&&g[i-1].n<=31&&g[i+1].n!==null&&[2,4].includes(g[i+1].value.length)&&!g[i+2]?.month&&!text.slice(g[i].end,g[i+1].start).includes(','))explicitYears.add(g[i+1]);
  const years=g.filter((x,i)=>x.n!==null&&(explicitYears.has(x)||x.n>31||x.value.replace(/^[’'ʼ]/,'').length===4||/^[’'ʼ]/.test(x.value)));
  const days=g.filter(x=>x.n!==null&&!years.includes(x)&&x.n>=1&&x.n<=31);if(days.length<2)continue;
  const assigned=new Map();
  for(const d of days){const at=g.indexOf(d),choices=[g[at-1],g[at+1]].filter(x=>x?.month&&!/[,]|\b(?:and|or|to|through|until)\b/u.test(text.slice(Math.min(x.end,d.end),Math.max(x.start,d.start))));choices.sort((a,b)=>{const gap=x=>text.slice(Math.min(x.end,d.end),Math.max(x.start,d.start));return Number(/[-–—]/.test(gap(a)))-Number(/[-–—]/.test(gap(b)))||Math.abs(a.start-d.start)-Math.abs(b.start-d.start);});if(choices[0])assigned.set(d,choices[0]);}
  if(!assigned.size)continue;
  let complete=true;const values=[];for(const d of days){let anchor=assigned.get(d);if(!anchor){const near=[...assigned.keys()].sort((a,b)=>Math.abs(a.start-d.start)-Math.abs(b.start-d.start))[0];anchor=assigned.get(near);}const own=years.find(y=>y.start>=Math.max(d.end,anchor.end)&&!g.some(x=>x!==d&&x!==anchor&&(x.month||days.includes(x))&&x.start>Math.min(d.start,anchor.start)&&x.start<=y.start));if(!assigned.has(d)||d.ownYear==null&&!own)complete=false;const y=own||years.slice().sort((a,b)=>Math.abs(a.start-d.start)-Math.abs(b.start-d.start))[0];let year=d.ownYear??y?.n??null;if(d.ownYear==null&&y&&y.value.replace(/^[’'ʼ]/,'').length===2)year+=year<=69?2000:1900;values.push({year,month:anchor.month,day:d.n});}
  if(complete)continue;
  const alternatives=days.map((d,i)=>d.numericMonth!=null&&d.n<=12&&d.numericMonth<=31?{year:values[i].year,month:d.n,day:d.numericMonth}:null);
  const ranges=[];for(let i=1;i<days.length;i++){const gap=text.slice(days[i-1].end,days[i].start);if(/[-–—−]|\b(?:to|through|until)\b/u.test(gap)){ranges.push([values[i-1],values[i]]);for(const a of [values[i-1],alternatives[i-1]].filter(Boolean))for(const b of [values[i],alternatives[i]].filter(Boolean))if(a!==values[i-1]||b!==values[i])ranges.push([a,b]);}}
  result.push({start:raw[0].start,end:raw.at(-1).end,values:values.concat(alternatives.filter(Boolean)),ranges});
 }
 return result;
}
