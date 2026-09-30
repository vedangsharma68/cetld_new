(() => {
  const rotatingWord = document.querySelector('.rotating-word');
  const currentWord = document.querySelector('.rotating-word-current');
  const nextWord = document.querySelector('.rotating-word-next');
  if (!rotatingWord || !currentWord || !nextWord) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const words = ['confidence', 'calm', 'clarity', 'control'];
  const probe = document.createElement('span');
  probe.className = 'rotating-word-probe';
  probe.setAttribute('aria-hidden', 'true');
  rotatingWord.append(probe);
  let index = 0;
  let timer;

  // Keep layout reads outside the animation path: one hidden-probe measurement
  // is made before each transition, then the browser owns the entire animation.
  const measureWord = (word) => {
    probe.textContent = word;
    return probe.getBoundingClientRect().width;
  };

  const stop = () => {
    window.clearTimeout(timer);
    index = 0;
    currentWord.textContent = words[0];
    currentWord.classList.remove('is-exiting');
    nextWord.textContent = '';
    nextWord.classList.remove('is-entering');
    rotatingWord.style.width = `${measureWord(words[0])}px`;
  };

  const scheduleRotation = () => {
    timer = window.setTimeout(() => {
      const nextIndex = (index + 1) % words.length;
      const nextWidth = measureWord(words[nextIndex]);
      nextWord.textContent = words[nextIndex];
      rotatingWord.style.width = `${nextWidth}px`;
      currentWord.classList.add('is-exiting');
      nextWord.classList.add('is-entering');

      timer = window.setTimeout(() => {
        index = nextIndex;
        currentWord.textContent = words[index];
        currentWord.classList.remove('is-exiting');
        nextWord.textContent = '';
        nextWord.classList.remove('is-entering');
        scheduleRotation();
      }, 360);
    }, 2140);
  };

  const setMotionPreference = () => {
    stop();
    if (!reducedMotion.matches) scheduleRotation();
  };

  reducedMotion.addEventListener('change', setMotionPreference);
  setMotionPreference();
})();
