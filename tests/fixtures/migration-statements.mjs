// Split only top-level SQL commands; function bodies and quoted semicolons stay
// intact. This lets native upgrade tests enforce a tighter per-command budget.
export function migrationStatements(source){
 const rows=[];let start=0,quote=null,dollar=null,line=false,block=0;
 for(let i=0;i<source.length;i++){
  const c=source[i],next=source[i+1];
  if(line){if(c==='\n')line=false;continue;}
  if(block){if(c==='/'&&next==='*'){block++;i++;}else if(c==='*'&&next==='/'){block--;i++;}continue;}
  if(dollar){if(source.startsWith(dollar,i)){i+=dollar.length-1;dollar=null;}continue;}
  if(quote){if(c===quote){if(next===quote)i++;else quote=null;}else if(c==='\\'&&quote==="'")i++;continue;}
  if(c==='-'&&next==='-'){line=true;i++;continue;}
  if(c==='/'&&next==='*'){block++;i++;continue;}
  if(c==="'"||c==='"'){quote=c;continue;}
  if(c==='$'){const tag=/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(source.slice(i));if(tag){dollar=tag[0];i+=dollar.length-1;continue;}}
  if(c===';'){rows.push(source.slice(start,i+1));start=i+1;}
 }
 if(source.slice(start).trim())rows.push(source.slice(start));return rows;
}
