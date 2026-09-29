(() => {
  const currentWord = document.querySelector('.rotating-word-current');
  const nextWord = document.querySelector('.rotating-word-next');
  if (!currentWord || !nextWord) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const words = ['confidence', 'calm', 'clarity', 'control'];
  let index = 0;
  let timer;

  const stop = () => {
    window.clearTimeout(timer);
    index = 0;
    currentWord.textContent = words[0];
    currentWord.classList.remove('is-exiting');
    nextWord.textContent = '';
    nextWord.classList.remove('is-entering');
  };

  const scheduleRotation = () => {
    timer = window.setTimeout(() => {
      const nextIndex = (index + 1) % words.length;
      nextWord.textContent = words[nextIndex];
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
