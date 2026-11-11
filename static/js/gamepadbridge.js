// static/js/gamepadbridge.js
//
// Forwards controller state from the web Gamepad API to the NaCl module.
//
// On Tizen TVs the PPB_Gamepad interface that the NaCl module used to poll
// (gamepad.cpp) does not report any controllers, while navigator.getGamepads()
// in JavaScript sees them just fine. So while a stream is running we poll the
// controllers here and send their state to the module as a 'gamepadState'
// message, which calls LiSendMultiControllerEvent on the native side.
//
// While DEBUG_OVERLAY is on, a small text overlay shows what the bridge sees
// and how many events the native side accepted, since there is no console on
// the TV.

var GamepadBridge = (function () {
  var POLL_INTERVAL_MS = 8;
  var OVERLAY_INTERVAL_MS = 250;
  var MAX_CONTROLLERS = 4;
  // Set to true to show the debug overlay during a stream
  var DEBUG_OVERLAY = false;

  var pollTimer = null;
  var overlayTimer = null;
  var overlay = null;

  // Last state sent per controller slot, as a string, so we only send changes
  var lastSent = {};
  // Controller slot numbers that were active in the last poll
  var lastActiveSlots = [];

  // Debug counters
  var sentCount = 0;
  var nativeAccepted = 0;
  var nativeDropped = 0;
  var lastError = '';

  function clampAxis(value) {
    if (typeof value !== 'number' || isNaN(value)) {
      return 0;
    }
    return Math.max(-1, Math.min(1, value));
  }

  function buttonValue(button) {
    if (!button) {
      return 0;
    }
    if (typeof button === 'object') {
      return typeof button.value === 'number' ? button.value : (button.pressed ? 1 : 0);
    }
    // Very old implementations expose plain numbers
    return button;
  }

  function buttonPressed(button) {
    if (!button) {
      return false;
    }
    if (typeof button === 'object') {
      return button.pressed || buttonValue(button) > 0.5;
    }
    return button > 0.5;
  }

  function getRawPads() {
    try {
      return navigator.getGamepads ? navigator.getGamepads() : [];
    } catch (e) {
      lastError = 'getGamepads: ' + e;
      return [];
    }
  }

  // Unlike getConnectedGamepadMask() in utils.js, pads with timestamp 0 are
  // kept: the Tizen browser may never update the timestamp.
  function getActivePads() {
    var pads = getRawPads();
    var active = [];

    for (var i = 0; i < pads.length && active.length < MAX_CONTROLLERS; i++) {
      var pad = pads[i];
      if (!pad || pad.connected === false) {
        continue;
      }
      active.push(pad);
    }

    return active;
  }

  function postState(slot, activeMask, state) {
    if (!common.naclModule) {
      lastError = 'naclModule missing';
      return;
    }

    try {
      // Posted directly instead of via sendMessage(), because sendMessage()
      // registers a promise callback that the module never resolves for this.
      common.naclModule.postMessage({
        'callbackId': 0,
        'method': 'gamepadState',
        'params': [
          slot,
          activeMask,
          state.buttons,
          state.leftTrigger,
          state.rightTrigger,
          state.leftStickX,
          state.leftStickY,
          state.rightStickX,
          state.rightStickY
        ]
      });
      sentCount++;
    } catch (e) {
      lastError = 'postMessage: ' + e;
    }
  }

  function readPad(pad) {
    // Bit i = standard-mapping button i is pressed. Buttons 6/7 are the
    // triggers and are sent as analog values instead.
    var buttons = 0;
    var padButtons = pad.buttons || [];
    for (var i = 0; i < padButtons.length && i < 17; i++) {
      if (i === 6 || i === 7) {
        continue;
      }
      if (buttonPressed(padButtons[i])) {
        buttons |= (1 << i);
      }
    }

    var axes = pad.axes || [];

    return {
      buttons: buttons,
      leftTrigger: Math.round(buttonValue(padButtons[6]) * 255),
      rightTrigger: Math.round(buttonValue(padButtons[7]) * 255),
      // Gamepad API: down/right are positive; GameStream: up is positive on Y
      leftStickX: Math.round(clampAxis(axes[0]) * 32767),
      leftStickY: Math.round(-clampAxis(axes[1]) * 32767),
      rightStickX: Math.round(clampAxis(axes[2]) * 32767),
      rightStickY: Math.round(-clampAxis(axes[3]) * 32767)
    };
  }

  var EMPTY_STATE = {
    buttons: 0, leftTrigger: 0, rightTrigger: 0,
    leftStickX: 0, leftStickY: 0, rightStickX: 0, rightStickY: 0
  };

  function poll() {
    var pads = getActivePads();
    var activeMask = 0;
    var activeSlots = [];

    for (var slot = 0; slot < pads.length; slot++) {
      activeMask |= (1 << slot);
      activeSlots.push(slot);
    }

    for (var s = 0; s < pads.length; s++) {
      var state = readPad(pads[s]);
      var key = activeMask + ':' + JSON.stringify(state);
      if (lastSent[s] !== key) {
        lastSent[s] = key;
        postState(s, activeMask, state);
      }
    }

    // Release everything on controllers that went away, so no button
    // stays held down on the host
    for (var j = 0; j < lastActiveSlots.length; j++) {
      var oldSlot = lastActiveSlots[j];
      if (activeSlots.indexOf(oldSlot) === -1) {
        postState(oldSlot, activeMask, EMPTY_STATE);
        delete lastSent[oldSlot];
      }
    }

    lastActiveSlots = activeSlots;
  }

  // --- Debug overlay ---------------------------------------------------------

  function describePads() {
    var raw = getRawPads();
    var lines = [];
    var count = raw ? raw.length : 0;
    lines.push('getGamepads(): ' + count + ' slots');

    for (var i = 0; i < count; i++) {
      var pad = raw[i];
      if (!pad) {
        lines.push(' [' + i + '] empty');
        continue;
      }
      var pressed = [];
      var padButtons = pad.buttons || [];
      for (var b = 0; b < padButtons.length; b++) {
        if (buttonPressed(padButtons[b])) {
          pressed.push(b);
        }
      }
      var axes = (pad.axes || []).map(function (a) {
        return (Math.round(a * 100) / 100).toFixed(2);
      });
      lines.push(' [' + i + '] ' + pad.id);
      lines.push('     connected=' + pad.connected + ' ts=' + pad.timestamp +
                 ' mapping="' + pad.mapping + '"');
      lines.push('     buttons=' + padButtons.length + ' pressed=[' + pressed.join(',') + ']');
      lines.push('     axes=[' + axes.join(' ') + ']');
    }

    lines.push('active pads: ' + getActivePads().length);
    lines.push('sent to NaCl: ' + sentCount +
               '  native accepted: ' + nativeAccepted +
               '  dropped: ' + nativeDropped);
    if (lastError) {
      lines.push('error: ' + lastError);
    }
    return lines.join('\n');
  }

  function showOverlay() {
    if (!DEBUG_OVERLAY) {
      return;
    }
    if (!overlay) {
      overlay = document.createElement('pre');
      overlay.id = 'gamepadDebugOverlay';
      overlay.style.cssText =
        'position:fixed;top:8px;left:8px;z-index:99999;margin:0;padding:8px;' +
        'background:rgba(0,0,0,0.7);color:#7CFC00;font:14px/1.3 monospace;' +
        'pointer-events:none;white-space:pre;max-width:60%;';
      document.body.appendChild(overlay);
    }
    overlay.textContent = describePads();
  }

  function hideOverlay() {
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    overlay = null;
  }

  // ---------------------------------------------------------------------------

  function start() {
    if (pollTimer) {
      return;
    }
    console.log('%c[gamepadbridge.js]', 'color:green;', 'Forwarding gamepads to the stream');
    lastSent = {};
    lastActiveSlots = [];
    sentCount = 0;
    nativeAccepted = 0;
    nativeDropped = 0;
    lastError = '';
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    if (DEBUG_OVERLAY) {
      showOverlay();
      overlayTimer = setInterval(showOverlay, OVERLAY_INTERVAL_MS);
    }
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (overlayTimer) {
      clearInterval(overlayTimer);
      overlayTimer = null;
    }
    hideOverlay();
    lastSent = {};
    lastActiveSlots = [];
    console.log('%c[gamepadbridge.js]', 'color:green;', 'Stopped forwarding gamepads');
  }

  // Called with "accepted,dropped" totals reported by the native side
  function onNativeAck(text) {
    var parts = text.split(',');
    nativeAccepted = parseInt(parts[0], 10) || 0;
    nativeDropped = parseInt(parts[1], 10) || 0;
  }

  // Maps a controller slot (as used by the host) back to a Gamepad object,
  // e.g. for rumble
  function getPadForSlot(slot) {
    return getActivePads()[slot] || null;
  }

  return { start: start, stop: stop, onNativeAck: onNativeAck, getPadForSlot: getPadForSlot };
})();
