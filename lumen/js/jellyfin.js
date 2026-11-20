// Minimal Jellyfin client: sign in, browse libraries, stream into the Cinema screen.
const KEY = 'lumen.jellyfin';

let hlsLoading = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLoading) {
    hlsLoading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/hls.light.min.js';
      s.onload = () => res(window.Hls);
      s.onerror = () => rej(new Error('Could not load video player'));
      document.head.appendChild(s);
    });
  }
  return hlsLoading;
}

export function createJellyfin(store) {
  let cfg = store.get(KEY);
  let deviceId = store.get('lumen.deviceId');
  if (!deviceId) { deviceId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); store.set('lumen.deviceId', deviceId); }

  const auth = () => `MediaBrowser Client="Lumen Spatial", Device="Lumen Headset", DeviceId="${deviceId}", Version="1.1.0"` + (cfg?.token ? `, Token="${cfg.token}"` : '');

  async function api(path, opts = {}) {
    const r = await fetch(cfg.url + path, {
      ...opts,
      headers: { Authorization: auth(), 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (!r.ok) {
      if (r.status === 401) throw new Error('Signed out: sign in to Jellyfin again on the start screen');
      throw new Error(`Jellyfin error ${r.status}`);
    }
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }

  const LIST_FIELDS = 'Fields=PrimaryImageAspectRatio&ImageTypeLimit=1&EnableTotalRecordCount=true';

  return {
    get connected() { return !!cfg?.token; },
    get userName() { return cfg?.userName || ''; },
    get serverUrl() { return cfg?.url || ''; },

    async login(url, username, password) {
      url = url.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      if (location.protocol === 'https:' && url.startsWith('http:')) throw new Error('The server address must start with https:// (phones block plain http here)');
      cfg = { url };
      try {
        const r = await api('/Users/AuthenticateByName', { method: 'POST', body: JSON.stringify({ Username: username, Pw: password }) });
        cfg = { url, token: r.AccessToken, userId: r.User.Id, userName: r.User.Name };
        store.set(KEY, cfg);
        return cfg;
      } catch (e) {
        cfg = null;
        if (e instanceof TypeError) throw new Error('Could not reach that server. Check the address and that it uses https.');
        if (/401/.test(e.message) || /Signed out/.test(e.message)) throw new Error('Wrong username or password');
        throw e;
      }
    },
    logout() {
      if (cfg?.token) api('/Sessions/Logout', { method: 'POST' }).catch(() => {});
      cfg = null; store.set(KEY, null);
    },

    views() { return api(`/UserViews?userId=${cfg.userId}`).then(r => r.Items || []); },
    resume(start, limit) {
      return api(`/UserItems/Resume?userId=${cfg.userId}&MediaTypes=Video&StartIndex=${start}&Limit=${limit}&${LIST_FIELDS}`);
    },
    children(parent, start, limit) {
      let q = `ParentId=${parent.Id}`;
      if (parent.CollectionType === 'movies') q += '&Recursive=true&IncludeItemTypes=Movie';
      else if (parent.CollectionType === 'tvshows') q += '&Recursive=true&IncludeItemTypes=Series';
      const sort = parent.Type === 'Season' || parent.Type === 'Series' ? 'ParentIndexNumber,IndexNumber,SortName' : 'SortName';
      return api(`/Items?userId=${cfg.userId}&${q}&SortBy=${sort}&SortOrder=Ascending&StartIndex=${start}&Limit=${limit}&${LIST_FIELDS}`);
    },
    imageUrl(item, height = 360) {
      const tag = item.ImageTags?.Primary;
      if (tag) return `${cfg.url}/Items/${item.Id}/Images/Primary?fillHeight=${height}&quality=85&tag=${tag}`;
      if (item.SeriesId && item.SeriesPrimaryImageTag) return `${cfg.url}/Items/${item.SeriesId}/Images/Primary?fillHeight=${height}&quality=85&tag=${item.SeriesPrimaryImageTag}`;
      return null;
    },

    // Returns a movie object for the Cinema app: { video, name, stop() }
    async play(item) {
      const Hls = await loadHls();
      const full = await api(`/Items/${item.Id}?userId=${cfg.userId}`);
      const ms = full.MediaSources?.[0];
      const msId = ms?.Id || item.Id;
      const psid = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).replace(/-/g, '');
      const hevc = window.MediaSource?.isTypeSupported?.('video/mp4; codecs="hvc1.1.6.L123.B0"');
      const q = new URLSearchParams({
        api_key: cfg.token, DeviceId: deviceId, MediaSourceId: msId, PlaySessionId: psid,
        VideoCodec: hevc ? 'hevc,h264' : 'h264', AudioCodec: 'aac,mp3', TranscodingMaxAudioChannels: '2',
        MaxStreamingBitrate: '40000000', SegmentContainer: 'mp4', MinSegments: '1', BreakOnNonKeyFrames: 'True', RequireAvc: 'false',
      });
      const src = `${cfg.url}/Videos/${item.Id}/master.m3u8?${q}`;

      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.playsInline = true; video.setAttribute('playsinline', '');
      let hls = null;
      if (Hls && Hls.isSupported()) {
        hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60 });
        hls.loadSource(src);
        hls.attachMedia(video);
      } else {
        video.src = src;
      }
      const startTicks = full.UserData?.PlaybackPositionTicks || 0;
      if (startTicks > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = startTicks / 1e7; }, { once: true });

      const base = { ItemId: item.Id, MediaSourceId: msId, PlaySessionId: psid };
      const ticks = () => Math.floor((video.currentTime || 0) * 1e7);
      api('/Sessions/Playing', { method: 'POST', body: JSON.stringify({ ...base, CanSeek: true, PlayMethod: 'Transcode', PositionTicks: startTicks }) }).catch(() => {});
      const timer = setInterval(() => {
        api('/Sessions/Playing/Progress', { method: 'POST', body: JSON.stringify({ ...base, PositionTicks: ticks(), IsPaused: video.paused, PlayMethod: 'Transcode' }) }).catch(() => {});
      }, 10000);

      const name = item.SeriesName
        ? `${item.SeriesName} · ${item.ParentIndexNumber != null ? `S${item.ParentIndexNumber}E${item.IndexNumber} ` : ''}${item.Name}`
        : item.Name;
      let stopped = false;
      return {
        video, name,
        waitForMeta: new Promise(res => {
          if (video.readyState >= 1) res(); else video.addEventListener('loadedmetadata', () => res(), { once: true });
          setTimeout(res, 8000);
        }),
        stop() {
          if (stopped) return; stopped = true;
          clearInterval(timer);
          api('/Sessions/Playing/Stopped', { method: 'POST', body: JSON.stringify({ ...base, PositionTicks: ticks() }) }).catch(() => {});
          api(`/Videos/ActiveEncodings?deviceId=${encodeURIComponent(deviceId)}&playSessionId=${psid}`, { method: 'DELETE' }).catch(() => {});
          video.pause();
          hls?.destroy();
          video.removeAttribute('src'); video.load();
        },
      };
    },
  };
}
