async function prepareThreads() {
  if (globalThis.crossOriginIsolated || !('serviceWorker' in navigator)) return true;
  const key = 'chessreview.isolation-reload';
  let timer;
  try {
    // Retry only once per tab, including browsers that cannot isolate embedded pages.
    if (sessionStorage.getItem(key)) return true;
    const ready = (async () => {
      await navigator.serviceWorker.register('/isolation-worker.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
      }
      return true;
    })();
    const active = await Promise.race([ready,new Promise(resolve => {timer=setTimeout(()=>resolve(false),8000);})]);
    if (active && navigator.serviceWorker.controller) {
      sessionStorage.setItem(key,'1');
      location.reload();
      return false;
    }
  } catch { /* Single-thread Stockfish remains usable without service workers or storage. */ }
  finally { clearTimeout(timer); }
  return true;
}

if (await prepareThreads()) await import('./app.js');
