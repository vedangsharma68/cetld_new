"""Extract the complete pinned WordNet verb inventories, without example filtering."""
import pathlib,json,hashlib,zipfile,sys
root=pathlib.Path(__file__).resolve().parent.parent;meta=json.loads((root/'data/private-language/wordnet-verb-source.json').read_text());archive=pathlib.Path(sys.argv[1]);assert hashlib.sha256(archive.read_bytes()).hexdigest()==meta['archiveSha256'];z=zipfile.ZipFile(archive)
records={};out={};children={};anchors={}
for line in z.read('wordnet/data.verb').decode().splitlines():
 if not line or line.startswith(' '):continue
 t=line.split('|')[0].split();count=int(t[3],16);words=[t[4+2*i] for i in range(count)];p=4+2*count;np=int(t[p]);p+=1
 for j in range(np):
  symbol,target,pos,indices=t[p:p+4];p+=4
  if symbol=='@':children.setdefault(target,set()).add(t[0])
 n=int(t[p]);p+=1;frames={w:[] for w in words}
 for _ in range(n):
  f=int(t[p+1]);ix=int(t[p+2],16);p+=3
  for i,w in enumerate(words):
   if ix in [0,i+1]:frames[w].append(f)
 records[t[0]]={w.lower():fs for w,fs in frames.items()}
 if t[1]=='31' and 'order' in [w.lower() for w in words]:anchors['order.cognition.'+t[0]]=t[0]
 for w,fs in frames.items():
  w=w.lower()
  if not w.isalpha():continue
  v=out.setdefault(w,[False,[],False]);v[0]|=any(f in [9,10,17,18] for f in fs)
  if any(f in [8,11] for f in fs) and int(t[1]) not in v[1]:v[1].append(int(t[1]))
for line in z.read('wordnet/index.verb').decode().splitlines():
 if not line or line.startswith(' '):continue
 t=line.split();w=t[0]
 if w not in out:continue
 first=t[6+int(t[3])];
 if w in ['choose','compare','group','arrange']:anchors[w]=first
 out[w][2]=any(f in [9,10,17,18] for f in records[first][w])
 out[w].append(records[first][w])
nounChildren={};nounRecords={}
for line in z.read('wordnet/data.noun').decode().splitlines():
 if not line or line.startswith(' '):continue
 t=line.split('|')[0].split();n=int(t[3],16);nounRecords[t[0]]=[t[4+2*i] for i in range(n)];j=4+2*n;count=int(t[j]);j+=1
 for _ in range(count):
  symbol,target,pos,indices=t[j:j+4];j+=4
  if symbol=='@':nounChildren.setdefault(target,set()).add(t[0])
# Logical arrangement of separate elements, with all hyponyms (ordering.n.01).
orderingSeen={'08456993'};pending=list(orderingSeen)
while pending:
 for child in nounChildren.get(pending.pop(),set()):
  if child not in orderingSeen:orderingSeen.add(child);pending.append(child)
ordering=sorted({w for synset in orderingSeen for w in nounRecords[synset] if w.isalpha()})
nounKinds={line.split()[0]:int(line.split()[1]) for line in z.read('wordnet/data.noun').decode().splitlines() if line and not line.startswith(' ')}
heads=[]
for line in z.read('wordnet/index.noun').decode().splitlines():
 if not line or line.startswith(' '):continue
 t=line.split()
 if t[0].isalpha() and nounKinds[t[6+int(t[3])]]==18:heads.append(t[0])
seen=set(anchors.values());pending=list(seen)
while pending:
 for child in children.get(pending.pop(),set()):
  if child not in seen:seen.add(child);pending.append(child)
collection=sorted({w for synset in seen for w in records[synset] if w.isalpha()})
base=root/'data/private-language';(base/'wordnet-ordering-nouns.txt').write_text('\n'.join(ordering)+'\n');meta['orderingNounOntologyAnchor']='08456993'
(base/'wordnet-collection-verbs.txt').write_text('\n'.join(collection)+'\n');meta['collectionOntologyAnchors']=anchors
(base/'wordnet-person-heads.txt').write_text('\n'.join(sorted(heads))+'\n');(base/'wordnet-verb-frames.json').write_text(json.dumps(out,separators=(',',':'))+'\n');(base/'wordnet-verb-exceptions.txt').write_bytes(z.read('wordnet/verb.exc'));(root/'docs/private-wordnet-LICENSE.txt').write_bytes(z.read('wordnet/LICENSE'))
meta['extraction']='All single-word verb frame inventories, ranked first-sense person-object frames, and complete verb exceptions; no example filtering'
meta['files']={str(f.relative_to(root)):hashlib.sha256(f.read_bytes()).hexdigest() for f in [base/'wordnet-ordering-nouns.txt',base/'wordnet-verb-frames.json',base/'wordnet-verb-exceptions.txt',base/'wordnet-person-heads.txt',base/'wordnet-collection-verbs.txt',root/'docs/private-wordnet-LICENSE.txt']};(base/'wordnet-verb-source.json').write_text(json.dumps(meta,indent=2)+'\n')
