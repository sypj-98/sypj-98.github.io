(() => {
  const link = document.getElementById('grgs-demo');
  link.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const player = document.createElement('iframe');
    const embed = new URL('https://www.youtube.com/embed/mwcIAyEqSY8');
    embed.searchParams.set('autoplay', '1');
    embed.searchParams.set('enablejsapi', '1');
    embed.searchParams.set('origin', location.origin);
    player.src = embed.href;
    player.title = 'GRGS demo video';
    player.allow = 'autoplay; encrypted-media; picture-in-picture';
    player.allowFullscreen = true;
    link.replaceWith(player);
    player.focus();

    function pauseDemo() {
      player.contentWindow.postMessage(JSON.stringify({
        event: 'command', func: 'pauseVideo', args: []
      }), embed.origin);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pauseDemo();
    });
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        if (!entries[0].isIntersecting) pauseDemo();
      });
      observer.observe(player);
    }
  });
})();
