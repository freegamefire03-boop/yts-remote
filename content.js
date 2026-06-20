// YTS Remote — content script
// Injected into YouTube pages. Receives remote-shift / remote-apply-gap
// commands from the background and seeks the <video> element.

(function () {
  'use strict';

  var overlay = null;
  var input = null;
  var errorTimer = null;
  var overlayMode = 'shift';

  var gapDetectionEnabled = false;
  var gapAccumulated = 0;
  var gapInterruptionStart = null;
  var gapInterruptionType = null;
  var gapLastCheckTime = null;
  var gapLastVideoTime = null;
  var gapCheckInterval = null;
  var gapVideo = null;
  var pendingGap = 0;
  var estimatedSeekLatencyMs = 50;
  var seekStartTime = null;

  function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'ms-shift-overlay';

    input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'ms (e.g. +500, -200)';

    overlay.appendChild(input);
    document.body.appendChild(overlay);

    input.addEventListener('keydown', onKeydown);
  }

  function onKeydown(e) {
    if (overlayMode === 'shift') {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyShift();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideOverlay();
      }
    } else if (overlayMode === 'gap-apply') {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyGapSeek();
      } else if (e.key === 'Backspace' || e.key === 'Escape') {
        e.preventDefault();
        hideOverlay();
      }
    }
  }

  function showOverlay() {
    if (!overlay) createOverlay();
    overlayMode = 'shift';
    input.readOnly = false;
    input.type = 'text';
    input.placeholder = 'ms (e.g. +500, -200)';
    reparentIfNeeded();
    overlay.style.display = 'block';
    input.value = '';
    input.className = '';
    input.focus();
  }

  function hideOverlay() {
    if (!overlay) return;
    overlay.style.display = 'none';
    overlayMode = 'shift';
    input.readOnly = false;
    input.type = 'text';
    input.placeholder = 'ms (e.g. +500, -200)';
    if (errorTimer) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
    input.value = '';
    input.className = '';
    pendingGap = 0;
  }

  function applyShift() {
    var raw = input.value.trim();
    if (raw === '') return;

    var match = raw.match(/^([+-])?(\d+)$/);
    if (!match) {
      input.className = 'error';
      input.value = '';
      if (errorTimer) clearTimeout(errorTimer);
      errorTimer = setTimeout(function () {
        input.className = '';
        input.focus();
        errorTimer = null;
      }, 400);
      return;
    }

    var sign = match[1] === '-' ? -1 : 1;
    var ms = parseInt(match[2], 10);
    var adjustedMs = sign * ms + estimatedSeekLatencyMs;

    seekVideo(adjustedMs / 1000);
    hideOverlay();
  }

  function seekVideo(deltaSeconds) {
    var video = document.querySelector('video');
    if (!video) {
      console.warn('[YTS-cs] no <video> on page');
      return false;
    }
    var before = video.currentTime;
    video.currentTime = Math.max(0, video.currentTime + deltaSeconds);
    console.log('[YTS-cs] seek ' + deltaSeconds.toFixed(3) + 's ' + before.toFixed(3) + ' -> ' + video.currentTime.toFixed(3));
    return true;
  }

  function reparentIfNeeded() {
    if (!overlay) return;
    var fsElement = document.fullscreenElement;
    if (fsElement && overlay.parentNode !== fsElement) {
      fsElement.appendChild(overlay);
    } else if (!fsElement && overlay.parentNode !== document.body) {
      document.body.appendChild(overlay);
    }
  }

  function showGapApplyOverlay() {
    if (!overlay) createOverlay();
    var video = document.querySelector('video');
    if (!video || gapAccumulated <= 0) {
      return;
    }
    if (overlay.style.display === 'block') {
      hideOverlay();
    }
    overlayMode = 'gap-apply';
    pendingGap = gapAccumulated;
    input.readOnly = true;
    input.type = 'text';
    input.value = 'Gap: +' + formatTime(pendingGap) + 's  [Enter=apply]';
    reparentIfNeeded();
    overlay.style.display = 'block';
    input.focus();
  }

  function applyGapSeek() {
    var video = document.querySelector('video');
    var applied = pendingGap;
    if (video && applied > 0) {
      video.currentTime = video.currentTime + applied + (estimatedSeekLatencyMs / 1000);
      gapAccumulated = 0;
      pendingGap = 0;
      hideOverlay();
      showGapAppliedNotification(applied);
    } else {
      hideOverlay();
    }
  }

  function showGapAppliedNotification(seconds) {
    var el = document.createElement('div');
    el.id = 'ms-gap-applied';
    el.textContent = '\u2713 Applied +' + formatTime(seconds) + 's';
    var container = document.fullscreenElement || document.body;
    container.appendChild(el);
    el.addEventListener('animationend', function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
  }

  function formatTime(seconds) {
    return seconds.toFixed(3);
  }

  function ensureGapVideo() {
    var v = document.querySelector('video');
    if (v !== gapVideo) {
      if (gapVideo) {
        gapVideo.removeEventListener('pause', onGapPause);
        gapVideo.removeEventListener('play', onGapPlay);
        gapVideo.removeEventListener('seeking', onGapSeeking);
        gapVideo.removeEventListener('seeked', onGapSeeked);
        gapVideo.removeEventListener('seeking', onLatencySeeking);
        gapVideo.removeEventListener('seeked', onLatencySeeked);
      }
      gapVideo = v;
      if (gapVideo) {
        gapVideo.addEventListener('pause', onGapPause);
        gapVideo.addEventListener('play', onGapPlay);
        gapVideo.addEventListener('seeking', onGapSeeking);
        gapVideo.addEventListener('seeked', onGapSeeked);
        gapVideo.addEventListener('seeking', onLatencySeeking);
        gapVideo.addEventListener('seeked', onLatencySeeked);
        gapLastVideoTime = gapVideo.currentTime;
        gapLastCheckTime = Date.now();
      }
    }
    return gapVideo;
  }

  function startGapDetection() {
    if (!ensureGapVideo()) return;
    gapAccumulated = 0;
    gapInterruptionStart = null;
    gapInterruptionType = null;
    gapLastCheckTime = Date.now();
    gapLastVideoTime = gapVideo.currentTime;

    if (gapVideo.paused) {
      gapInterruptionStart = Date.now();
      gapInterruptionType = 'pause';
    }

    gapCheckInterval = setInterval(checkGapState, 250);
  }

  function stopGapDetection() {
    if (gapCheckInterval) {
      clearInterval(gapCheckInterval);
      gapCheckInterval = null;
    }
    if (gapVideo) {
      gapVideo.removeEventListener('pause', onGapPause);
      gapVideo.removeEventListener('play', onGapPlay);
      gapVideo.removeEventListener('seeking', onGapSeeking);
      gapVideo.removeEventListener('seeked', onGapSeeked);
      gapVideo.removeEventListener('seeking', onLatencySeeking);
      gapVideo.removeEventListener('seeked', onLatencySeeked);
    }
    finalizeGapInterruption();
    gapVideo = null;
  }

  function onGapPause() {
    if (gapInterruptionType) finalizeGapInterruption();
    gapInterruptionStart = Date.now();
    gapInterruptionType = 'pause';
  }

  function onGapPlay() {
    if (gapInterruptionType === 'pause') {
      finalizeGapInterruption();
    }
    gapInterruptionStart = null;
    gapInterruptionType = null;
  }

  var gapWasSeeking = false;

  function onGapSeeking() {
    gapWasSeeking = true;
  }

  function onGapSeeked() {
    gapWasSeeking = false;
    gapLastVideoTime = gapVideo ? gapVideo.currentTime : null;
    gapLastCheckTime = Date.now();
  }

  function checkGapState() {
    if (!ensureGapVideo() || gapWasSeeking) {
      gapLastCheckTime = Date.now();
      return;
    }
    var now = Date.now();
    var currentVideoTime = gapVideo.currentTime;

    if (gapVideo.paused) {
      gapLastCheckTime = now;
      gapLastVideoTime = currentVideoTime;
      return;
    }

    if (gapLastVideoTime === currentVideoTime && currentVideoTime > 0) {
      if (!gapInterruptionType) {
        gapInterruptionStart = now;
        gapInterruptionType = 'freeze';
      }
    } else {
      if (gapInterruptionType === 'freeze') {
        finalizeGapInterruption();
      }
      gapInterruptionStart = null;
      gapInterruptionType = null;
    }

    gapLastVideoTime = currentVideoTime;
    gapLastCheckTime = now;
  }

  function finalizeGapInterruption() {
    if (gapInterruptionStart && gapInterruptionType) {
      var duration = (Date.now() - gapInterruptionStart) / 1000;
      if (duration > 0.05) {
        gapAccumulated += duration;
      }
    }
    gapInterruptionStart = null;
    gapInterruptionType = null;
  }

  function onLatencySeeking() {
    seekStartTime = performance.now();
  }

  function onLatencySeeked() {
    if (seekStartTime !== null) {
      var elapsed = performance.now() - seekStartTime;
      estimatedSeekLatencyMs = Math.min(elapsed, 300);
      seekStartTime = null;
    }
  }

  document.addEventListener('fullscreenchange', reparentIfNeeded);

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.action) { sendResponse({ ok: false }); return true; }

    if (message.action === '__ping_cs') {
      sendResponse({ ok: true, url: location.href, hasVideo: !!document.querySelector('video') });
      return true;
    }

    if (message.action === 'toggle-overlay') {
      if (overlay && overlay.style.display === 'block') {
        hideOverlay();
      } else {
        showOverlay();
      }
      sendResponse({ ok: true });
      return true;
    } else if (message.action === 'show-gap-apply') {
      if (overlay && overlay.style.display === 'block' && overlayMode === 'gap-apply') {
        hideOverlay();
      } else {
        showGapApplyOverlay();
      }
      sendResponse({ ok: true });
      return true;
    } else if (message.action === 'toggle-gap-detection') {
      gapDetectionEnabled = !!message.enabled;
      if (gapDetectionEnabled) {
        startGapDetection();
      } else {
        stopGapDetection();
      }
      sendResponse({ enabled: gapDetectionEnabled, gap: gapAccumulated });
      return true;
    } else if (message.action === 'get-gap-status') {
      sendResponse({ enabled: gapDetectionEnabled, gap: gapAccumulated });
      return true;
    } else if (message.action === 'remote-shift') {
      var ok = seekVideo((message.delta || 0) + (estimatedSeekLatencyMs / 1000));
      sendResponse({ ok: !!ok });
      return true;
    } else if (message.action === 'remote-apply-gap') {
      var video = document.querySelector('video');
      var applied = gapAccumulated;
      if (video && applied > 0) {
        video.currentTime = video.currentTime + applied + (estimatedSeekLatencyMs / 1000);
        gapAccumulated = 0;
        showGapAppliedNotification(applied);
      }
      sendResponse({ ok: true, applied: applied });
      return true;
    } else if (message.action === 'reset-gap') {
      gapAccumulated = 0;
      gapInterruptionStart = null;
      gapInterruptionType = null;
      sendResponse({ ok: true });
      return true;
    } else {
      sendResponse({ ok: false });
      return true;
    }
  });

  createOverlay();
  hideOverlay();
  console.log('[YTS-cs] content script loaded on', location.href);

  // Try to wake the background's WS
  try { chrome.runtime.sendMessage({ action: 'wake' }).catch(function () {}); } catch (_) {}
})();
