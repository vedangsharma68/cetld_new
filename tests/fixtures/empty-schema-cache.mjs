import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir,writeFile,rename,unlink,stat,mkdir,rmdir} from 'node:fs/promises';
import {join} from 'node:path';

// This is a disposable, per-release cache, not a deployment or database cache.
// One atomic file contains both integrity metadata and the empty-schema archive.
const MAX_ARCHIVE_BYTES=16*1024*1024,MAX_ENTRIES=32;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function emptySchemaKey(inputs,{node=process.version,versions=process.versions,platform=process.platform,arch=process.arch}={}) {
  return digest(JSON.stringify({format:1,node,versions,platform,arch,inputs}));
}
export async function cachedEmptySchema({directory,key,create,restore}) {
  if(!directory)return create();
  if(!/^[a-f0-9]{64}$/.test(key))throw Error('Invalid empty-schema cache key');
  const target=join(directory,key+'.tgz');
  try {
    // Bound reads as well as writes. Bad/missing/unreadable cache is always a miss.
    if((await stat(target)).size<=MAX_ARCHIVE_BYTES+256){
      const bytes=await readFile(target),newline=bytes.indexOf(10);
      const header=JSON.parse(bytes.subarray(0,newline).toString()),archive=bytes.subarray(newline+1);
      if(header.key===key&&header.sha256===digest(archive)&&archive.length<=MAX_ARCHIVE_BYTES)
        return await restore(new Blob([archive]));
    }
  } catch { /* Cold schema creation remains authoritative. */ }
  const db=await create();
  let temporary,locked=false;
  const lock=join(directory,'.publish-lock');
  try {
    // Contending/crashed publishers cause a cache miss, never a wait or partial read.
    await mkdir(lock);locked=true;
    const entries=(await readdir(directory)).filter(file=>/^[a-f0-9]{64}\.tgz$/.test(file));
    // Publication is serialized, so the 32-entry storage bound is exact.
    // Once full, new keys run cold until release cleanup removes the directory.
    if(entries.length>=MAX_ENTRIES)return db;
    const blob=await db.dumpDataDir('gzip');
    if(blob.size>MAX_ARCHIVE_BYTES)return db;
    const archive=Buffer.from(await blob.arrayBuffer());
    const header=Buffer.from(JSON.stringify({key,sha256:digest(archive)})+'\n');
    temporary=target+'.'+randomUUID()+'.tmp';
    await writeFile(temporary,Buffer.concat([header,archive]),{mode:0o600,flag:'wx'});
    await rename(temporary,target);
  } catch { /* Cache storage is optional; never hide a schema creation error. */ }
  finally {
    if(temporary)await unlink(temporary).catch(()=>{});
    if(locked)await rmdir(lock).catch(()=>{});
  }
  return db;
}
