/** Only the explicitly marked dashboard fragments are refreshed; forms keep their input. */
export const ADMIN_LIVE_SCRIPT = `(() => {
  const status = document.getElementById('live-status');
  const toggle = document.getElementById('live-toggle');
  let paused = false, busy = false, stopped = false;
  toggle.addEventListener('click', () => {
    paused = !paused;
    toggle.textContent = paused ? '자동 갱신 켜기' : '자동 갱신 끄기';
    status.textContent = paused ? '자동 갱신 일시정지' : '5초마다 자동 갱신';
    if (!paused) refresh();
  });
  async function refresh() {
    if (paused || busy || stopped || document.hidden) return;
    busy = true;
    try {
      const response = await fetch(location.pathname + location.search, {cache:'no-store', credentials:'same-origin', redirect:'error', signal:AbortSignal.timeout(8000)});
      if (!response.ok) throw new Error('request');
      const next = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (!next.getElementById('live-status')) { stopped = true; throw new Error('session'); }
      document.querySelectorAll('[data-live]').forEach(current => {
        if (current.contains(document.activeElement)) return;
        const replacement = next.getElementById(current.id);
        if (replacement) current.replaceChildren(...replacement.childNodes);
      });
      status.textContent = '5초마다 자동 갱신 · 마지막 수신 ' + new Date().toLocaleTimeString('ko-KR');
      status.dataset.state = 'ok';
    } catch {
      status.textContent = '갱신 실패 · 연결 또는 로그인 상태를 확인해주세요. 현재 값은 마지막 수신 자료입니다.';
      status.dataset.state = 'error';
    } finally { busy = false; }
  }
  setInterval(refresh, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();`
