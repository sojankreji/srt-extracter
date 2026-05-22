const videoInput = document.getElementById('videoFile');
const extractBtn = document.getElementById('extractBtn');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');
const previewEl = document.getElementById('preview');
const modeSelect = document.getElementById('modeSelect');
const trackRow = document.getElementById('trackRow');
const trackSelect = document.getElementById('trackSelect');

let currentSrt = '';
let currentFileName = 'subtitles.srt';
let selectedVideoPath = '';
let embeddedTracks = [];

function setStatus(message) {
  statusEl.textContent = message;
}

function setBusy(isBusy) {
  extractBtn.disabled = isBusy;
  videoInput.disabled = isBusy;
  modeSelect.disabled = isBusy;
  trackSelect.disabled = isBusy;
}

function isEmbeddedMode() {
  return modeSelect.value === 'embedded';
}

function renderTrackOptions() {
  trackSelect.innerHTML = '';

  if (embeddedTracks.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No subtitle tracks found';
    trackSelect.appendChild(option);
    trackSelect.disabled = true;
    return;
  }

  for (const track of embeddedTracks) {
    const option = document.createElement('option');
    option.value = String(track.streamIndex);
    option.textContent = track.label;
    trackSelect.appendChild(option);
  }

  trackSelect.disabled = false;
}

async function resolveVideoPath() {
  let videoPath = selectedVideoPath;

  if (!videoPath) {
    const file = videoInput.files?.[0];
    videoPath = file && typeof file.path === 'string' ? file.path : '';
  }

  if (!videoPath) {
    setStatus('Opening native file picker...');
    videoPath = await window.subtitleAPI.pickVideoFile();

    if (!videoPath) {
      return '';
    }

    selectedVideoPath = videoPath;
  }

  return videoPath;
}

async function ensureEmbeddedTracks(videoPath) {
  setStatus('Reading embedded subtitle tracks...');
  embeddedTracks = await window.subtitleAPI.listEmbeddedSubtitleTracks(videoPath);
  renderTrackOptions();

  if (embeddedTracks.length === 0) {
    throw new Error('No embedded subtitle tracks found in this video.');
  }
}

function updateModeUI() {
  const embeddedMode = isEmbeddedMode();
  trackRow.classList.toggle('is-hidden', !embeddedMode);
}

window.subtitleAPI.onStatus((message) => {
  setStatus(message);
});

videoInput.addEventListener('change', () => {
  const file = videoInput.files?.[0];
  selectedVideoPath = file && typeof file.path === 'string' ? file.path : '';
  embeddedTracks = [];
  renderTrackOptions();
});

modeSelect.addEventListener('change', async () => {
  updateModeUI();

  if (!isEmbeddedMode()) {
    return;
  }

  try {
    const videoPath = await resolveVideoPath();
    if (!videoPath) {
      setStatus('Please choose a video file first.');
      return;
    }

    await ensureEmbeddedTracks(videoPath);
    setStatus('Embedded subtitle tracks loaded.');
  } catch (error) {
    console.error(error);
    setStatus(`Failed to load embedded tracks: ${error.message}`);
  }
});

updateModeUI();
renderTrackOptions();

extractBtn.addEventListener('click', async () => {
  const videoPath = await resolveVideoPath();
  if (!videoPath) {
    setStatus('Please choose a video file first.');
    return;
  }

  setBusy(true);
  saveBtn.disabled = true;
  previewEl.value = '';

  try {
    let payload;

    if (isEmbeddedMode()) {
      if (embeddedTracks.length === 0) {
        await ensureEmbeddedTracks(videoPath);
      }

      const selectedTrackValue = Number.parseInt(trackSelect.value, 10);
      if (!Number.isInteger(selectedTrackValue)) {
        throw new Error('Please select an embedded subtitle track.');
      }

      payload = {
        videoPath,
        mode: 'embedded',
        subtitleStreamIndex: selectedTrackValue
      };
    } else {
      payload = {
        videoPath,
        mode: 'transcribe'
      };
    }

    const result = await window.subtitleAPI.extractSubtitles(payload);
    currentSrt = result.srt;
    currentFileName = result.fileName;

    previewEl.value = currentSrt;
    saveBtn.disabled = !currentSrt;
    setStatus('Subtitles generated successfully.');
  } catch (error) {
    console.error(error);
    setStatus(`Failed to generate subtitles: ${error.message}`);
  } finally {
    setBusy(false);
  }
});

saveBtn.addEventListener('click', async () => {
  if (!currentSrt) {
    return;
  }

  try {
    const result = await window.subtitleAPI.saveSrt(currentFileName, currentSrt);
    if (result.saved) {
      setStatus(`Saved to ${result.filePath}`);
    } else {
      setStatus('Save canceled.');
    }
  } catch (error) {
    console.error(error);
    setStatus(`Failed to save .srt: ${error.message}`);
  }
});
