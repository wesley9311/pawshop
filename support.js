// Compatibility shim for older pages. The prelaunch site does not collect
// customer information until a server-side inquiry channel is available.
window.openSupport = function () {
  if (typeof window.openWaitlist === 'function') window.openWaitlist();
};
