// Where the game server lives.
// The page itself can be hosted anywhere (Netlify). The game server (dealer,
// tables, bots, voice signaling) runs on Render. Change GAME_SERVER if your
// Render service has a different URL.
(function () {
  var GAME_SERVER = 'https://oldguyspoker.onrender.com';
  var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  // Same origin when running locally or when the server serves the page itself.
  window.OGP_SERVER_URL = local || location.origin === GAME_SERVER ? '' : GAME_SERVER;
})();
