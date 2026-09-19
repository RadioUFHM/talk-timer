"use strict";

// ---------- DOM ----------
const introCard = document.getElementById("introCard");
const calibrateCard = document.getElementById("calibrateCard");
const liveCard = document.getElementById("liveCard");
const summaryCard = document.getElementById("summaryCard");

const micBtn = document.getElementById("micBtn");
const micError = document.getElementById("micError");

const calibrateBtn = document.getElementById("calibrateBtn");
const calibrateInstructions = document.getElementById("calibrateInstructions");
const calibrateProgress = document.getElementById("calibrateProgress");

const youBar = document.getElementById("youBar");
const otherBar = document.getElementById("otherBar");
const youTimeEl = document.getElementById("youTime");
const otherTimeEl = document.getElementById("otherTime");
const youPctEl = document.getElementById("youPct");
const otherPctEl = document.getElementById("otherPct");
const streakBanner = document.getElementById("streakBanner");
const streakText = document.getElementById("streakText");
const stopBtn = document.getElementById("stopBtn");

const summaryText = document.getElementById("summaryText");
const newSessionBtn = document.getElementById("newSessionBtn");

const settingsBtn = document.getElementById("settingsBtn");
const settingsOverlay = document.getElementById("settingsOverlay");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const streakThresholdSel = document.getElementById("streakThreshold");
const shareThresholdSel = document.getElementById("shareThreshold");
const vibrateToggle = document.getElementById("vibrateToggle");
const recalibrateBtn = document.getElementById("recalibrateBtn");

// ---------- settings (thresholds only — never audio) ----------
const settings = {
  streakThresholdSec: 45,
  shareThreshold: 0.5,
  vibrate: true,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("talkTimerSettings") || "{}");
    Object.assign(settings, saved);
  } catch (_) { /* ignore corrupt/missing settings, defaults stand */ }
  streakThresholdSel.value = String(settings.streakThresholdSec);
  shareThresholdSel.value = String(settings.shareThreshold);
  vibrateToggle.checked = settings.vibrate;
}

function saveSettings() {
  settings.streakThresholdSec = Number(streakThresholdSel.value);
  settings.shareThreshold = Number(shareThresholdSel.value);
  settings.vibrate = vibrateToggle.checked;
  localStorage.setItem("talkTimerSettings", JSON.stringify(settings));
}

// ---------- audio ----------
let audioCtx = null;
let analyser = null;
let micStream = null;
let timeDomainData = null;

// Thresholds live in dBFS (20*log10(rms)), not raw RMS. Sound pressure
// falls off with distance, so a quieter, farther-away speaker can be
// many times smaller in linear RMS while only ~10-15dB down — a linear
// split between noise floor and your own voice collapses everyone
// else's speech down near the noise floor. dB space keeps that gap
// meaningful and matches how a 3-point calibration below is spaced.
let silenceThresholdDb = -55;
let selfThresholdDb = -30;

function toDb(rms) {
  return 20 * Math.log10(Math.max(rms, 1e-6));
}

async function requestMic() {
  const baseConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  try {
    // Legacy Chrome-only flags: on some Android builds the standard
    // constraints above only disable WebRTC's software processing while
    // the OS audio path still runs hardware AEC/NS/AGC (tuned for voice
    // calls, i.e. tuned to suppress anything that isn't close to the
    // mic). These aren't part of the spec and are silently ignored where
    // unsupported, so they're safe to always send.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...baseConstraints,
        googEchoCancellation: false,
        googAutoGainControl: false,
        googNoiseSuppression: false,
        googHighpassFilter: false,
        googTypingNoiseDetection: false,
      },
    });
  } catch (err) {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: baseConstraints });
  }
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0;
  timeDomainData = new Float32Array(analyser.fftSize);
  source.connect(analyser);
}

function currentRms() {
  analyser.getFloatTimeDomainData(timeDomainData);
  let sumSquares = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    sumSquares += timeDomainData[i] * timeDomainData[i];
  }
  return Math.sqrt(sumSquares / timeDomainData.length);
}

function stopAudio() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
}

// ---------- calibration ----------
async function runCalibration() {
  calibrateBtn.disabled = true;

  const quietSamples = await sampleFor(2000, "Stay quiet for a moment…");
  const selfSamples = await sampleFor(3000, "Now talk normally, like you're chatting…");
  const otherSamples = await sampleFor(
    4000,
    "Now have someone else talk normally, at the distance they'd usually be sitting or standing…"
  );

  const noiseFloorDb = toDb(median(quietSamples));
  let otherDb = toDb(median(otherSamples));
  let selfDb = toDb(median(selfSamples));

  // Guard against an unclear or too-quiet calibration pass rather than
  // ending up with inverted or overlapping thresholds.
  if (otherDb < noiseFloorDb + 3) otherDb = noiseFloorDb + 3;
  if (selfDb < otherDb + 4) selfDb = otherDb + 6;

  silenceThresholdDb = noiseFloorDb + (otherDb - noiseFloorDb) * 0.5;
  selfThresholdDb = otherDb + (selfDb - otherDb) * 0.5;

  calibrateBtn.disabled = false;
  showCard(liveCard);
  startSession();
}

function sampleFor(durationMs, instructionText) {
  return new Promise((resolve) => {
    calibrateInstructions.textContent = instructionText;
    const samples = [];
    const start = performance.now();

    function tick() {
      const elapsed = performance.now() - start;
      samples.push(currentRms());
      calibrateProgress.style.width = Math.min(100, (elapsed / durationMs) * 100) + "%";
      if (elapsed < durationMs) {
        requestAnimationFrame(tick);
      } else {
        resolve(samples);
      }
    }
    requestAnimationFrame(tick);
  });
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------- live tracking state machine ----------
const DEBOUNCE_MS = 150;   // ignore state flips shorter than this (avoids jitter)
const GRACE_MS = 1500;     // a short pause within your own turn doesn't end the streak
const VIBRATE_COOLDOWN_MS = 15000;

let smoothedLevel = 0;
let candidateState = "silence";
let candidateSince = 0;
let confirmedState = "silence";

let youSeconds = 0;
let otherSeconds = 0;
let youStreakSeconds = 0;
let streakActive = false;
let lastYouActiveTime = 0;

let streakAlertOn = false;
let shareAlertOn = false;
let lastVibrateTime = 0;

let rafHandle = null;
let lastFrameTime = 0;

function classify(rmsLevel) {
  const db = toDb(rmsLevel);
  if (db >= selfThresholdDb) return "you";
  if (db >= silenceThresholdDb) return "other";
  return "silence";
}

function startSession() {
  youSeconds = 0;
  otherSeconds = 0;
  youStreakSeconds = 0;
  streakActive = false;
  streakAlertOn = false;
  shareAlertOn = false;
  smoothedLevel = 0;
  confirmedState = "silence";
  candidateState = "silence";
  lastFrameTime = performance.now();
  rafHandle = requestAnimationFrame(loop);
}

function loop(now) {
  const dt = Math.min(0.25, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  const rms = currentRms();
  smoothedLevel = smoothedLevel * 0.6 + rms * 0.4;
  const instClass = classify(smoothedLevel);

  if (instClass !== candidateState) {
    candidateState = instClass;
    candidateSince = now;
  } else if (candidateState !== confirmedState && now - candidateSince >= DEBOUNCE_MS) {
    confirmedState = candidateState;
  }

  if (confirmedState === "you") {
    youSeconds += dt;
    youStreakSeconds += dt;
    streakActive = true;
    lastYouActiveTime = now;
  } else {
    if (confirmedState === "other") otherSeconds += dt;
    if (streakActive && now - lastYouActiveTime > GRACE_MS) {
      streakActive = false;
      youStreakSeconds = 0;
      streakAlertOn = false;
    }
  }

  updateAlerts(now);
  render();

  rafHandle = requestAnimationFrame(loop);
}

function updateAlerts(now) {
  const totalSpeaking = youSeconds + otherSeconds;

  const streakShouldFire = youStreakSeconds >= settings.streakThresholdSec;
  const shareShouldFire = totalSpeaking >= 15 && youSeconds / totalSpeaking >= settings.shareThreshold;

  if (streakShouldFire && !streakAlertOn) {
    streakAlertOn = true;
    buzz(now);
  } else if (streakShouldFire && now - lastVibrateTime > VIBRATE_COOLDOWN_MS) {
    buzz(now);
  } else if (!streakShouldFire) {
    streakAlertOn = false;
  }

  shareAlertOn = shareShouldFire;
}

function buzz(now) {
  lastVibrateTime = now;
  if (settings.vibrate && navigator.vibrate) {
    navigator.vibrate([180, 90, 180]);
  }
}

function render() {
  const total = youSeconds + otherSeconds;
  const youPct = total > 0 ? youSeconds / total : 0;
  const otherPct = total > 0 ? otherSeconds / total : 0;

  youTimeEl.textContent = formatTime(youSeconds);
  otherTimeEl.textContent = formatTime(otherSeconds);
  youBar.style.width = (youPct * 100).toFixed(1) + "%";
  otherBar.style.width = (otherPct * 100).toFixed(1) + "%";
  youPctEl.textContent = Math.round(youPct * 100) + "%";
  otherPctEl.textContent = Math.round(otherPct * 100) + "%";

  youBar.classList.toggle("alert", streakAlertOn);

  if (streakAlertOn) {
    streakBanner.hidden = false;
    streakText.textContent = `You've been talking for over ${settings.streakThresholdSec}s — good time to pause?`;
  } else if (shareAlertOn) {
    streakBanner.hidden = false;
    streakText.textContent = `You've had more than ${Math.round(settings.shareThreshold * 100)}% of the talk time so far.`;
  } else {
    streakBanner.hidden = true;
  }
}

function formatTime(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

function endSession() {
  if (rafHandle) cancelAnimationFrame(rafHandle);
  const total = youSeconds + otherSeconds;
  const youPct = total > 0 ? Math.round((youSeconds / total) * 100) : 0;
  summaryText.textContent = total > 0
    ? `You talked for ${formatTime(youSeconds)} (${youPct}% of the conversation). Others talked for ${formatTime(otherSeconds)}.`
    : "No speaking was detected during this session.";
  showCard(summaryCard);
}

// ---------- flow control ----------
function showCard(card) {
  [introCard, calibrateCard, liveCard, summaryCard].forEach((c) => (c.hidden = c !== card));
}

micBtn.addEventListener("click", async () => {
  micError.hidden = true;
  micBtn.disabled = true;
  try {
    await requestMic();
    showCard(calibrateCard);
  } catch (err) {
    micError.hidden = false;
    micError.textContent = "Couldn't access the microphone. Check site permissions and try again.";
  }
  micBtn.disabled = false;
});

calibrateBtn.addEventListener("click", runCalibration);

stopBtn.addEventListener("click", () => {
  endSession();
});

newSessionBtn.addEventListener("click", () => {
  showCard(calibrateCard);
  calibrateProgress.style.width = "0%";
  calibrateInstructions.textContent = "Stay quiet for a moment so I can learn the room's background noise.";
  calibrateBtn.disabled = false;
});

settingsBtn.addEventListener("click", () => (settingsOverlay.hidden = false));
closeSettingsBtn.addEventListener("click", () => {
  saveSettings();
  settingsOverlay.hidden = true;
});

recalibrateBtn.addEventListener("click", () => {
  saveSettings();
  settingsOverlay.hidden = true;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  showCard(calibrateCard);
  calibrateProgress.style.width = "0%";
});

window.addEventListener("beforeunload", stopAudio);

loadSettings();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("service-worker.js").catch(() => { /* offline install is a bonus, not required */ });
}
