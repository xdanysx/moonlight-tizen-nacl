// static/js/gamepadbridge.js
//
// Forwards controller state from the web Gamepad API to the NaCl module.
//
// On Tizen TVs the PPB_Gamepad interface that the NaCl module used to poll
// (gamepad.cpp) does not report any controllers, while navigator.getGamepads()
// in JavaScript sees them just fine. So while a stream is running we poll the
// controllers here and send their state to the module as a 'gamepadState'
// message, which calls LiSendMultiControllerEvent on the native side.

var GamepadBridge = (function () {
  var POLL_INTERVAL_MS = 8;
  var MAX_CONTROLLERS = 4;

  var pollTimer = null;
  // Last state sent per controller slot, as a string, so we only send changes
  var lastSent = {};
  // Controller slot numbers that were active in the last poll
  var lastActiveSlots = [];

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

  // Same filtering as getConnectedGamepadMask() in utils.js, so the slot
  // numbers match the controller mask sent to the host at launch.
  function getActivePads() {
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    var active = [];

    for (var i = 0; i < pads.length && active.length < MAX_CONTROLLERS; i++) {
      var pad = pads[i];
      if (!pad || !pad.connected || pad.timestamp === 0) {
        continue;
      }
      active.push(pad);
    }

    return active;
  }

  function postState(slot, activeMask, state) {
    if (!common.naclModule) {
      return;
    }

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
  }

  function readPad(pad) {
    // Bit i = standard-mapping button i is pressed. Buttons 6/7 are the
    // triggers and are sent as analog values instead.
    var buttons = 0;
    for (var i = 0; i < pad.buttons.length && i < 17; i++) {
      if (i === 6 || i === 7) {
        continue;
      }
      if (buttonPressed(pad.buttons[i])) {
        buttons |= (1 << i);
      }
    }

    var axes = pad.axes || [];

    return {
      buttons: buttons,
      leftTrigger: Math.round(buttonValue(pad.buttons[6]) * 255),
      rightTrigger: Math.round(buttonValue(pad.buttons[7]) * 255),
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

  function start() {
    if (pollTimer) {
      return;
    }
    console.log('%c[gamepadbridge.js]', 'color:green;', 'Forwarding gamepads to the stream');
    lastSent = {};
    lastActiveSlots = [];
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  function stop() {
    if (!pollTimer) {
      return;
    }
    clearInterval(pollTimer);
    pollTimer = null;
    lastSent = {};
    lastActiveSlots = [];
    console.log('%c[gamepadbridge.js]', 'color:green;', 'Stopped forwarding gamepads');
  }

  // Maps a controller slot (as used by the host) back to a Gamepad object,
  // e.g. for rumble
  function getPadForSlot(slot) {
    return getActivePads()[slot] || null;
  }

  return { start: start, stop: stop, getPadForSlot: getPadForSlot };
})();
