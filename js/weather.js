/* ================= FRACTAL RUN NAVI :: weather =================
   Open-Meteo (free, no key, CORS). Shown before a run because heat is the one
   condition that should actually change the plan: in a Tokyo summer the
   difference between 24°C and 33°C matters more than the route does.
   =============================================================== */
window.RN = window.RN || {};

RN.weather = (function () {
  const U = RN.util;
  let cache = null;                       // {key, at, data}
  const TTL = 15 * 60e3;

  const WMO = {
    0: ['快晴', '☀️'], 1: ['晴れ', '🌤'], 2: ['薄曇り', '⛅️'], 3: ['曇り', '☁️'],
    45: ['霧', '🌫'], 48: ['霧', '🌫'],
    51: ['霧雨', '🌦'], 53: ['霧雨', '🌦'], 55: ['霧雨', '🌦'],
    61: ['小雨', '🌧'], 63: ['雨', '🌧'], 65: ['強い雨', '🌧'],
    66: ['凍雨', '🌧'], 67: ['凍雨', '🌧'],
    71: ['小雪', '🌨'], 73: ['雪', '🌨'], 75: ['大雪', '🌨'], 77: ['霧雪', '🌨'],
    80: ['にわか雨', '🌦'], 81: ['にわか雨', '🌦'], 82: ['激しい雨', '⛈'],
    85: ['にわか雪', '🌨'], 86: ['にわか雪', '🌨'],
    95: ['雷雨', '⛈'], 96: ['雷雨', '⛈'], 99: ['雷雨', '⛈']
  };

  /**
   * Running-specific heat advice. Based on apparent temperature (which already
   * folds in humidity and wind) rather than the raw reading — 28°C at 90%
   * humidity is a different run from 28°C at 40%.
   */
  function heatAdvice(apparent) {
    if (apparent == null) return null;
    if (apparent >= 35) return { level: 3, text: '危険な暑さ。屋外ランは避けてください' };
    if (apparent >= 31) return { level: 2, text: '厳重警戒。距離を控えめに、給水を必ず' };
    if (apparent >= 28) return { level: 1, text: '暑さに注意。給水と日陰のコースを' };
    if (apparent <= 2) return { level: 1, text: '路面凍結に注意。ウォームアップ長めに' };
    return { level: 0, text: '走りやすい条件です' };
  }

  async function get(p) {
    const k = p.lat.toFixed(2) + ',' + p.lng.toFixed(2);
    if (cache && cache.key === k && Date.now() - cache.at < TTL) return cache.data;

    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${p.lat.toFixed(4)}&longitude=${p.lng.toFixed(4)}`
      + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,'
      + 'precipitation,wind_speed_10m,weather_code'
      + '&hourly=precipitation_probability&forecast_hours=3'
      + '&timezone=Asia%2FTokyo';
    const r = await U.fetchJSON(url, { timeout: 12000 });
    const c = r.current || {};
    const pop = (r.hourly && r.hourly.precipitation_probability) || [];
    const w = WMO[c.weather_code] || ['—', '🌡'];
    const data = {
      temp: c.temperature_2m,
      apparent: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      precip: c.precipitation,
      wind: c.wind_speed_10m,
      desc: w[0], icon: w[1],
      popNext3h: pop.length ? Math.max(...pop.filter(v => v != null)) : null,
      advice: heatAdvice(c.apparent_temperature)
    };
    cache = { key: k, at: Date.now(), data };
    return data;
  }

  return { get, heatAdvice };
})();
