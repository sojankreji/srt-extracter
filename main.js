const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

let mainWindow = null;
let asrPipeline = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function formatSrtTime(seconds) {
  const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  const totalMs = Math.round(safeSeconds * 1000);

  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function buildSrtFromChunks(chunks) {
  return chunks
    .map((chunk, index) => {
      const [start, end] = chunk.timestamp || [0, 0];
      const text = (chunk.text || '').trim();
      return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${text}`;
    })
    .join('\n\n');
}

function runFfmpeg(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg binary was not found.'));
      return;
    }

    const ffmpeg = spawn(ffmpegPath, [
      '-y',
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'wav',
      audioPath
    ]);

    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('error', (error) => {
      reject(new Error(`Failed to start ffmpeg: ${error.message}`));
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}. ${stderr}`));
      }
    });
  });
}

function inspectStreams(videoPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg binary was not found.'));
      return;
    }

    const ffmpeg = spawn(ffmpegPath, ['-hide_banner', '-i', videoPath]);
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('error', (error) => {
      reject(new Error(`Failed to inspect media streams: ${error.message}`));
    });

    ffmpeg.on('close', () => {
      resolve(stderr);
    });
  });
}

async function listEmbeddedSubtitleTracks(videoPath) {
  const streamInfo = await inspectStreams(videoPath);
  const lines = streamInfo.split(/\r?\n/);
  const tracks = [];

  for (const line of lines) {
    if (!line.includes('Subtitle:')) {
      continue;
    }

    const match = line.match(/Stream #\d+:(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?: Subtitle: ([^,\n]+)/i);
    if (!match) {
      continue;
    }

    const streamIndex = Number(match[1]);
    if (!Number.isInteger(streamIndex)) {
      continue;
    }

    const language = (match[2] || 'und').trim();
    const codec = match[3].trim();

    tracks.push({
      streamIndex,
      language,
      codec,
      label: `Track ${streamIndex} (${language}) - ${codec}`
    });
  }

  return tracks;
}

async function extractEmbeddedSubtitleToSrt(videoPath, streamIndex, sendStatus) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srtextracter-embedded-'));
  const outputPath = path.join(tempDir, 'embedded-subtitles.srt');

  try {
    sendStatus(`Extracting embedded subtitles from track ${streamIndex}...`);

    await new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, [
        '-y',
        '-i',
        videoPath,
        '-map',
        `0:${streamIndex}`,
        '-c:s',
        'srt',
        outputPath
      ]);

      let stderr = '';

      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('error', (error) => {
        reject(new Error(`Failed to start ffmpeg for subtitle extraction: ${error.message}`));
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Could not extract embedded subtitles from track ${streamIndex}. ${stderr}`));
        }
      });
    });

    const content = await fs.readFile(outputPath, 'utf8');
    if (!content.trim()) {
      throw new Error('Embedded subtitle track was extracted but returned empty output.');
    }

    return content;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function getAsrPipeline(sendStatus) {
  if (asrPipeline) {
    return asrPipeline;
  }

  sendStatus('Loading Whisper model (first run may take a few minutes)...');
  const { pipeline, env } = await import('@xenova/transformers');

  env.allowLocalModels = true;
  env.useFSCache = true;

  asrPipeline = await pipeline(
    'automatic-speech-recognition',
    'Xenova/whisper-small',
    { quantized: true }
  );

  return asrPipeline;
}

async function transcribeToSrt(videoPath, sendStatus) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srtextracter-'));
  const audioPath = path.join(tempDir, 'audio.wav');

  try {
    sendStatus('Extracting audio from video...');
    await runFfmpeg(videoPath, audioPath);

    sendStatus('Running speech recognition locally...');
    const asr = await getAsrPipeline(sendStatus);

    const result = await asr(audioPath, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5
    });

    const chunks = Array.isArray(result.chunks) ? result.chunks : [];

    if (chunks.length === 0) {
      const text = (result.text || '').trim();
      const fallback = [{ timestamp: [0, Math.max(2, text.split(' ').length * 0.4)], text }];
      return buildSrtFromChunks(fallback);
    }

    return buildSrtFromChunks(chunks);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

ipcMain.handle('extract-subtitles', async (event, payload) => {
  const sendStatus = (message) => {
    event.sender.send('transcription-status', message);
  };

  const request = typeof payload === 'string' ? { videoPath: payload, mode: 'transcribe' } : (payload || {});
  const { videoPath, mode = 'transcribe', subtitleStreamIndex } = request;

  if (!videoPath || typeof videoPath !== 'string' || !videoPath.trim()) {
    throw new Error('No video file path was provided.');
  }

  const safeVideoPath = videoPath.trim();

  try {
    await fs.access(safeVideoPath);
  } catch {
    throw new Error('Selected video file could not be accessed. Please choose it again.');
  }

  const baseName = path.basename(safeVideoPath, path.extname(safeVideoPath));

  if (mode === 'embedded') {
    const tracks = await listEmbeddedSubtitleTracks(safeVideoPath);
    if (tracks.length === 0) {
      throw new Error('No embedded subtitle track found in this video.');
    }

    let streamIndex = Number.isInteger(subtitleStreamIndex) ? subtitleStreamIndex : tracks[0].streamIndex;
    if (!tracks.some((track) => track.streamIndex === streamIndex)) {
      streamIndex = tracks[0].streamIndex;
    }

    const srt = await extractEmbeddedSubtitleToSrt(safeVideoPath, streamIndex, sendStatus);
    sendStatus('Embedded subtitle extraction complete.');

    return {
      fileName: `${baseName}.embedded.srt`,
      srt
    };
  }

  sendStatus('Preparing transcription...');
  const srt = await transcribeToSrt(safeVideoPath, sendStatus);
  sendStatus('Transcription complete.');

  return {
    fileName: `${baseName}.srt`,
    srt
  };
});

ipcMain.handle('list-embedded-subtitle-tracks', async (_event, videoPath) => {
  if (!videoPath || typeof videoPath !== 'string' || !videoPath.trim()) {
    throw new Error('No video file path was provided.');
  }

  const safeVideoPath = videoPath.trim();
  try {
    await fs.access(safeVideoPath);
  } catch {
    throw new Error('Selected video file could not be accessed. Please choose it again.');
  }

  return listEmbeddedSubtitleTracks(safeVideoPath);
});

ipcMain.handle('save-srt', async (_event, defaultFileName, content) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: defaultFileName,
    filters: [{ name: 'SubRip Subtitle', extensions: ['srt'] }]
  });

  if (canceled || !filePath) {
    return { saved: false };
  }

  await fs.writeFile(filePath, content, 'utf8');
  return { saved: true, filePath };
});

ipcMain.handle('pick-video-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose a video file',
    properties: ['openFile'],
    filters: [
      {
        name: 'Video Files',
        extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v']
      },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (canceled || !filePaths || filePaths.length === 0) {
    return null;
  }

  return filePaths[0];
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
