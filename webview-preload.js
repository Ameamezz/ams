(() => {
  const mainWorldPatch = `
    (() => {
      const blocked = (feature) => new DOMException(feature + ' is disabled in AmiyaPlayer.', 'NotAllowedError');
      const blockConstructor = (feature) => function blockedConstructor() {
        throw blocked(feature);
      };
      const defineBlockedApi = (target, name, value) => {
        try {
          Object.defineProperty(target, name, {
            configurable: true,
            enumerable: false,
            get: () => value
          });
        } catch (_error) {
          try {
            target[name] = value;
          } catch (_ignored) {}
        }
      };

      defineBlockedApi(window, 'RTCPeerConnection', blockConstructor('WebRTC'));
      defineBlockedApi(window, 'webkitRTCPeerConnection', blockConstructor('WebRTC'));

      if (navigator.mediaDevices) {
        try {
          navigator.mediaDevices.getUserMedia = () => Promise.reject(blocked('media capture'));
          navigator.mediaDevices.getDisplayMedia = () => Promise.reject(blocked('display capture'));
        } catch (_error) {}
      }
    })();
  `;

  const blocked = (feature) => new DOMException(`${feature} is disabled in AmiyaPlayer.`, 'NotAllowedError');

  const blockConstructor = (feature) => function blockedConstructor() {
    throw blocked(feature);
  };

  const defineBlockedApi = (target, name, value) => {
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: false,
        get: () => value
      });
    } catch (_error) {
      try {
        target[name] = value;
      } catch (_ignored) {
        // Some browser APIs are read-only in isolated contexts.
      }
    }
  };

  defineBlockedApi(window, 'RTCPeerConnection', blockConstructor('WebRTC'));
  defineBlockedApi(window, 'webkitRTCPeerConnection', blockConstructor('WebRTC'));

  if (navigator.mediaDevices) {
    try {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(blocked('media capture'));
      navigator.mediaDevices.getDisplayMedia = () => Promise.reject(blocked('display capture'));
    } catch (_error) {
      // Keep page loading even when the browser locks down mediaDevices.
    }
  }

  const injectMainWorldPatch = () => {
    try {
      const script = document.createElement('script');
      script.textContent = mainWorldPatch;
      (document.documentElement || document.head || document.body).appendChild(script);
      script.remove();
    } catch (_error) {
      // The command-line WebRTC restrictions still apply if page injection is blocked.
    }
  };

  if (document.documentElement) {
    injectMainWorldPatch();
  } else {
    window.addEventListener('DOMContentLoaded', injectMainWorldPatch, { once: true });
  }
})();
