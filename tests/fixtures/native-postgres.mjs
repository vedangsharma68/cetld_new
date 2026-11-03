import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,cp,readdir,lstat,writeFile,unlink,chmod,chown,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const exec=promisify(execFile);
async function identity(){
 const uid=process.getuid?.(),gid=process.getgid?.();
 if(uid!==0)return {uid,gid};
 // Use an existing unprivileged OS identity. No useradd/groupadd, persistent
 // accounts, host-directory permission changes, or root postgres process.
 for(const name of ['nobody','daemon'])try{
  const user=Number((await exec('id',['-u',name])).stdout.trim());
  const group=Number((await exec('id',['-g',name])).stdout.trim());
  if(Number.isInteger(user)&&user>0&&Number.isInteger(group)&&group>=0)return {uid:user,gid:group};
 }catch{}
 throw new Error('Native PostgreSQL requires an existing non-root OS account');
}

export async function createNativePostgresFixture({port}){
 const directory=await mkdtemp(path.join(tmpdir(),'cetld-private-native-'));
 const runAs=await identity();const databaseDir=path.join(directory,'data');
 let binaries=await import(`@embedded-postgres/${process.platform}-${process.arch}`);
 {
  // The checkout/cache can be root-only (0700). Copy the native distribution
  // into this disposable directory for every run; never chmod the checkout or host packages.
  const distribution=path.join(directory,'distribution');
  await cp(path.dirname(path.dirname(binaries.postgres)),distribution,{recursive:true,verbatimSymlinks:true});
  const readable=async p=>{const st=await lstat(p);if(st.isSymbolicLink())return;if(st.isDirectory()){await chmod(p,0o755);for(const name of await readdir(p))await readable(path.join(p,name));}else await chmod(p,(st.mode&0o111)?0o755:0o644);};
  await readable(distribution);
  binaries={initdb:path.join(distribution,'bin','initdb'),postgres:path.join(distribution,'bin','postgres')};
 }
 const password='local-fixture-only',passwordFile=path.join(directory,'init-password');
 const clientFactory=new EmbeddedPostgres({databaseDir,user:'postgres',password,port,onLog(){},onError(){}});
 const env={...process.env,LANG:'C',LC_ALL:'C',LC_MESSAGES:'C'};
 let server;
 if(process.getuid?.()===0)await chown(directory,runAs.uid,runAs.gid);
 await chmod(directory,0o700);
 const child=(file,args)=>spawn(file,args,{...runAs,env,cwd:directory,stdio:['ignore','pipe','pipe']});
 return {
  identity:runAs,
  async initialise(){
   await writeFile(passwordFile,password+'\n',{mode:0o600});
   if(process.getuid?.()===0)await chown(passwordFile,runAs.uid,runAs.gid);
   try{await new Promise((resolve,reject)=>{
    const p=child(binaries.initdb,['-D',databaseDir,'-U','postgres','--auth=scram-sha-256','--pwfile='+passwordFile,'--encoding=UTF8','--locale=C','--lc-messages=C']);
    let output='';p.stdout.on('data',b=>{output+=b;});p.stderr.on('data',b=>{output+=b;});p.once('error',reject);p.once('close',code=>code===0?resolve():reject(new Error('Native initdb failed: '+output.slice(-2000))));
   });}finally{await unlink(passwordFile).catch(()=>{});}
  },
  async start(){
   await new Promise((resolve,reject)=>{
    server=child(binaries.postgres,['-D',databaseDir,'-p',String(port),'-h','127.0.0.1','-k',directory,'-c','lc_messages=C']);
    let output='';const timer=setTimeout(()=>reject(new Error('Native PostgreSQL startup timeout: '+output.slice(-1000))),15000);
    const done=callback=>value=>{clearTimeout(timer);callback(value);};
    server.stderr.on('data',b=>{output+=b;if(output.includes('database system is ready to accept connections'))done(resolve)();});
    server.once('error',done(reject));server.once('exit',code=>done(reject)(new Error('Native PostgreSQL exited: '+code+' '+output.slice(-1000))));
   });
  },
  getPgClient(){return clientFactory.getPgClient('postgres','127.0.0.1');},
  async stop(){
   if(server&&server.exitCode===null&&server.signalCode===null){await new Promise(resolve=>{server.once('exit',resolve);server.kill('SIGINT');});}
   await rm(directory,{recursive:true,force:true});
  },
 };
}
