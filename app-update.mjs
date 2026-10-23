// A build-stamped baseline avoids accepting a newer deployment as the loaded version.
export function watchAppVersion({document:doc=document, window:win=window, fetchImpl=fetch, interval=60000}={}) {
  const current=doc.querySelector('meta[name="app-version"]')?.content;
  if (!current || current==='development') return () => {};
  let pending=false, stopped=false, available=false;
  const check=async()=>{
    if (pending || stopped || available || doc.visibilityState==='hidden') return;
    pending=true;
    try {
      const response=await fetchImpl(`/app-version.json?t=${Date.now()}`,{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(10000)});
      if (!response.ok) return;
      const {version}=await response.json();
      if (stopped || !/^[a-f0-9]{64}$/.test(version) || version===current) return;
      available=true;
      const banner=doc.createElement('aside');
      banner.className='app-update';banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');
      const message=doc.createElement('span');message.textContent='A new version of Cetld is ready. Save your work, then refresh.';
      const button=doc.createElement('button');button.type='button';button.className='btn primary';button.textContent='Refresh app';
      button.addEventListener('click',()=>{if(win.confirm('Refresh Cetld now? Unsaved edits will be lost.'))win.location.reload()});
      banner.append(message,button);doc.body.append(banner);
    } catch { /* Offline and transient failures leave the current tab usable. */ }
    finally {pending=false}
  };
  const timer=win.setInterval(check,interval);
  win.addEventListener('focus',check);doc.addEventListener('visibilitychange',check);win.addEventListener('online',check);
  void check();
  return ()=>{stopped=true;win.clearInterval(timer);win.removeEventListener('focus',check);doc.removeEventListener('visibilitychange',check);win.removeEventListener('online',check)};
}
