export const TEST_CLIPS = [
  {
    label: 'Trees in Wind',
    url: 'https://videos.pexels.com/video-files/1254570/1254570-hd_1920_1080_30fps.mp4',
  },
  {
    label: 'Flowing River',
    url: 'https://videos.pexels.com/video-files/6981415/6981415-hd_1920_1080_25fps.mp4',
  },
  {
    label: 'Sunset Timelapse',
    url: 'https://videos.pexels.com/video-files/5646694/5646694-hd_1920_1080_30fps.mp4',
  },
];

export const PARAMETER_PRESETS = [
  {
    name: 'Subtle Wind',
    params: {
      frameOffset: 2,
      threshold: 8,
      trailLength: 8,
      channelSpread: 0,
      algorithm: 'posy',
      blurEnabled: false,
    },
  },
  {
    name: 'Ghost Trails',
    params: {
      frameOffset: 10,
      threshold: 12,
      trailLength: 15,
      channelSpread: 2,
      algorithm: 'posy',
      blurEnabled: false,
    },
  },
  {
    name: 'High Contrast',
    params: {
      frameOffset: 3,
      threshold: 5,
      trailLength: 3,
      channelSpread: 0,
      algorithm: 'raw',
      blurEnabled: false,
    },
  },
  {
    name: 'Atmosphere',
    params: {
      frameOffset: 30,
      threshold: 6,
      trailLength: 20,
      channelSpread: 1,
      algorithm: 'posy',
      blurEnabled: true,
    },
  },
  {
    name: 'Rainbow Drift',
    params: {
      frameOffset: 8,
      threshold: 10,
      trailLength: 12,
      channelSpread: 4,
      algorithm: 'posy',
      blurEnabled: false,
    },
  },
];
