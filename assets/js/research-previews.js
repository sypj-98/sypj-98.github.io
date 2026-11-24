(() => {
  const videos = Array.from(document.querySelectorAll('video[data-src], video[data-preview]'));
  const toggle = document.querySelector('[data-preview-toggle]');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let autoplay = !motion.matches;
  const states = new Map(videos.map(video => [video, {
    visible: false, userPaused: false, automaticPauses: 0
  }]));

  function attachSource(video) {
    if (!video.hasAttribute('src') && video.dataset.src) video.src = video.dataset.src;
  }

  function pause(video, state) {
    if (video.paused) return;
    // The pause event is queued. Keep an automatic pause distinct from a viewer's choice.
    state.automaticPauses += 1;
    video.pause();
  }

  function sync(video, state) {
    if (!state.visible || document.hidden) {
      pause(video, state);
    } else if (autoplay && !state.userPaused && video.paused) {
      attachSource(video);
      const playing = video.play();
      if (playing) playing.catch(error => {
        if (error.name === 'NotAllowedError') {
          state.userPaused = true;
          video.controls = true;
        }
      });
    }
  }

  function syncAll() {
    states.forEach((state, video) => sync(video, state));
  }

  function setAutoplay(enabled) {
    autoplay = enabled;
    if (toggle) toggle.textContent = enabled ? 'Pause previews' : 'Play previews';
    states.forEach((state, video) => {
      if (!enabled) pause(video, state);
      else sync(video, state);
    });
  }

  document.addEventListener('visibilitychange', syncAll);
  if (!('IntersectionObserver' in window)) {
    // Older browsers can use the native player without fetching every clip on load.
    videos.forEach(video => {
      attachSource(video);
      video.controls = true;
    });
    return;
  }

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const state = states.get(entry.target);
      state.visible = entry.intersectionRatio >= 0.5;
      sync(entry.target, state);
    });
  }, { threshold: 0.5 });

  videos.forEach(video => {
    const state = states.get(video);
    video.addEventListener('pause', () => {
      if (state.automaticPauses) state.automaticPauses -= 1;
      else state.userPaused = true;
    });
    video.addEventListener('play', () => {
      state.userPaused = false;
      if (document.hidden) pause(video, state);
    });
    observer.observe(video);
  });

  if (toggle) {
    toggle.hidden = false;
    toggle.addEventListener('click', () => setAutoplay(!autoplay));
  }
  setAutoplay(autoplay);
  const updateMotion = () => setAutoplay(!motion.matches);
  if (motion.addEventListener) motion.addEventListener('change', updateMotion);
  else motion.addListener(updateMotion);
})();
