import Hls from 'hls.js';

export function isDashUrl(url) {
  return /\.mpd($|\?)/i.test(url);
}

export function isHlsUrl(url) {
  return /\.m3u8($|\?)/i.test(url) || /\/hls\//i.test(url);
}

export function isYouTubeUrl(url) {
  return /(?:youtube\.com|youtu\.be)/i.test(url);
}

export function attachHlsSource(url, videoEl, pipeline) {
  return new Promise((resolve, reject) => {
    if (Hls.isSupported()) {
      const hls = new Hls();
      pipeline.setHlsInstance(hls);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        resolve({ mode: 'hls.js' });
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal) return;
        reject(new Error(data.details || 'Failed to load HLS stream.'));
      });

      hls.loadSource(url);
      hls.attachMedia(videoEl);
      return;
    }

    if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      pipeline.setHlsInstance(null);
      videoEl.src = url;
      resolve({ mode: 'native' });
      return;
    }

    reject(new Error('HLS is not supported in this browser.'));
  });
}
