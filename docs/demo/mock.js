// Stubs the extension runtime with fictional data so pages render without Chrome's extension APIs.
(function () {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const day = i => new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
  const daily = [4009, 5706, 2741, 3459, 11324, 10797, 6328];
  const history = daily.map((v, i) => ({ utcDate: day(7 - i), impressions: v, today: false })).concat([{ utcDate: day(0), impressions: 2891, today: true }]);
  const dayView = { utcDate: day(0), u: 14.2, dailyNow: 2891, dailyNowSource: 'analytics', early: false, point: 6105, low: 5410, high: 6890, pace: 5200, fromTodayPosts: 1017, fromTails: 1874, regime: 'calibrating', postByLocal: '12:12' };
  const S=[[0.5,0.1],[1,0.18],[2,0.3],[3,0.4],[4,0.48],[5,0.56],[6,0.63],[8,0.74],[10,0.82],[12,0.87],[15,0.92],[18,0.95],[21,0.98],[24,1]];
  const shape=h=>{ if(h<=0.5) return 0.1*h/0.5; for(let i=1;i<S.length;i++){ if(h<=S[i][0]){const [a,va]=S[i-1],[b,vb]=S[i]; return va+(vb-va)*(h-a)/(b-a);} } return 1; };
  const post = (urn, publishedAt, hours, impressions, point, low, high, gain, status, text) => ({ urn, publishedAt, hours, impressions, point, low, high, gainPerHour: gain, tailMode: status === 'tail', status, textPreview: text, series: Array.from({ length: 8 }, (_, i) => { const h = hours * (i + 1) / 8; return [h, Math.round(impressions * shape(h) / shape(hours))]; }), regime: 'calibrating', type: 'image', observedAt: new Date().toISOString() });
  const live = [
    post('7505901697601384448', new Date(Date.now() - 2.7 * 36e5).toISOString(), 2.7, 1017, 2207, 1690, 2980, 214, 'rising', 'The third cohort kicked off last Friday. 24 people in a room, session 1 of 51, and a first NPS of +55.'),
    post('7505801697601384448', new Date(Date.now() - 6.1 * 36e5).toISOString(), 6.1, 3412, 4180, 3760, 4720, 96, 'slowing', 'I use a payment app as my laundry timer. Sunday is laundry day, and the receipt is the alarm.'),
    post('7505701697601384448', new Date(Date.now() - 13.7 * 36e5).toISOString(), 13.7, 968, 1024, 990, 1090, 12, 'tail', 'Some of you have never named a file FINAL_FINAL_v7 and it shows.'),
  ];
  const state = {
    now: new Date().toISOString(),
    settings: { goal: { kind: 'monthly', value: 160000 }, quietHours: { start: 23, end: 7 }, autoVisit: { enabled: true, analyticsMin: 60, postMin: 30 }, notifCap: 4, overlay: true },
    onboarding: { step: 6, done: true, timezone: 'Europe/Madrid' },
    health: { analytics: { lastOkAt: new Date(Date.now() - 12 * 6e4).toISOString(), path: 'aria' }, post_summary: { lastOkAt: new Date(Date.now() - 40 * 6e4).toISOString(), path: 'dom' }, feed: { lastOkAt: new Date(Date.now() - 3 * 6e4).toISOString() } },
    today: dayView, live,
    accuracy: { byHorizon: { '24h': { n: 14, mape: 0.21, coverage: 0.79 }, eod: { n: 22, mape: 0.09, coverage: 0.82 }, dayahead: { n: 9, mape: 0.31, coverage: 0.67 } }, byShare: { '<0.25': { n: 6, mape: 0.34 }, '0.25-0.5': { n: 8, mape: 0.19 }, '0.5-0.8': { n: 12, mape: 0.11 }, '>0.8': { n: 10, mape: 0.05 } }, byType: { image: { n: 9, mape: 0.2 }, text: { n: 5, mape: 0.23 } }, eodErrors: [-0.12, 0.08, 0.04, -0.06, 0.11, -0.03, 0.07].map((e, i) => ({ utcDate: day(7 - i), errorPct: e })), sdScale: { post: 1, day: 0.9 } },
    autovisit: { count: 14, failures: 0, backoff: 1 },
    goal: { target: 160000, recordedMonth: 78400, todayEod: 6105, monthEod: 84505, daysLeft: 15, paceNeeded: 5440, expectedByNow: 82600, postedToday: 1, verdict: 'on-pace', secondPostAdd: 1540, bestSlot: 17, postByLocal: '12:12', suggestion: 156000 },
    model: { regime: 'calibrating', nPostActuals: 14, recentTotals: [2100, 2600, 1900, 3400, 2200], recentDaily: daily, sdScale: { post: 1, day: 0.9 } },
    daily: Array.from({ length: 28 }, (_, i) => ({ utcDate: day(27 - i), impressions: [3100, 2800, 4200, 3900, 2600, 2100, 2300][i % 7] + (i * 37) % 900, final: i < 27, source: 'analytics' })),
    goalSuggestion: 156000, postsToRead: [], timezone: 'Europe/Madrid', analyticsUrl: '#',
  };
  const respond = msg => {
    switch (msg.type) {
      case 'forecast:post': return { enabled: true, view: live.find(p => p.urn === msg.payload.urn) || live[0] };
      case 'forecast:day': return { enabled: true, view: dayView, history };
      case 'ui:getState': return state;
      case 'snapshot': return { view: live[0] };
      default: return { ok: true };
    }
  };
  window.chrome = { runtime: { sendMessage: (msg, cb) => { setTimeout(() => cb && cb(respond(msg)), 0); }, lastError: undefined, openOptionsPage() {} }, storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } } };
})();
